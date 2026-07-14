/**
 * Shared Phase 3 test fixture: the 8-fixture matrix evaluated under the same
 * three policies as the Phase 2 snapshot suite (policy.test.ts), packaged as
 * `Report`s for the reporter tests.
 * @packageDocumentation
 */

import { DEFAULT_POLICY, evaluatePolicy } from "../policy.js";
import type { Policy } from "../policy.js";
import { locateFindings } from "../report.js";
import type { Report } from "../report.js";
import type { EnrichmentWarning } from "../types.js";
import { ENRICHED_FIXTURES, FIXTURE_PACKAGE_NAMES } from "./fixture-packages.js";

/** Frozen clock shared with the Phase 2 suite. */
export const MATRIX_NOW = new Date("2026-07-12T00:00:00.000Z");

/** The 8 fixture dependencies, in FIXTURE_PACKAGE_NAMES order. */
export const MATRIX_DEPENDENCIES = Object.values(FIXTURE_PACKAGE_NAMES).map((name) => {
  const record = ENRICHED_FIXTURES[name];
  if (!record) throw new Error(`missing fixture: ${name}`);
  return record;
});

/** Everything errors, all-deps scope - the harshest configuration. */
export const STRICT_ALL_DEPS: Policy = {
  scope: "all-deps",
  rules: {
    newArchitecture: "error",
    newArchUnknown: "error",
    lastPublish: { warnMonths: 6, errorMonths: 12 },
    githubArchived: "error",
    npmDeprecated: "error",
    directoryUnmaintained: "error",
  },
  allow: [],
};

/** Warn-heavy policy with one active and one expired allowlist entry. */
export const LENIENT_WITH_ALLOWLIST: Policy = {
  scope: "rn-native-only",
  rules: {
    newArchitecture: "warn",
    newArchUnknown: "off",
    lastPublish: { warnMonths: 24, errorMonths: 48 },
    githubArchived: "warn",
    npmDeprecated: "warn",
    directoryUnmaintained: "warn",
  },
  allow: [
    // Active through 2026-12-31: suppresses react-native-markdown's findings.
    { package: "react-native-markdown", reason: "migration planned Q4 2026", expires: "2026-12-31" },
    // Expired: react-native-htmltext's findings escalate to error.
    { package: "react-native-htmltext", reason: "fork planned Q3 2025", expires: "2026-01-01" },
  ],
};

/** Label × policy pairs, matching the Phase 2 snapshot suite. */
export const MATRIX_POLICIES: readonly (readonly [string, Policy])[] = [
  ["default", DEFAULT_POLICY],
  ["strict-all-deps", STRICT_ALL_DEPS],
  ["lenient-with-allowlist", LENIENT_WITH_ALLOWLIST],
];

/** Representative run-level + per-dependency enrichment warnings. */
export const MATRIX_WARNINGS: readonly EnrichmentWarning[] = [
  {
    source: "github",
    message:
      "GitHub API rate limit reached without a GITHUB_TOKEN; remaining repositories degrade to unknown. Set GITHUB_TOKEN to raise the limit.",
  },
  {
    dependency: "left-pad",
    source: "npm",
    message: "npm search returned no publish date; lastPublish is unknown.",
  },
];

/**
 * Build a `Report` for one policy over the 8-fixture matrix, with the
 * representative warnings attached.
 */
export function matrixReport(policy: Policy): Report {
  return {
    findings: locateFindings(evaluatePolicy(MATRIX_DEPENDENCIES, policy, { now: MATRIX_NOW }), "package.json"),
    warnings: MATRIX_WARNINGS,
    checkedCount: MATRIX_DEPENDENCIES.length,
  };
}
