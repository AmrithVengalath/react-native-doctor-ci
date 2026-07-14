import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitError, createGitRunner, readFileAtCommit, resolveBaseCommit } from "./git.js";
import type { GitRunResult, GitRunner } from "./git.js";
import { commitAll, initFixtureRepo } from "./testing/git-fixture.js";

/** A GitRunner that replays a canned result and records the invocation. */
function fakeGit(result: Partial<GitRunResult>): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve({ code: 1, stdout: "", stderr: "", ...result });
  };
  return { runner, calls };
}

describe("resolveBaseCommit", () => {
  it("returns the trimmed merge-base SHA and runs the expected command", async () => {
    const { runner, calls } = fakeGit({ code: 0, stdout: "abc123def\n" });
    await expect(resolveBaseCommit(runner, "/repo", "origin/main")).resolves.toBe("abc123def");
    expect(calls).toEqual([["merge-base", "HEAD", "origin/main"]]);
  });

  it.each([
    [
      "not a repository",
      "fatal: not a git repository (or any of the parent directories): .git",
      /requires running inside a git repository.*drop the flag/s,
    ],
    [
      "unknown ref (not a valid object name)",
      "fatal: Not a valid object name origin/main",
      /base ref "origin\/main" was not found.*git fetch origin.*fetch-depth: 0/s,
    ],
    [
      "unknown ref (unknown revision)",
      "fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree.",
      /base ref "origin\/main" was not found/,
    ],
    [
      "unknown ref (needed a single revision)",
      "fatal: merge-base: needed a single revision",
      /base ref "origin\/main" was not found/,
    ],
    [
      "no common ancestor (exit 1, silent)",
      "",
      /no merge base between HEAD and "origin\/main".*fetch-depth: 0/s,
    ],
  ])("maps %s to an actionable GitError", async (_label, stderr, expected) => {
    const { runner } = fakeGit({ code: stderr === "" ? 1 : 128, stderr });
    await expect(resolveBaseCommit(runner, "/repo", "origin/main")).rejects.toThrow(GitError);
    await expect(resolveBaseCommit(runner, "/repo", "origin/main")).rejects.toThrow(expected);
  });

  it("surfaces unclassified failures with the raw stderr", async () => {
    const { runner } = fakeGit({ code: 128, stderr: "fatal: something exotic" });
    await expect(resolveBaseCommit(runner, "/repo", "dev")).rejects.toThrow(
      /git merge-base HEAD dev failed - fatal: something exotic/,
    );
  });
});

describe("readFileAtCommit", () => {
  it("returns the blob text and normalizes backslashes in the pathspec", async () => {
    const { runner, calls } = fakeGit({ code: 0, stdout: '{"dependencies":{}}' });
    await expect(readFileAtCommit(runner, "/repo", "abc123", "packages\\a\\package.json")).resolves.toBe(
      '{"dependencies":{}}',
    );
    expect(calls).toEqual([["show", "abc123:./packages/a/package.json"]]);
  });

  it("strips a UTF-8 BOM from the blob, like readPackageJson", async () => {
    const { runner } = fakeGit({ code: 0, stdout: "\uFEFF{}" });
    await expect(readFileAtCommit(runner, "/repo", "abc123", "package.json")).resolves.toBe("{}");
  });

  it.each([
    ["fatal: path 'package.json' does not exist in 'abc123'"],
    ["fatal: path 'packages/a/package.json' exists on disk, but not in 'abc123'"],
  ])("returns null when the path is absent at the commit (%s)", async (stderr) => {
    const { runner } = fakeGit({ code: 128, stderr });
    await expect(readFileAtCommit(runner, "/repo", "abc123", "package.json")).resolves.toBeNull();
  });

  it("throws GitError for other failures", async () => {
    const { runner } = fakeGit({ code: 128, stderr: "fatal: bad object abc123" });
    await expect(readFileAtCommit(runner, "/repo", "abc123", "package.json")).rejects.toThrow(
      /git show abc123:\.\/package\.json failed - fatal: bad object abc123/,
    );
  });
});

// Real git spawns can be slow on Windows when the whole suite runs in
// parallel; give these generous timeouts and retry EBUSY cleanups.
const GIT_TEST_TIMEOUT = 30_000;

describe("createGitRunner (real git)", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    dir = null;
  });

  it("locks the command strings against a real two-commit repo", { timeout: GIT_TEST_TIMEOUT }, async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-git-"));
    initFixtureRepo(dir);

    await writeFile(join(dir, "package.json"), '{\n  "dependencies": {\n    "a": "1.0.0"\n  }\n}\n', "utf8");
    const first = commitAll(dir, "one");

    await writeFile(join(dir, "sub.json"), "{}\n", "utf8");
    commitAll(dir, "two");

    const runner = createGitRunner();

    // merge-base(HEAD, first) is the first commit itself.
    await expect(resolveBaseCommit(runner, dir, first)).resolves.toBe(first);

    // Blob read at the base commit, cwd-relative.
    const text = await readFileAtCommit(runner, dir, first, "package.json");
    expect(text).toContain('"a": "1.0.0"');

    // Path absent at the base commit → null, not an error.
    await expect(readFileAtCommit(runner, dir, first, "sub.json")).resolves.toBeNull();

    // Unknown ref → actionable GitError.
    await expect(resolveBaseCommit(runner, dir, "no-such-ref")).rejects.toThrow(GitError);
  });

  it("fails actionably outside a git repository", { timeout: GIT_TEST_TIMEOUT }, async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-git-"));
    const runner = createGitRunner();
    await expect(resolveBaseCommit(runner, dir, "origin/main")).rejects.toThrow(
      /requires running inside a git repository/,
    );
  });
});
