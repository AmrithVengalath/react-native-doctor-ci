#!/usr/bin/env node
import { VERSION } from "./index.js";

const USAGE = `rn-doctor — React Native dependency health gate for CI

Usage:
  rn-doctor [options]

Options:
  -v, --version    Print the version and exit
  -h, --help       Show this help and exit
  --no-cache       Bypass cache (read and write)

The enrichment engine is wired up; the policy engine and reporters land in Phase 2.
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

  // Recognize --no-cache but don't do anything with it yet (inert stub for Phase 1)
  // The enrichment engine itself handles this option in Phase 2's wiring

  // Everything else prints usage for now. No policy evaluation or reporters yet.
  process.stdout.write(USAGE);
  return 0;
}

process.exit(main(process.argv.slice(2)));
