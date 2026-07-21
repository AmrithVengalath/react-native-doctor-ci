/**
 * Enrichment engine orchestrator.
 * Coordinates data gathering from npm, RN Directory, and GitHub.
 *
 * External responses are narrowed into typed records at the source boundary
 * (`sources/*`), so this orchestrator works with typed data throughout - the
 * layer that judges other packages' health carries no `any` of its own.
 *
 * @packageDocumentation
 */

import type {
  EnrichedDependency,
  EnrichmentOptions,
  EnrichmentResult,
  EnrichmentWarning,
  NewArchTier,
  RnNativeReason,
  Signal,
  UnknownReason,
} from "./types.js";
import { readCacheFile, writeCacheFile, getFreshEntry, putEntry, isEntryDegraded } from "./cache.js";
import type { CacheFile } from "./cache.js";
import { mapWithConcurrency } from "./concurrency.js";
import { checkLibraries, fetchLibraryDetails } from "./sources/directory.js";
import type { DirectoryCheckEntry, DirectoryLibraryDetail } from "./sources/directory.js";
import { fetchNpmLatestManifest, searchNpmForPackage } from "./sources/npm.js";
import type { NpmVersionManifest } from "./sources/npm.js";
import { fetchGithubRepo, GitHubCircuitBreaker, parseGithubUrl } from "./sources/github.js";
import type { GithubRepoInfo } from "./sources/github.js";

/** Per-package outcome of the npm `/latest` fetch. */
type NpmState =
  | { readonly kind: "ok"; readonly manifest: NpmVersionManifest }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "rate-limited" };

/** Matches `android`, `ios`, or a path under either (npm `files` heuristic). */
const NATIVE_DIR_PATTERN = /^(android|ios)(\/.*)?$/;

/**
 * Compute the New Architecture tier for a dependency.
 */
export function computeNewArchTier(dep: {
  directoryVerdict: string | null;
  hasCodegenConfig: { known: boolean; value?: boolean };
}): NewArchTier {
  const { directoryVerdict, hasCodegenConfig } = dep;

  if (directoryVerdict === "supported" || directoryVerdict === "new-arch-only") {
    return "supported";
  }

  if (directoryVerdict === "unsupported") {
    return "unsupported";
  }

  // untested or null (not in directory) + has codegenConfig → pass with note
  if (hasCodegenConfig.known && hasCodegenConfig.value) {
    return "passWithNote";
  }

  return "unknown";
}

/**
 * Enrich multiple dependencies from npm, RN Directory, and GitHub.
 */
export async function enrichDependencies(
  names: readonly string[],
  options: EnrichmentOptions = {},
): Promise<EnrichmentResult> {
  const cacheDir = options.cacheDir || process.cwd();
  const concurrency = options.concurrency ?? 8;
  const githubToken = options.githubToken || process.env.GITHUB_TOKEN;

  const warnings: EnrichmentWarning[] = [];
  const enriched: EnrichedDependency[] = [];

  // Phase 0: Load and split cache
  let cache: CacheFile = { version: 1, entries: {} };

  if (!options.noCache) {
    try {
      cache = await readCacheFile(cacheDir);
    } catch {
      warnings.push({
        source: "cache",
        message: "Failed to read cache file; proceeding without cache",
      });
    }
  }

  const cached: EnrichedDependency[] = [];
  const toFetch: string[] = [];

  for (const name of names) {
    const entry = options.noCache ? undefined : getFreshEntry(cache, name);
    if (entry) {
      cached.push(entry.enriched);
    } else {
      toFetch.push(name);
    }
  }

  // Add cached results immediately
  enriched.push(...cached);

  if (toFetch.length === 0) {
    return { dependencies: enriched, warnings };
  }

  // Phase 1: Batch directory check
  const directoryCheckOutcome = await checkLibraries(toFetch);
  const directoryCheckData: Record<string, DirectoryCheckEntry> =
    directoryCheckOutcome.status === "ok" ? directoryCheckOutcome.data : {};

  if (directoryCheckOutcome.status === "error") {
    warnings.push({
      source: "directory",
      message: `Failed to check RN Directory: ${directoryCheckOutcome.message}`,
    });
  }

  // Phase 2: Fetch npm /latest for all packages needing fetch (bounded parallel)
  const npmManifests = await mapWithConcurrency(
    toFetch,
    async (name) => ({ name, outcome: await fetchNpmLatestManifest(name) }),
    concurrency,
  );

  const npmData = new Map<string, NpmState>();
  for (const { name, outcome } of npmManifests) {
    if (outcome.status === "ok") {
      npmData.set(name, { kind: "ok", manifest: outcome.data });
    } else if (outcome.status === "not-found") {
      npmData.set(name, { kind: "not-found" });
    } else if (outcome.status === "error") {
      npmData.set(name, { kind: "error", message: outcome.message });
    } else {
      npmData.set(name, { kind: "rate-limited" });
    }
  }

  // Phase 3: Fetch RN Directory details for directory-listed packages
  const listedInDirectory = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(directoryCheckData, name);
  const dirListed = toFetch.filter(listedInDirectory);
  const directoryDetails: Record<string, DirectoryLibraryDetail> =
    dirListed.length > 0 ? await fetchLibraryDetails(dirListed, concurrency) : {};

  // Phase 4: Fetch npm search for non-directory-listed packages (bounded parallel).
  // The /latest manifest carries no publish date, so search is the only source
  // of a last-publish date for packages the directory does not know about.
  const dirNotListed = toFetch.filter((name) => !listedInDirectory(name));
  const npmSearchResults = new Map<string, string>();
  const searchOutcomes = await mapWithConcurrency(
    dirNotListed,
    async (name) => ({ name, outcome: await searchNpmForPackage(name) }),
    concurrency,
  );
  for (const { name, outcome } of searchOutcomes) {
    // Search is fuzzy; only trust an exact name match.
    if (outcome.status === "ok" && outcome.data.name === name) {
      npmSearchResults.set(name, outcome.data.date);
    }
  }

  // Phase 5: Resolve GitHub owner/repo for every package with a repo URL.
  const githubCalls: Array<{ name: string; owner: string; repo: string }> = [];
  // Track which packages had a resolvable repo URL, so the "no repo at all" case
  // reports "no-repo-url" rather than the misleading "no-github-token".
  const packagesWithRepoUrl = new Set<string>();

  for (const name of toFetch) {
    const npmState = npmData.get(name);
    const repoFromNpm =
      npmState?.kind === "ok" ? npmState.manifest.repository?.url : undefined;
    const repoUrl = directoryDetails[name]?.githubUrl ?? repoFromNpm;
    if (!repoUrl) continue;

    packagesWithRepoUrl.add(name);
    const parsed = parseGithubUrl(repoUrl);
    if (parsed) {
      githubCalls.push({ name, owner: parsed.owner, repo: parsed.repo });
    }
  }

  // Phase 5b: Fetch GitHub data in bounded windows. Once the API rate-limits,
  // trip the breaker and stop launching further windows - remaining packages
  // fall back to the RN Directory snapshot or degrade to `unknown`.
  const githubBreaker = new GitHubCircuitBreaker();
  const githubData = new Map<string, GithubRepoInfo>();
  const githubErrors = new Map<string, string>();

  for (let i = 0; i < githubCalls.length && !githubBreaker.isTripped(); i += concurrency) {
    const window = githubCalls.slice(i, i + concurrency);
    const outcomes = await mapWithConcurrency(
      window,
      async (call) => ({ call, outcome: await fetchGithubRepo(call.owner, call.repo, githubToken) }),
      concurrency,
    );

    let rateLimited = false;
    for (const { call, outcome } of outcomes) {
      if (outcome.status === "ok") {
        githubData.set(call.name, outcome.data);
      } else if (outcome.status === "rate-limited") {
        rateLimited = true;
      } else if (outcome.status === "error") {
        githubErrors.set(call.name, outcome.message);
      }
      // "not-found" (404): leave absent → directory fallback / unknown.
    }

    if (rateLimited) {
      githubBreaker.trip();
      warnings.push({
        source: "github",
        message:
          "GitHub API rate-limited after checking dependencies; remaining packages fall back to cached GitHub data or unknown",
      });
    }
  }

  // Phase 6: Assemble enriched dependencies
  for (const name of toFetch) {
    const npmState = npmData.get(name);
    const manifest = npmState?.kind === "ok" ? npmState.manifest : null;
    const npmFound = manifest !== null;
    const npmNotFound = npmState?.kind === "not-found";
    const npmError = npmState?.kind === "error" ? npmState.message : null;
    const npmUnknownReason: UnknownReason = npmNotFound ? "npm-not-found" : "npm-lookup-failed";

    const dirCheck: DirectoryCheckEntry = directoryCheckData[name] ?? {};
    const listed = listedInDirectory(name);
    const dirDetail = directoryDetails[name];
    const github = githubData.get(name);
    const githubError = githubErrors.get(name);
    const npmRepoUrl = manifest?.repository?.url ?? null;

    // Build npm signals
    const deprecatedMessage = manifest?.deprecated ?? null;
    const deprecated: Signal<{ deprecated: boolean; message: string | null }> = npmFound
      ? {
          known: true,
          value: { deprecated: Boolean(deprecatedMessage), message: deprecatedMessage || null },
          source: "npm",
        }
      : { known: false, reason: npmUnknownReason };

    const hasCodegenConfig: Signal<boolean> = npmFound
      ? { known: true, value: Boolean(manifest?.codegenConfig), source: "npm" }
      : { known: false, reason: npmUnknownReason };

    const hasReactNativePeerDep: Signal<boolean> = npmFound
      ? {
          known: true,
          value: Boolean(manifest?.peerDependencies?.["react-native"]),
          source: "npm",
        }
      : { known: false, reason: npmUnknownReason };

    const hasNativeDirsHint: Signal<boolean> = npmFound
      ? {
          known: true,
          value: Boolean(manifest?.files?.some((f) => NATIVE_DIR_PATTERN.test(f))),
          source: "npm",
        }
      : { known: false, reason: npmUnknownReason };

    // GitHub signals, with fallback to the RN Directory snapshot.
    let archivedSignal: Signal<boolean>;
    let pushedAtSignal: Signal<string>;
    let githubSource: "github-api" | "directory-fallback" | null = null;

    if (github) {
      archivedSignal = { known: true, value: github.archived === true, source: "github-api" };
      pushedAtSignal = github.pushed_at
        ? { known: true, value: github.pushed_at, source: "github-api" }
        : { known: false, reason: "github-error" };
      githubSource = "github-api";
    } else if (dirDetail?.github !== undefined) {
      const dirGithub = dirDetail.github;
      if (dirGithub.isArchived !== undefined) {
        archivedSignal = { known: true, value: dirGithub.isArchived, source: "directory-fallback" };
        const dirPushedAt = dirGithub.stats?.pushedAt ?? null;
        pushedAtSignal = dirPushedAt
          ? { known: true, value: dirPushedAt, source: "directory-fallback" }
          : { known: false, reason: "github-error" };
        githubSource = "directory-fallback";
      } else {
        const reason: UnknownReason = githubBreaker.isTripped()
          ? "github-rate-limited"
          : "no-github-token";
        archivedSignal = { known: false, reason };
        pushedAtSignal = { known: false, reason };
      }
    } else {
      const noGithubReason: UnknownReason = githubBreaker.isTripped()
        ? "github-rate-limited"
        : packagesWithRepoUrl.has(name)
          ? "no-github-token"
          : "no-repo-url";
      archivedSignal = { known: false, reason: noGithubReason };
      pushedAtSignal = { known: false, reason: noGithubReason };
    }

    // Resolve a GitHub URL for evidence: directory first, then npm repository.
    let githubUrl: string | null = dirDetail?.githubUrl ?? null;
    if (githubUrl === null && npmRepoUrl) {
      const parsed = parseGithubUrl(npmRepoUrl);
      if (parsed) githubUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
    }

    // Last-publish date: directory record, then npm search; otherwise honestly
    // distinguish "listed but no recorded date" from "not in the directory".
    const directoryDate = dirDetail?.npm?.latestReleaseDate ?? null;
    const searchDate = npmSearchResults.get(name) ?? null;
    let lastPublish: Signal<{ date: string }>;
    if (directoryDate) {
      lastPublish = { known: true, value: { date: directoryDate }, source: "directory" };
    } else if (searchDate) {
      lastPublish = { known: true, value: { date: searchDate }, source: "npm-search" };
    } else {
      lastPublish = { known: false, reason: listed ? "no-release-date" : "not-in-directory" };
    }

    // RN-native detection reasons
    const rnNativeReasons: RnNativeReason[] = [];
    if (listed) rnNativeReasons.push("directory-listed");
    if (hasReactNativePeerDep.known && hasReactNativePeerDep.value) {
      rnNativeReasons.push("peer-dependency");
    }
    if (hasNativeDirsHint.known && hasNativeDirsHint.value) {
      rnNativeReasons.push("native-files-hint");
    }
    const isRnNative = rnNativeReasons.length > 0;

    const newArchTier = computeNewArchTier({
      directoryVerdict: dirCheck.newArchitecture ?? null,
      hasCodegenConfig,
    });

    // Per-dependency warnings (data loss, not policy verdicts)
    const depWarnings: EnrichmentWarning[] = [];
    if (npmNotFound) {
      depWarnings.push({
        source: "npm",
        dependency: name,
        message: `Package not found on npm registry - verify the package name is correct`,
      });
    }
    if (npmError) {
      depWarnings.push({
        source: "npm",
        dependency: name,
        message: `Failed to fetch npm data: ${npmError}`,
      });
    }
    if (githubError) {
      depWarnings.push({
        source: "github",
        dependency: name,
        message: `Failed to fetch GitHub data: ${githubError}`,
      });
    }

    const enrichedDep: EnrichedDependency = {
      name,
      warnings: depWarnings,
      npm: {
        found: npmFound,
        latestVersion: manifest?.version ?? null,
        deprecated,
        hasCodegenConfig,
        hasReactNativePeerDep,
        hasNativeDirsHint,
        repositoryUrl: npmRepoUrl ? npmRepoUrl.replace(/^git\+/, "") : null,
      },
      directory: {
        listed,
        unmaintained: Boolean(dirCheck.unmaintained),
        newArchitectureRaw: dirCheck.newArchitecture ?? null,
        // Directory-sourced URL only; the npm-derived fallback belongs to `github.repoUrl`.
        githubUrl: dirDetail?.githubUrl ?? null,
        lastPublishedAt: dirDetail?.npm?.latestReleaseDate ?? null,
        // Explicit boolean check so a genuine `false` (repo not archived) survives.
        githubArchived:
          typeof dirDetail?.github?.isArchived === "boolean" ? dirDetail.github.isArchived : null,
        githubPushedAt: dirDetail?.github?.stats?.pushedAt ?? null,
        matchingScoreModifiers: dirDetail?.matchingScoreModifiers ?? [],
      },
      github: {
        archived: archivedSignal,
        pushedAt: pushedAtSignal,
        repoUrl: githubUrl,
        source: githubSource,
      },
      isRnNative,
      rnNativeReasons,
      newArch: {
        tier: newArchTier,
        evidence: {
          directoryVerdict: dirCheck.newArchitecture ?? null,
          hasCodegenConfig: hasCodegenConfig.known ? hasCodegenConfig.value : null,
        },
      },
      lastPublish,
    };

    enriched.push(enrichedDep);

    // Write to cache - but never persist a degraded (transient-failure) entry, so a
    // momentary rate-limit or network blip can't poison future runs with stale unknowns.
    if (!options.noCache) {
      const candidate = { fetchedAt: new Date().toISOString(), enriched: enrichedDep };
      if (!isEntryDegraded(candidate)) {
        cache = putEntry(cache, candidate);
      }
    }
  }

  // Write cache back to disk
  if (!options.noCache) {
    try {
      await writeCacheFile(cacheDir, cache);
    } catch {
      warnings.push({
        source: "cache",
        message: "Failed to write cache file",
      });
    }
  }

  return { dependencies: enriched, warnings };
}
