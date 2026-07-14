/**
 * Shared reporter surface: the report shape every renderer consumes, the
 * finding summary, and the exit-code contract.
 * @packageDocumentation
 */

import type { Finding } from "./policy.js";
import type { EnrichmentWarning } from "./types.js";

/**
 * A policy finding located in a specific manifest file. The CLI decorates
 * pure policy findings with their manifest path at report-assembly time; the
 * policy engine itself stays manifest-blind.
 */
export interface ReportFinding extends Finding {
  /**
   * Manifest path relative to the run cwd, POSIX separators - `package.json`
   * for single-manifest runs, e.g. `packages/a/package.json` under
   * `--workspaces`.
   */
  readonly file: string;
}

/**
 * Everything a reporter needs to render one rn-doctor run.
 */
export interface Report {
  /** Findings from the policy engine, grouped by manifest in its stable output order. */
  readonly findings: readonly ReportFinding[];
  /** Run-level and per-dependency enrichment warnings (degraded data, etc.). */
  readonly warnings: readonly EnrichmentWarning[];
  /** How many (manifest, dependency) pairs were checked across all scanned manifests. */
  readonly checkedCount: number;
  /**
   * How many manifests were scanned. Omitted (equivalent to 1) outside
   * `--workspaces`; the pretty reporter mentions it only when above 1.
   */
  readonly manifestCount?: number;
}

/**
 * Decorate pure policy findings with the manifest they belong to.
 *
 * @param findings - Findings from {@link evaluatePolicy}.
 * @param file - Manifest path relative to the run cwd, POSIX separators.
 */
export function locateFindings(
  findings: readonly Finding[],
  file: string,
): readonly ReportFinding[] {
  return findings.map((f) => ({ ...f, file }));
}

/**
 * Counts of findings by effect. Suppressed findings are counted only under
 * `suppressed` - they keep their severity for display but have no effect on
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
 * (tool failure) is decided by the CLI, not here - a report that rendered
 * at all is not a tool failure.
 */
export function computeExitCode(findings: readonly Finding[]): 0 | 1 {
  return findings.some((f) => f.severity === "error" && f.suppressedBy === null) ? 1 : 0;
}
