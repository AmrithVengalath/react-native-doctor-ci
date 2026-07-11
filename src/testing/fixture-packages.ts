/**
 * Test fixtures for the 8-package acceptance matrix.
 * Used by Phase 1 tests and reused by Phase 2/3 tests.
 * @packageDocumentation
 */

import type { EnrichedDependency } from "../types.js";

/**
 * Mapping of fixture category to npm package name.
 */
export const FIXTURE_PACKAGE_NAMES = {
  healthy: "react-native-webview",
  deprecated: "request",
  archived: "react-native-htmltext",
  stale24mo: "react-native-markdown",
  directoryUnmaintained: "react-native-ab",
  newArchUnsupported: "react-native-legacy-bridge",
  unknownWithCodegen: "my-rn-codegen-package",
  unknownBare: "left-pad",
} as const;

/**
 * Hand-authored enriched dependency fixtures for all 8 categories + rate-limit scenario.
 * The orchestrator's output should deep-equal these.
 */
export const ENRICHED_FIXTURES: Record<string, EnrichedDependency> = {
  [FIXTURE_PACKAGE_NAMES.healthy]: {
    name: "react-native-webview",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "14.0.1",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/react-native-webview/react-native-webview.git",
    },
    directory: {
      listed: true,
      unmaintained: false,
      newArchitectureRaw: "supported",
      githubUrl: "https://github.com/react-native-webview/react-native-webview",
      lastPublishedAt: "2026-06-20T23:27:50.592Z",
      githubArchived: false,
      githubPushedAt: "2026-07-11T10:19:37Z",
      matchingScoreModifiers: [
        "Very popular",
        "Popular",
        "Known",
        "Recently updated",
        "Has a README file",
        "Has a description",
      ],
    },
    github: {
      archived: { known: true, value: false, source: "github-api" },
      pushedAt: { known: true, value: "2026-07-11T10:19:37Z", source: "github-api" },
      repoUrl: "https://github.com/react-native-webview/react-native-webview",
      source: "github-api",
    },
    isRnNative: true,
    rnNativeReasons: ["directory-listed", "peer-dependency"],
    newArch: {
      tier: "supported",
      evidence: { directoryVerdict: "supported", hasCodegenConfig: false },
    },
    lastPublish: { known: true, value: { date: "2026-06-20T23:27:50.592Z" }, source: "directory" },
  },

  [FIXTURE_PACKAGE_NAMES.deprecated]: {
    name: "request",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "2.88.2",
      deprecated: {
        known: true,
        value: {
          deprecated: true,
          message: "request has been deprecated, see https://github.com/request/request/issues/3142",
        },
        source: "npm",
      },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: false, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/request/request.git",
    },
    directory: {
      listed: false,
      unmaintained: false,
      newArchitectureRaw: null,
      githubUrl: null,
      lastPublishedAt: null,
      githubArchived: null,
      githubPushedAt: null,
      matchingScoreModifiers: [],
    },
    github: {
      archived: { known: true, value: false, source: "github-api" },
      pushedAt: { known: true, value: "2023-08-08T14:08:07Z", source: "github-api" },
      repoUrl: "https://github.com/request/request",
      source: "github-api",
    },
    isRnNative: false,
    rnNativeReasons: [],
    newArch: {
      tier: "unknown",
      evidence: { directoryVerdict: null, hasCodegenConfig: false },
    },
    lastPublish: {
      known: true,
      value: { date: "2023-08-08T14:08:07Z" },
      source: "npm-search",
    },
  },

  [FIXTURE_PACKAGE_NAMES.archived]: {
    name: "react-native-htmltext",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "0.7.2",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/siuying/react-native-htmltext.git",
    },
    directory: {
      listed: true,
      unmaintained: true,
      newArchitectureRaw: "supported",
      githubUrl: "https://github.com/siuying/react-native-htmltext",
      lastPublishedAt: null,
      githubArchived: true,
      githubPushedAt: "2015-03-30T14:33:47Z",
      matchingScoreModifiers: ["Not updated recently", "Unmaintained"],
    },
    github: {
      archived: { known: true, value: true, source: "directory-fallback" },
      pushedAt: { known: true, value: "2015-03-30T14:33:47Z", source: "directory-fallback" },
      repoUrl: "https://github.com/siuying/react-native-htmltext",
      source: "directory-fallback",
    },
    isRnNative: true,
    rnNativeReasons: ["directory-listed", "peer-dependency"],
    newArch: {
      tier: "supported",
      evidence: { directoryVerdict: "supported", hasCodegenConfig: false },
    },
    lastPublish: { known: false, reason: "not-in-directory" },
  },

  [FIXTURE_PACKAGE_NAMES.stale24mo]: {
    name: "react-native-markdown",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "0.3.1",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/lwansbrough/react-native-markdown.git",
    },
    directory: {
      listed: true,
      unmaintained: true,
      newArchitectureRaw: "unsupported",
      githubUrl: "https://github.com/lwansbrough/react-native-markdown",
      lastPublishedAt: null,
      githubArchived: false,
      githubPushedAt: "2015-07-04T18:55:07Z",
      matchingScoreModifiers: ["Known", "Not updated recently", "Unmaintained"],
    },
    github: {
      archived: { known: true, value: false, source: "directory-fallback" },
      pushedAt: { known: true, value: "2015-07-04T18:55:07Z", source: "directory-fallback" },
      repoUrl: "https://github.com/lwansbrough/react-native-markdown",
      source: "directory-fallback",
    },
    isRnNative: true,
    rnNativeReasons: ["directory-listed", "peer-dependency"],
    newArch: {
      tier: "unsupported",
      evidence: { directoryVerdict: "unsupported", hasCodegenConfig: false },
    },
    lastPublish: { known: false, reason: "not-in-directory" },
  },

  [FIXTURE_PACKAGE_NAMES.directoryUnmaintained]: {
    name: "react-native-ab",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "0.1.5",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/lwansbrough/react-native-ab.git",
    },
    directory: {
      listed: true,
      unmaintained: true,
      newArchitectureRaw: "untested",
      githubUrl: "https://github.com/lwansbrough/react-native-ab",
      lastPublishedAt: null,
      githubArchived: false,
      githubPushedAt: "2015-07-24T01:25:49Z",
      matchingScoreModifiers: ["Not updated recently", "Unmaintained"],
    },
    github: {
      archived: { known: true, value: false, source: "directory-fallback" },
      pushedAt: { known: true, value: "2015-07-24T01:25:49Z", source: "directory-fallback" },
      repoUrl: "https://github.com/lwansbrough/react-native-ab",
      source: "directory-fallback",
    },
    isRnNative: true,
    rnNativeReasons: ["directory-listed", "peer-dependency"],
    newArch: {
      tier: "unknown",
      evidence: { directoryVerdict: "untested", hasCodegenConfig: false },
    },
    lastPublish: { known: false, reason: "not-in-directory" },
  },

  [FIXTURE_PACKAGE_NAMES.newArchUnsupported]: {
    name: "react-native-legacy-bridge",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "1.0.0",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/example/react-native-legacy-bridge.git",
    },
    directory: {
      listed: true,
      unmaintained: false,
      newArchitectureRaw: "unsupported",
      githubUrl: "https://github.com/example/react-native-legacy-bridge",
      lastPublishedAt: "2024-01-15T10:00:00.000Z",
      githubArchived: false,
      githubPushedAt: "2024-01-15T10:00:00Z",
      matchingScoreModifiers: [],
    },
    github: {
      archived: { known: true, value: false, source: "github-api" },
      pushedAt: { known: true, value: "2024-01-15T10:00:00Z", source: "github-api" },
      repoUrl: "https://github.com/example/react-native-legacy-bridge",
      source: "github-api",
    },
    isRnNative: true,
    rnNativeReasons: ["directory-listed", "peer-dependency"],
    newArch: {
      tier: "unsupported",
      evidence: { directoryVerdict: "unsupported", hasCodegenConfig: false },
    },
    lastPublish: { known: true, value: { date: "2024-01-15T10:00:00.000Z" }, source: "directory" },
  },

  [FIXTURE_PACKAGE_NAMES.unknownWithCodegen]: {
    name: "my-rn-codegen-package",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "1.0.0",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: true, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/example/my-rn-codegen-package.git",
    },
    directory: {
      listed: false,
      unmaintained: false,
      newArchitectureRaw: null,
      githubUrl: null,
      lastPublishedAt: null,
      githubArchived: null,
      githubPushedAt: null,
      matchingScoreModifiers: [],
    },
    github: {
      archived: { known: true, value: false, source: "github-api" },
      pushedAt: { known: true, value: "2024-06-01T12:00:00Z", source: "github-api" },
      repoUrl: "https://github.com/example/my-rn-codegen-package",
      source: "github-api",
    },
    isRnNative: true,
    rnNativeReasons: ["peer-dependency"],
    newArch: {
      tier: "passWithNote",
      evidence: { directoryVerdict: null, hasCodegenConfig: true },
    },
    lastPublish: {
      known: true,
      value: { date: "2024-06-01T12:00:00Z" },
      source: "npm-search",
    },
  },

  [FIXTURE_PACKAGE_NAMES.unknownBare]: {
    name: "left-pad",
    warnings: [],
    npm: {
      found: true,
      latestVersion: "1.3.0",
      deprecated: { known: true, value: { deprecated: true, message: "use String.prototype.padStart()" }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: false, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: null,
    },
    directory: {
      listed: false,
      unmaintained: false,
      newArchitectureRaw: null,
      githubUrl: null,
      lastPublishedAt: null,
      githubArchived: null,
      githubPushedAt: null,
      matchingScoreModifiers: [],
    },
    github: {
      archived: { known: false, reason: "no-repo-url" },
      pushedAt: { known: false, reason: "no-repo-url" },
      repoUrl: null,
      source: null,
    },
    isRnNative: false,
    rnNativeReasons: [],
    newArch: {
      tier: "unknown",
      evidence: { directoryVerdict: null, hasCodegenConfig: false },
    },
    lastPublish: { known: true, value: { date: "2017-02-20T19:07:57.149Z" }, source: "npm-search" },
  },

  // 9th scenario: rate-limited (reuse healthy's npm/directory data, but GitHub returns 403)
  rateLimited: {
    name: "react-native-webview",
    // The rate-limit warning is a run-level concern (it announces that *remaining*
    // packages will degrade), so the orchestrator emits it on EnrichmentResult.warnings,
    // not on this dependency. The dependency itself carries no warning.
    warnings: [],
    npm: {
      found: true,
      latestVersion: "14.0.1",
      deprecated: { known: true, value: { deprecated: false, message: null }, source: "npm" },
      hasCodegenConfig: { known: true, value: false, source: "npm" },
      hasReactNativePeerDep: { known: true, value: true, source: "npm" },
      hasNativeDirsHint: { known: true, value: false, source: "npm" },
      repositoryUrl: "https://github.com/react-native-webview/react-native-webview.git",
    },
    directory: {
      listed: true,
      unmaintained: false,
      newArchitectureRaw: "supported",
      githubUrl: "https://github.com/react-native-webview/react-native-webview",
      lastPublishedAt: "2026-06-20T23:27:50.592Z",
      githubArchived: false,
      githubPushedAt: "2026-07-11T10:19:37Z",
      matchingScoreModifiers: [
        "Very popular",
        "Popular",
        "Known",
        "Recently updated",
        "Has a README file",
        "Has a description",
      ],
    },
    github: {
      archived: { known: true, value: false, source: "directory-fallback" },
      pushedAt: { known: true, value: "2026-07-11T10:19:37Z", source: "directory-fallback" },
      repoUrl: "https://github.com/react-native-webview/react-native-webview",
      source: "directory-fallback",
    },
    isRnNative: true,
    rnNativeReasons: ["directory-listed", "peer-dependency"],
    newArch: {
      tier: "supported",
      evidence: { directoryVerdict: "supported", hasCodegenConfig: false },
    },
    lastPublish: { known: true, value: { date: "2026-06-20T23:27:50.592Z" }, source: "directory" },
  },
};
