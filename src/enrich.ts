/**
 * Enrichment engine orchestrator.
 * Coordinates data gathering from npm, RN Directory, and GitHub.
 * @packageDocumentation
 */

import type {
  EnrichedDependency,
  EnrichmentOptions,
  EnrichmentResult,
  EnrichmentWarning,
  NewArchTier,
  Signal,
  UnknownReason,
} from "./types.js";
import { readCacheFile, writeCacheFile, getFreshEntry, putEntry, isEntryDegraded } from "./cache.js";
import { mapWithConcurrency } from "./concurrency.js";
import { checkLibraries, fetchLibraryDetails } from "./sources/directory.js";
import { fetchNpmLatestManifest, searchNpmForPackage, parseGithubUrl as parseGithubUrlNpm } from "./sources/npm.js";
import { fetchGithubRepo, GitHubCircuitBreaker, parseGithubUrl as parseGithubUrlGithub } from "./sources/github.js";

/**
 * Compute the RN-native detection boolean for a dependency.
 */
export function computeIsRnNative(dep: EnrichedDependency): boolean {
  return (
    dep.directory.listed ||
    (dep.npm.hasReactNativePeerDep.known && dep.npm.hasReactNativePeerDep.value) ||
    (dep.npm.hasNativeDirsHint.known && dep.npm.hasNativeDirsHint.value)
  );
}

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
  let cache = { version: 1 as const, entries: {} };

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
  const directoryCheckData: Record<string, any> = (directoryCheckOutcome.status === "ok"
    ? directoryCheckOutcome.data
    : {}) as Record<string, any>;

  if (directoryCheckOutcome.status === "error") {
    warnings.push({
      source: "directory",
      message: `Failed to check RN Directory: ${directoryCheckOutcome.message}`,
    });
  }

  // Phase 2: Fetch npm /latest for all packages needing fetch
  const npmManifests = await mapWithConcurrency(
    toFetch,
    async (name) => {
      const outcome = await fetchNpmLatestManifest(name);
      return { name, outcome };
    },
    concurrency,
  );

  const npmData: Record<string, any> = {};
  for (const { name, outcome } of npmManifests) {
    if (outcome.status === "ok") {
      (npmData as any)[name] = outcome.data;
    } else if (outcome.status === "not-found") {
      (npmData as any)[name] = { found: false };
    } else if (outcome.status === "error") {
      (npmData as any)[name] = { error: outcome.message };
    } else if (outcome.status === "rate-limited") {
      (npmData as any)[name] = { rateLimited: true };
    }
  }

  // Phase 3: Fetch RN Directory details for directory-listed packages
  const dirListed = toFetch.filter((name) => directoryCheckData[name]);
  const directoryDetails = await (dirListed.length > 0 ? fetchLibraryDetails(dirListed, concurrency) : Promise.resolve({}));

  // Phase 4: Fetch npm search for non-directory-listed packages
  const dirNotListed = toFetch.filter((name) => !directoryCheckData[name]);
  const npmSearchResults: Record<string, { name: string; date: string } | undefined> = {};

  for (const name of dirNotListed) {
    const outcome = await searchNpmForPackage(name);
    if (outcome.status === "ok" && outcome.data.name === name) {
      npmSearchResults[name] = outcome.data;
    }
  }

  // Phase 5: Resolve GitHub URLs and prepare for GitHub calls
  const githubBreaker = new GitHubCircuitBreaker();
  const githubCalls: Array<{
    name: string;
    owner: string;
    repo: string;
  }> = [];
  // Track which packages had a resolvable repo URL, so the "no repo at all" case
  // reports "no-repo-url" rather than the misleading "no-github-token".
  const packagesWithRepoUrl = new Set<string>();

  for (const name of toFetch) {
    let repoUrl: string | undefined;

    // Try directory first
    const dirDetail = (directoryDetails as any)[name];
    if (dirDetail && typeof dirDetail === "object" && "githubUrl" in dirDetail) {
      repoUrl = (dirDetail as any).githubUrl;
    }

    // Fallback to npm
    if (!repoUrl && (npmData as any)[name]?.repository?.url) {
      repoUrl = (npmData as any)[name].repository.url;
    }

    if (!repoUrl) {
      continue;
    }

    packagesWithRepoUrl.add(name);

    // Try to parse as GitHub
    let parsed = parseGithubUrlGithub(repoUrl);
    if (!parsed) {
      parsed = parseGithubUrlNpm(repoUrl);
    }

    if (parsed) {
      githubCalls.push({ name, owner: parsed.owner, repo: parsed.repo });
    }
  }

  // Phase 5b: Fetch GitHub data with circuit breaker
  const githubData: Record<string, any> = {};

  for (const { name, owner, repo } of githubCalls) {
    if (githubBreaker.isTripped()) {
      break;
    }

    const outcome = await fetchGithubRepo(owner, repo, githubToken);

    if (outcome.status === "ok") {
      githubData[name] = outcome.data;
    } else if (outcome.status === "rate-limited") {
      githubBreaker.trip();
      warnings.push({
        source: "github",
        message: "GitHub API rate-limited after checking dependencies; remaining packages fall back to cached GitHub data or unknown",
      });
      break;
    } else if (outcome.status === "error") {
      (githubData as any)[name] = { error: outcome.message };
    }
  }

  // Phase 6: Assemble enriched dependencies
  for (const name of toFetch) {
    const npm = (npmData as any)[name] || {};
    const dirCheck = (directoryCheckData as any)[name] || {};
    // `dirCheck` is `{}` for unlisted packages, and `Boolean({})` is truthy — so listing
    // must be decided by presence of the key, not the object's truthiness.
    const listedInDirectory = Object.prototype.hasOwnProperty.call(directoryCheckData, name);
    const dirDetail = (directoryDetails as any)[name] || {};
    const github = (githubData as any)[name];

    // Determine npm status
    const npmFound = npm.found !== false && !npm.rateLimited && !npm.error;
    const npmNotFound = npm.found === false;

    // Build npm signals
    const deprecated: Signal<{ deprecated: boolean; message: string | null }> = npmFound
      ? {
          known: true,
          value: {
            deprecated: Boolean(npm.deprecated),
            message: npm.deprecated ? String(npm.deprecated) : null,
          },
          source: "npm",
        }
      : { known: false, reason: npmNotFound ? "npm-not-found" : "npm-lookup-failed" };

    const hasCodegenConfig: Signal<boolean> = npmFound
      ? { known: true, value: Boolean(npm.codegenConfig), source: "npm" }
      : { known: false, reason: npmNotFound ? "npm-not-found" : "npm-lookup-failed" };

    const hasReactNativePeerDep: Signal<boolean> = npmFound
      ? {
          known: true,
          value: Boolean(npm.peerDependencies?.["react-native"]),
          source: "npm",
        }
      : { known: false, reason: npmNotFound ? "npm-not-found" : "npm-lookup-failed" };

    // Check for native dirs in files array
    const hasNativeDirsHint: Signal<boolean> = npmFound
      ? {
          known: true,
          value: Boolean(
            npm.files && Array.isArray(npm.files) && npm.files.some((f: string) => /^(android|ios)(\/.*)?$/.test(f)),
          ),
          source: "npm",
        }
      : { known: false, reason: npmNotFound ? "npm-not-found" : "npm-lookup-failed" };

    // GitHub signals with fallback to directory
    let archivedSignal: Signal<boolean>;
    let pushedAtSignal: Signal<string>;
    let githubSource: "github-api" | "directory-fallback" | null = null;

    if (github && !github.error) {
      archivedSignal = { known: true, value: github.archived === true, source: "github-api" };
      if (github.pushed_at) {
        pushedAtSignal = { known: true, value: github.pushed_at, source: "github-api" };
      } else {
        pushedAtSignal = { known: false, reason: "github-error" };
      }
      githubSource = "github-api";
    } else if (dirDetail && typeof dirDetail === "object" && "github" in dirDetail) {
      const dir = dirDetail as any;
      if (dir.github?.isArchived !== undefined) {
        archivedSignal = { known: true, value: dir.github.isArchived, source: "directory-fallback" };
        if (dir.github.stats?.pushedAt) {
          pushedAtSignal = { known: true, value: dir.github.stats.pushedAt, source: "directory-fallback" };
        } else {
          pushedAtSignal = { known: false, reason: "github-error" };
        }
        githubSource = "directory-fallback";
      } else {
        archivedSignal = { known: false, reason: githubBreaker.isTripped() ? "github-rate-limited" : "no-github-token" };
        pushedAtSignal = { known: false, reason: githubBreaker.isTripped() ? "github-rate-limited" : "no-github-token" };
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

    // Resolve github URL
    let githubUrl: string | null = null;
    if (dirDetail && typeof dirDetail === "object" && "githubUrl" in dirDetail) {
      githubUrl = (dirDetail as any).githubUrl || null;
    } else if (npm.repository?.url) {
      const parsed = parseGithubUrlNpm(npm.repository.url) || parseGithubUrlGithub(npm.repository.url);
      if (parsed) {
        githubUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
      }
    }

    // Last publish signal
    let lastPublish: Signal<{ date: string }>;

    if (dirDetail && typeof dirDetail === "object" && "npm" in dirDetail) {
      const dir = dirDetail as any;
      if (dir.npm?.latestReleaseDate) {
        lastPublish = { known: true, value: { date: dir.npm.latestReleaseDate }, source: "directory" };
      } else if (npmSearchResults[name]?.date) {
        lastPublish = { known: true, value: { date: npmSearchResults[name].date }, source: "npm-search" };
      } else {
        lastPublish = { known: false, reason: "not-in-directory" };
      }
    } else if (npmSearchResults[name]?.date) {
      lastPublish = { known: true, value: { date: npmSearchResults[name].date }, source: "npm-search" };
    } else {
      lastPublish = { known: false, reason: "not-in-directory" };
    }

    // Build rnNativeReasons
    const rnNativeReasons: ("directory-listed" | "peer-dependency" | "native-files-hint")[] = [];
    if (listedInDirectory) {
      rnNativeReasons.push("directory-listed");
    }
    if (hasReactNativePeerDep.known && hasReactNativePeerDep.value) {
      rnNativeReasons.push("peer-dependency");
    }
    if (hasNativeDirsHint.known && hasNativeDirsHint.value) {
      rnNativeReasons.push("native-files-hint");
    }

    const isRnNative = listedInDirectory || (hasReactNativePeerDep.known && hasReactNativePeerDep.value) ||
      (hasNativeDirsHint.known && hasNativeDirsHint.value);

    // Compute newArch tier
    const newArchTier = computeNewArchTier({
      directoryVerdict: (dirCheck.newArchitecture as any) || null,
      hasCodegenConfig,
    });

    // Build warnings
    const depWarnings: EnrichmentWarning[] = [];
    if (npmNotFound) {
      depWarnings.push({
        source: "npm",
        dependency: name,
        message: `Package not found on npm registry — verify the package name is correct`,
      });
    }
    if (npm.error) {
      depWarnings.push({
        source: "npm",
        dependency: name,
        message: `Failed to fetch npm data: ${npm.error}`,
      });
    }
    if (github?.error) {
      depWarnings.push({
        source: "github",
        dependency: name,
        message: `Failed to fetch GitHub data: ${github.error}`,
      });
    }

    const enrichedDep: EnrichedDependency = {
      name,
      warnings: depWarnings,
      npm: {
        found: npmFound && !npmNotFound,
        latestVersion: npmFound ? npm.version : null,
        deprecated,
        hasCodegenConfig,
        hasReactNativePeerDep,
        hasNativeDirsHint,
        repositoryUrl: npm.repository?.url ? String(npm.repository.url).replace(/^git\+/, "") : null,
      },
      directory: {
        listed: listedInDirectory,
        unmaintained: Boolean(dirCheck.unmaintained),
        newArchitectureRaw: (dirCheck.newArchitecture as any) || null,
        // Directory-sourced URL only; the npm-derived fallback belongs to `github.repoUrl`.
        githubUrl: dirDetail && typeof dirDetail === "object" ? (dirDetail as any).githubUrl || null : null,
        lastPublishedAt:
          (dirDetail && typeof dirDetail === "object" && (dirDetail as any).npm?.latestReleaseDate) || null,
        // `?? null` (not `|| null`) so a genuine `false` (repo not archived) survives.
        githubArchived:
          dirDetail && typeof dirDetail === "object" && typeof (dirDetail as any).github?.isArchived === "boolean"
            ? (dirDetail as any).github.isArchived
            : null,
        githubPushedAt:
          (dirDetail && typeof dirDetail === "object" && (dirDetail as any).github?.stats?.pushedAt) || null,
        matchingScoreModifiers:
          (dirDetail && typeof dirDetail === "object" && (dirDetail as any).matchingScoreModifiers) || [],
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
          directoryVerdict: (dirCheck.newArchitecture as any) || null,
          hasCodegenConfig: hasCodegenConfig.known ? hasCodegenConfig.value : null,
        },
      },
      lastPublish,
    };

    enriched.push(enrichedDep);

    // Write to cache — but never persist a degraded (transient-failure) entry, so a
    // momentary rate-limit or network blip can't poison future runs with stale unknowns.
    if (!options.noCache) {
      const candidate = { fetchedAt: new Date().toISOString(), enriched: enrichedDep };
      if (!isEntryDegraded(candidate)) {
        cache = putEntry(cache, candidate);
      }
    }
  }

  // Write cache back to disk
  if (!options.noCache && toFetch.length > 0) {
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
