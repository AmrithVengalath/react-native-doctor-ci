#!/usr/bin/env node
import { VERSION } from "./index.js";

const USAGE = `rn-doctor — React Native dependency health gate for CI

Usage:
  rn-doctor [options]

Options:
  -v, --version   Print the version and exit
  -h, --help      Show this help and exit

The checks (dependency enrichment, policy evaluation, reporters) are not wired
up yet — this is an early scaffold.
`;

/**
 * Run the CLI and return its exit code.
 *
 * @remarks
 * Exit codes are a stable contract that CI depends on:
 *
 * - `0` — clean; no policy errors
 * - `1` — policy errors found
 * - `2` — tool failure (bad configuration or an unexpected error)
 *
 * @param argv - Arguments after the node binary and script (`process.argv.slice(2)`).
 * @returns The process exit code.
 */
function main(argv: readonly string[]): number {
  const args = new Set(argv);

  if (args.has("-v") || args.has("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // Everything else prints usage for now. No checks are implemented, so there
  // is nothing to fail on: exit clean.
  process.stdout.write(USAGE);
  return 0;
}

process.exit(main(process.argv.slice(2)));
