/**
 * Workspace discovery for `--workspaces`: find every workspace package.json
 * declared by the root manifest, so the CLI can scan and report them as one
 * grouped run.
 *
 * Supports both workspace conventions:
 * - `pnpm-workspace.yaml` `packages:` globs (takes precedence — pnpm itself
 *   ignores the package.json field), parsed with the existing `yaml` dep;
 * - root package.json `"workspaces"` (an array, or `{ packages: [...] }`).
 *
 * Glob expansion is hand-rolled on purpose (zero-dependency bias): literal
 * paths, `*` as a full or partial segment, `**`, and leading-`!` exclusions
 * cover what real-world workspace fields use.
 *
 * @packageDocumentation
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parse } from "yaml";

/**
 * `--workspaces` was requested but no workspace configuration exists or it is
 * malformed. Maps to exit code 2 (tool failure) in the CLI.
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** One discovered manifest location. */
export interface WorkspaceDir {
  /** Absolute directory containing a package.json. */
  readonly dir: string;
  /**
   * Manifest path relative to the root cwd, POSIX separators — e.g.
   * `packages/a/package.json`. The root manifest is `package.json`.
   */
  readonly manifestRelPath: string;
}

/** Compile one pattern segment (`*` wildcards only) to a RegExp. */
function segmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/\\\\]*");
  return new RegExp(`^${escaped}$`);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** List subdirectory names of `dir`, skipping node_modules and dot-dirs. */
async function listSubdirs(dir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => e.name);
}

/** All directories at any depth under `dir` (inclusive), same skip rules. */
async function walkDirs(dir: string): Promise<readonly string[]> {
  const out: string[] = [dir];
  for (const name of await listSubdirs(dir)) {
    out.push(...(await walkDirs(join(dir, name))));
  }
  return out;
}

/** Expand one inclusion pattern to absolute directories under `rootDir`. */
async function expandPattern(rootDir: string, pattern: string): Promise<readonly string[]> {
  // Normalize authored separators and trailing slashes.
  const segments = pattern.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter((s) => s !== "" && s !== ".");

  let dirs: readonly string[] = [rootDir];
  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      // `**` matches zero or more directories; delegate the rest of the
      // pattern to every directory under the current set (inclusive).
      const rest = segments.slice(index + 1).join("/");
      const under = (await Promise.all(dirs.map((d) => walkDirs(d)))).flat();
      if (rest === "") return under;
      return (await Promise.all(under.map((d) => expandPattern(d, rest)))).flat();
    }
    if (segment.includes("*")) {
      const re = segmentToRegExp(segment);
      const next: string[] = [];
      for (const dir of dirs) {
        for (const name of await listSubdirs(dir)) {
          if (re.test(name)) next.push(join(dir, name));
        }
      }
      dirs = next;
    } else {
      const next: string[] = [];
      for (const dir of dirs) {
        const candidate = join(dir, segment);
        if (await isDirectory(candidate)) next.push(candidate);
      }
      dirs = next;
    }
    if (dirs.length === 0) return [];
  }
  return dirs;
}

/** POSIX-separated path of `dir` relative to `rootDir`. */
function relPosix(rootDir: string, dir: string): string {
  return relative(rootDir, dir).split(sep).join("/");
}

/**
 * Expand workspace glob patterns to absolute directories under `rootDir`,
 * deduplicated and sorted by relative path. Leading-`!` patterns exclude
 * directories matched by earlier inclusions (pnpm-workspace.yaml commonly
 * carries e.g. `!**\/test/**`).
 *
 * @remarks Supported syntax: literal paths, `*` as a full or partial path
 * segment, and `**` (any depth). `node_modules` and dot-directories are never
 * traversed. Anything fancier (braces, extglobs) simply matches nothing —
 * the CLI warns when a configuration yields zero workspaces.
 */
export async function expandWorkspacePatterns(
  rootDir: string,
  patterns: readonly string[],
): Promise<readonly string[]> {
  const included = new Map<string, string>(); // relPosix → absolute
  const exclusions: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      exclusions.push(pattern.slice(1));
      continue;
    }
    for (const dir of await expandPattern(rootDir, pattern)) {
      const rel = relPosix(rootDir, dir);
      if (rel !== "") included.set(rel, dir);
    }
  }

  for (const exclusion of exclusions) {
    const excluded = new Set(
      (await expandPattern(rootDir, exclusion)).map((dir) => relPosix(rootDir, dir)),
    );
    for (const rel of [...included.keys()]) {
      if (excluded.has(rel)) included.delete(rel);
    }
  }

  return [...included.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, dir]) => dir);
}

/** Read the `packages:` globs from pnpm-workspace.yaml, or null when absent. */
async function readPnpmWorkspacePatterns(rootDir: string): Promise<readonly string[] | null> {
  let text: string;
  try {
    text = await readFile(join(rootDir, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parse(text) as unknown;
  } catch (err) {
    throw new WorkspaceError(
      `pnpm-workspace.yaml is not valid YAML — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const packages: unknown = (parsed as Record<string, unknown>)["packages"];
  if (packages === undefined) return null;
  if (!Array.isArray(packages) || !packages.every((p): p is string => typeof p === "string")) {
    throw new WorkspaceError('pnpm-workspace.yaml has a "packages" field that is not a list of strings.');
  }
  return packages;
}

/** Read the `workspaces` patterns from a parsed root package.json, or null. */
function readManifestWorkspacePatterns(parsed: unknown): readonly string[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  let field: unknown = (parsed as Record<string, unknown>)["workspaces"];
  if (field === undefined) return null;
  if (typeof field === "object" && field !== null && !Array.isArray(field)) {
    field = (field as Record<string, unknown>)["packages"];
    if (field === undefined) return null;
  }
  if (!Array.isArray(field) || !field.every((p): p is string => typeof p === "string")) {
    throw new WorkspaceError('package.json has a "workspaces" field that is not a list of strings.');
  }
  return field;
}

/**
 * Discover the manifests of a workspace root: the root package.json first,
 * then every configured workspace directory that actually contains a
 * package.json, sorted by relative path.
 *
 * @param rootDir - The workspace root (the CLI cwd).
 * @param rootManifestParsed - The JSON-parsed root package.json (already
 * loaded by the CLI), used for its `workspaces` field.
 * @returns Zero workspace matches yield just the root entry — the CLI warns
 * but proceeds.
 * @throws WorkspaceError when neither `pnpm-workspace.yaml` `packages:` nor a
 * package.json `workspaces` field exists, or either is malformed.
 */
export async function discoverWorkspaces(
  rootDir: string,
  rootManifestParsed: unknown,
): Promise<readonly WorkspaceDir[]> {
  const patterns =
    (await readPnpmWorkspacePatterns(rootDir)) ?? readManifestWorkspacePatterns(rootManifestParsed);
  if (patterns === null) {
    throw new WorkspaceError(
      '--workspaces requires a "workspaces" field in package.json or a packages list in pnpm-workspace.yaml.',
    );
  }

  const result: WorkspaceDir[] = [{ dir: rootDir, manifestRelPath: "package.json" }];
  for (const dir of await expandWorkspacePatterns(rootDir, patterns)) {
    try {
      await stat(join(dir, "package.json"));
    } catch {
      continue; // matched directory without a manifest — not a workspace
    }
    result.push({ dir, manifestRelPath: `${relPosix(rootDir, dir)}/package.json` });
  }
  return result;
}
