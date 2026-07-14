/**
 * Core types for the enrichment engine.
 * @packageDocumentation
 */

/**
 * A value that may be known or unknown, with a reason if not.
 * Used to represent partial/failed lookups without lying about them.
 *
 * @typeParam T - The value type when known.
 */
export type Signal<T> =
  | { readonly known: true; readonly value: T; readonly source: string }
  | { readonly known: false; readonly reason: UnknownReason };

/**
 * Reasons a signal could not be resolved.
 * Distinguishes between durable (expected, won't retry) and transient (might retry).
 */
export type UnknownReason =
  | "not-in-directory"        // Normal, not a warning
  | "no-repo-url"             // No repository URL found - normal
  | "no-github-token"         // No GITHUB_TOKEN configured
  | "github-rate-limited"     // Circuit breaker tripped (API 403/429)
  | "github-error"            // Network, 5xx, or parse error from GitHub
  | "npm-not-found"           // Confirmed 404 from npm
  | "npm-lookup-failed"       // Network, 5xx, or parse error from npm
  | "npm-search-no-match";    // Search result didn't exactly match the package name

/**
 * New Architecture support tier, as determined by RN Directory and codegen hints.
 */
export type NewArchTier = "supported" | "unsupported" | "passWithNote" | "unknown";

/**
 * Reason(s) a package is classified as React Native native.
 */
export type RnNativeReason = "directory-listed" | "peer-dependency" | "native-files-hint";

/**
 * A warning about data loss or degradation during enrichment.
 * Per-dependency when narrowly scoped; run-level when absent `.dependency`.
 */
export interface EnrichmentWarning {
  readonly dependency?: string;   // Omitted for run-level warnings
  readonly source: "npm" | "directory" | "github" | "cache" | "git" | "workspaces";
  readonly message: string;       // Actionable, human-readable
}

/**
 * Enriched metadata for a single dependency, gathered from npm, RN Directory, and GitHub.
 * Carries raw signals; Phase 2's policy engine turns these into pass/warn/error verdicts.
 */
export interface EnrichedDependency {
  readonly name: string;
  readonly warnings: readonly EnrichmentWarning[];

  readonly npm: {
    readonly found: boolean;                          // false only on confirmed 404
    readonly latestVersion: string | null;
    readonly deprecated: Signal<{ readonly deprecated: boolean; readonly message: string | null }>;
    readonly hasCodegenConfig: Signal<boolean>;
    readonly hasReactNativePeerDep: Signal<boolean>;
    readonly hasNativeDirsHint: Signal<boolean>;       // Inferred from `files` listing
    readonly repositoryUrl: string | null;             // Best-effort; often absent
  };

  readonly directory: {
    readonly listed: boolean;                          // In RN Directory or not
    readonly unmaintained: boolean;                    // Only meaningful when listed
    readonly newArchitectureRaw: "new-arch-only" | "supported" | "unsupported" | "untested" | null;
    readonly githubUrl: string | null;
    readonly lastPublishedAt: string | null;           // ISO, from npm.latestReleaseDate
    readonly githubArchived: boolean | null;
    readonly githubPushedAt: string | null;            // ISO
    readonly matchingScoreModifiers: readonly string[]; // e.g. "Unmaintained", "Recently updated"
  };

  readonly github: {
    readonly archived: Signal<boolean>;
    readonly pushedAt: Signal<string>;
    readonly repoUrl: string | null;
    readonly source: "github-api" | "directory-fallback" | null;
  };

  readonly isRnNative: boolean;
  readonly rnNativeReasons: readonly RnNativeReason[];

  readonly newArch: {
    readonly tier: NewArchTier;
    readonly evidence: {
      readonly directoryVerdict: string | null;
      readonly hasCodegenConfig: boolean | null;
    };
  };

  readonly lastPublish: Signal<{ readonly date: string }>;
}

/**
 * Enrichment result: the enriched dependencies plus run-level warnings.
 */
export interface EnrichmentResult {
  readonly dependencies: readonly EnrichedDependency[];
  readonly warnings: readonly EnrichmentWarning[];
}

/**
 * Options for the enrichment run.
 */
export interface EnrichmentOptions {
  readonly noCache?: boolean;
  readonly githubToken?: string;
  readonly concurrency?: number;
  readonly cacheDir?: string;
}
