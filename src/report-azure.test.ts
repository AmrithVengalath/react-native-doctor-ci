import { describe, expect, it } from "vitest";

import type { Finding } from "./policy.js";
import { renderAzureAnnotations } from "./report-azure.js";
import { locateFindings } from "./report.js";
import type { Report } from "./report.js";
import { LENIENT_WITH_ALLOWLIST, matrixReport } from "./testing/policy-matrix.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    package: "example-pkg",
    rule: "npmDeprecated",
    severity: "error",
    message: "example message",
    evidenceUrl: null,
    suppressedBy: null,
    ...overrides,
  };
}

function reportOf(findings: Finding[]): Report {
  return {
    findings: locateFindings(findings, "package.json"),
    warnings: [],
    checkedCount: findings.length,
  };
}

const noLine = (): number | null => null;

describe("renderAzureAnnotations - Azure Pipelines logging commands", () => {
  it("emits one command per gating finding, targeting the resolved line", () => {
    const text = renderAzureAnnotations(reportOf([finding({ message: "bad dep" })]), () => 7);
    expect(text).toBe(
      "##vso[task.logissue type=error;sourcepath=package.json;linenumber=7;code=npmDeprecated]example-pkg: bad dep\n",
    );
  });

  it("omits linenumber when the dependency line cannot be resolved", () => {
    const text = renderAzureAnnotations(reportOf([finding({})]), noLine);
    expect(text).toContain("type=error;sourcepath=package.json;code=");
    expect(text).not.toContain("linenumber=");
  });

  it("maps severities: error -> error, warn -> warning", () => {
    const report = reportOf([
      finding({ severity: "error", message: "e" }),
      finding({ severity: "warn", message: "w" }),
    ]);
    const lines = renderAzureAnnotations(report, noLine).trimEnd().split("\n");
    expect(lines[0]).toMatch(/^##vso\[task\.logissue type=error;/);
    expect(lines[1]).toMatch(/^##vso\[task\.logissue type=warning;/);
  });

  it("skips notes entirely (Azure has no notice type)", () => {
    expect(renderAzureAnnotations(reportOf([finding({ severity: "note" })]), noLine)).toBe("");
  });

  it("skips suppressed findings entirely, whatever their severity", () => {
    const report = reportOf([
      finding({
        severity: "error",
        suppressedBy: { reason: "fork planned Q3", expires: "2026-12-31" },
      }),
    ]);
    expect(renderAzureAnnotations(report, noLine)).toBe("");
  });

  it("escapes %, CR and LF in message data using %AZP25 for percent", () => {
    const report = reportOf([finding({ message: "50% broken\r\nsecond line" })]);
    const text = renderAzureAnnotations(report, noLine);
    expect(text).toContain("]example-pkg: 50%AZP25 broken%0D%0Asecond line\n");
  });

  it("escapes ; and ] in property values but not in message data", () => {
    const report: Report = {
      findings: [{ ...finding({}), file: "weird;dir]/package.json" }],
      warnings: [],
      checkedCount: 1,
    };
    const text = renderAzureAnnotations(report, noLine);
    expect(text).toContain("sourcepath=weird%3Bdir%5D/package.json;");
  });

  it("targets each finding's own manifest in a --workspaces run", () => {
    const report: Report = {
      findings: [
        { ...finding({ message: "bad dep" }), file: "packages/a/package.json" },
        { ...finding({ package: "other-pkg", message: "also bad" }), file: "packages/b/package.json" },
      ],
      warnings: [],
      checkedCount: 2,
      manifestCount: 3,
    };
    const lineOf = (file: string): number | null => (file === "packages/a/package.json" ? 12 : null);
    const lines = renderAzureAnnotations(report, lineOf).trimEnd().split("\n");
    expect(lines[0]).toBe(
      "##vso[task.logissue type=error;sourcepath=packages/a/package.json;linenumber=12;code=npmDeprecated]example-pkg: bad dep",
    );
    expect(lines[1]).toContain("sourcepath=packages/b/package.json;code=");
  });

  it("returns an empty string when there are no findings", () => {
    expect(renderAzureAnnotations(reportOf([]), noLine)).toBe("");
  });

  it("suppressed matrix findings never emit any command", () => {
    const text = renderAzureAnnotations(matrixReport(LENIENT_WITH_ALLOWLIST), noLine);
    expect(text).not.toContain("react-native-markdown");
  });
});
