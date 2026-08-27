import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ProxyHttpRequest } from "./bitbucket-insights.js";
import { runCli } from "./cli-main.js";
import type { CliIo } from "./cli-main.js";
import { findDependencyLine } from "./package-json.js";
import { createMswServer } from "./testing/msw-server.js";
import { FIXTURE_PACKAGE_NAMES } from "./testing/fixture-packages.js";
import { commitAll, gitIn, initFixtureRepo } from "./testing/git-fixture.js";
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

describe("runCli - flag handling (no network)", () => {
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

describe("runCli - tool failures (exit 2)", () => {
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

describe("runCli - end-to-end (enrich -> policy -> report)", () => {
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

/** Manifest with only the healthy fixture. */
const HEALTHY_ONLY = `{
  "name": "example-app",
  "dependencies": {
    "${FIXTURE_PACKAGE_NAMES.healthy}": "^14.0.1"
  }
}
`;

/** HEALTHY_ONLY plus the archived fixture (an error under the default policy). */
const HEALTHY_PLUS_ARCHIVED = `{
  "name": "example-app",
  "dependencies": {
    "${FIXTURE_PACKAGE_NAMES.healthy}": "^14.0.1",
    "${FIXTURE_PACKAGE_NAMES.archived}": "^0.7.2"
  }
}
`;

interface JsonDoc {
  summary: { checked: number; errors: number };
  findings: { file: string; package: string; rule: string }[];
  warnings: { source: string; message: string }[];
}

// Real git spawns can be slow on Windows when the whole suite runs in
// parallel; give the git-backed suites generous timeouts and retried cleanup.
const GIT_TEST_TIMEOUT = 30_000;

describe("runCli - --changed-only (real git fixture)", { timeout: GIT_TEST_TIMEOUT }, () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "rn-doctor-changed-"));
    initFixtureRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("flags only the newly added dependency (acceptance)", async () => {
    await writeFile(join(repo, "package.json"), HEALTHY_ONLY, "utf8");
    commitAll(repo, "base");
    gitIn(repo, "checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "package.json"), HEALTHY_PLUS_ARCHIVED, "utf8");
    commitAll(repo, "add archived dep");

    const { io, stdout, stderr } = makeIo(repo);
    const code = await runCli(["--changed-only", "--base", "main", "--json", "--no-cache"], io);

    expect(stderr()).toBe("");
    const doc = JSON.parse(stdout()) as JsonDoc;
    expect(doc.summary.checked).toBe(1);
    expect(doc.findings.length).toBeGreaterThan(0);
    for (const f of doc.findings) {
      expect(f.package).toBe(FIXTURE_PACKAGE_NAMES.archived);
      expect(f.file).toBe("package.json");
    }
    expect(code).toBe(1);
  });

  it("flags a dependency whose spec changed", async () => {
    await writeFile(join(repo, "package.json"), HEALTHY_PLUS_ARCHIVED, "utf8");
    commitAll(repo, "base");
    gitIn(repo, "checkout", "-q", "-b", "feature");
    await writeFile(
      join(repo, "package.json"),
      HEALTHY_PLUS_ARCHIVED.replace("^0.7.2", "^0.8.0"),
      "utf8",
    );
    commitAll(repo, "bump archived dep");

    const { io, stdout } = makeIo(repo);
    const code = await runCli(["--changed-only", "--base", "main", "--json", "--no-cache"], io);

    const doc = JSON.parse(stdout()) as JsonDoc;
    expect(doc.summary.checked).toBe(1);
    expect(doc.findings.every((f) => f.package === FIXTURE_PACKAGE_NAMES.archived)).toBe(true);
    expect(code).toBe(1);
  });

  it("treats a manifest absent at the base as all-added", async () => {
    await writeFile(join(repo, "README.md"), "hello\n", "utf8");
    commitAll(repo, "base without manifest");
    gitIn(repo, "checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "package.json"), HEALTHY_PLUS_ARCHIVED, "utf8");
    commitAll(repo, "add manifest");

    const { io, stdout } = makeIo(repo);
    await runCli(["--changed-only", "--base", "main", "--json", "--no-cache"], io);
    expect((JSON.parse(stdout()) as JsonDoc).summary.checked).toBe(2);
  });

  it("reports zero changes on the base branch itself and exits 0", async () => {
    await writeFile(join(repo, "package.json"), HEALTHY_PLUS_ARCHIVED, "utf8");
    commitAll(repo, "base");

    const { io, stdout } = makeIo(repo);
    expect(await runCli(["--changed-only", "--base", "main", "--no-cache"], io)).toBe(0);
    expect(stdout()).toContain("No findings across 0 dependencies.");
  });

  it("warns and checks everything when the base manifest is unparseable", async () => {
    await writeFile(join(repo, "package.json"), "{ not json", "utf8");
    commitAll(repo, "broken base");
    gitIn(repo, "checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "package.json"), HEALTHY_PLUS_ARCHIVED, "utf8");
    commitAll(repo, "fix manifest");

    const { io, stdout } = makeIo(repo);
    const code = await runCli(["--changed-only", "--base", "main", "--json", "--no-cache"], io);

    const doc = JSON.parse(stdout()) as JsonDoc;
    expect(doc.summary.checked).toBe(2);
    expect(doc.warnings.some((w) => w.source === "git" && w.message.includes("checking all"))).toBe(
      true,
    );
    expect(code).toBe(1);
  });

  it("fails actionably outside a git repository (exit 2)", async () => {
    const plain = await mkdtemp(join(tmpdir(), "rn-doctor-norepo-"));
    try {
      await writeFile(join(plain, "package.json"), HEALTHY_ONLY, "utf8");
      const { io, stderr } = makeIo(plain);
      expect(await runCli(["--changed-only", "--no-cache"], io)).toBe(2);
      expect(stderr()).toContain("requires running inside a git repository");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("fails actionably for an unknown base ref (exit 2)", async () => {
    await writeFile(join(repo, "package.json"), HEALTHY_ONLY, "utf8");
    commitAll(repo, "base");

    const { io, stderr } = makeIo(repo);
    expect(await runCli(["--changed-only", "--base", "bogus", "--no-cache"], io)).toBe(2);
    expect(stderr()).toContain('base ref "bogus" was not found');
  });

  it("rejects --base without --changed-only (exit 2)", async () => {
    const { io, stderr } = makeIo(repo);
    expect(await runCli(["--base", "main"], io)).toBe(2);
    expect(stderr()).toContain("--base requires --changed-only");
  });
});

/** One workspace tree: root (healthy) + packages/a (archived) + packages/b (stale). */
const WS_ROOT = `{
  "name": "monorepo-root",
  "workspaces": ["packages/*"],
  "dependencies": {
    "${FIXTURE_PACKAGE_NAMES.healthy}": "^14.0.1"
  }
}
`;
const WS_A = `{
  "name": "a",
  "dependencies": {
    "${FIXTURE_PACKAGE_NAMES.archived}": "^0.7.2"
  }
}
`;
const WS_B = `{
  "name": "b",
  "dependencies": {
    "${FIXTURE_PACKAGE_NAMES.stale24mo}": "^0.3.1"
  }
}
`;

async function writeWorkspaceTree(root: string): Promise<void> {
  await writeFile(join(root, "package.json"), WS_ROOT, "utf8");
  await mkdir(join(root, "packages", "a"), { recursive: true });
  await mkdir(join(root, "packages", "b"), { recursive: true });
  await writeFile(join(root, "packages", "a", "package.json"), WS_A, "utf8");
  await writeFile(join(root, "packages", "b", "package.json"), WS_B, "utf8");
}

describe("runCli - --workspaces", () => {
  it("groups the pretty report by manifest and counts all of them", async () => {
    await writeWorkspaceTree(dir);
    const { io, stdout } = makeIo(dir);
    const code = await runCli(["--workspaces", "--no-cache"], io);

    expect(stdout()).toContain("packages/a/package.json:");
    expect(stdout()).toContain(`error  ${FIXTURE_PACKAGE_NAMES.archived}  [githubArchived]`);
    expect(stdout()).toContain("packages/b/package.json:");
    expect(stdout()).toContain("across 3 dependencies in 3 manifests.");
    expect(code).toBe(1);
  });

  it("locates JSON findings in their own manifest", async () => {
    await writeWorkspaceTree(dir);
    const { io, stdout } = makeIo(dir);
    await runCli(["--workspaces", "--json", "--no-cache"], io);

    const doc = JSON.parse(stdout()) as JsonDoc;
    expect(doc.summary.checked).toBe(3);
    const files = new Set(doc.findings.map((f) => f.file));
    expect(files).toEqual(new Set(["packages/a/package.json", "packages/b/package.json"]));
  });

  it("emits annotations against each workspace manifest with its real line", async () => {
    await writeWorkspaceTree(dir);
    const { io, stdout } = makeIo(dir);
    await runCli(["--workspaces", "--annotations", "--no-cache"], io);

    const line = findDependencyLine(WS_A, FIXTURE_PACKAGE_NAMES.archived);
    expect(line).not.toBeNull();
    expect(stdout()).toContain(`::error file=packages/a/package.json,line=${String(line)},title=`);
  });

  it("locates SARIF results in each workspace manifest", async () => {
    await writeWorkspaceTree(dir);
    const { io, stdout } = makeIo(dir);
    await runCli(["--workspaces", "--sarif", "--no-cache"], io);

    const doc = JSON.parse(stdout()) as {
      runs: {
        results: {
          ruleId: string;
          locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
        }[];
      }[];
    };
    const archived = doc.runs[0]?.results.find((r) => r.ruleId === "githubArchived");
    expect(archived?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      "packages/a/package.json",
    );
  });

  it("fails actionably without a workspace configuration (exit 2)", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--workspaces", "--no-cache"], io)).toBe(2);
    expect(stderr()).toContain('--workspaces requires a "workspaces" field');
  });

  it("composes with --changed-only: only the workspace that gained a dep is flagged", { timeout: GIT_TEST_TIMEOUT }, async () => {
    const repo = await mkdtemp(join(tmpdir(), "rn-doctor-ws-changed-"));
    try {
      initFixtureRepo(repo);
      await writeWorkspaceTree(repo);
      // Base: packages/b has no dependencies yet.
      await writeFile(join(repo, "packages", "b", "package.json"), '{ "name": "b" }\n', "utf8");
      commitAll(repo, "base");
      gitIn(repo, "checkout", "-q", "-b", "feature");
      await writeFile(join(repo, "packages", "b", "package.json"), WS_B, "utf8");
      commitAll(repo, "b gains a stale dep");

      const { io, stdout } = makeIo(repo);
      const code = await runCli(
        ["--workspaces", "--changed-only", "--base", "main", "--json", "--no-cache"],
        io,
      );

      const doc = JSON.parse(stdout()) as JsonDoc;
      expect(doc.summary.checked).toBe(1);
      expect(doc.findings.length).toBeGreaterThan(0);
      for (const f of doc.findings) {
        expect(f.file).toBe("packages/b/package.json");
        expect(f.package).toBe(FIXTURE_PACKAGE_NAMES.stale24mo);
      }
      expect(code).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("runCli - GitHub annotations", () => {
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

describe("runCli - multi-CI platforms", () => {
  it("rejects an invalid --ci value (exit 2)", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--ci", "jenkins"], io)).toBe(2);
    expect(stderr()).toContain('invalid --ci value "jenkins"');
  });

  it("rejects --ci none with --annotations (exit 2)", async () => {
    const { io, stderr } = makeIo(dir);
    expect(await runCli(["--ci", "none", "--annotations"], io)).toBe(2);
    expect(stderr()).toContain("mutually exclusive");
  });

  it("--ci azure forces ##vso logging commands outside any CI", async () => {
    const { io, stdout } = makeIo(dir);
    await runCli(["--no-cache", "--ci", "azure"], io);

    const line = findDependencyLine(MANIFEST_TEXT, FIXTURE_PACKAGE_NAMES.archived);
    expect(stdout()).toContain(
      `##vso[task.logissue type=error;sourcepath=package.json;linenumber=${String(line)};code=`,
    );
    expect(stdout()).not.toContain("::error");
  });

  it("auto-emits ##vso commands when TF_BUILD=True", async () => {
    const { io, stdout } = makeIo(dir, { TF_BUILD: "True" });
    await runCli(["--no-cache"], io);
    expect(stdout()).toContain("##vso[task.logissue type=error;");
  });

  it("--no-annotations disables inline feedback on Azure too", async () => {
    const { io, stdout } = makeIo(dir, { TF_BUILD: "True" });
    await runCli(["--no-cache", "--no-annotations"], io);
    expect(stdout()).not.toContain("##vso");
  });

  it("--ci none disables auto-detected inline feedback", async () => {
    const { io, stdout } = makeIo(dir, { GITHUB_ACTIONS: "true" });
    await runCli(["--no-cache", "--ci", "none"], io);
    expect(stdout()).not.toContain("::error");
  });

  it("emits no GitHub commands under GitLab CI and hints at --gitlab-codequality", async () => {
    const { io, stdout, stderr } = makeIo(dir, { GITLAB_CI: "true" });
    await runCli(["--no-cache"], io);
    expect(stdout()).not.toContain("::error");
    expect(stdout()).not.toContain("##vso");
    expect(stderr()).toContain("--gitlab-codequality");
  });

  it("--gitlab-codequality writes the Code Quality artifact next to pretty output", async () => {
    const { io } = makeIo(dir, { GITLAB_CI: "true" });
    expect(await runCli(["--no-cache", "--gitlab-codequality", "gl.json"], io)).toBe(1);

    const issues = JSON.parse(await readFile(join(dir, "gl.json"), "utf8")) as {
      check_name: string;
      location: { lines: { begin: number } };
    }[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.check_name.startsWith("rn-doctor/"))).toBe(true);
    const line = findDependencyLine(MANIFEST_TEXT, FIXTURE_PACKAGE_NAMES.archived);
    expect(issues.some((i) => i.location.lines.begin === line)).toBe(true);
  });

  it("--gitlab-codequality also works alongside --json without touching stdout", async () => {
    const { io, stdout } = makeIo(dir);
    await runCli(["--no-cache", "--json", "--gitlab-codequality", "gl.json"], io);
    expect(() => {
      JSON.parse(stdout());
    }).not.toThrow();
    const artifact = await readFile(join(dir, "gl.json"), "utf8");
    expect(() => {
      JSON.parse(artifact);
    }).not.toThrow();
  });

  it("fails with exit 2 when the Code Quality artifact cannot be written", async () => {
    const { io, stderr } = makeIo(dir);
    expect(
      await runCli(["--no-cache", "--gitlab-codequality", "no-such-dir/gl.json"], io),
    ).toBe(2);
    expect(stderr()).toContain("could not write the Code Quality report");
  });

  it("skips Bitbucket Code Insights with a warning when the Pipelines env is incomplete", async () => {
    const { io, stdout, stderr } = makeIo(dir, { BITBUCKET_BUILD_NUMBER: "7" });
    const code = await runCli(["--no-cache"], io);
    expect(code).toBe(1);
    expect(stderr()).toContain("Bitbucket Code Insights skipped");
    expect(stdout()).not.toContain("::error");
  });

  it("publishes Bitbucket Code Insights through the transport and keeps the policy exit code", async () => {
    const sent: { method: string; url: string; body: string }[] = [];
    const transport: ProxyHttpRequest = (opts) => {
      sent.push({ method: opts.method, url: opts.url, body: opts.body });
      return Promise.resolve({ ok: true, status: 200 });
    };
    const { io, stderr } = makeIo(dir, {
      BITBUCKET_BUILD_NUMBER: "7",
      BITBUCKET_WORKSPACE: "acme",
      BITBUCKET_REPO_SLUG: "app",
      BITBUCKET_COMMIT: "abc123",
    });
    const code = await runCli(["--no-cache"], { ...io, bitbucketTransport: transport });
    expect(code).toBe(1);
    expect(stderr()).not.toContain("Bitbucket");
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.url).toBe(
      "http://api.bitbucket.org/2.0/repositories/acme/app/commit/abc123/reports/rn-doctor",
    );
    expect(sent[0]?.body).toContain('"reporter":"rn-doctor"');
    expect(sent[1]?.method).toBe("POST");
    expect(sent[1]?.url.endsWith("/annotations")).toBe(true);
  });

  it("warns and continues when the Bitbucket upload fails", async () => {
    const transport: ProxyHttpRequest = () => Promise.resolve({ ok: false, status: 500 });
    const { io, stderr } = makeIo(dir, {
      BITBUCKET_BUILD_NUMBER: "7",
      BITBUCKET_WORKSPACE: "acme",
      BITBUCKET_REPO_SLUG: "app",
      BITBUCKET_COMMIT: "abc123",
    });
    const code = await runCli(["--no-cache"], { ...io, bitbucketTransport: transport });
    expect(code).toBe(1);
    expect(stderr()).toContain("Bitbucket Code Insights report upload failed (HTTP 500)");
    expect(stderr()).toContain("continuing");
  });
});
