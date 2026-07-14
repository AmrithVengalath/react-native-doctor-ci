import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "./policy.js";
import { renderPretty } from "./report-pretty.js";
import {
  LENIENT_WITH_ALLOWLIST,
  MATRIX_POLICIES,
  STRICT_ALL_DEPS,
  matrixReport,
} from "./testing/policy-matrix.js";

describe("renderPretty - human-readable output", () => {
  it.each(MATRIX_POLICIES)("8-fixture matrix under the %s policy", (_label, policy) => {
    expect(renderPretty(matrixReport(policy), { color: false })).toMatchSnapshot();
  });

  it("celebrates a clean run and counts the dependencies checked", () => {
    const text = renderPretty({ findings: [], warnings: [], checkedCount: 3 }, { color: false });
    expect(text).toBe("No findings across 3 dependencies.\n");
    expect(
      renderPretty({ findings: [], warnings: [], checkedCount: 1 }, { color: false }),
    ).toContain("1 dependency");
  });

  it("shows verdict, reason, and evidence link per finding", () => {
    // request is not RN-native, so its npmDeprecated finding needs all-deps scope.
    const text = renderPretty(matrixReport(STRICT_ALL_DEPS), { color: false });
    expect(text).toContain("error  request  [npmDeprecated]");
    expect(text).toContain("evidence: https://www.npmjs.com/package/request");
  });

  it("marks allowlist-suppressed findings and shows the allow reason", () => {
    const text = renderPretty(matrixReport(LENIENT_WITH_ALLOWLIST), { color: false });
    expect(text).toContain("allowed(warn)  react-native-markdown");
    expect(text).toContain("allowed by .rn-doctor.yml: migration planned Q4 2026, expires 2026-12-31");
  });

  it("renders enrichment warnings without hiding them", () => {
    const text = renderPretty(matrixReport(DEFAULT_POLICY), { color: false });
    expect(text).toContain("Data warnings");
    expect(text).toContain("[github] GitHub API rate limit reached");
    expect(text).toContain("[npm] left-pad: npm search returned no publish date");
  });

  it("groups findings by manifest and counts manifests in a --workspaces run", () => {
    const strict = matrixReport(STRICT_ALL_DEPS);
    const [first, ...rest] = strict.findings;
    if (first === undefined) throw new Error("matrix produced no findings");
    const report = {
      findings: [
        { ...first, file: "packages/a/package.json" },
        ...rest.map((f) => ({ ...f, file: "packages/b/package.json" })),
      ],
      warnings: [],
      checkedCount: strict.checkedCount * 2,
      manifestCount: 3,
    };
    const text = renderPretty(report, { color: false });
    expect(text).toContain("packages/a/package.json:\n");
    expect(text).toContain("packages/b/package.json:\n");
    expect(text).toContain("in 3 manifests.");
    // Each group header appears exactly once.
    expect(text.split("packages/b/package.json:\n")).toHaveLength(2);
  });

  it("keeps single-manifest output free of group headers", () => {
    const text = renderPretty(matrixReport(STRICT_ALL_DEPS), { color: false });
    expect(text).not.toContain("package.json:");
    expect(text).not.toContain("manifests");
  });

  it("emits ANSI codes only when color is on, with identical content", () => {
    const plain = renderPretty(matrixReport(DEFAULT_POLICY), { color: false });
    const colored = renderPretty(matrixReport(DEFAULT_POLICY), { color: true });
    const esc = String.fromCharCode(27);
    expect(plain).not.toContain(esc);
    expect(colored).toContain(`${esc}[31m`);
    // Stripping the codes recovers the plain rendering exactly.
    const stripped = colored.split(esc).map((seg, i) => (i === 0 ? seg : seg.replace(/^\[\d+m/, ""))).join("");
    expect(stripped).toBe(plain);
  });
});
