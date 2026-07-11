/**
 * GitHub API data source with rate-limit circuit breaker.
 * @packageDocumentation
 */

import { fetchJson, type FetchOutcome } from "../http.js";

/**
 * Repository metadata from GitHub API.
 */
export interface GithubRepoInfo {
  readonly archived?: boolean;
  readonly pushed_at?: string;
}

/**
 * Circuit breaker state for GitHub API rate limiting.
 */
export class GitHubCircuitBreaker {
  private tripped = false;

  /**
   * Check if the circuit breaker is currently tripped.
   */
  isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Trip the circuit breaker (call this on a 403/429 response).
   */
  trip(): void {
    this.tripped = true;
  }
}

/**
 * Fetch repository metadata from GitHub API.
 * @param owner - Repository owner (e.g. "facebook").
 * @param repo - Repository name (e.g. "react-native").
 * @param token - Optional GitHub API token for higher rate limits.
 * @returns Repository info or an outcome describing what went wrong.
 */
export async function fetchGithubRepo(
  owner: string,
  repo: string,
  token?: string,
): Promise<FetchOutcome<GithubRepoInfo>> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const headers: Record<string, string> = {};
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }

  return fetchJson<GithubRepoInfo>(url, { headers });
}

/**
 * Parse a GitHub repository URL to extract owner and repo.
 * @param url - A GitHub URL like `https://github.com/owner/repo` or `git@github.com:owner/repo.git`.
 * @returns `{ owner, repo }` if parseable as GitHub, or `undefined` otherwise.
 */
export function parseGithubUrl(
  url: string | undefined,
): { readonly owner: string; readonly repo: string } | undefined {
  if (!url) {
    return undefined;
  }

  // Match patterns:
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  // https://github.com/owner/repo/tree/...
  // git@github.com:owner/repo.git
  const match = url.match(
    /(?:https:\/\/github\.com|git@github\.com:)\/?([^/]+)\/([^/.]+)(?:\.git|\/|$)/i,
  );

  if (!match || !match[1] || !match[2]) {
    return undefined;
  }

  return { owner: match[1], repo: match[2] };
}
