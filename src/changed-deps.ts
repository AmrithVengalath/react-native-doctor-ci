/**
 * Pure `--changed-only` semantics: which dependencies of the current manifest
 * were added or changed relative to the base manifest. No git knowledge here  - 
 * the CLI composes this with the blob reads from `git.ts`.
 *
 * @packageDocumentation
 */

import type { DependencyEntry } from "./package-json.js";

/**
 * Names to check under `--changed-only`: additions (name absent at base) and
 * changes (raw spec string differs - upgrades, downgrades, and protocol
 * changes like an `npm:` alias all count; re-checking is always safe).
 * Removed and unchanged dependencies are skipped.
 *
 * @param base - Entries at the base commit, or `null` when the manifest did
 * not exist there - every current dependency then counts as added.
 * @param current - Entries in the working-tree manifest.
 * @returns Names in `current` authored order.
 */
export function diffDependencies(
  base: readonly DependencyEntry[] | null,
  current: readonly DependencyEntry[],
): readonly string[] {
  if (base === null) return current.map((entry) => entry.name);

  const baseSpecs = new Map(base.map((entry) => [entry.name, entry.spec]));
  return current
    .filter((entry) => baseSpecs.get(entry.name) !== entry.spec)
    .map((entry) => entry.name);
}
