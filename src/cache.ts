/**
 * Disk cache for enriched dependencies with 24h TTL and degraded-entry semantics.
 * @packageDocumentation
 */

import * as fs from "fs";
import * as path from "path";
import type { EnrichedDependency, Signal, UnknownReason } from "./types.js";

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
  // Only *transient* unknowns (a blip, a rate-limit) make an entry degraded. Durable
  // unknowns (no repo URL, not in the directory, a real 404) are the true answer and
  // are safe to cache - re-fetching wouldn't change them.
  const transientReasons = new Set<UnknownReason>([
    "github-rate-limited",
    "github-error",
    "npm-lookup-failed",
  ]);

  const dep = entry.enriched;
  const signals: Signal<unknown>[] = [
    dep.npm.deprecated,
    dep.npm.hasCodegenConfig,
    dep.npm.hasReactNativePeerDep,
    dep.npm.hasNativeDirsHint,
    dep.github.archived,
    dep.github.pushedAt,
    dep.lastPublish,
  ];

  return signals.some((s) => !s.known && transientReasons.has(s.reason));
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
    // Missing file or parse error - return empty cache, never throw
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

  const age = now.getTime() - new Date(entry.fetchedAt).getTime();

  // Expired, or degraded by a transient failure → treat as a miss and re-fetch.
  if (age >= TTL_MS || isDegraded(entry)) {
    return undefined;
  }

  return entry;
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
