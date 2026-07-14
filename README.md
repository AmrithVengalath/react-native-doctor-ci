# react-native-doctor-ci

Fail pull requests that add abandoned, non-New-Architecture, or npm-deprecated React Native dependencies - with inline annotations and a policy-as-code allowlist.

![PR annotation: rn-doctor fails a pull request on the exact package.json line that adds a dying dependency](https://raw.githubusercontent.com/AmrithVengalath/react-native-doctor-ci/main/docs/assets/pr-annotation.png)

[![npm version](https://img.shields.io/npm/v/react-native-doctor-ci)](https://www.npmjs.com/package/react-native-doctor-ci)
[![CI](https://github.com/AmrithVengalath/react-native-doctor-ci/actions/workflows/ci.yml/badge.svg)](https://github.com/AmrithVengalath/react-native-doctor-ci/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

## Why

Unmaintained dependencies are a perennial top-5 pain in React Native surveys, and the cost keeps climbing now that the New Architecture is the default: a package that looked fine when it was added quietly stops getting releases, never gains New Architecture support, or gets deprecated on npm - and you find out during an upgrade, months after the PR that introduced it merged.

Lookup tools exist (the React Native Directory tells you a package's status if you go ask). What's been missing is **enforcement**: the check that runs on every PR, fails when someone adds a dying dependency, and points at the exact line - so the conversation happens at review time, when swapping the package costs five minutes instead of a quarter.

`rn-doctor` is that check. Pure TypeScript, zero native code, one command.

## Quickstart

### GitHub Action (recommended)

Create `.github/workflows/rn-doctor.yml`:

```yaml
name: Dependency health

on:
  pull_request:

permissions:
  contents: read

jobs:
  rn-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # required for changed-only (merge-base diff)

      - uses: AmrithVengalath/react-native-doctor-ci/action@v0.1.2
        with:
          changed-only: "true"
          base: origin/${{ github.base_ref }}
```

That's the whole setup. PRs that add or upgrade a dependency failing your policy get a red check with an inline annotation on the offending `package.json` line. A ready-to-copy workflow and a fully commented policy file live in [`example/`](example/).

### CLI

Run it directly in any project with a `package.json`:

```sh
npx --yes --package react-native-doctor-ci rn-doctor
```

(The package name and the binary name differ, hence `--package`. Once installed as a devDependency, it's just `rn-doctor`.)

## GitHub Action reference

```yaml
- uses: AmrithVengalath/react-native-doctor-ci/action@v0.1.2
  with:
    version: "0.1.2"          # npm version/dist-tag to run (default: latest)
    policy: ".rn-doctor.yml"  # policy file path (default: auto-detect)
    changed-only: "true"      # only deps added/changed vs base (default: "false")
    base: origin/main         # base ref for changed-only (default: origin/main)
    workspaces: "false"       # also check workspace package.jsons
    annotations: "true"       # inline GitHub annotations (default: "true")
    token: ${{ github.token }} # for GitHub repo enrichment (default: workflow token)
    working-directory: "."    # where package.json lives
    node-version: "22"        # Node to set up (rn-doctor needs >= 20)
```

Notes:

- `changed-only` requires `actions/checkout` with `fetch-depth: 0` - the diff is computed against the merge-base of the PR branch and `base`, same as GitHub's three-dot compare. Without history the run fails with an actionable message telling you exactly that.
- The default `token` (the workflow's own `GITHUB_TOKEN`) is enough; it's only used to read public repo metadata (archived state, last push). Without any token those fields degrade to `unknown` with a warning - the run never fails because of rate limits.
- Pin `version` for reproducible CI; `latest` is convenient but floats.

## CLI reference

```
rn-doctor [options]

  --json             Machine-readable JSON report (stable-ordered)
  --sarif            SARIF 2.1.0 report (for code-scanning upload)
  --policy <path>    Policy file path (default: .rn-doctor.yml if present)
  --changed-only     Only check deps added or changed vs the base ref
  --base <ref>       Base ref for --changed-only (default: origin/main)
  --workspaces       Also check every workspace package.json
  --no-cache         Bypass the enrichment cache (read and write)
  --annotations      Force GitHub annotations on (auto in GitHub Actions)
  --no-annotations   Force GitHub annotations off
  -v, --version      Print the version
  -h, --help         Show help
```

**Exit codes** (stable contract - CI depends on it):

| Code | Meaning |
| ---- | ------- |
| `0`  | Clean. Warnings, notes, and allowlisted findings are OK. |
| `1`  | Policy errors found. |
| `2`  | Tool failure: bad flags, unreadable `package.json`, invalid policy file, git failure under `--changed-only`. |

**Environment**: `GITHUB_TOKEN` (optional, enables GitHub repo enrichment), `NO_COLOR` (disables ANSI color), `GITHUB_ACTIONS=true` (auto-enables annotations).

Only `dependencies` are checked - `devDependencies` never ship in your app.

## Policy: `.rn-doctor.yml`

Everything is optional; omitted keys use the defaults shown. Unknown keys are rejected loudly, so a typo can't silently weaken the policy.

```yaml
rules:
  newArchitecture: error        # directory says "not New Arch supported"
  newArchUnknown: warn          # New Arch support unknown (missing data -> warn, not error)
  lastPublish:                  # staleness of the latest npm publish
    warnMonths: 12
    errorMonths: 24             # or the string "off"
  githubArchived: error         # GitHub repository is archived
  npmDeprecated: error          # latest version deprecated on npm
  directoryUnmaintained: warn   # RN Directory "unmaintained" flag

scope: rn-native-only           # or all-deps

allow: []                       # see "Unblocking a PR" below
```

Each rule takes `error | warn | off` (except `lastPublish`, which takes thresholds or `"off"`).

**How the data is gathered.** Each dependency is enriched in parallel from the npm registry (publish time, deprecation, `codegenConfig`), the [React Native Directory](https://reactnative.directory) (New Architecture support, unmaintained flag, GitHub URL), and the GitHub API (archived, last push - token optional). Results are cached in `.rn-doctor-cache.json` for 24 hours (add it to `.gitignore`; `--no-cache` bypasses).

**New Architecture verdicts** are tiered honestly: directory says supported → pass; directory says unsupported → `newArchitecture` fires; unknown but the package ships `codegenConfig` → pass with an informational note; unknown otherwise → `newArchUnknown` fires (a warning by default - missing data is not the same as a dead package).

**Scope.** `rn-native-only` (default) checks packages that actually couple to React Native: listed in the RN Directory, peer-depend on `react-native`, or ship `android`/`ios` directories. `all-deps` checks everything under `dependencies`.

## Unblocking a PR (allowlist)

Sometimes you ship with a flagged package on purpose. One YAML entry unblocks the PR while keeping the finding visible in every report:

```yaml
allow:
  - package: react-native-legacy-thing
    reason: "Replacement planned for Q4; tracked in TICKET-123"
    expires: 2027-01-31
```

- Suppressed findings still appear in output (marked as allowed) - nothing disappears silently.
- `expires` is optional but recommended: past that date the allow stops suppressing and findings **escalate to errors**, so exceptions can't quietly outlive their justification.
- Every finding's message suggests the exact allowlist entry to add, so unblocking is copy-paste.

## Output formats

- **Pretty** (default): one block per finding - severity badge, message, allow-reason if suppressed, and an evidence link (npm/directory/GitHub) so you can verify every claim.
- **`--json`**: stable-ordered, timestamp-free (`version: 1`) - safe to snapshot or post-process.
- **`--sarif`**: SARIF 2.1.0, validates against the official schema. Upload to GitHub code scanning:

  ```yaml
  - run: npx --yes --package react-native-doctor-ci rn-doctor --sarif > rn-doctor.sarif
    continue-on-error: true # let the SARIF upload happen; the gate is separate
  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: rn-doctor.sarif
  ```

- **GitHub annotations**: emitted automatically inside GitHub Actions, resolved to the dependency's real line in `package.json` (string-escape-aware - a same-named key under `scripts` can't false-match).

## Changed-only and monorepos

`--changed-only` is the flagship PR mode: it diffs `dependencies` against the merge-base with `--base` and checks only additions and spec changes (downgrades and protocol changes count too - they're re-checked). Fast, and zero noise from pre-existing debt: adopting rn-doctor on a 5-year-old app doesn't mean fixing 30 findings before the check goes green.

`--workspaces` walks npm/yarn `workspaces` globs or `pnpm-workspace.yaml` and checks every workspace manifest, with findings grouped per manifest and annotations pointing at the right file. Composes with `--changed-only`.

## FAQ

**Does it check devDependencies?** No - they don't ship in your app. Scope decisions live in the policy file, not flags.

**Is it a security scanner?** No. CVE auditing is `npm audit` / OSV territory. rn-doctor answers a different question: *is this dependency alive and does it have a future on the New Architecture?*

**Does it fix anything?** No - it tells you what's wrong and what to do (allowlist entry, `npx expo install --fix`, Renovate), then gets out of the way.

**What if the RN Directory is wrong about a package?** Every finding carries an evidence link so you can check, and a false positive costs one allowlist line. File a correction with the directory - everyone benefits.

**Why is `yaml` the only runtime dependency?** The policy file and `pnpm-workspace.yaml` are YAML, and a spec-compliant YAML parser is not a weekend project - this one is worth its weight. Everything else (HTTP, caching, git diffing, glob matching, SARIF, annotations) is hand-rolled on Node built-ins; less supply chain in a tool whose whole job is judging dependencies.

## Contributing

Issues and PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). The project follows a phased roadmap; out-of-scope items (security auditing, auto-fixing, a hosted service) are listed there.

## License

[MIT](LICENSE) © Amrith Vengalath
