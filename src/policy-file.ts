/**
 * `.rn-doctor.yml` loading and validation.
 *
 * Parses the policy file with `yaml`, validates the untyped result with
 * explicit type guards (typo protection: unknown keys and bad values are
 * rejected with actionable messages), and merges partial user config over
 * {@link DEFAULT_POLICY}.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

import type { AllowEntry, Policy, PolicyRules, PolicyScope, RuleSeverity } from "./policy.js";
import { DEFAULT_POLICY } from "./policy.js";

/** The policy file name looked up in the working directory by default. */
export const DEFAULT_POLICY_FILENAME = ".rn-doctor.yml";

/**
 * A policy file could not be read or is invalid. Maps to exit code 2
 * (tool failure) in the CLI - a broken policy must never silently pass.
 */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const RULE_SEVERITIES: readonly RuleSeverity[] = ["error", "warn", "off"];
const SCOPES: readonly PolicyScope[] = ["rn-native-only", "all-deps"];
const RULE_KEYS: readonly (keyof PolicyRules)[] = [
  "newArchitecture",
  "newArchUnknown",
  "lastPublish",
  "githubArchived",
  "npmDeprecated",
  "directoryUnmaintained",
];
const TOP_LEVEL_KEYS = ["rules", "scope", "allow"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function fail(where: string, problem: string): never {
  throw new PolicyError(`Invalid policy${where}: ${problem}`);
}

function parseSeverity(value: unknown, key: string, where: string): RuleSeverity {
  if (typeof value === "string" && (RULE_SEVERITIES as readonly string[]).includes(value)) {
    return value as RuleSeverity;
  }
  return fail(where, `rules.${key} must be one of ${RULE_SEVERITIES.join(" | ")}, got ${JSON.stringify(value)}`);
}

function parseLastPublish(value: unknown, where: string): PolicyRules["lastPublish"] {
  if (value === "off") return "off";
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const unknown = keys.filter((k) => k !== "warnMonths" && k !== "errorMonths");
    if (unknown.length > 0) {
      fail(where, `rules.lastPublish has unknown key(s): ${unknown.join(", ")} (expected warnMonths, errorMonths)`);
    }
    const { warnMonths, errorMonths } = value;
    if (typeof warnMonths !== "number" || typeof errorMonths !== "number") {
      fail(where, `rules.lastPublish.warnMonths and .errorMonths must both be numbers`);
    }
    if (warnMonths < 0 || errorMonths < 0 || errorMonths < warnMonths) {
      fail(where, `rules.lastPublish thresholds must be >= 0 with errorMonths >= warnMonths`);
    }
    return { warnMonths, errorMonths };
  }
  return fail(where, `rules.lastPublish must be "off" or { warnMonths, errorMonths }, got ${JSON.stringify(value)}`);
}

function parseRules(value: unknown, where: string): PolicyRules {
  if (!isRecord(value)) {
    return fail(where, `"rules" must be a mapping, got ${JSON.stringify(value)}`);
  }
  const unknown = Object.keys(value).filter((k) => !(RULE_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    fail(where, `unknown rule(s): ${unknown.join(", ")} (known rules: ${RULE_KEYS.join(", ")})`);
  }
  const defaults = DEFAULT_POLICY.rules;
  const severity = (key: keyof PolicyRules, fallback: RuleSeverity): RuleSeverity =>
    key in value ? parseSeverity(value[key], key, where) : fallback;
  return {
    newArchitecture: severity("newArchitecture", defaults.newArchitecture),
    newArchUnknown: severity("newArchUnknown", defaults.newArchUnknown),
    lastPublish: "lastPublish" in value ? parseLastPublish(value.lastPublish, where) : defaults.lastPublish,
    githubArchived: severity("githubArchived", defaults.githubArchived),
    npmDeprecated: severity("npmDeprecated", defaults.npmDeprecated),
    directoryUnmaintained: severity("directoryUnmaintained", defaults.directoryUnmaintained),
  };
}

const EXPIRES_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseAllowEntry(value: unknown, index: number, where: string): AllowEntry {
  const at = `allow[${String(index)}]`;
  if (!isRecord(value)) {
    return fail(where, `${at} must be a mapping with a "package" key, got ${JSON.stringify(value)}`);
  }
  const unknown = Object.keys(value).filter((k) => k !== "package" && k !== "reason" && k !== "expires");
  if (unknown.length > 0) {
    fail(where, `${at} has unknown key(s): ${unknown.join(", ")} (expected package, reason, expires)`);
  }
  const pkg = value.package;
  if (typeof pkg !== "string" || pkg.length === 0) {
    fail(where, `${at}.package must be a non-empty string`);
  }
  const reason = value.reason;
  if (reason !== undefined && typeof reason !== "string") {
    fail(where, `${at}.reason must be a string when present`);
  }
  let expires = value.expires;
  // The yaml parser turns unquoted dates into Date objects; normalize back.
  if (expires instanceof Date && !Number.isNaN(expires.getTime())) {
    expires = expires.toISOString().slice(0, 10);
  }
  if (expires !== undefined && (typeof expires !== "string" || !EXPIRES_PATTERN.test(expires))) {
    fail(where, `${at}.expires must be a YYYY-MM-DD date when present, got ${JSON.stringify(value.expires)}`);
  }
  return {
    package: pkg,
    reason: typeof reason === "string" ? reason : null,
    expires: typeof expires === "string" ? expires : null,
  };
}

/**
 * Parse and validate policy YAML text into a complete {@link Policy}.
 *
 * Absent keys fall back to {@link DEFAULT_POLICY}; unknown keys and invalid
 * values throw {@link PolicyError} with the offending key named.
 *
 * @param yamlText - Raw contents of a `.rn-doctor.yml` file.
 * @param filePath - Optional path used to contextualize error messages.
 * @returns The validated policy, merged over the defaults.
 */
export function parsePolicy(yamlText: string, filePath?: string): Policy {
  const where = filePath ? ` (${filePath})` : "";

  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    return fail(where, `YAML syntax error - ${err instanceof Error ? err.message : String(err)}`);
  }

  if (raw === null || raw === undefined) return DEFAULT_POLICY;
  if (!isRecord(raw)) {
    return fail(where, `top level must be a mapping, got ${JSON.stringify(raw)}`);
  }

  const unknown = Object.keys(raw).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknown.length > 0) {
    fail(where, `unknown top-level key(s): ${unknown.join(", ")} (expected ${TOP_LEVEL_KEYS.join(", ")})`);
  }

  const rules = "rules" in raw ? parseRules(raw.rules, where) : DEFAULT_POLICY.rules;

  let scope: PolicyScope = DEFAULT_POLICY.scope;
  if ("scope" in raw) {
    const value = raw.scope;
    if (typeof value !== "string" || !(SCOPES as readonly string[]).includes(value)) {
      fail(where, `"scope" must be one of ${SCOPES.join(" | ")}, got ${JSON.stringify(value)}`);
    }
    scope = value as PolicyScope;
  }

  let allow: readonly AllowEntry[] = DEFAULT_POLICY.allow;
  if ("allow" in raw) {
    const value = raw.allow;
    if (!isList(value)) {
      return fail(where, `"allow" must be a list of entries, got ${JSON.stringify(value)}`);
    }
    allow = value.map((entry, i) => parseAllowEntry(entry, i, where));
  }

  return { rules, scope, allow };
}

/**
 * Load the effective policy from disk.
 *
 * @remarks
 * - With an explicit `path`: the file must exist - a missing file is a
 *   {@link PolicyError} (a CI run pointing at a typo'd path must not
 *   silently fall back to defaults).
 * - Without a `path`: looks for `.rn-doctor.yml` in `cwd`; if absent,
 *   returns {@link DEFAULT_POLICY}.
 *
 * @param path - Optional explicit policy file path.
 * @param cwd - Directory searched for the default file. Defaults to `process.cwd()`.
 * @returns The validated effective policy.
 */
export async function loadPolicy(path?: string, cwd: string = process.cwd()): Promise<Policy> {
  const explicit = path !== undefined;
  const filePath = explicit ? resolve(cwd, path) : resolve(cwd, DEFAULT_POLICY_FILENAME);

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !explicit) return DEFAULT_POLICY;
    throw new PolicyError(
      explicit && code === "ENOENT"
        ? `Policy file not found: ${filePath}. Check the --policy path.`
        : `Could not read policy file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parsePolicy(text, filePath);
}
