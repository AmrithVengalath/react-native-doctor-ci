/**
 * The rn-doctor CLI, factored as a pure-ish `runCli` function with injectable
 * I/O so the whole flow (read package.json, enrich, evaluate policy, report,
 * exit code) is testable without spawning a process. `cli.ts` is the thin bin
 * wrapper around this.
 * @packageDocumentation
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { diffDependencies } from "./changed-deps.js";
import { enrichDependencies } from "./enrich.js";
import { GitError, createGitRunner, readFileAtCommit, resolveBaseCommit } from "./git.js";
import type { GitRunner } from "./git.js";
import {
  ManifestError,
  entriesFromManifestText,
  findDependencyLine,
  readManifestAt,
  readPackageJson,
} from "./package-json.js";
import type { ProjectManifest } from "./package-json.js";
import { evaluatePolicy } from "./policy.js";
import { loadPolicy, PolicyError } from "./policy-file.js";
import { renderAnnotations } from "./report-annotations.js";
import { renderJson } from "./report-json.js";
import { renderPretty } from "./report-pretty.js";
import { renderSarif } from "./report-sarif.js";
import { computeExitCode } from "./report.js";
import type { Report, ReportFinding } from "./report.js";
import type { EnrichmentWarning } from "./types.js";
import { VERSION } from "./version.js";
import { WorkspaceError, discoverWorkspaces } from "./workspaces.js";

const USAGE = `rn-doctor - React Native dependency health gate for CI

Usage:
  rn-doctor [options]

Checks the "dependencies" of the package.json in the current directory
against the policy in .rn-doctor.yml (or the built-in default policy).

Options:
  --json             Output a machine-readable JSON report (stable-ordered)
  --sarif            Output a SARIF 2.1.0 report (for code-scanning upload)
  --policy <path>    Path to the policy file (default: .rn-doctor.yml if present)
  --changed-only     Check only dependencies added or changed vs the base ref
                     (compares against the merge-base of HEAD and the base)
  --base <ref>       Base ref for --changed-only (default: origin/main)
  --workspaces       Also check every workspace package.json (npm/yarn
                     "workspaces" or pnpm-workspace.yaml), grouped by manifest
  --no-cache         Bypass the enrichment cache (read and write)
  --annotations      Force GitHub annotations on (default: auto in GitHub Actions)
  --no-annotations   Force GitHub annotations off
  -v, --version      Print the version and exit
  -h, --help         Show this help and exit

Exit codes:
  0  clean (no policy errors; warnings, notes and allowlisted findings are ok)
  1  policy errors found
  2  tool failure (bad flags, unreadable package.json, invalid policy file,
     git failure under --changed-only, missing workspace configuration)
`;

/**
 * Injectable process surface for {@link runCli}.
 */
export interface CliIo {
  readonly stdout: { write(chunk: string): unknown; readonly isTTY?: boolean };
  readonly stderr: { write(chunk: string): unknown };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Clock for policy evaluation; defaults to the real time. */
  readonly now?: Date;
  /** Git process runner for --changed-only; defaults to the real git binary. */
  readonly git?: GitRunner;
}

/** The CLI exit codes — a stable contract CI depends on. */
export type ExitCode = 0 | 1 | 2;

interface CliFlags {
  readonly json: boolean;
  readonly sarif: boolean;
  readonly policy: string | undefined;
  readonly changedOnly: boolean;
  readonly base: string | undefined;
  readonly workspaces: boolean;
  readonly noCache: boolean;
  readonly annotations: boolean;
  readonly noAnnotations: boolean;
  readonly version: boolean;
  readonly help: boolean;
}

function parseCliArgs(argv: readonly string[]): CliFlags {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      sarif: { type: "boolean", default: false },
      policy: { type: "string" },
      "changed-only": { type: "boolean", default: false },
      // No parseArgs default: --base without --changed-only must be detectable.
      base: { type: "string" },
      workspaces: { type: "boolean", default: false },
      // Node 20 parseArgs has no allowNegative; model --no-* as literal flags.
      "no-cache": { type: "boolean", default: false },
      annotations: { type: "boolean", default: false },
      "no-annotations": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  return {
    json: values.json,
    sarif: values.sarif,
    policy: values.policy,
    changedOnly: values["changed-only"],
    base: values.base,
    workspaces: values.workspaces,
    noCache: values["no-cache"],
    annotations: values.annotations,
    noAnnotations: values["no-annotations"],
    version: values.version,
    help: values.help,
  };
}

/**
 * Run the rn-doctor CLI.
 *
 * @param argv - Arguments after the node binary and script (`process.argv.slice(2)`).
 * @param io - Process surface (streams, cwd, env, clock).
 * @returns The process exit code: 0 clean, 1 policy errors, 2 tool failure.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let flags: CliFlags;
  try {
    flags = parseCliArgs(argv);
  } catch (err) {
    io.stderr.write(`rn-doctor: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  if (flags.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (flags.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.json && flags.sarif) {
    io.stderr.write("rn-doctor: --json and --sarif are mutually exclusive.\n");
    return 2;
  }
  if (flags.annotations && flags.noAnnotations) {
    io.stderr.write("rn-doctor: --annotations and --no-annotations are mutually exclusive.\n");
    return 2;
  }
  if (flags.base !== undefined && !flags.changedOnly) {
    io.stderr.write("rn-doctor: --base requires --changed-only.\n");
    return 2;
  }

  try {
    const rootManifest = await readPackageJson(io.cwd);
    const policy = await loadPolicy(flags.policy, io.cwd);
    const runWarnings: EnrichmentWarning[] = [];

    // The manifests to scan: just the root, or root + discovered workspaces.
    let scans: { readonly relPath: string; readonly manifest: ProjectManifest }[];
    if (flags.workspaces) {
      const dirs = await discoverWorkspaces(io.cwd, JSON.parse(rootManifest.text));
      if (dirs.length === 1) {
        runWarnings.push({
          source: "workspaces",
          message:
            "The workspace configuration matched no directories; checking the root manifest only.",
        });
      }
      scans = await Promise.all(
        dirs.map(async (w) => ({
          relPath: w.manifestRelPath,
          manifest:
            w.manifestRelPath === "package.json"
              ? rootManifest
              : await readManifestAt(join(w.dir, "package.json")),
        })),
      );
    } else {
      scans = [{ relPath: "package.json", manifest: rootManifest }];
    }

    // Which dependency names to check per manifest: everything, or only the
    // names added/changed since the merge-base under --changed-only.
    let checks: { readonly relPath: string; readonly names: readonly string[] }[];
    if (flags.changedOnly) {
      const git = io.git ?? createGitRunner();
      const baseRef = flags.base ?? "origin/main";
      const baseCommit = await resolveBaseCommit(git, io.cwd, baseRef);
      checks = await Promise.all(
        scans.map(async ({ relPath, manifest }) => {
          const baseText = await readFileAtCommit(git, io.cwd, baseCommit, relPath);
          let baseEntries = null;
          if (baseText !== null) {
            try {
              baseEntries = entriesFromManifestText(baseText, `${relPath} at ${baseRef}`);
            } catch (err) {
              // A malformed base manifest must not fail the run: checking all
              // current deps is a strict superset, so we never under-check.
              if (!(err instanceof ManifestError)) throw err;
              runWarnings.push({
                source: "git",
                message: `${relPath} at ${baseRef} could not be parsed (${err.message}); checking all of its dependencies.`,
              });
            }
          }
          return { relPath, names: diffDependencies(baseEntries, manifest.entries) };
        }),
      );
    } else {
      checks = scans.map(({ relPath, manifest }) => ({ relPath, names: manifest.dependencies }));
    }

    // Enrich the union once (dedupes; shared cache), then evaluate once and
    // fan the findings back out to the manifests that declare each package.
    const union = [...new Set(checks.flatMap((c) => c.names))];
    const enriched =
      union.length > 0
        ? await enrichDependencies(union, {
            noCache: flags.noCache,
            cacheDir: io.cwd,
            githubToken: io.env.GITHUB_TOKEN,
          })
        : { dependencies: [], warnings: [] };

    const findings = evaluatePolicy(enriched.dependencies, policy, { now: io.now });
    const located: ReportFinding[] = [];
    for (const { relPath, names } of checks) {
      const declared = new Set(names);
      for (const f of findings) {
        if (declared.has(f.package)) located.push({ ...f, file: relPath });
      }
    }

    const report: Report = {
      findings: located,
      warnings: [...runWarnings, ...enriched.warnings],
      checkedCount: checks.reduce((sum, c) => sum + c.names.length, 0),
      ...(flags.workspaces ? { manifestCount: scans.length } : {}),
    };
    const texts = new Map(scans.map(({ relPath, manifest }) => [relPath, manifest.text]));
    const lineOf = (file: string, name: string): number | null => {
      const text = texts.get(file);
      return text === undefined ? null : findDependencyLine(text, name);
    };

    if (flags.json) {
      io.stdout.write(renderJson(report));
    } else if (flags.sarif) {
      io.stdout.write(renderSarif(report, { lineOf }));
    } else {
      const color = Boolean(io.stdout.isTTY) && !io.env.NO_COLOR;
      io.stdout.write(renderPretty(report, { color }));

      const emitAnnotations =
        flags.annotations || (io.env.GITHUB_ACTIONS === "true" && !flags.noAnnotations);
      if (emitAnnotations) {
        io.stdout.write(renderAnnotations(report, lineOf));
      }
    }

    return computeExitCode(report.findings);
  } catch (err) {
    if (
      err instanceof ManifestError ||
      err instanceof PolicyError ||
      err instanceof GitError ||
      err instanceof WorkspaceError
    ) {
      io.stderr.write(`rn-doctor: ${err.message}\n`);
      return 2;
    }
    io.stderr.write(
      `rn-doctor: unexpected error - ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 2;
  }
}
