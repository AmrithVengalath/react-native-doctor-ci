import { describe, expect, it } from "vitest";

import type { Finding } from "./policy.js";
import { computeExitCode, summarize } from "./report.js";

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

describe("computeExitCode - exit-code contract", () => {
  it.each([
    ["an unsuppressed error", [finding({ severity: "error" })], 1],
    ["no findings", [], 0],
    ["only warnings", [finding({ severity: "warn" })], 0],
    ["only notes", [finding({ severity: "note" })], 0],
    [
      "an error suppressed by an active allow entry",
      [finding({ severity: "error", suppressedBy: { reason: "fork planned", expires: "2026-12-31" } })],
      0,
    ],
    [
      "a suppressed error alongside a live one",
      [
        finding({ severity: "error", suppressedBy: { reason: null, expires: null } }),
        finding({ severity: "error" }),
      ],
      1,
    ],
    ["warnings plus a suppressed error", [finding({ severity: "warn" }), finding({ severity: "error", suppressedBy: { reason: null, expires: null } })], 0],
  ] as const)("%s -> exit %i", (_label, findings, expected) => {
    expect(computeExitCode(findings)).toBe(expected);
  });
});

describe("summarize", () => {
  it("counts suppressed findings only under suppressed", () => {
    const findings = [
      finding({ severity: "error" }),
      finding({ severity: "error", suppressedBy: { reason: "r", expires: null } }),
      finding({ severity: "warn" }),
      finding({ severity: "warn", suppressedBy: { reason: null, expires: "2027-01-01" } }),
      finding({ severity: "note" }),
    ];
    expect(summarize(findings)).toEqual({ errors: 1, warnings: 1, notes: 1, suppressed: 2 });
  });

  it("is all zeros for an empty run", () => {
    expect(summarize([])).toEqual({ errors: 0, warnings: 0, notes: 0, suppressed: 0 });
  });
});
