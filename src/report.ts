/**
 * Shared reporter surface: the report shape every renderer consumes, the
 * finding summary, and the exit-code contract.
 * @packageDocumentation
 */

import type { Finding } from "./policy.js";
import type { EnrichmentWarning } from "./types.js";

/**
 * Everything a reporter needs to render one rn-doctor run.
 */
export interface Report {
  /** Findings from the policy engine, in its stable output order. */
  readonly findings: readonly Finding[];
  /** Run-level and per-dependency enrichment warnings (degraded data, etc.). */
  readonly warnings: readonly EnrichmentWarning[];
  /** How many dependencies were checked (after scope filtering happens in policy, this is the full input count). */
  readonly checkedCount: number;
}

/**
 * Counts of findings by effect. Suppressed findings are counted only under
 * `suppressed` — they keep their severity for display but have no effect on
 * the run outcome.
 */
export interface FindingSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly notes: number;
  readonly suppressed: number;
}

/**
 * Summarize findings for the pretty footer and the JSON document.
 */
export function summarize(findings: readonly Finding[]): FindingSummary {
  let errors = 0;
  let warnings = 0;
  let notes = 0;
  let suppressed = 0;
  for (const f of findings) {
    if (f.suppressedBy !== null) {
      suppressed++;
    } else if (f.severity === "error") {
      errors++;
    } else if (f.severity === "warn") {
      warnings++;
    } else {
      notes++;
    }
  }
  return { errors, warnings, notes, suppressed };
}

/**
 * The stable exit-code contract for policy outcomes.
 *
 * @remarks
 * Returns `1` iff any finding is an unsuppressed `error`; warnings, notes,
 * and allowlist-suppressed findings never fail the run. Exit code `2`
 * (tool failure) is decided by the CLI, not here — a report that rendered
 * at all is not a tool failure.
 */
export function computeExitCode(findings: readonly Finding[]): 0 | 1 {
  return findings.some((f) => f.severity === "error" && f.suppressedBy === null) ? 1 : 0;
}
