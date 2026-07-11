import { describe, expect, it } from "vitest";

import { getFreshEntry, isEntryDegraded, putEntry, type CacheEntry, type CacheFile } from "./cache.js";
import type { EnrichedDependency } from "./types.js";
import { ENRICHED_FIXTURES, FIXTURE_PACKAGE_NAMES } from "./testing/fixture-packages.js";

const healthyDep = ENRICHED_FIXTURES[FIXTURE_PACKAGE_NAMES.healthy]!;
// `left-pad`: its GitHub signals are unknown for the durable reason "no-repo-url".
const durableUnknownDep = ENRICHED_FIXTURES[FIXTURE_PACKAGE_NAMES.unknownBare]!;

// A transient failure: same package, but GitHub was rate-limited this run.
const degradedDep: EnrichedDependency = {
  ...healthyDep,
  github: {
    ...healthyDep.github,
    archived: { known: false, reason: "github-rate-limited" },
  },
};

const HOUR = 60 * 60 * 1000;

function entry(dep: EnrichedDependency, ageMs: number): CacheEntry {
  return { fetchedAt: new Date(Date.now() - ageMs).toISOString(), enriched: dep };
}

const cacheOf = (e: CacheEntry): CacheFile => putEntry({ version: 1, entries: {} }, e);

describe("isEntryDegraded", () => {
  it("is false when every signal is known", () => {
    expect(isEntryDegraded(entry(healthyDep, 0))).toBe(false);
  });

  it("is false for durable unknowns (no-repo-url is the real, cacheable answer)", () => {
    expect(isEntryDegraded(entry(durableUnknownDep, 0))).toBe(false);
  });

  it("is true when a transient unknown (rate-limit) is present", () => {
    expect(isEntryDegraded(entry(degradedDep, 0))).toBe(true);
  });
});

describe("getFreshEntry", () => {
  it("returns a fresh, non-degraded entry", () => {
    const e = entry(healthyDep, 1 * HOUR);
    expect(getFreshEntry(cacheOf(e), healthyDep.name)).toEqual(e);
  });

  it("misses when the entry is older than the 24h TTL", () => {
    const e = entry(healthyDep, 25 * HOUR);
    expect(getFreshEntry(cacheOf(e), healthyDep.name)).toBeUndefined();
  });

  it("misses a fresh but degraded entry, so a blip can't poison the cache", () => {
    const e = entry(degradedDep, 1 * HOUR);
    expect(getFreshEntry(cacheOf(e), degradedDep.name)).toBeUndefined();
  });

  it("misses for an unknown package", () => {
    expect(getFreshEntry({ version: 1, entries: {} }, "not-cached")).toBeUndefined();
  });
});
