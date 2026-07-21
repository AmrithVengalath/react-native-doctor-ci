/**
 * npm registry data source.
 * @packageDocumentation
 */

import { fetchJson, isRecord, type FetchOutcome } from "../http.js";

/**
 * The subset of the npm registry `/latest` version manifest the enrichment
 * engine reads. All fields beyond name/version are optional and best-effort.
 */
export interface NpmVersionManifest {
  readonly name: string;
  readonly version: string;
  /** npm's deprecation message; a non-empty string means deprecated. */
  readonly deprecated?: string;
  /** Present (any shape) when the package ships New-Architecture codegen. */
  readonly codegenConfig?: unknown;
  readonly peerDependencies?: Record<string, string>;
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly files?: readonly string[];
}

/**
 * Narrow an unknown npm `/latest` payload to {@link NpmVersionManifest},
 * dropping malformed fields rather than throwing - the engine degrades missing
 * data to `unknown`, it never fails a run on a surprising response shape.
 * @param data - The JSON-parsed response body.
 */
export function parseNpmManifest(data: unknown): NpmVersionManifest {
  if (!isRecord(data)) return { name: "", version: "" };

  const repository = data["repository"];
  const peerDependencies = data["peerDependencies"];
  const files = data["files"];

  return {
    name: typeof data["name"] === "string" ? data["name"] : "",
    version: typeof data["version"] === "string" ? data["version"] : "",
    ...(typeof data["deprecated"] === "string" ? { deprecated: data["deprecated"] } : {}),
    ...("codegenConfig" in data ? { codegenConfig: data["codegenConfig"] } : {}),
    ...(isRecord(peerDependencies)
      ? { peerDependencies: filterStringMap(peerDependencies) }
      : {}),
    ...(isRecord(repository) && typeof repository["url"] === "string"
      ? {
          repository: {
            url: repository["url"],
            ...(typeof repository["type"] === "string" ? { type: repository["type"] } : {}),
          },
        }
      : {}),
    ...(Array.isArray(files)
      ? { files: files.filter((f): f is string => typeof f === "string") }
      : {}),
  };
}

/** Keep only string-valued entries of an object (e.g. a dependency map). */
function filterStringMap(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

/**
 * Fetch the latest version manifest from npm registry.
 * @param packageName - The npm package name (may be scoped, e.g. `@react-native-community/netinfo`).
 * @returns The parsed version manifest or an outcome describing what went wrong.
 */
export async function fetchNpmLatestManifest(
  packageName: string,
): Promise<FetchOutcome<NpmVersionManifest>> {
  const encoded = encodeURIComponent(packageName);
  const url = `https://registry.npmjs.org/${encoded}/latest`;

  const outcome = await fetchJson<unknown>(url);
  if (outcome.status !== "ok") return outcome;
  return { status: "ok", data: parseNpmManifest(outcome.data) };
}

/** Extract the top search hit's name and publish date, or null when absent. */
function parseNpmSearchTop(data: unknown): { name: string; date: string } | null {
  if (!isRecord(data)) return null;
  const objects = data["objects"];
  if (!Array.isArray(objects) || objects.length === 0) return null;
  const first: unknown = objects[0];
  if (!isRecord(first)) return null;
  const pkg = first["package"];
  if (!isRecord(pkg)) return null;
  const name = pkg["name"];
  const date = pkg["date"];
  if (typeof name !== "string" || typeof date !== "string") return null;
  return { name, date };
}

/**
 * Search npm for a package and return the top result's publish date.
 * Callers must verify that the returned name matches exactly; if not, treat as not-found.
 * @param packageName - The npm package name to search for.
 * @returns The search result or an outcome describing what went wrong.
 */
export async function searchNpmForPackage(
  packageName: string,
): Promise<FetchOutcome<{ readonly name: string; readonly date: string }>> {
  const url = new URL("https://registry.npmjs.org/-/v1/search");
  url.searchParams.set("text", packageName);
  url.searchParams.set("size", "1");

  const outcome = await fetchJson<unknown>(url.toString());
  if (outcome.status !== "ok") {
    return outcome;
  }

  const top = parseNpmSearchTop(outcome.data);
  if (!top) {
    return { status: "error", message: "No search results" };
  }
  return { status: "ok", data: top };
}
