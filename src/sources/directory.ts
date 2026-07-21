/**
 * React Native Directory data source.
 * @packageDocumentation
 */

import { fetchJson, type FetchOutcome } from "../http.js";
import { mapWithConcurrency } from "../concurrency.js";

/**
 * Result from the `/api/libraries/check` endpoint (batched check).
 */
export interface DirectoryCheckEntry {
  readonly unmaintained?: boolean;
  readonly newArchitecture?: "new-arch-only" | "supported" | "unsupported" | "untested";
}

/**
 * Full library entry from `/api/library` endpoint (singular lookup).
 */
export interface DirectoryLibraryDetail {
  readonly githubUrl?: string;
  readonly github?: {
    readonly isArchived?: boolean;
    readonly stats?: {
      readonly pushedAt?: string;
    };
  };
  readonly npm?: {
    readonly latestReleaseDate?: string;
  };
  readonly matchingScoreModifiers?: string[];
}

/**
 * Batch-check multiple packages against RN Directory in one call.
 * Packages not in the directory are simply omitted from the response.
 * @param packageNames - List of npm package names (may be scoped).
 * @returns A map of package name → check result (absent keys = not listed).
 */
export async function checkLibraries(
  packageNames: readonly string[],
): Promise<FetchOutcome<Record<string, DirectoryCheckEntry>>> {
  if (packageNames.length === 0) {
    return { status: "ok", data: {} };
  }

  // Chunk names into ~200-name batches to stay well under URL length limits
  const chunks: string[][] = [];
  for (let i = 0; i < packageNames.length; i += 200) {
    chunks.push(Array.from(packageNames.slice(i, i + 200)));
  }

  const results: Record<string, DirectoryCheckEntry> = {};

  for (const chunk of chunks) {
    const url = new URL("https://reactnative.directory/api/libraries/check");
    url.searchParams.set("packages", chunk.join(","));

    const outcome = await fetchJson<Record<string, DirectoryCheckEntry>>(url.toString());

    if (outcome.status !== "ok") {
      return outcome;
    }

    Object.assign(results, outcome.data);
  }

  return { status: "ok", data: results };
}

/**
 * Fetch full library details for a single package from RN Directory.
 * Unknown packages return an empty object (not an error).
 *
 * @remarks
 * The endpoint keys the detail by package name -
 * `{ "react-native-webview": { githubUrl, github, npm, ... } }` - so the
 * response is unwrapped here before being handed back. An unlisted package
 * yields `{}`.
 *
 * @param packageName - The npm package name.
 * @returns The unwrapped library detail, or an empty object if not found.
 */
export async function fetchLibraryDetail(
  packageName: string,
): Promise<FetchOutcome<DirectoryLibraryDetail>> {
  const url = new URL("https://reactnative.directory/api/library");
  url.searchParams.set("name", packageName);

  const outcome = await fetchJson<Record<string, DirectoryLibraryDetail>>(url.toString());

  if (outcome.status !== "ok") {
    return outcome;
  }

  const keys = Object.keys(outcome.data);
  // Prefer the exact name; fall back to a lone entry in case the registry
  // normalizes the key (casing, etc.). Absent / empty object = not listed.
  const detail =
    outcome.data[packageName] ?? (keys.length === 1 ? outcome.data[keys[0]!] : undefined);

  if (!detail || typeof detail !== "object") {
    return { status: "ok", data: {} };
  }

  return { status: "ok", data: detail };
}

/**
 * Batch-fetch library details for multiple packages.
 * Not listed packages result in empty objects.
 * @param packageNames - List of npm package names to fetch details for.
 * @param concurrency - Maximum concurrent requests (default 8).
 * @returns A map of package name → library detail (or empty object if not found).
 */
export async function fetchLibraryDetails(
  packageNames: readonly string[],
  concurrency = 8,
): Promise<Record<string, DirectoryLibraryDetail>> {
  const outcomes = await mapWithConcurrency(
    packageNames,
    (name) => fetchLibraryDetail(name),
    concurrency,
  );

  const results: Record<string, DirectoryLibraryDetail> = {};

  packageNames.forEach((name, i) => {
    const outcome = outcomes[i];
    if (outcome?.status === "ok") {
      results[name] = outcome.data;
    }
  });

  return results;
}
