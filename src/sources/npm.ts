/**
 * npm registry data source.
 * @packageDocumentation
 */

import { fetchJson, type FetchOutcome } from "../http.js";

/**
 * Version object from npm registry `/latest` endpoint.
 */
export interface NpmVersionManifest {
  readonly name: string;
  readonly version: string;
  readonly deprecated?: string;
  readonly codegenConfig?: unknown;
  readonly peerDependencies?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly files?: string[];
}

/**
 * Search result from npm search API.
 */
export interface NpmSearchResult {
  readonly objects?: Array<{
    readonly package: {
      readonly name: string;
      readonly version: string;
      readonly date: string;
    };
  }>;
}

/**
 * Fetch the latest version manifest from npm registry.
 * @param packageName - The npm package name (may be scoped, e.g. `@react-native-community/netinfo`).
 * @returns The version manifest or an outcome describing what went wrong.
 */
export async function fetchNpmLatestManifest(
  packageName: string,
): Promise<FetchOutcome<NpmVersionManifest>> {
  const encoded = encodeURIComponent(packageName);
  const url = `https://registry.npmjs.org/${encoded}/latest`;

  return fetchJson<NpmVersionManifest>(url);
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

  const outcome = await fetchJson<NpmSearchResult>(url.toString());

  if (outcome.status !== "ok") {
    return outcome;
  }

  const topResult = outcome.data.objects?.[0];
  if (!topResult) {
    return { status: "error", message: "No search results" };
  }

  return {
    status: "ok",
    data: {
      name: topResult.package.name,
      date: topResult.package.date,
    },
  };
}

/**
 * Parse a repository URL to extract owner and repo for GitHub (if applicable).
 * @param repoUrl - A repository URL, e.g. `git+https://github.com/owner/repo.git`.
 * @returns `{ owner, repo }` if it's a GitHub URL, or `undefined` otherwise.
 */
export function parseGithubUrl(
  repoUrl: string | undefined,
): { readonly owner: string; readonly repo: string } | undefined {
  if (!repoUrl) {
    return undefined;
  }

  // Match patterns like:
  // git+https://github.com/owner/repo.git
  // https://github.com/owner/repo.git
  // github.com/owner/repo
  const match = repoUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (!match || !match[1] || !match[2]) {
    return undefined;
  }

  return { owner: match[1], repo: match[2] };
}
