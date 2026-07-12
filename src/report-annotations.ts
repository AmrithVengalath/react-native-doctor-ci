/**
 * GitHub Actions annotation reporter: emits workflow commands
 * (`::error file=package.json,line=N::message`) so findings appear inline on
 * the PR diff.
 * @packageDocumentation
 */

import type { Finding } from "./policy.js";
import type { Report } from "./report.js";

/**
 * Escape a workflow-command message (the part after `::`).
 * Per the GitHub Actions runner: `%` must be escaped first.
 */
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * Escape a workflow-command property value (e.g. `file=`, `title=`).
 * Property values additionally escape `,` and `:`, which delimit properties.
 */
function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/**
 * The annotation command for a finding. Suppressed findings and notes are
 * informational: they surface as `notice`, never as a failing `error`.
 */
function commandFor(f: Finding): "error" | "warning" | "notice" {
  if (f.suppressedBy !== null || f.severity === "note") return "notice";
  return f.severity === "error" ? "error" : "warning";
}

/**
 * Render the report as GitHub Actions workflow commands, one per finding.
 *
 * @remarks
 * Each command targets the finding's manifest (`package.json`, or e.g.
 * `packages/a/package.json` under `--workspaces`) with the dependency's
 * declaration line when `lineOf` resolves one (omitting `line=` otherwise),
 * so annotations land inline on the PR diff. Suppressed findings keep an
 * annotation (as a `notice` including the allow reason) so policy debt stays
 * visible without failing checks.
 *
 * @param report - The report to render.
 * @param lineOf - Resolve a package's 1-based declaration line in the
 * manifest at `file` (the finding's cwd-relative path), or `null`.
 * @returns Newline-terminated workflow commands; empty string when there are
 * no findings.
 */
export function renderAnnotations(
  report: Report,
  lineOf: (file: string, packageName: string) => number | null,
): string {
  const lines: string[] = [];

  for (const f of report.findings) {
    const command = commandFor(f);
    const line = lineOf(f.file, f.package);
    const properties = [
      `file=${escapeProperty(f.file)}`,
      ...(line !== null ? [`line=${String(line)}`] : []),
      `title=${escapeProperty(`rn-doctor: ${f.rule} (${f.package})`)}`,
    ].join(",");

    const suffix =
      f.suppressedBy !== null
        ? ` [allowed${f.suppressedBy.reason ? `: ${f.suppressedBy.reason}` : ""}` +
          `${f.suppressedBy.expires ? `, expires ${f.suppressedBy.expires}` : ""}]`
        : "";

    lines.push(`::${command} ${properties}::${escapeData(f.message + suffix)}`);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
