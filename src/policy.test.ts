import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, evaluatePolicy } from "./policy.js";
import type { Policy, PolicyRules, RuleSeverity } from "./policy.js";
import type { EnrichedDependency } from "./types.js";
import { ENRICHED_FIXTURES, FIXTURE_PACKAGE_NAMES } from "./testing/fixture-packages.js";

/** Frozen clock: all staleness and expiry math in this suite is relative to this. */
const NOW = new Date("2026-07-12T00:00:00.000Z");

type DeepWritable<T> = { -readonly [K in keyof T]: DeepWritable<T[K]> };

function fixture(name: string): EnrichedDependency {
  const record = ENRICHED_FIXTURES[name];
  if (!record) throw new Error(`missing fixture: ${name}`);
  return record;
}

/**
 * Clone the healthy fixture (no findings under the default policy) and let the
 * caller flip exactly the signals the rule under test needs.
 */
function makeEnriched(mutate?: (d: DeepWritable<EnrichedDependency>) => void): EnrichedDependency {
  const clone = structuredClone(fixture(FIXTURE_PACKAGE_NAMES.healthy)) as DeepWritable<EnrichedDependency>;
  mutate?.(clone);
  return clone;
}

/** All rules disabled — the baseline for isolating a single rule per test. */
const ALL_OFF: PolicyRules = {
  newArchitecture: "off",
  newArchUnknown: "off",
  lastPublish: "off",
  githubArchived: "off",
  npmDeprecated: "off",
  directoryUnmaintained: "off",
};

function policyOf(rules: PolicyRules, extra?: Partial<Omit<Policy, "rules">>): Policy {
  return { rules, scope: "rn-native-only", allow: [], ...extra };
}

describe("evaluatePolicy — every rule × every severity", () => {
  interface SeverityRuleCase {
    readonly rule: string;
    readonly arrange: (d: DeepWritable<EnrichedDependency>) => void;
    readonly configure: (severity: RuleSeverity) => PolicyRules;
  }

  const severityRules: readonly SeverityRuleCase[] = [
    {
      rule: "newArchitecture",
      arrange: (d) => {
        d.newArch.tier = "unsupported";
      },
      configure: (s) => ({ ...ALL_OFF, newArchitecture: s }),
    },
    {
      rule: "newArchUnknown",
      arrange: (d) => {
        d.newArch.tier = "unknown";
      },
      configure: (s) => ({ ...ALL_OFF, newArchUnknown: s }),
    },
    {
      rule: "githubArchived",
      arrange: (d) => {
        d.github.archived = { known: true, value: true, source: "github-api" };
      },
      configure: (s) => ({ ...ALL_OFF, githubArchived: s }),
    },
    {
      rule: "npmDeprecated",
      arrange: (d) => {
        d.npm.deprecated = {
          known: true,
          value: { deprecated: true, message: "use something-else instead" },
          source: "npm",
        };
      },
      configure: (s) => ({ ...ALL_OFF, npmDeprecated: s }),
    },
    {
      rule: "directoryUnmaintained",
      arrange: (d) => {
        d.directory.unmaintained = true;
      },
      configure: (s) => ({ ...ALL_OFF, directoryUnmaintained: s }),
    },
  ];

  const firingSeverities: readonly ["error" | "warn"][] = [["error"], ["warn"]];

  for (const { rule, arrange, configure } of severityRules) {
    it.each(firingSeverities)(`${rule} fires at severity %s`, (severity) => {
      const dep = makeEnriched(arrange);
      const findings = evaluatePolicy([dep], policyOf(configure(severity)), { now: NOW });

      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding?.rule).toBe(rule);
      expect(finding?.severity).toBe(severity);
      expect(finding?.package).toBe(dep.name);
      expect(finding?.suppressedBy).toBeNull();
      // Actionable: names the package and links evidence.
      expect(finding?.message).toContain(dep.name);
      expect(finding?.evidenceUrl).toMatch(/^https:\/\//);
    });

    it(`${rule} is silent when off`, () => {
      const dep = makeEnriched(arrange);
      const findings = evaluatePolicy([dep], policyOf(configure("off")), { now: NOW });
      expect(findings).toEqual([]);
    });

    it(`${rule} does not fire on a healthy dependency`, () => {
      const findings = evaluatePolicy([makeEnriched()], policyOf(configure("error")), { now: NOW });
      expect(findings).toEqual([]);
    });
  }

  describe("lastPublish thresholds", () => {
    const withPublishDate = (date: string) =>
      makeEnriched((d) => {
        d.lastPublish = { known: true, value: { date }, source: "npm-search" };
      });
    const thresholds = { warnMonths: 12, errorMonths: 24 } as const;
    const policy = policyOf({ ...ALL_OFF, lastPublish: thresholds });

    it("is silent for a fresh publish", () => {
      const findings = evaluatePolicy([withPublishDate("2026-06-20T00:00:00.000Z")], policy, { now: NOW });
      expect(findings).toEqual([]);
    });

    it("warns between warnMonths and errorMonths", () => {
      const findings = evaluatePolicy([withPublishDate("2025-06-01T00:00:00.000Z")], policy, { now: NOW });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("lastPublish");
      expect(findings[0]?.severity).toBe("warn");
      expect(findings[0]?.message).toContain("12-month threshold");
    });

    it("errors beyond errorMonths", () => {
      const findings = evaluatePolicy([withPublishDate("2024-01-01T00:00:00.000Z")], policy, { now: NOW });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("error");
      expect(findings[0]?.message).toContain("24-month threshold");
    });

    it("is silent when the publish date is unknown (degrade honestly, never alarm)", () => {
      const dep = makeEnriched((d) => {
        d.lastPublish = { known: false, reason: "not-in-directory" };
      });
      expect(evaluatePolicy([dep], policy, { now: NOW })).toEqual([]);
    });

    it("is silent when off, even for an ancient publish", () => {
      const findings = evaluatePolicy(
        [withPublishDate("2015-01-01T00:00:00.000Z")],
        policyOf({ ...ALL_OFF, lastPublish: "off" }),
        { now: NOW },
      );
      expect(findings).toEqual([]);
    });
  });

  describe("newArchitecture passWithNote tier", () => {
    const codegenDep = () => fixture(FIXTURE_PACKAGE_NAMES.unknownWithCodegen);

    it("emits an informational note (never fails the run)", () => {
      const findings = evaluatePolicy(
        [codegenDep()],
        policyOf({ ...ALL_OFF, newArchitecture: "error" }),
        { now: NOW },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("newArchitecture");
      expect(findings[0]?.severity).toBe("note");
      expect(findings[0]?.message).toContain("codegenConfig");
    });

    it("is silenced when newArchitecture is off", () => {
      const findings = evaluatePolicy([codegenDep()], policyOf(ALL_OFF), { now: NOW });
      expect(findings).toEqual([]);
    });

    it("is not escalated by an expired allowlist entry (notes are not violations)", () => {
      const findings = evaluatePolicy(
        [codegenDep()],
        policyOf(
          { ...ALL_OFF, newArchitecture: "error" },
          { allow: [{ package: codegenDep().name, reason: "x", expires: "2020-01-01" }] },
        ),
        { now: NOW },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("note");
      expect(findings[0]?.suppressedBy).toBeNull();
    });
  });
});

describe("evaluatePolicy — scope", () => {
  // `request` is npm-deprecated but not an RN native module.
  const nonNative = fixture(FIXTURE_PACKAGE_NAMES.deprecated);

  it("rn-native-only skips dependencies that are not RN native", () => {
    const findings = evaluatePolicy([nonNative], DEFAULT_POLICY, { now: NOW });
    expect(findings).toEqual([]);
  });

  it("all-deps evaluates everything", () => {
    const findings = evaluatePolicy(
      [nonNative],
      { ...DEFAULT_POLICY, scope: "all-deps" },
      { now: NOW },
    );
    expect(findings.map((f) => f.rule)).toContain("npmDeprecated");
  });
});

describe("evaluatePolicy — allowlist", () => {
  const archived = () =>
    makeEnriched((d) => {
      d.github.archived = { known: true, value: true, source: "github-api" };
    });
  const rules: PolicyRules = { ...ALL_OFF, githubArchived: "error" };

  it("an active entry suppresses (severity preserved, suppressedBy set)", () => {
    const dep = archived();
    const findings = evaluatePolicy(
      [dep],
      policyOf(rules, { allow: [{ package: dep.name, reason: "fork planned Q3", expires: "2026-12-31" }] }),
      { now: NOW },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.suppressedBy).toEqual({ reason: "fork planned Q3", expires: "2026-12-31" });
  });

  it("an entry without expiry never expires", () => {
    const dep = archived();
    const findings = evaluatePolicy(
      [dep],
      policyOf(rules, { allow: [{ package: dep.name, reason: null, expires: null }] }),
      { now: NOW },
    );
    expect(findings[0]?.suppressedBy).toEqual({ reason: null, expires: null });
  });

  it("the expiry day itself is still active (inclusive, UTC)", () => {
    const dep = archived();
    const findings = evaluatePolicy(
      [dep],
      policyOf(rules, { allow: [{ package: dep.name, reason: null, expires: "2026-07-12" }] }),
      { now: NOW },
    );
    expect(findings[0]?.suppressedBy).not.toBeNull();
  });

  it("an expired entry escalates the finding to error and says so", () => {
    const dep = archived();
    const findings = evaluatePolicy(
      [dep],
      policyOf(
        { ...ALL_OFF, githubArchived: "warn" }, // would only warn without the expired allow
        { allow: [{ package: dep.name, reason: "fork planned Q3", expires: "2026-07-11" }] },
      ),
      { now: NOW },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.suppressedBy).toBeNull();
    expect(findings[0]?.message).toContain("expired on 2026-07-11");
    expect(findings[0]?.message).toContain("fork planned Q3");
  });

  it("an entry for a package with no findings emits nothing", () => {
    const findings = evaluatePolicy(
      [makeEnriched()],
      policyOf(rules, { allow: [{ package: "react-native-webview", reason: null, expires: null }] }),
      { now: NOW },
    );
    expect(findings).toEqual([]);
  });

  it("does not leak onto other packages", () => {
    const dep = archived();
    const findings = evaluatePolicy(
      [dep],
      policyOf(rules, { allow: [{ package: "some-other-package", reason: null, expires: null }] }),
      { now: NOW },
    );
    expect(findings[0]?.suppressedBy).toBeNull();
  });
});

describe("evaluatePolicy — 8-fixture matrix under 3 policies (snapshots)", () => {
  const matrix = Object.values(FIXTURE_PACKAGE_NAMES).map((name) => fixture(name));

  const STRICT_ALL_DEPS: Policy = {
    scope: "all-deps",
    rules: {
      newArchitecture: "error",
      newArchUnknown: "error",
      lastPublish: { warnMonths: 6, errorMonths: 12 },
      githubArchived: "error",
      npmDeprecated: "error",
      directoryUnmaintained: "error",
    },
    allow: [],
  };

  const LENIENT_WITH_ALLOWLIST: Policy = {
    scope: "rn-native-only",
    rules: {
      newArchitecture: "warn",
      newArchUnknown: "off",
      lastPublish: { warnMonths: 24, errorMonths: 48 },
      githubArchived: "warn",
      npmDeprecated: "warn",
      directoryUnmaintained: "warn",
    },
    allow: [
      // Active through 2026-12-31: suppresses react-native-markdown's findings.
      { package: "react-native-markdown", reason: "migration planned Q4 2026", expires: "2026-12-31" },
      // Expired: react-native-htmltext's findings escalate to error.
      { package: "react-native-htmltext", reason: "fork planned Q3 2025", expires: "2026-01-01" },
    ],
  };

  const policies: readonly (readonly [string, Policy])[] = [
    ["default", DEFAULT_POLICY],
    ["strict-all-deps", STRICT_ALL_DEPS],
    ["lenient-with-allowlist", LENIENT_WITH_ALLOWLIST],
  ];

  it.each(policies)("findings under the %s policy", (_label, policy) => {
    expect(evaluatePolicy(matrix, policy, { now: NOW })).toMatchSnapshot();
  });

  it("output is deterministic and stable-ordered", () => {
    const first = evaluatePolicy(matrix, DEFAULT_POLICY, { now: NOW });
    const second = evaluatePolicy([...matrix], DEFAULT_POLICY, { now: NOW });
    expect(second).toEqual(first);
    // Findings follow input dependency order.
    const packageOrder = [...new Set(first.map((f) => f.package))];
    const inputOrder = matrix.map((d) => d.name).filter((n) => packageOrder.includes(n));
    expect(packageOrder).toEqual(inputOrder);
  });
});
