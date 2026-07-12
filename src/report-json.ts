/**
 * JSON reporter: a machine-readable document with a stable key order, safe
 * to snapshot and to diff across runs.
 * @packageDocumentation
 */

import { summarize } from "./report.js";
import type { Report } from "./report.js";

/**
 * Render the report as a stable-ordered JSON document.
 *
 * @remarks
 * Key order is fixed by construction (every object is rebuilt field by
 * field), and the document contains no timestamps or environment-dependent
 * values, so identical inputs always serialize identically. The `version`
 * field is the document format version, bumped only on breaking shape
 * changes — additive fields (like `file`, added for `--workspaces`) do not
 * bump it.
 *
 * @param report - The report to render.
 * @returns Pretty-printed JSON, terminated with a newline.
 */
export function renderJson(report: Report): string {
  const summary = summarize(report.findings);

  const doc = {
    version: 1,
    summary: {
      checked: report.checkedCount,
      errors: summary.errors,
      warnings: summary.warnings,
      notes: summary.notes,
      suppressed: summary.suppressed,
    },
    findings: report.findings.map((f) => ({
      file: f.file,
      package: f.package,
      rule: f.rule,
      severity: f.severity,
      message: f.message,
      evidenceUrl: f.evidenceUrl,
      suppressedBy: f.suppressedBy === null
        ? null
        : { reason: f.suppressedBy.reason, expires: f.suppressedBy.expires },
    })),
    warnings: report.warnings.map((w) => ({
      ...(w.dependency !== undefined ? { dependency: w.dependency } : {}),
      source: w.source,
      message: w.message,
    })),
  };

  return `${JSON.stringify(doc, null, 2)}\n`;
}
