/**
 * package.json reading and dependency-line resolution for the CLI and the
 * GitHub-annotation reporter.
 *
 * The enrichment engine itself stays manifest-agnostic (it takes plain
 * package names); everything in this module is CLI-side plumbing.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A project manifest could not be read or parsed. Maps to exit code 2
 * (tool failure) in the CLI.
 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * One dependency declaration from a `dependencies` section: the package name
 * and its raw version spec string, exactly as authored.
 */
export interface DependencyEntry {
  readonly name: string;
  /** The raw spec (`"^1.2.0"`, `"npm:foo@2"`, …) — never parsed as semver. */
  readonly spec: string;
}

/**
 * A loaded package.json: the raw text (for line resolution) and the
 * dependency names to check, in the order they are authored.
 */
export interface ProjectManifest {
  /** Absolute path the manifest was read from. */
  readonly path: string;
  /** The raw file text, used to resolve dependency line numbers. */
  readonly text: string;
  /** Names from the `dependencies` section, in authored order. */
  readonly dependencies: readonly string[];
  /** Name/spec pairs from the `dependencies` section, in authored order. */
  readonly entries: readonly DependencyEntry[];
}

/**
 * Extract name/spec pairs from the `dependencies` section of a parsed
 * package.json value, preserving authored order. Returns an empty list when
 * the section is absent; throws {@link ManifestError} when the section or a
 * spec value has the wrong shape.
 *
 * @param parsed - The JSON-parsed manifest.
 * @param where - Human-readable location used in error messages.
 */
export function listDependencyEntries(
  parsed: unknown,
  where = "package.json",
): readonly DependencyEntry[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError(`${where} is not a JSON object.`);
  }
  const deps: unknown = (parsed as Record<string, unknown>)["dependencies"];
  if (deps === undefined) return [];
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    throw new ManifestError(`${where} has a "dependencies" field that is not an object.`);
  }
  return Object.entries(deps).map(([name, spec]) => {
    if (typeof spec !== "string") {
      throw new ManifestError(`${where} has a non-string version for dependency "${name}".`);
    }
    return { name, spec };
  });
}

/**
 * Extract the names of the `dependencies` section from a parsed package.json
 * value, preserving authored order. Returns an empty list when the section is
 * absent; throws {@link ManifestError} when it is present but not an object.
 *
 * @param parsed - The JSON-parsed manifest.
 * @param where - Human-readable location used in error messages.
 */
export function listDependencies(parsed: unknown, where = "package.json"): readonly string[] {
  return listDependencyEntries(parsed, where).map((entry) => entry.name);
}

/**
 * Parse raw manifest text (e.g. a blob read from git) into dependency
 * entries. BOM-tolerant like {@link readPackageJson}.
 *
 * @param text - The raw manifest text.
 * @param where - Human-readable location used in error messages.
 * @throws ManifestError when the text is not valid JSON or has a malformed
 * `dependencies` section.
 */
export function entriesFromManifestText(text: string, where: string): readonly DependencyEntry[] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch (err) {
    throw new ManifestError(
      `${where} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return listDependencyEntries(parsed, where);
}

/**
 * Read and parse the manifest at an exact path.
 *
 * @param path - Absolute path of the package.json to read.
 * @param missingMessage - Error message when the file does not exist; defaults
 * to a plain "not found" pointing at `path`.
 * @returns The manifest text and its dependency entries.
 * @throws ManifestError when the file is missing or not valid JSON — the CLI
 * turns this into exit code 2 with the message shown as-is.
 */
export async function readManifestAt(
  path: string,
  missingMessage?: string,
): Promise<ProjectManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
    // npm tolerates a UTF-8 BOM in package.json; JSON.parse does not. The BOM
    // sits before line 1's content, so stripping it never shifts line numbers.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ManifestError(missingMessage ?? `No package.json found at ${path}.`);
    }
    throw new ManifestError(
      `Could not read ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new ManifestError(
      `${path} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entries = listDependencyEntries(parsed, path);
  return { path, text, dependencies: entries.map((entry) => entry.name), entries };
}

/**
 * Read and parse `<cwd>/package.json`.
 *
 * @param cwd - Directory containing the manifest.
 * @returns The manifest text and its dependency names.
 * @throws ManifestError when the file is missing or not valid JSON — the CLI
 * turns this into exit code 2 with the message shown as-is.
 */
export async function readPackageJson(cwd: string): Promise<ProjectManifest> {
  return readManifestAt(
    join(cwd, "package.json"),
    `No package.json found in ${cwd}. Run rn-doctor from the project root ` +
      `(the directory containing package.json).`,
  );
}

/**
 * Resolve the 1-based line number where `name` is declared inside the
 * top-level `dependencies` object of a package.json text.
 *
 * @remarks
 * Scans the raw text with a minimal JSON walker (string- and escape-aware,
 * tracking object depth), so a key with the same name under `devDependencies`,
 * `scripts`, or a nested object can never false-match. Returns `null` when the
 * name is not declared in `dependencies` — annotations then omit the line.
 *
 * @param text - The raw package.json text (not re-serialized — the real file).
 * @param name - The exact dependency name to locate.
 */
export function findDependencyLine(text: string, name: string): number | null {
  let line = 1;
  let depth = 0;
  let inDependencies = false;

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") {
      line++;
      i++;
      continue;
    }

    if (ch === '"') {
      // Consume the whole string, tracking lines and the literal content.
      const stringLine = line;
      let value = "";
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          value += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === "\n") line++; // Invalid in JSON, but keep the count honest.
        if (c === '"') {
          i++;
          break;
        }
        value += c;
        i++;
      }
      // A string followed by ":" (after whitespace) is an object key.
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j++;
      const isKey = text[j] === ":";
      if (isKey) {
        if (depth === 1 && value === "dependencies") {
          // Only an object-valued `dependencies` opens the section; a scalar
          // value must not leak the flag onto sibling objects.
          let k = j + 1;
          while (k < text.length && (text[k] === " " || text[k] === "\t" || text[k] === "\r" || text[k] === "\n")) k++;
          if (text[k] === "{") inDependencies = true;
        } else if (inDependencies && depth === 2 && value === name) {
          return stringLine;
        }
      }
      continue;
    }

    if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (inDependencies && depth <= 1) inDependencies = false;
    }
    i++;
  }

  return null;
}
