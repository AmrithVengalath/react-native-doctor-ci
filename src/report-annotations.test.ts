import { describe, expect, it } from "vitest";

import type { Finding } from "./policy.js";
import { renderAnnotations } from "./report-annotations.js";
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
  return { findings, warnings: [], checkedCount: findings.length };
}

const noLine = (): number | null => null;

describe("renderAnnotations — GitHub workflow commands", () => {
  it("emits one command per finding, targeting the resolved package.json line", () => {
    const text = renderAnnotations(reportOf([finding({ message: "bad dep" })]), () => 7);
    expect(text).toBe(
      "::error file=package.json,line=7,title=rn-doctor%3A npmDeprecated (example-pkg)::bad dep\n",
    );
  });

  it("omits line= when the dependency line cannot be resolved", () => {
    const text = renderAnnotations(reportOf([finding({})]), noLine);
    expect(text).toContain("::error file=package.json,title=");
    expect(text).not.toContain("line=");
  });

  it("maps severities: error, warn -> warning, note -> notice", () => {
    const report = reportOf([
      finding({ severity: "error", message: "e" }),
      finding({ severity: "warn", message: "w" }),
      finding({ severity: "note", message: "n" }),
    ]);
    const lines = renderAnnotations(report, noLine).trimEnd().split("\n");
    expect(lines[0]).toMatch(/^::error /);
    expect(lines[1]).toMatch(/^::warning /);
    expect(lines[2]).toMatch(/^::notice /);
  });

  it("downgrades suppressed findings to notice and appends the allow reason", () => {
    const report = reportOf([
      finding({
        severity: "error",
        message: "dead dep.",
        suppressedBy: { reason: "fork planned Q3", expires: "2026-12-31" },
      }),
    ]);
    const text = renderAnnotations(report, noLine);
    expect(text).toMatch(/^::notice /);
    expect(text).toContain("dead dep. [allowed: fork planned Q3, expires 2026-12-31]");
  });

  it("escapes %, CR and LF in messages", () => {
    const report = reportOf([finding({ message: "50% broken\r\nsecond line" })]);
    const text = renderAnnotations(report, noLine);
    expect(text).toContain("::50%25 broken%0D%0Asecond line\n");
  });

  it("escapes colons and commas in property values", () => {
    const report = reportOf([finding({ package: "weird:pkg,name" })]);
    const text = renderAnnotations(report, noLine);
    expect(text).toContain("title=rn-doctor%3A npmDeprecated (weird%3Apkg%2Cname)");
  });

  it("returns an empty string when there are no findings", () => {
    expect(renderAnnotations(reportOf([]), noLine)).toBe("");
  });

  it("suppressed matrix findings never emit ::error", () => {
    const text = renderAnnotations(matrixReport(LENIENT_WITH_ALLOWLIST), noLine);
    for (const line of text.trimEnd().split("\n")) {
      if (line.includes("react-native-markdown")) {
        expect(line).toMatch(/^::notice /);
      }
    }
  });
});
