import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parsePolicy } from "./policy-file.js";

/**
 * Structural checks on the composite GitHub Action and the example files.
 * These cannot prove the action works on a live runner (that is the Phase 5
 * live acceptance), but they pin the contracts that would otherwise only
 * break in someone else's CI: the action must stay a valid composite, every
 * flag it emits must exist in the CLI, and inputs must never be interpolated
 * into the shell script.
 */

const read = (relPath: string) => readFile(new URL(`../${relPath}`, import.meta.url), "utf8");

interface CompositeStep {
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface ActionYml {
  readonly name: string;
  readonly inputs: Record<string, { readonly default?: string; readonly description?: string }>;
  readonly runs: { readonly using: string; readonly steps: readonly CompositeStep[] };
}

let actionText: string;
let action: ActionYml;
let runStep: CompositeStep;

beforeAll(async () => {
  actionText = await read("action/action.yml");
  action = parse(actionText) as ActionYml;
  const found = action.runs.steps.find((step) => typeof step.run === "string");
  if (!found) throw new Error("action.yml has no run step");
  runStep = found;
});

describe("action/action.yml", () => {
  it("is a valid composite action", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.name).toBe("React Native Doctor CI");
    expect(runStep.shell).toBe("bash");
  });

  it("references every declared input somewhere in its steps", () => {
    const stepsText = JSON.stringify(action.runs.steps);
    for (const name of Object.keys(action.inputs)) {
      expect(stepsText, `input "${name}" is declared but never used`).toContain(
        `\${{ inputs.${name} }}`,
      );
    }
  });

  it("never interpolates inputs into the shell script (injection guard)", () => {
    expect(runStep.run).not.toMatch(/\$\{\{/);
  });

  it("keeps expressions out of input descriptions (runner evaluates them)", () => {
    // GitHub evaluates ${{ }} in action metadata descriptions; contexts
    // like `github` are not available there and make the action unloadable.
    for (const [name, input] of Object.entries(action.inputs)) {
      expect(input.description ?? "", `input "${name}" description`).not.toMatch(/\$\{\{/);
    }
  });

  it("only emits flags the CLI actually parses", async () => {
    const cliSource = await read("src/cli-main.ts");
    const knownFlags = new Set(
      [...cliSource.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]),
    );
    const emittedFlags = [...(runStep.run ?? "").matchAll(/--[a-z][a-z-]+/g)]
      .map((match) => match[0])
      .filter((flag) => !flag.startsWith("--package") && flag !== "--yes");
    expect(emittedFlags.length).toBeGreaterThan(0);
    for (const flag of emittedFlags) {
      expect(knownFlags, `action emits ${flag}, which the CLI does not parse`).toContain(flag);
    }
  });

  it("runs the published package via npx --package (bin name differs)", () => {
    expect(runStep.run).toContain(
      'npx --yes --package "react-native-doctor-ci@$RN_DOCTOR_VERSION" rn-doctor',
    );
  });

  it("passes the token to the CLI as GITHUB_TOKEN", () => {
    expect(runStep.env?.GITHUB_TOKEN).toBe("${{ inputs.token }}");
  });
});

describe("example files", () => {
  it("example/rn-doctor.yml is a parseable workflow using the action", async () => {
    const workflow = parse(await read("example/rn-doctor.yml")) as {
      on: unknown;
      jobs: Record<string, { steps: readonly CompositeStep[] }>;
    };
    const steps = Object.values(workflow.jobs)[0]?.steps ?? [];
    const usesAction = steps.some((step) => step.uses?.includes("react-native-doctor-ci/action@"));
    expect(usesAction).toBe(true);
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout"));
    // changed-only needs history for the merge-base diff.
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("example/.rn-doctor.yml passes the real policy validator", async () => {
    const policy = parsePolicy(await read("example/.rn-doctor.yml"));
    expect(policy.scope).toBe("rn-native-only");
    expect(policy.allow).toHaveLength(1);
    expect(policy.allow[0]?.expires).toBe("2027-01-31");
  });
});
