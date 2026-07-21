/**
 * GitHub API data source with rate-limit circuit breaker, plus the single
 * GitHub-URL parser used across the enrichment engine.
 * @packageDocumentation
 */

import { fetchJson, isRecord, type FetchOutcome } from "../http.js";

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
 * Narrow an unknown GitHub API payload to the repository fields the engine
 * reads. Malformed fields are dropped (treated as absent) rather than thrown -
 * missing data degrades to `unknown` downstream, never a failed run.
 * @param data - The JSON-parsed response body.
 */
export function parseGithubRepo(data: unknown): GithubRepoInfo {
  if (!isRecord(data)) return {};
  return {
    ...(typeof data["archived"] === "boolean" ? { archived: data["archived"] } : {}),
    ...(typeof data["pushed_at"] === "string" ? { pushed_at: data["pushed_at"] } : {}),
  };
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

  const outcome = await fetchJson<unknown>(url, { headers });
  if (outcome.status !== "ok") return outcome;
  return { status: "ok", data: parseGithubRepo(outcome.data) };
}

// Owner and repo allow word chars, dots, and hyphens (repo non-greedy so a
// trailing `.git` is stripped but a dotted name like `next.js` survives).
// The leading boundary keeps `notgithub.com` from false-matching; a trailing
// `/...`, `?...`, or `#...` (deep links like /tree/main) is ignored.
const GITHUB_URL_PATTERN =
  /(?:^|[/@\s])github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;

/**
 * Parse any GitHub repository URL form to its owner and repo.
 *
 * @remarks
 * Accepts the shapes that occur in npm `repository` metadata and RN Directory
 * records: `git+https://github.com/owner/repo.git`, plain https URLs (with or
 * without `.git` or a `/tree/...` suffix), bare `github.com/owner/repo`, and
 * ssh `git@github.com:owner/repo.git`. Non-GitHub URLs return `undefined`.
 *
 * @param url - A repository URL, or `undefined`.
 * @returns `{ owner, repo }` if parseable as GitHub, or `undefined` otherwise.
 */
export function parseGithubUrl(
  url: string | undefined,
): { readonly owner: string; readonly repo: string } | undefined {
  if (!url) {
    return undefined;
  }

  const match = url.match(GITHUB_URL_PATTERN);
  if (!match || !match[1] || !match[2]) {
    return undefined;
  }

  return { owner: match[1], repo: match[2] };
}
