/**
 * Git plumbing for `--changed-only`: resolve the diff base (merge-base of HEAD
 * and the base ref) and read manifest blobs at that commit.
 *
 * This is the only module in the codebase that touches `child_process`; the
 * process runner is injectable so everything above it is testable without a
 * real repository.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";

/**
 * A git invocation failed in a way rn-doctor cannot recover from. Maps to
 * exit code 2 (tool failure) in the CLI; the message says what to do.
 */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Result of one git invocation. */
export interface GitRunResult {
  /** Process exit code (0 = success). */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injectable git process runner. Resolves with the exit code rather than
 * rejecting on nonzero exit — callers classify failures themselves. Throws
 * {@link GitError} only when git cannot be spawned at all.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

/**
 * The real runner: spawns the `git` binary via `execFile` (args array, no
 * shell, so refs and Windows paths need no quoting).
 */
export function createGitRunner(): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        [...args],
        { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new GitError("git executable not found on PATH — --changed-only requires git."),
            );
            return;
          }
          // execFile sets err for nonzero exit too; surface the code instead.
          const code = err ? ((err as { code?: number | string }).code ?? 1) : 0;
          resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
        },
      );
    });
}

/**
 * Resolve the commit to diff against: `merge-base(HEAD, baseRef)`.
 *
 * @remarks
 * The merge-base (not the base tip) reproduces GitHub's three-dot PR diff:
 * dependency changes that landed on the base branch after the PR diverged are
 * never attributed to the PR. On the base branch itself the merge-base is HEAD,
 * so `--changed-only` correctly reports zero changes.
 *
 * @param git - The process runner.
 * @param cwd - Directory to run git in (the project root being checked).
 * @param baseRef - The base ref, e.g. `origin/main`.
 * @returns The merge-base commit SHA.
 * @throws GitError with an actionable message when the cwd is not a repo, the
 * ref does not exist, or the histories share no common ancestor.
 */
export async function resolveBaseCommit(
  git: GitRunner,
  cwd: string,
  baseRef: string,
): Promise<string> {
  const result = await git(["merge-base", "HEAD", baseRef], cwd);
  if (result.code === 0) {
    const sha = result.stdout.trim();
    if (sha !== "") return sha;
  }

  const stderr = result.stderr;
  if (/not a git repository/i.test(stderr)) {
    throw new GitError(
      "--changed-only requires running inside a git repository " +
        "(or drop the flag to check all dependencies).",
    );
  }
  if (/not a valid object name|unknown revision|bad revision|needed a single revision/i.test(stderr)) {
    throw new GitError(
      `base ref "${baseRef}" was not found. Fetch it first (git fetch origin) or pass ` +
        `--base <ref>. In GitHub Actions, check out with fetch-depth: 0.`,
    );
  }
  if (stderr.trim() === "") {
    // merge-base exits 1 with empty output when there is no common ancestor.
    throw new GitError(
      `no merge base between HEAD and "${baseRef}" — histories are unrelated or the ` +
        `clone is too shallow. In GitHub Actions, check out with fetch-depth: 0.`,
    );
  }
  throw new GitError(`git merge-base HEAD ${baseRef} failed — ${stderr.trim()}`);
}

/**
 * Read the contents of a file as it existed at `commit`, or `null` when the
 * path did not exist at that commit (e.g. a manifest created since the base).
 *
 * @remarks
 * Uses the `git show <commit>:./<path>` form: the `./` prefix makes git
 * resolve the path relative to `cwd`, so no repository-root discovery is
 * needed even when the project sits in a subdirectory of the repo. A UTF-8
 * BOM is stripped, mirroring {@link readPackageJson}.
 *
 * @param git - The process runner.
 * @param cwd - Directory to run git in.
 * @param commit - The commit SHA (from {@link resolveBaseCommit}).
 * @param relPath - Path relative to `cwd`; separators are normalized to `/`.
 * @throws GitError for any failure other than "path absent at that commit".
 */
export async function readFileAtCommit(
  git: GitRunner,
  cwd: string,
  commit: string,
  relPath: string,
): Promise<string | null> {
  const posixPath = relPath.replaceAll("\\", "/");
  const result = await git(["show", `${commit}:./${posixPath}`], cwd);

  if (result.code === 0) {
    let text = result.stdout;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  if (/does not exist in|exists on disk, but not in|but not in the working tree|path .* does not exist/i.test(result.stderr)) {
    return null;
  }
  throw new GitError(`git show ${commit}:./${posixPath} failed — ${result.stderr.trim()}`);
}
