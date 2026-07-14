import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "./policy.js";
import { DEFAULT_POLICY_FILENAME, PolicyError, loadPolicy, parsePolicy } from "./policy-file.js";

/** The documented sample from the project plan - must parse exactly. */
const SPEC_SAMPLE = `
rules:
  newArchitecture: error          # error | warn | off ; how to treat "unsupported"
  newArchUnknown: warn            # data missing -> warn by default
  lastPublish: { warnMonths: 12, errorMonths: 24 }
  githubArchived: error
  npmDeprecated: error
  directoryUnmaintained: warn     # RN Directory "unmaintained" flag
scope: rn-native-only             # rn-native-only | all-deps
allow:
  - package: react-native-legacy-thing
    reason: "fork planned Q3"
    expires: 2026-12-31           # expired allows become errors
`;

describe("parsePolicy", () => {
  it("parses the documented sample policy exactly", () => {
    expect(parsePolicy(SPEC_SAMPLE)).toEqual({
      rules: {
        newArchitecture: "error",
        newArchUnknown: "warn",
        lastPublish: { warnMonths: 12, errorMonths: 24 },
        githubArchived: "error",
        npmDeprecated: "error",
        directoryUnmaintained: "warn",
      },
      scope: "rn-native-only",
      allow: [
        { package: "react-native-legacy-thing", reason: "fork planned Q3", expires: "2026-12-31" },
      ],
    });
  });

  it("merges a partial file over the defaults", () => {
    const policy = parsePolicy("rules:\n  npmDeprecated: warn\n");
    expect(policy).toEqual({
      ...DEFAULT_POLICY,
      rules: { ...DEFAULT_POLICY.rules, npmDeprecated: "warn" },
    });
  });

  it("returns the defaults for an empty file", () => {
    expect(parsePolicy("")).toEqual(DEFAULT_POLICY);
    expect(parsePolicy("# just a comment\n")).toEqual(DEFAULT_POLICY);
  });

  it("accepts lastPublish: off", () => {
    expect(parsePolicy("rules:\n  lastPublish: off\n").rules.lastPublish).toBe("off");
  });

  it("allow entries default reason and expires to null", () => {
    const policy = parsePolicy("allow:\n  - package: react-native-thing\n");
    expect(policy.allow).toEqual([{ package: "react-native-thing", reason: null, expires: null }]);
  });

  describe("rejects invalid input with the offending key named", () => {
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ["bad severity", "rules:\n  npmDeprecated: fatal\n", /rules\.npmDeprecated/],
      ["unknown rule", "rules:\n  newArch: error\n", /unknown rule.*newArch/],
      ["unknown top-level key", "rule:\n  npmDeprecated: error\n", /unknown top-level key.*rule/],
      ["non-mapping top level", "- just\n- a\n- list\n", /top level must be a mapping/],
      ["bad scope", "scope: everything\n", /"scope" must be one of/],
      ["non-array allow", "allow: react-native-thing\n", /"allow" must be a list/],
      ["allow entry without package", 'allow:\n  - reason: "x"\n', /allow\[0\]\.package/],
      ["malformed expires", "allow:\n  - package: x\n    expires: soon\n", /allow\[0\]\.expires/],
      ["unknown allow key", "allow:\n  - package: x\n    why: because\n", /allow\[0\] has unknown key/],
      [
        "lastPublish thresholds inverted",
        "rules:\n  lastPublish: { warnMonths: 24, errorMonths: 12 }\n",
        /errorMonths >= warnMonths/,
      ],
      [
        "lastPublish non-numeric",
        "rules:\n  lastPublish: { warnMonths: twelve, errorMonths: 24 }\n",
        /must both be numbers/,
      ],
      ["YAML syntax error", "rules: [unclosed\n", /YAML syntax error/],
    ];

    it.each(cases)("%s", (_label, yamlText, messagePattern) => {
      expect(() => parsePolicy(yamlText)).toThrow(PolicyError);
      expect(() => parsePolicy(yamlText)).toThrow(messagePattern);
    });
  });

  it("includes the file path in error messages when provided", () => {
    expect(() => parsePolicy("scope: bogus\n", "/repo/.rn-doctor.yml")).toThrow(/\/repo\/\.rn-doctor\.yml/);
  });
});

describe("loadPolicy", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-policy-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the defaults when no policy file exists in cwd", async () => {
    await expect(loadPolicy(undefined, dir)).resolves.toEqual(DEFAULT_POLICY);
  });

  it("loads and validates the default-named file from cwd", async () => {
    await writeFile(join(dir, DEFAULT_POLICY_FILENAME), "scope: all-deps\n", "utf8");
    const policy = await loadPolicy(undefined, dir);
    expect(policy.scope).toBe("all-deps");
    expect(policy.rules).toEqual(DEFAULT_POLICY.rules);
  });

  it("fails loudly when an explicit path does not exist", async () => {
    await expect(loadPolicy("does-not-exist.yml", dir)).rejects.toThrow(PolicyError);
    await expect(loadPolicy("does-not-exist.yml", dir)).rejects.toThrow(/does-not-exist\.yml/);
  });

  it("propagates validation errors with the resolved path in the message", async () => {
    const file = join(dir, "broken.yml");
    await writeFile(file, "scope: bogus\n", "utf8");
    await expect(loadPolicy("broken.yml", dir)).rejects.toThrow(/"scope" must be one of/);
  });
});
