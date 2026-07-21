# Troubleshooting

Common questions when running `rn-doctor` locally or in CI.

## "It found nothing, but I expected findings"

- **Scope.** The default scope is `rn-native-only`, which only checks packages
  that couple to React Native (listed in the RN Directory, peer-depend on
  `react-native`, or ship `android`/`ios` directories). Set `scope: all-deps`
  in `.rn-doctor.yml` to check every dependency.
- **`--changed-only`.** In PR mode only dependencies added or changed versus the
  base ref are checked. Pre-existing findings on untouched dependencies are
  intentionally skipped so adopting the tool doesn't require fixing old debt
  first. Drop the flag to check everything.
- **Only `dependencies`.** `devDependencies` are never checked - they don't ship
  in your app.

## "`--changed-only` fails with a git error"

The diff is computed against the merge-base of your branch and the base ref, so
the base ref's history must be present:

- In GitHub Actions, check out with `fetch-depth: 0` (the default shallow clone
  has no merge-base).
- Locally, make sure the base ref exists: `git fetch origin`. Override the ref
  with `--base <ref>` (default `origin/main`).

## GitHub fields show as `unknown`

`archived` and last-push data come from the GitHub API, which is rate-limited
(60 requests/hour unauthenticated). Provide a token to raise the limit:

- CLI: set `GITHUB_TOKEN` in the environment.
- Action: the default workflow `token` is already passed through.

Without a token, directory-listed packages fall back to the React Native
Directory's cached GitHub snapshot; other packages degrade to `unknown` with a
warning. A rate limit **never** fails the run.

## The cache file `.rn-doctor-cache.json`

Enrichment results are cached for 24 hours next to your `package.json`.

- Add `.rn-doctor-cache.json` to your `.gitignore` - it's a machine-local
  artifact, not something to commit.
- Pass `--no-cache` to force a fresh audit (bypasses both read and write).
- Transient failures (a momentary rate limit or network blip) are never cached,
  so a degraded run can't poison the next one.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Clean. Warnings, notes, and allowlisted findings are OK. |
| `1`  | Policy errors found. |
| `2`  | Tool failure: bad flags, unreadable `package.json`, invalid policy file, or a git failure under `--changed-only`. |

Note that `--sarif`/`--json` still return exit `1` on policy errors. If you want
the SARIF upload to run regardless, put the `rn-doctor --sarif` step behind
`continue-on-error: true` and keep the gating step separate.

## A finding looks wrong

Every finding carries an evidence link (npm, the RN Directory, or GitHub) so you
can verify the claim. If the React Native Directory has stale data about a
package, a false positive costs one allowlist line while you file a correction
upstream:

```yaml
allow:
  - package: the-package
    reason: "directory data is stale; see <link>"
    expires: 2027-01-31
```
