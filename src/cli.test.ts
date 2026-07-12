import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./cli-main.js";
import type { CliIo } from "./cli-main.js";
import { findDependencyLine } from "./package-json.js";
import { createMswServer } from "./testing/msw-server.js";
import { FIXTURE_PACKAGE_NAMES } from "./testing/fixture-packages.js";
import { MATRIX_NOW } from "./testing/policy-matrix.js";
import { VERSION } from "./version.js";

const server = createMswServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Captures writes so assertions can inspect exactly what the CLI printed. */
interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function makeIo(cwd: string, env: Record<string, string | undefined> = {}): CapturedIo {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          out += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          err += chunk;
        },
      },
      cwd,
      env,
      now: MATRIX_NOW,
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/**
 * A project manifest over four fixture packages: one healthy, one deprecated
 * (not RN-native), one with an archived repo, one New-Arch-unsupported.
 */
const MANIFEST_TEXT = `{
  "name": "example-app",
  "private": true,
  "dependencies": {
    "${FIXTURE_PACKAGE_NAMES.healthy}": "^14.0.1",
    "${FIXTURE_PACKAGE_NAMES.deprecated}": "^2.88.2",
    "${FIXTURE_PACKAGE_NAMES.archived}": "^0.7.2",
    "${FIXTURE_PACKAGE_NAMES.stale24mo}": "^0.3.1"
  }
}
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rn-doctor-cli-"));
  await writeFile(join(dir, "package.json"), MANIFEST_TEXT, "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runCli — flag handling (no network)", () => {
  it("--version prints the version and exits 0", async () => {
    const { io, stdout } = makeIo(dir);
    expect(await runCli(["--version"], io)).toBe(0);
    expect(stdout()).toBe(`${VERSION}\n`);
  });

  it("--help prints usage and exits 0", async () => {
    const { io, stdout } = makeIo(dir);
    expect(await runCli(["--help"], io)).toBe(0);
    expect(stdout()).toContain("Usage:");
    expect(stdout()).toContain("Exit codes:");
  });

  it("rejects unknown flags with exit 2 and usage on stderr", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--bogus"], io)).toBe(2);
    expect(stderr()).toContain("--bogus");
    expect(stderr()).toContain("Usage:");
  });

  it("rejects --json with --sarif (exit 2)", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--json", "--sarif"], io)).toBe(2);
    expect(stderr()).toContain("mutually exclusive");
  });

  it("rejects --annotations with --no-annotations (exit 2)", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--annotations", "--no-annotations"], io)).toBe(2);
    expect(stderr()).toContain("mutually exclusive");
  });
});

describe("runCli — tool failures (exit 2)", () => {
  it("fails actionably when package.json is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "rn-doctor-empty-"));
    try {
      const { io, stderr } = makeIo(empty);
      expect(await runCli(["--no-cache"], io)).toBe(2);
      expect(stderr()).toContain("No package.json found");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("fails when an explicit --policy path does not exist", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--no-cache", "--policy", "missing.yml"], io)).toBe(2);
    expect(stderr()).toMatch(/rn-doctor: .*missing\.yml/);
  });

  it("fails when the policy file is invalid", async () => {
    await writeFile(join(dir, ".rn-doctor.yml"), "rules:\n  nonsenseRule: error\n", "utf8");
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--no-cache"], io)).toBe(2);
    expect(stderr()).toContain("nonsenseRule");
  });
});

describe("runCli — end-to-end (enrich -> policy -> report)", () => {
  it("default policy, pretty output: reports findings and exits 1", async () => {
    const { io, stdout, stderr } = makeIo(dir);
    const code = await runCli(["--no-cache"], io);

    expect(stderr()).toBe("");
    // Archived repo and New-Arch-unsupported are errors under the default policy.
    expect(stdout()).toContain(`error  ${FIXTURE_PACKAGE_NAMES.archived}  [githubArchived]`);
    expect(stdout()).toContain(`error  ${FIXTURE_PACKAGE_NAMES.stale24mo}  [newArchitecture]`);
    // `request` is not RN-native, so rn-native-only scope skips it.
    expect(stdout()).not.toContain("[npmDeprecated]");
    expect(stdout()).toContain("across 4 dependencies.");
    expect(code).toBe(1);
  });

  it("a policy with every rule off is clean and exits 0", async () => {
    await writeFile(
      join(dir, ".rn-doctor.yml"),
      [
        "rules:",
        "  newArchitecture: off",
        "  newArchUnknown: off",
        "  lastPublish: off",
        "  githubArchived: off",
        "  npmDeprecated: off",
        "  directoryUnmaintained: off",
        "",
      ].join("\n"),
      "utf8",
    );
    const { io, stdout } = makeIo(dir);
    expect(await runCli(["--no-cache"], io)).toBe(0);
    expect(stdout()).toContain("No findings across 4 dependencies.");
  });

  it("allowlisted errors are shown as allowed and do not fail the run", async () => {
    await writeFile(
      join(dir, ".rn-doctor.yml"),
      [
        "allow:",
        `  - package: ${FIXTURE_PACKAGE_NAMES.archived}`,
        '    reason: "fork planned"',
        "    expires: 2026-12-31",
        `  - package: ${FIXTURE_PACKAGE_NAMES.stale24mo}`,
        '    reason: "migration planned"',
        "    expires: 2026-12-31",
        "",
      ].join("\n"),
      "utf8",
    );
    const { io, stdout } = makeIo(dir);
    const code = await runCli(["--no-cache"], io);
    expect(stdout()).toContain("allowed by .rn-doctor.yml: fork planned, expires 2026-12-31");
    expect(code).toBe(0);
  });

  it("--json emits the stable document and still exits 1 on errors", async () => {
    const { io, stdout } = makeIo(dir);
    const code = await runCli(["--no-cache", "--json"], io);

    const doc = JSON.parse(stdout()) as {
      version: number;
      summary: { checked: number; errors: number };
      findings: { package: string; rule: string }[];
      warnings: unknown[];
    };
    expect(doc.version).toBe(1);
    expect(doc.summary.checked).toBe(4);
    expect(doc.summary.errors).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it("--sarif emits SARIF 2.1.0 with regions matching the real manifest lines", async () => {
    const { io, stdout } = makeIo(dir);
    const code = await runCli(["--no-cache", "--sarif"], io);

    const doc = JSON.parse(stdout()) as {
      version: string;
      runs: {
        results: {
          ruleId: string;
          message: { text: string };
          locations: { physicalLocation: { region?: { startLine: number } } }[];
        }[];
      }[];
    };
    expect(doc.version).toBe("2.1.0");

    const archived = doc.runs[0]?.results.find((r) => r.ruleId === "githubArchived");
    expect(archived).toBeDefined();
    const expectedLine = findDependencyLine(MANIFEST_TEXT, FIXTURE_PACKAGE_NAMES.archived);
    expect(expectedLine).not.toBeNull();
    expect(archived?.locations[0]?.physicalLocation.region?.startLine).toBe(expectedLine);
    expect(code).toBe(1);
  });

  it("runs with zero dependencies: clean report, exit 0", async () => {
    await writeFile(join(dir, "package.json"), '{ "name": "bare" }\n', "utf8");
    const { io, stdout } = makeIo(dir);
    expect(await runCli(["--no-cache"], io)).toBe(0);
    expect(stdout()).toContain("No findings across 0 dependencies.");
  });
});

describe("runCli — GitHub annotations", () => {
  it("auto-emits workflow commands when GITHUB_ACTIONS=true", async () => {
    const { io, stdout } = makeIo(dir, { GITHUB_ACTIONS: "true" });
    await runCli(["--no-cache"], io);

    const line = findDependencyLine(MANIFEST_TEXT, FIXTURE_PACKAGE_NAMES.archived);
    expect(stdout()).toContain(`::error file=package.json,line=${String(line)},title=`);
  });

  it("--no-annotations disables them even in GitHub Actions", async () => {
    const { io, stdout } = makeIo(dir, { GITHUB_ACTIONS: "true" });
    await runCli(["--no-cache", "--no-annotations"], io);
    expect(stdout()).not.toContain("::error");
  });

  it("--annotations forces them outside GitHub Actions", async () => {
    const { io, stdout } = makeIo(dir);
    await runCli(["--no-cache", "--annotations"], io);
    expect(stdout()).toContain("::error file=package.json,");
  });

  it("annotation commands never appear in --json or --sarif output", async () => {
    const { io, stdout } = makeIo(dir, { GITHUB_ACTIONS: "true" });
    await runCli(["--no-cache", "--json"], io);
    expect(stdout()).not.toContain("::error");
  });
});
