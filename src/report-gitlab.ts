/**
 * GitLab Code Quality reporter: renders findings as a CodeClimate-subset JSON
 * array that GitLab consumes via `artifacts: reports: codequality:`, surfacing
 * findings in the merge-request Code Quality widget and diff.
 * @packageDocumentation
 */

import { createHash } from "node:crypto";

import type { Finding } from "./policy.js";
import type { Report } from "./report.js";

/** A single CodeClimate-subset issue as GitLab's Code Quality report expects. */
export interface GitlabCodeQualityIssue {
  /** Human-readable description shown in the MR widget. */
  readonly description: string;
  /** The rn-doctor rule id, namespaced for readability in the widget. */
  readonly check_name: string;
  /**
   * Stable identity for the finding across pipelines. Hashes rule, package
   * and manifest path - never the line number or message - so dependency
   * reordering and message wording changes don't churn the MR widget.
   */
  readonly fingerprint: string;
  readonly severity: "info" | "minor" | "major" | "critical" | "blocker";
  readonly location: {
    readonly path: string;
    readonly lines: { readonly begin: number };
  };
}

function severityFor(f: Finding): GitlabCodeQualityIssue["severity"] {
  if (f.suppressedBy !== null || f.severity === "note") return "info";
  return f.severity === "error" ? "major" : "minor";
}

function fingerprintFor(f: Finding & { readonly file: string }): string {
  return createHash("sha256").update(`${f.rule}\0${f.package}\0${f.file}`).digest("hex");
}

/**
 * Render the report as a GitLab Code Quality (CodeClimate subset) JSON array.
 *
 * @remarks
 * Severity mapping: `error` -> `major`, `warn` -> `minor`, `note` and
 * allowlist-suppressed findings -> `info` (with the allow reason appended to
 * the description, so policy debt stays visible without gating). GitLab
 * requires `location.lines.begin`, so unresolvable lines fall back to 1.
 *
 * @param report - The report to render.
 * @param lineOf - Resolve a package's 1-based declaration line in the
 * manifest at `file` (the finding's cwd-relative path), or `null`.
 * @returns Pretty-printed JSON array, newline-terminated. `[]` when there are
 * no findings.
 */
export function renderGitlabCodeQuality(
  report: Report,
  lineOf: (file: string, packageName: string) => number | null,
): string {
  const issues: GitlabCodeQualityIssue[] = report.findings.map((f) => {
    const suffix =
      f.suppressedBy !== null
        ? ` [allowed${f.suppressedBy.reason ? `: ${f.suppressedBy.reason}` : ""}` +
          `${f.suppressedBy.expires ? `, expires ${f.suppressedBy.expires}` : ""}]`
        : "";
    return {
      description: `${f.package}: ${f.message}${suffix}`,
      check_name: `rn-doctor/${f.rule}`,
      fingerprint: fingerprintFor(f),
      severity: severityFor(f),
      location: {
        path: f.file,
        lines: { begin: lineOf(f.file, f.package) ?? 1 },
      },
    };
  });

  return `${JSON.stringify(issues, null, 2)}\n`;
}
