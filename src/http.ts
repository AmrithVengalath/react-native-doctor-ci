/**
 * Shared HTTP layer for all data sources.
 * @packageDocumentation
 */

import { VERSION } from "./version.js";

export interface FetchOptions {
  readonly headers?: Record<string, string>;
  readonly timeout?: number;
}

export type FetchOutcome<T> =
  | { status: "ok"; data: T }
  | { status: "not-found" }
  | { status: "rate-limited" }  // 403 or 429
  | { status: "error"; message: string };

/**
 * Fetch JSON from a URL, returning a structured outcome instead of throwing.
 * @param url - The URL to fetch.
 * @param options - Optional headers and timeout.
 * @returns A FetchOutcome indicating success, not-found, rate-limit, or error.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchOptions = {},
): Promise<FetchOutcome<T>> {
  const controller = new AbortController();
  const timeoutMs = options.timeout ?? 10000;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": `rn-doctor/${VERSION}`,
        ...options.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    if (response.status === 404) {
      return { status: "not-found" };
    }

    if (response.status === 403 || response.status === 429) {
      return { status: "rate-limited" };
    }

    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as T;
    return { status: "ok", data };
  } catch (err) {
    clearTimeout(timeoutHandle);

    if (err instanceof Error && err.name === "AbortError") {
      return { status: "error", message: "Request timeout" };
    }

    if (err instanceof SyntaxError) {
      return { status: "error", message: "Invalid JSON response" };
    }

    return {
      status: "error",
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
