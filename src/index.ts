/**
 * react-native-doctor-ci - a policy-as-code CI gate for React Native dependency
 * health. It fails pull requests that add abandoned, non-New-Architecture, or
 * npm-deprecated dependencies, with readable annotations and an allowlist
 * workflow.
 *
 * @packageDocumentation
 */

export { VERSION } from "./version.js";

// Re-export public API from the enrichment engine
export { enrichDependencies } from "./enrich.js";

// Re-export public API from the policy engine
export { DEFAULT_POLICY, evaluatePolicy } from "./policy.js";
export type {
  AllowEntry,
  EvaluateOptions,
  Finding,
  FindingSeverity,
  LastPublishThresholds,
  Policy,
  PolicyRules,
  PolicyScope,
  RuleId,
  RuleSeverity,
} from "./policy.js";
export { DEFAULT_POLICY_FILENAME, PolicyError, loadPolicy, parsePolicy } from "./policy-file.js";

// Re-export public API from the reporters (Phase 3)
export { computeExitCode, locateFindings, summarize } from "./report.js";
export type { FindingSummary, Report, ReportFinding } from "./report.js";
export { renderJson } from "./report-json.js";
export { renderSarif } from "./report-sarif.js";
export type { SarifOptions } from "./report-sarif.js";
export { renderPretty } from "./report-pretty.js";
export type { PrettyOptions } from "./report-pretty.js";
export { renderAnnotations } from "./report-annotations.js";
export {
  ManifestError,
  entriesFromManifestText,
  findDependencyLine,
  listDependencies,
  listDependencyEntries,
  readManifestAt,
  readPackageJson,
} from "./package-json.js";
export type { DependencyEntry, ProjectManifest } from "./package-json.js";

// Re-export public API for PR mode and monorepos (Phase 4)
export { diffDependencies } from "./changed-deps.js";
export { GitError, createGitRunner, readFileAtCommit, resolveBaseCommit } from "./git.js";
export type { GitRunResult, GitRunner } from "./git.js";
export { WorkspaceError, discoverWorkspaces, expandWorkspacePatterns } from "./workspaces.js";
export type { WorkspaceDir } from "./workspaces.js";
export type {
  EnrichedDependency,
  EnrichmentOptions,
  EnrichmentResult,
  EnrichmentWarning,
  NewArchTier,
  Signal,
  UnknownReason,
  RnNativeReason,
} from "./types.js";
