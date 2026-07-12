import { readFileSync } from "node:fs";

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "./policy.js";
import { renderSarif } from "./report-sarif.js";
import { LENIENT_WITH_ALLOWLIST, MATRIX_POLICIES, matrixReport } from "./testing/policy-matrix.js";

/**
 * The OASIS SARIF 2.1.0 schema (draft-07), vendored from
 * https://www.schemastore.org/sarif-2.1.0.json so the suite needs no network.
 */
const SCHEMA_URL = new URL("./testing/schemas/sarif-2.1.0.json", import.meta.url);

let validate: ValidateFunction;

beforeAll(() => {
  const schema: unknown = JSON.parse(readFileSync(SCHEMA_URL, "utf8"));
  // validateFormats off: format checking needs ajv-formats; the acceptance
  // criterion is structural validity against the SARIF schema.
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  validate = ajv.compile(schema as object);
});

/** Fixture line resolver: pretend every package sits on a distinct line. */
const LINES: Readonly<Record<string, number>> = {
  "react-native-webview": 10,
  request: 11,
  "react-native-htmltext": 12,
  "react-native-markdown": 13,
};
const lineOf = (name: string): number | null => LINES[name] ?? null;

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: {
    physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } };
  }[];
  suppressions?: { kind: string; status?: string; justification?: string }[];
}

interface SarifLog {
  version: string;
  runs: {
    tool: { driver: { name: string; rules: { id: string }[] } };
    invocations: { executionSuccessful: boolean; toolExecutionNotifications: unknown[] }[];
    results: SarifResult[];
  }[];
}

function render(policy: (typeof MATRIX_POLICIES)[number][1]): SarifLog {
  return JSON.parse(renderSarif(matrixReport(policy), { lineOf })) as SarifLog;
}

describe("renderSarif — validates against the SARIF 2.1.0 schema", () => {
  it.each(MATRIX_POLICIES)("8-fixture matrix under the %s policy", (_label, policy) => {
    const doc: unknown = JSON.parse(renderSarif(matrixReport(policy), { lineOf }));
    const valid = validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("an empty report still validates", () => {
    const doc: unknown = JSON.parse(
      renderSarif({ findings: [], warnings: [], checkedCount: 0 }, {}),
    );
    expect(validate(doc)).toBe(true);
  });
});

describe("renderSarif — content mapping", () => {
  it("maps severities to SARIF levels (error/warning/note)", () => {
    const log = render(DEFAULT_POLICY);
    const levels = new Set(log.runs[0]?.results.map((r) => r.level));
    expect([...levels].sort()).toEqual(["error", "note", "warning"]);
  });

  it("declares all six rules on the driver and uses consistent ruleIndex", () => {
    const log = render(DEFAULT_POLICY);
    const run = log.runs[0];
    const ruleIds = run?.tool.driver.rules.map((r) => r.id);
    expect(ruleIds).toEqual([
      "newArchitecture",
      "newArchUnknown",
      "lastPublish",
      "githubArchived",
      "npmDeprecated",
      "directoryUnmaintained",
    ]);
    for (const result of run?.results ?? []) {
      expect(ruleIds?.[result.ruleIndex]).toBe(result.ruleId);
    }
  });

  it("locates findings in package.json with the resolved line", () => {
    const log = render(DEFAULT_POLICY);
    const results = log.runs[0]?.results ?? [];
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const location = result.locations[0]?.physicalLocation;
      expect(location?.artifactLocation.uri).toBe("package.json");
      const text = result.message.text;
      const pkg = Object.keys(LINES).find((name) => text.includes(name));
      if (pkg !== undefined) {
        expect(location?.region?.startLine).toBe(LINES[pkg]);
      }
    }
  });

  it("omits the region when no line is resolvable", () => {
    const log = JSON.parse(renderSarif(matrixReport(DEFAULT_POLICY), {})) as SarifLog;
    for (const result of log.runs[0]?.results ?? []) {
      expect(result.locations[0]?.physicalLocation.region).toBeUndefined();
    }
  });

  it("marks allowlist-suppressed findings with an external accepted suppression", () => {
    const log = render(LENIENT_WITH_ALLOWLIST);
    const results = log.runs[0]?.results ?? [];
    const suppressed = results.filter((r) => r.suppressions !== undefined);
    expect(suppressed.length).toBeGreaterThan(0);
    for (const result of suppressed) {
      expect(result.message.text).toContain("react-native-markdown");
      expect(result.suppressions).toEqual([
        {
          kind: "external",
          status: "accepted",
          justification:
            "Allowlisted in .rn-doctor.yml: migration planned Q4 2026 (expires 2026-12-31)",
        },
      ]);
    }
    // Unsuppressed results must not carry a suppressions property at all.
    for (const result of results.filter((r) => !r.message.text.includes("react-native-markdown"))) {
      expect(result.suppressions).toBeUndefined();
    }
  });

  it("carries enrichment warnings as tool execution notifications", () => {
    const log = render(DEFAULT_POLICY);
    const invocation = log.runs[0]?.invocations[0];
    expect(invocation?.executionSuccessful).toBe(true);
    expect(invocation?.toolExecutionNotifications).toHaveLength(2);
  });

  it("is deterministic", () => {
    expect(renderSarif(matrixReport(DEFAULT_POLICY), { lineOf })).toBe(
      renderSarif(matrixReport(DEFAULT_POLICY), { lineOf }),
    );
  });
});
