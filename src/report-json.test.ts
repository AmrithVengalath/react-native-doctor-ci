import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "./policy.js";
import { renderJson } from "./report-json.js";
import { LENIENT_WITH_ALLOWLIST, MATRIX_POLICIES, matrixReport } from "./testing/policy-matrix.js";

describe("renderJson — stable-ordered machine output", () => {
  it.each(MATRIX_POLICIES)("8-fixture matrix under the %s policy", (_label, policy) => {
    expect(renderJson(matrixReport(policy))).toMatchSnapshot();
  });

  it("parses back as JSON with the documented top-level shape", () => {
    const doc: unknown = JSON.parse(renderJson(matrixReport(DEFAULT_POLICY)));
    expect(Object.keys(doc as Record<string, unknown>)).toEqual([
      "version",
      "summary",
      "findings",
      "warnings",
    ]);
    const summary = (doc as { summary: Record<string, unknown> }).summary;
    expect(Object.keys(summary)).toEqual(["checked", "errors", "warnings", "notes", "suppressed"]);
  });

  it("is byte-identical across repeated renders (snapshot-safe)", () => {
    expect(renderJson(matrixReport(LENIENT_WITH_ALLOWLIST))).toBe(
      renderJson(matrixReport(LENIENT_WITH_ALLOWLIST)),
    );
  });

  it("contains no timestamps or environment-dependent values", () => {
    const text = renderJson(matrixReport(DEFAULT_POLICY));
    // A full ISO timestamp in the document would leak wall-clock state.
    expect(text).not.toMatch(/"generatedAt"|"timestamp"|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("ends with a newline", () => {
    expect(renderJson(matrixReport(DEFAULT_POLICY)).endsWith("\n")).toBe(true);
  });
});
