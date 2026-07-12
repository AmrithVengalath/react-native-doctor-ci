#!/usr/bin/env node
/**
 * Bin entry point: wires {@link runCli} to the real process. Kept separate
 * from `cli-main.ts` so tests can import the CLI without executing it.
 * @packageDocumentation
 */

import { runCli } from "./cli-main.js";

// `.then` rather than top-level await: tsup also emits a CJS build of this file.
void runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  env: process.env,
}).then((code) => {
  process.exitCode = code;
});
