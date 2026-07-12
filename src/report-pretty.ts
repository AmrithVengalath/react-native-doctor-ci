/**
 * Human-readable terminal reporter: one block per finding (verdict, reason,
 * evidence link), enrichment warnings, and a summary footer.
 * @packageDocumentation
 */

import type { Finding } from "./policy.js";
import { summarize } from "./report.js";
import type { Report } from "./report.js";

/**
 * Options for {@link renderPretty}.
 */
export interface PrettyOptions {
  /**
   * Enable ANSI colors. The CLI passes `stdout.isTTY && !NO_COLOR`; tests
   * pass `false` for stable snapshots.
   */
  readonly color: boolean;
}

const ESC = String.fromCharCode(27);

const ANSI = {
  red: "31",
  yellow: "33",
  cyan: "36",
  green: "32",
  dim: "2",
  bold: "1",
} as const;

type AnsiCode = (typeof ANSI)[keyof typeof ANSI];

function paint(code: AnsiCode, text: string, on: boolean): string {
  return on ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

/** The display badge for a finding, after suppression is taken into account. */
function badge(f: Finding, color: boolean): string {
  if (f.suppressedBy !== null) return paint(ANSI.dim, `allowed(${f.severity})`, color);
  if (f.severity === "error") return paint(ANSI.red, "error", color);
  if (f.severity === "warn") return paint(ANSI.yellow, "warn", color);
  return paint(ANSI.cyan, "note", color);
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Render the report for human eyes.
 *
 * @remarks
 * When the findings span more than one manifest (a `--workspaces` run), each
 * group is introduced by its manifest path; single-manifest output is
 * unchanged.
 *
 * @param report - The report to render.
 * @param options - Color toggling; content is identical either way.
 * @returns The full report text, terminated with a newline.
 */
export function renderPretty(report: Report, options: PrettyOptions): string {
  const { color } = options;
  const lines: string[] = [];

  const multiManifest = (report.manifestCount ?? 1) > 1;
  let currentFile: string | null = null;

  for (const f of report.findings) {
    if (multiManifest && f.file !== currentFile) {
      currentFile = f.file;
      lines.push(paint(ANSI.dim, `${f.file}:`, color));
      lines.push("");
    }
    lines.push(`${badge(f, color)}  ${paint(ANSI.bold, f.package, color)}  [${f.rule}]`);
    lines.push(`    ${f.message}`);
    if (f.suppressedBy !== null) {
      const reason = f.suppressedBy.reason ?? "no reason given";
      const expires = f.suppressedBy.expires ? `, expires ${f.suppressedBy.expires}` : "";
      lines.push(paint(ANSI.dim, `    allowed by .rn-doctor.yml: ${reason}${expires}`, color));
    }
    if (f.evidenceUrl !== null) {
      lines.push(paint(ANSI.dim, `    evidence: ${f.evidenceUrl}`, color));
    }
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push("Data warnings (missing or degraded lookups - findings may be incomplete):");
    for (const w of report.warnings) {
      const scope = w.dependency !== undefined ? `${w.dependency}: ` : "";
      lines.push(paint(ANSI.dim, `  - [${w.source}] ${scope}${w.message}`, color));
    }
    lines.push("");
  }

  const s = summarize(report.findings);
  const n = report.checkedCount;
  const checked =
    `${String(n)} ${n === 1 ? "dependency" : "dependencies"}` +
    (multiManifest ? ` in ${String(report.manifestCount)} manifests` : "");
  if (s.errors === 0 && s.warnings === 0 && s.notes === 0 && s.suppressed === 0) {
    lines.push(paint(ANSI.green, `No findings across ${checked}.`, color));
  } else {
    const parts = [
      paint(ANSI.red, plural(s.errors, "error"), color),
      paint(ANSI.yellow, plural(s.warnings, "warning"), color),
      plural(s.notes, "note"),
      `${String(s.suppressed)} allowed`,
    ];
    lines.push(`${parts.join(", ")} across ${checked}.`);
  }

  return `${lines.join("\n")}\n`;
}
