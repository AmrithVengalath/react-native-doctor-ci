/**
 * SARIF 2.1.0 reporter, for GitHub code scanning and other SARIF consumers.
 * The output validates against the OASIS SARIF 2.1.0 schema (enforced by the
 * acceptance suite).
 * @packageDocumentation
 */

import type { Finding, RuleId } from "./policy.js";
import { summarize } from "./report.js";
import type { Report } from "./report.js";
import { VERSION } from "./version.js";

const INFORMATION_URI = "https://www.npmjs.com/package/react-native-doctor-ci";

/** Fixed rule order - also the `ruleIndex` mapping for results. */
const RULE_IDS: readonly RuleId[] = [
  "newArchitecture",
  "newArchUnknown",
  "lastPublish",
  "githubArchived",
  "npmDeprecated",
  "directoryUnmaintained",
];

const RULE_DESCRIPTIONS: Readonly<Record<RuleId, string>> = {
  newArchitecture:
    "The package does not support the React Native New Architecture, per the React Native Directory.",
  newArchUnknown:
    "New Architecture support for the package could not be determined from the React Native Directory or npm codegen hints.",
  lastPublish: "The package's latest npm publish is older than the configured staleness threshold.",
  githubArchived: "The package's GitHub repository is archived (read-only).",
  npmDeprecated: "The package is marked deprecated on the npm registry.",
  directoryUnmaintained: "The React Native Directory flags the package as unmaintained.",
};

/** Map finding severity to a SARIF result level. */
function sarifLevel(severity: Finding["severity"]): "error" | "warning" | "note" {
  return severity === "warn" ? "warning" : severity;
}

/**
 * Options for {@link renderSarif}.
 */
export interface SarifOptions {
  /**
   * Resolve a package's 1-based declaration line in the manifest at `file`
   * (the finding's cwd-relative manifest path), or `null` when unknown. When
   * omitted (or when it returns `null`), results still carry the manifest
   * artifact location, just without a region.
   */
  readonly lineOf?: (file: string, packageName: string) => number | null;
}

/**
 * Render the report as a SARIF 2.1.0 log with a single run.
 *
 * @remarks
 * Severity maps `error` → `"error"`, `warn` → `"warning"`, `note` → `"note"`.
 * Allowlist-suppressed findings are emitted with a `suppressions` entry
 * (`kind: "external"`, `status: "accepted"`) so SARIF consumers exclude them
 * from gating, mirroring the CLI exit-code contract. Enrichment warnings are
 * carried as tool execution notifications on the invocation.
 *
 * @param report - The report to render.
 * @param options - Line resolution for annotating package.json regions.
 * @returns Pretty-printed SARIF JSON, terminated with a newline.
 */
export function renderSarif(report: Report, options: SarifOptions = {}): string {
  const lineOf = options.lineOf ?? (() => null);
  const summary = summarize(report.findings);

  const results = report.findings.map((f) => {
    const line = lineOf(f.file, f.package);
    return {
      ruleId: f.rule,
      ruleIndex: RULE_IDS.indexOf(f.rule),
      level: sarifLevel(f.severity),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            ...(line !== null ? { region: { startLine: line } } : {}),
          },
        },
      ],
      ...(f.suppressedBy !== null
        ? {
            suppressions: [
              {
                kind: "external" as const,
                status: "accepted" as const,
                justification:
                  `Allowlisted in .rn-doctor.yml` +
                  (f.suppressedBy.reason ? `: ${f.suppressedBy.reason}` : "") +
                  (f.suppressedBy.expires ? ` (expires ${f.suppressedBy.expires})` : ""),
              },
            ],
          }
        : {}),
      ...(f.evidenceUrl !== null ? { hostedViewerUri: f.evidenceUrl } : {}),
    };
  });

  const doc = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: "rn-doctor",
            informationUri: INFORMATION_URI,
            version: VERSION,
            rules: RULE_IDS.map((id) => ({
              id,
              shortDescription: { text: RULE_DESCRIPTIONS[id] },
              helpUri: INFORMATION_URI,
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: report.warnings.map((w) => ({
              level: "warning" as const,
              message: {
                text: (w.dependency !== undefined ? `${w.dependency}: ` : "") + w.message,
              },
            })),
          },
        ],
        results,
        properties: {
          checked: report.checkedCount,
          errors: summary.errors,
          warnings: summary.warnings,
          notes: summary.notes,
          suppressed: summary.suppressed,
        },
      },
    ],
  };

  return `${JSON.stringify(doc, null, 2)}\n`;
}
