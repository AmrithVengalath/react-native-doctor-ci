/**
 * Azure Pipelines annotation reporter: emits logging commands
 * (`##vso[task.logissue type=error;sourcepath=package.json;linenumber=N]message`)
 * so findings appear in the run's Issues pane and build summary.
 * @packageDocumentation
 */

import type { Finding } from "./policy.js";
import type { Report } from "./report.js";

/**
 * Escape logging-command message data (the part after `]`).
 * Per the azure-pipelines-agent: `%` first (as `%AZP25`), then CR/LF.
 */
function escapeAzureData(value: string): string {
  return value.replaceAll("%", "%AZP25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * Escape a logging-command property value. Properties additionally escape
 * `]` and `;`, which delimit the command envelope and properties.
 */
function escapeAzureProperty(value: string): string {
  return escapeAzureData(value).replaceAll("]", "%5D").replaceAll(";", "%3B");
}

/**
 * The `task.logissue` type for a finding, or `null` to emit nothing.
 * Azure has no notice-level issue type, and warnings count toward the run's
 * Issues total (and can flip a job to SucceededWithIssues) - so notes and
 * allowlist-suppressed findings are skipped here rather than inflated to
 * warnings; the pretty output printed alongside still lists them.
 */
function typeFor(f: Finding): "error" | "warning" | null {
  if (f.suppressedBy !== null || f.severity === "note") return null;
  return f.severity === "error" ? "error" : "warning";
}

/**
 * Render the report as Azure Pipelines `task.logissue` logging commands.
 *
 * @remarks
 * Each command targets the finding's manifest with the dependency's
 * declaration line when `lineOf` resolves one (omitting `linenumber`
 * otherwise) and carries the rule id in `code`. Only gating findings emit
 * commands: notes and suppressed findings are informational and Azure has no
 * non-counting issue type to carry them (see {@link typeFor}).
 *
 * @param report - The report to render.
 * @param lineOf - Resolve a package's 1-based declaration line in the
 * manifest at `file` (the finding's cwd-relative path), or `null`.
 * @returns Newline-terminated logging commands; empty string when no finding
 * emits one.
 */
export function renderAzureAnnotations(
  report: Report,
  lineOf: (file: string, packageName: string) => number | null,
): string {
  const lines: string[] = [];

  for (const f of report.findings) {
    const type = typeFor(f);
    if (type === null) continue;
    const line = lineOf(f.file, f.package);
    const properties = [
      `type=${type}`,
      `sourcepath=${escapeAzureProperty(f.file)}`,
      ...(line !== null ? [`linenumber=${String(line)}`] : []),
      `code=${escapeAzureProperty(f.rule)}`,
    ].join(";");

    lines.push(`##vso[task.logissue ${properties}]${escapeAzureData(`${f.package}: ${f.message}`)}`);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
