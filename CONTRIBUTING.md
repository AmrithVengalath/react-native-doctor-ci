# Contributing to react-native-doctor-ci

Thanks for your interest in contributing! This project is maintained by a solo maintainer, so a little process goes a long way.

## Issue first

Please open an issue before starting work on anything non-trivial. It saves you from building something that can't be merged, and it lets us agree on the approach up front. Small fixes (typos, obvious bugs with a clear one-line fix) can go straight to a PR.

The project follows a phased roadmap — features land in a deliberate order, so a good idea may be queued rather than merged immediately.

## Out of scope — won't be accepted

To keep the tool focused and low-maintenance, PRs adding the following will be declined:

- **Security / CVE auditing.** `npm audit` and dedicated scanners already do this well; `rn-doctor` checks maintenance health and New Architecture support, not vulnerabilities.
- **Fixing or upgrading dependencies.** The tool reports and gates; it does not modify your project. Messages may *suggest* remedies (e.g. `npx expo install --fix`, Renovate), but auto-fixing is out of scope.
- **A website / hosted service.** This is a CLI and CI tool only.

## Pull requests

- **Title:** use [Conventional Commits](https://www.conventionalcommits.org/) scoped to this package, e.g. `fix(cli): resolve package.json line for scoped deps` or `feat(policy): support expires on allowlist entries`.
- **One concern per PR.** Small, reviewable PRs get merged fast; grab-bag PRs stall.
- **Fill in the PR template** — Problem / Solution / Testing / New Dependencies / Checklist. "New Dependencies" defaults to **None**; any new runtime dependency needs a stated justification (the project has a strong zero-dependency bias).
- **User-facing changes** must be reflected in the changelog: use a `fix:` / `feat:` (or `feat!:` for breaking) Conventional Commit title so the release notes pick the change up.
- **Green locally before pushing:** typecheck, lint, tests, and build must all pass.

## Coding standards

- TypeScript **strict** mode; no `any` in the public API.
- All exported symbols documented with TSDoc.
- Node >= 20; pure TypeScript — no native code.
- Policy semantics target the React Native New Architecture era (`react-native >= 0.76`).
- Error and finding messages must be actionable: say what to do, not just what's wrong, and include an evidence link where one exists.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
