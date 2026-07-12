/**
 * react-native-doctor-ci — a policy-as-code CI gate for React Native dependency
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
export { computeExitCode, summarize } from "./report.js";
export type { FindingSummary, Report } from "./report.js";
export { renderJson } from "./report-json.js";
export { renderSarif } from "./report-sarif.js";
export type { SarifOptions } from "./report-sarif.js";
export { renderPretty } from "./report-pretty.js";
export type { PrettyOptions } from "./report-pretty.js";
export { renderAnnotations } from "./report-annotations.js";
export {
  ManifestError,
  findDependencyLine,
  listDependencies,
  readPackageJson,
} from "./package-json.js";
export type { ProjectManifest } from "./package-json.js";
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
