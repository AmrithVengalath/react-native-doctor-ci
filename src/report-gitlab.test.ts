import { describe, expect, it } from "vitest";

import type { Finding } from "./policy.js";
import { renderGitlabCodeQuality } from "./report-gitlab.js";
import type { GitlabCodeQualityIssue } from "./report-gitlab.js";
import { locateFindings } from "./report.js";
import type { Report } from "./report.js";

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

function parse(text: string): GitlabCodeQualityIssue[] {
  return JSON.parse(text) as GitlabCodeQualityIssue[];
}

describe("renderGitlabCodeQuality - Code Quality (CodeClimate subset) JSON", () => {
  it("renders one issue per finding with the resolved line", () => {
    const issues = parse(renderGitlabCodeQuality(reportOf([finding({ message: "bad dep" })]), () => 7));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      description: "example-pkg: bad dep",
      check_name: "rn-doctor/npmDeprecated",
      severity: "major",
      location: { path: "package.json", lines: { begin: 7 } },
    });
    expect(issues[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to line 1 when the dependency line cannot be resolved", () => {
    const issues = parse(renderGitlabCodeQuality(reportOf([finding({})]), noLine));
    expect(issues[0]?.location.lines.begin).toBe(1);
  });

  it("maps severities: error -> major, warn -> minor, note -> info", () => {
    const issues = parse(
      renderGitlabCodeQuality(
        reportOf([
          finding({ severity: "error" }),
          finding({ severity: "warn" }),
          finding({ severity: "note" }),
        ]),
        noLine,
      ),
    );
    expect(issues.map((i) => i.severity)).toEqual(["major", "minor", "info"]);
  });

  it("maps suppressed findings to info and appends the allow reason", () => {
    const issues = parse(
      renderGitlabCodeQuality(
        reportOf([
          finding({
            severity: "error",
            message: "dead dep.",
            suppressedBy: { reason: "fork planned Q3", expires: "2026-12-31" },
          }),
        ]),
        noLine,
      ),
    );
    expect(issues[0]?.severity).toBe("info");
    expect(issues[0]?.description).toBe(
      "example-pkg: dead dep. [allowed: fork planned Q3, expires 2026-12-31]",
    );
  });

  it("keeps the fingerprint stable across line moves and message changes", () => {
    const a = parse(renderGitlabCodeQuality(reportOf([finding({ message: "one" })]), () => 7));
    const b = parse(renderGitlabCodeQuality(reportOf([finding({ message: "two" })]), () => 99));
    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
  });

  it("distinguishes fingerprints by rule, package and file", () => {
    const base = parse(renderGitlabCodeQuality(reportOf([finding({})]), noLine))[0]?.fingerprint;
    const otherRule = parse(
      renderGitlabCodeQuality(reportOf([finding({ rule: "githubArchived" })]), noLine),
    )[0]?.fingerprint;
    const otherPkg = parse(
      renderGitlabCodeQuality(reportOf([finding({ package: "other-pkg" })]), noLine),
    )[0]?.fingerprint;
    const otherFile: Report = {
      findings: [{ ...finding({}), file: "packages/a/package.json" }],
      warnings: [],
      checkedCount: 1,
    };
    const otherFileFp = parse(renderGitlabCodeQuality(otherFile, noLine))[0]?.fingerprint;
    expect(new Set([base, otherRule, otherPkg, otherFileFp]).size).toBe(4);
  });

  it("renders an empty array when there are no findings", () => {
    expect(renderGitlabCodeQuality(reportOf([]), noLine)).toBe("[]\n");
  });

  it("is newline-terminated, parseable JSON", () => {
    const text = renderGitlabCodeQuality(reportOf([finding({})]), noLine);
    expect(text.endsWith("\n")).toBe(true);
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
  });
});
