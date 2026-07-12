/**
 * Policy engine: turns enriched dependency records into findings.
 *
 * Pure and deterministic — no I/O, no clock reads unless the caller omits
 * `options.now`. Reporters (Phase 3) consume the `Finding[]` output.
 *
 * @packageDocumentation
 */

import type { EnrichedDependency } from "./types.js";

/**
 * Identifier of a policy rule; also the `rule` field on emitted findings.
 */
export type RuleId =
  | "newArchitecture"
  | "newArchUnknown"
  | "lastPublish"
  | "githubArchived"
  | "npmDeprecated"
  | "directoryUnmaintained";

/**
 * Severity a rule can be configured to fire at. `off` disables the rule.
 */
export type RuleSeverity = "error" | "warn" | "off";

/**
 * Staleness thresholds for the `lastPublish` rule, in months since the
 * latest npm publish. `errorMonths` should be greater than `warnMonths`.
 */
export interface LastPublishThresholds {
  readonly warnMonths: number;
  readonly errorMonths: number;
}

/**
 * Which dependencies the policy applies to: only those detected as React
 * Native native modules, or every dependency.
 */
export type PolicyScope = "rn-native-only" | "all-deps";

/**
 * One allowlist entry: suppresses findings for `package` until `expires`.
 * An expired entry escalates the findings it used to suppress to `error`.
 */
export interface AllowEntry {
  /** Exact npm package name the entry applies to. */
  readonly package: string;
  /** Why the package is allowed (shown in reports). */
  readonly reason: string | null;
  /** `YYYY-MM-DD` (inclusive, UTC). `null` means the entry never expires. */
  readonly expires: string | null;
}

/**
 * Per-rule severity configuration.
 */
export interface PolicyRules {
  /** How to treat a package the RN Directory marks New-Architecture-unsupported. */
  readonly newArchitecture: RuleSeverity;
  /** How to treat a package whose New Architecture support cannot be determined. */
  readonly newArchUnknown: RuleSeverity;
  /** Staleness thresholds for the latest npm publish, or `off`. */
  readonly lastPublish: LastPublishThresholds | "off";
  /** How to treat a package whose GitHub repository is archived. */
  readonly githubArchived: RuleSeverity;
  /** How to treat a package deprecated on npm. */
  readonly npmDeprecated: RuleSeverity;
  /** How to treat a package the RN Directory flags as unmaintained. */
  readonly directoryUnmaintained: RuleSeverity;
}

/**
 * A complete policy: rule severities, scope, and the allowlist.
 */
export interface Policy {
  readonly rules: PolicyRules;
  readonly scope: PolicyScope;
  readonly allow: readonly AllowEntry[];
}

/**
 * The default policy, used when no `.rn-doctor.yml` is present.
 * Matches the documented sample: hard failures for clearly-dead signals,
 * warnings where data is merely missing (honest, not alarmist).
 */
export const DEFAULT_POLICY: Policy = {
  rules: {
    newArchitecture: "error",
    newArchUnknown: "warn",
    lastPublish: { warnMonths: 12, errorMonths: 24 },
    githubArchived: "error",
    npmDeprecated: "error",
    directoryUnmaintained: "warn",
  },
  scope: "rn-native-only",
  allow: [],
};

/**
 * Severity of an emitted finding. `note` is informational — it never fails
 * the run and is not subject to allowlisting.
 */
export type FindingSeverity = "error" | "warn" | "note";

/**
 * A single policy violation (or informational note) for one dependency.
 */
export interface Finding {
  /** npm package name the finding is about. */
  readonly package: string;
  /** The rule that produced the finding. */
  readonly rule: RuleId;
  /** Effective severity after allowlist processing. */
  readonly severity: FindingSeverity;
  /** Human-readable verdict + reason + what to do about it. */
  readonly message: string;
  /** Link to the evidence backing the verdict, when one exists. */
  readonly evidenceUrl: string | null;
  /**
   * Set when an active allowlist entry suppresses this finding. Suppressed
   * findings keep their severity for display but must not fail the run.
   */
  readonly suppressedBy: { readonly reason: string | null; readonly expires: string | null } | null;
}

/**
 * Options for {@link evaluatePolicy}.
 */
export interface EvaluateOptions {
  /** Clock used for staleness and allowlist expiry. Defaults to `new Date()`. */
  readonly now?: Date;
}

/** Mean Gregorian month in milliseconds; used for publish-age thresholds. */
const MEAN_MONTH_MS = (365.2425 / 12) * 24 * 60 * 60 * 1000;

/** How an allowlist entry applies to a package's findings. */
type AllowState =
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly entry: AllowEntry }
  | { readonly kind: "expired"; readonly entry: AllowEntry };

function allowStateFor(name: string, allow: readonly AllowEntry[], now: Date): AllowState {
  const entry = allow.find((a) => a.package === name);
  if (!entry) return { kind: "none" };
  if (entry.expires === null) return { kind: "active", entry };
  // The expiry day is inclusive in UTC: the entry stops applying the next day.
  const expiryEnd = Date.parse(`${entry.expires}T23:59:59.999Z`);
  return now.getTime() <= expiryEnd ? { kind: "active", entry } : { kind: "expired", entry };
}

function allowHint(name: string): string {
  return (
    `If this is intentional, allowlist it in .rn-doctor.yml: ` +
    `{ package: ${name}, reason: "<why>", expires: YYYY-MM-DD }.`
  );
}

function directoryUrl(name: string): string {
  return `https://reactnative.directory/?search=${encodeURIComponent(name)}`;
}

function npmUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

/**
 * A raw rule hit before allowlist processing.
 */
interface RuleHit {
  readonly rule: RuleId;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly evidenceUrl: string | null;
}

function evaluateRules(dep: EnrichedDependency, rules: PolicyRules, now: Date): RuleHit[] {
  const hits: RuleHit[] = [];
  const name = dep.name;

  // newArchitecture — directory says "unsupported", or unknown-with-codegen note.
  if (rules.newArchitecture !== "off") {
    if (dep.newArch.tier === "unsupported") {
      hits.push({
        rule: "newArchitecture",
        severity: rules.newArchitecture,
        message:
          `${name} does not support the React Native New Architecture ` +
          `(RN Directory verdict: unsupported). Look for a maintained alternative ` +
          `or check the repo for New Architecture plans. ${allowHint(name)}`,
        evidenceUrl: directoryUrl(name),
      });
    } else if (dep.newArch.tier === "passWithNote") {
      hits.push({
        rule: "newArchitecture",
        severity: "note",
        message:
          `${name} is not listed in the RN Directory, but its npm package ships a ` +
          `codegenConfig, which indicates New Architecture support. Treating as a pass; ` +
          `verify manually if this dependency is critical.`,
        evidenceUrl: npmUrl(name),
      });
    }
  }

  // newArchUnknown — no directory verdict and no codegen hint.
  if (rules.newArchUnknown !== "off" && dep.newArch.tier === "unknown") {
    hits.push({
      rule: "newArchUnknown",
      severity: rules.newArchUnknown,
      message:
        `New Architecture support for ${name} is unknown: it is not listed in the ` +
        `RN Directory and its npm package has no codegen hints. Verify support ` +
        `manually (check the repo README/releases). ${allowHint(name)}`,
      evidenceUrl: directoryUrl(name),
    });
  }

  // lastPublish — staleness of the latest npm publish.
  if (rules.lastPublish !== "off" && dep.lastPublish.known) {
    const publishedAt = Date.parse(dep.lastPublish.value.date);
    if (!Number.isNaN(publishedAt)) {
      const ageMonths = (now.getTime() - publishedAt) / MEAN_MONTH_MS;
      const { warnMonths, errorMonths } = rules.lastPublish;
      const band: FindingSeverity | null =
        ageMonths >= errorMonths ? "error" : ageMonths >= warnMonths ? "warn" : null;
      if (band !== null) {
        const threshold = band === "error" ? errorMonths : warnMonths;
        hits.push({
          rule: "lastPublish",
          severity: band,
          message:
            `${name} was last published ${String(Math.floor(ageMonths))} months ago ` +
            `(${dep.lastPublish.value.date.slice(0, 10)}), exceeding the ` +
            `${String(threshold)}-month threshold. Check whether it is abandoned; ` +
            `consider a maintained fork, or let renovate surface a replacement. ` +
            allowHint(name),
          evidenceUrl: npmUrl(name),
        });
      }
    }
  }

  // githubArchived — the repository is read-only.
  if (rules.githubArchived !== "off" && dep.github.archived.known && dep.github.archived.value) {
    hits.push({
      rule: "githubArchived",
      severity: rules.githubArchived,
      message:
        `The GitHub repository for ${name} is archived (read-only): no fixes or ` +
        `releases will land. Replace it or pin a fork. ${allowHint(name)}`,
      evidenceUrl: dep.github.repoUrl ?? npmUrl(name),
    });
  }

  // npmDeprecated — the package owner marked it deprecated.
  if (rules.npmDeprecated !== "off" && dep.npm.deprecated.known && dep.npm.deprecated.value.deprecated) {
    const upstream = dep.npm.deprecated.value.message;
    hits.push({
      rule: "npmDeprecated",
      severity: rules.npmDeprecated,
      message:
        `${name} is deprecated on npm` +
        (upstream ? `: "${upstream}"` : "") +
        `. Follow the deprecation notice to migrate. ${allowHint(name)}`,
      evidenceUrl: npmUrl(name),
    });
  }

  // directoryUnmaintained — RN Directory's own unmaintained flag.
  if (rules.directoryUnmaintained !== "off" && dep.directory.listed && dep.directory.unmaintained) {
    hits.push({
      rule: "directoryUnmaintained",
      severity: rules.directoryUnmaintained,
      message:
        `${name} is flagged as unmaintained in the RN Directory. Plan a migration ` +
        `to a maintained alternative. ${allowHint(name)}`,
      evidenceUrl: directoryUrl(name),
    });
  }

  return hits;
}

/**
 * Evaluate a policy against enriched dependencies and produce findings.
 *
 * @remarks
 * Pure: same inputs (including `options.now`) always yield the same output,
 * in a stable order (input dependency order, then a fixed rule order).
 *
 * Allowlist semantics: an **active** entry keeps the finding visible but sets
 * {@link Finding.suppressedBy} (reporters must not fail the run on suppressed
 * findings); an **expired** entry escalates the finding to `error` and says
 * so in the message. `note` findings are informational and unaffected.
 *
 * @param dependencies - Enriched records from the enrichment engine.
 * @param policy - The effective policy (see {@link DEFAULT_POLICY}).
 * @param options - Evaluation options; inject `now` for deterministic output.
 * @returns All findings, unfiltered — including suppressed ones.
 */
export function evaluatePolicy(
  dependencies: readonly EnrichedDependency[],
  policy: Policy,
  options: EvaluateOptions = {},
): readonly Finding[] {
  const now = options.now ?? new Date();
  const findings: Finding[] = [];

  for (const dep of dependencies) {
    if (policy.scope === "rn-native-only" && !dep.isRnNative) continue;

    const allowState = allowStateFor(dep.name, policy.allow, now);

    for (const hit of evaluateRules(dep, policy.rules, now)) {
      if (hit.severity === "note" || allowState.kind === "none") {
        findings.push({ package: dep.name, ...hit, suppressedBy: null });
      } else if (allowState.kind === "active") {
        findings.push({
          package: dep.name,
          ...hit,
          suppressedBy: {
            reason: allowState.entry.reason,
            expires: allowState.entry.expires,
          },
        });
      } else {
        // Expired allow: the grace period is over — escalate to error.
        const { entry } = allowState;
        findings.push({
          package: dep.name,
          rule: hit.rule,
          severity: "error",
          message:
            `${hit.message} NOTE: the allowlist entry for ${dep.name}` +
            (entry.reason ? ` ("${entry.reason}")` : "") +
            ` expired on ${entry.expires ?? "?"} — escalated to error. ` +
            `Renew the entry with a new expiry, or remove the dependency.`,
          evidenceUrl: hit.evidenceUrl,
          suppressedBy: null,
        });
      }
    }
  }

  return findings;
}
