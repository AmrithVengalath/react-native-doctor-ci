/**
 * The rn-doctor CLI, factored as a pure-ish `runCli` function with injectable
 * I/O so the whole flow (read package.json, enrich, evaluate policy, report,
 * exit code) is testable without spawning a process. `cli.ts` is the thin bin
 * wrapper around this.
 * @packageDocumentation
 */

import { parseArgs } from "node:util";

import { enrichDependencies } from "./enrich.js";
import { findDependencyLine, readPackageJson, ManifestError } from "./package-json.js";
import { evaluatePolicy } from "./policy.js";
import { loadPolicy, PolicyError } from "./policy-file.js";
import { renderAnnotations } from "./report-annotations.js";
import { renderJson } from "./report-json.js";
import { renderPretty } from "./report-pretty.js";
import { renderSarif } from "./report-sarif.js";
import { computeExitCode } from "./report.js";
import type { Report } from "./report.js";
import { VERSION } from "./version.js";

const USAGE = `rn-doctor - React Native dependency health gate for CI

Usage:
  rn-doctor [options]

Checks the "dependencies" of the package.json in the current directory
against the policy in .rn-doctor.yml (or the built-in default policy).

Options:
  --json             Output a machine-readable JSON report (stable-ordered)
  --sarif            Output a SARIF 2.1.0 report (for code-scanning upload)
  --policy <path>    Path to the policy file (default: .rn-doctor.yml if present)
  --no-cache         Bypass the enrichment cache (read and write)
  --annotations      Force GitHub annotations on (default: auto in GitHub Actions)
  --no-annotations   Force GitHub annotations off
  -v, --version      Print the version and exit
  -h, --help         Show this help and exit

Exit codes:
  0  clean (no policy errors; warnings, notes and allowlisted findings are ok)
  1  policy errors found
  2  tool failure (bad flags, unreadable package.json, invalid policy file)
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
}

/** The CLI exit codes — a stable contract CI depends on. */
export type ExitCode = 0 | 1 | 2;

interface CliFlags {
  readonly json: boolean;
  readonly sarif: boolean;
  readonly policy: string | undefined;
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

  try {
    const manifest = await readPackageJson(io.cwd);
    const policy = await loadPolicy(flags.policy, io.cwd);

    const enriched = await enrichDependencies(manifest.dependencies, {
      noCache: flags.noCache,
      cacheDir: io.cwd,
      githubToken: io.env.GITHUB_TOKEN,
    });

    const findings = evaluatePolicy(enriched.dependencies, policy, { now: io.now });
    const report: Report = {
      findings,
      warnings: enriched.warnings,
      checkedCount: manifest.dependencies.length,
    };
    const lineOf = (name: string): number | null => findDependencyLine(manifest.text, name);

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
    if (err instanceof ManifestError || err instanceof PolicyError) {
      io.stderr.write(`rn-doctor: ${err.message}\n`);
      return 2;
    }
    io.stderr.write(
      `rn-doctor: unexpected error - ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 2;
  }
}
