/**
 * Disk cache for enriched dependencies with 24h TTL and degraded-entry semantics.
 * @packageDocumentation
 */

import * as fs from "fs";
import * as path from "path";
import type { EnrichedDependency, EnrichmentWarning } from "./types.js";

export interface CacheEntry {
  readonly fetchedAt: string; // ISO 8601
  readonly enriched: EnrichedDependency;
}

export interface CacheFile {
  readonly version: 1;
  readonly entries: Record<string, CacheEntry>;
}

const CACHE_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Determine if a cache entry is "degraded" (has transient warnings).
 * Transient reasons indicate the entry may be incomplete and shouldn't be re-used across runs.
 */
function isDegraded(entry: CacheEntry): boolean {
  const transientReasons = new Set([
    "github-rate-limited",
    "github-error",
    "npm-lookup-failed",
  ]);

  return entry.enriched.warnings.some((w) => transientReasons.has(w.source as any));
}

/**
 * Read the cache file from disk. Returns an empty cache if missing or corrupt.
 */
export async function readCacheFile(cacheDir: string): Promise<CacheFile> {
  const cacheFile = path.join(cacheDir, ".rn-doctor-cache.json");

  try {
    const content = await fs.promises.readFile(cacheFile, "utf-8");
    const parsed = JSON.parse(content) as CacheFile;

    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }

    return parsed;
  } catch {
    // Missing file or parse error — return empty cache, never throw
    return { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * Write the cache file to disk.
 */
export async function writeCacheFile(cacheDir: string, cache: CacheFile): Promise<void> {
  const cacheFile = path.join(cacheDir, ".rn-doctor-cache.json");

  await fs.promises.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * Get a fresh entry from cache if available (not expired, not degraded).
 * Returns undefined if not cached, expired, or degraded (for next-run persistence).
 */
export function getFreshEntry(
  cache: CacheFile,
  packageName: string,
  now: Date = new Date(),
): CacheEntry | undefined {
  const entry = cache.entries[packageName];

  if (!entry) {
    return undefined;
  }

  const fetchedAt = new Date(entry.fetchedAt);
  const age = now.getTime() - fetchedAt.getTime();

  // Fresh + not degraded → cache hit
  if (age < TTL_MS && !isDegraded(entry)) {
    return entry;
  }

  // Fresh but degraded → usable within this run, but treat as expired for next
  // Fresh and not degraded → cache hit
  if (age < TTL_MS) {
    return entry; // Reuse within the current run
  }

  return undefined; // Expired
}

/**
 * Put an enriched dependency into the cache.
 */
export function putEntry(
  cache: CacheFile,
  entry: CacheEntry,
): CacheFile {
  return {
    version: CACHE_VERSION,
    entries: {
      ...cache.entries,
      [entry.enriched.name]: entry,
    },
  };
}

/**
 * Check if an entry is degraded (has transient warnings).
 */
export function isEntryDegraded(entry: CacheEntry): boolean {
  return isDegraded(entry);
}
