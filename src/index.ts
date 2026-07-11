/**
 * react-native-doctor-ci — a policy-as-code CI gate for React Native dependency
 * health. It fails pull requests that add abandoned, non-New-Architecture, or
 * npm-deprecated dependencies, with readable annotations and an allowlist
 * workflow.
 *
 * @packageDocumentation
 */

export const VERSION = "0.0.0";

// Re-export public API from the enrichment engine
export { enrichDependencies } from "./enrich.js";
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
