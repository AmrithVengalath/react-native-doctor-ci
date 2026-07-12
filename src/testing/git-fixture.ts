/**
 * Real-git fixture helpers for tests: initialize a hermetic throwaway repo in
 * a temp directory, insulated from the host's global git configuration
 * (signing, hooks, templates), and commit files to it.
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";

/** Run a git command in `cwd`, returning trimmed stdout. */
export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Initialize a hermetic git repository at `dir` with branch `main`.
 * Commits in fixture repos must never depend on the host machine's identity,
 * signing setup, or hooks — CI has none of them.
 */
export function initFixtureRepo(dir: string): void {
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.email", "test@example.com");
  gitIn(dir, "config", "user.name", "Test");
  gitIn(dir, "config", "commit.gpgsign", "false");
  gitIn(dir, "config", "core.hooksPath", "no-hooks");
  gitIn(dir, "config", "core.autocrlf", "false");
}

/** Stage everything and commit; returns the new commit SHA. */
export function commitAll(dir: string, message: string): string {
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", message);
  return gitIn(dir, "rev-parse", "HEAD");
}
