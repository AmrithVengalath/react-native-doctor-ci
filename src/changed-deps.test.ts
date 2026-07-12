import { describe, expect, it } from "vitest";

import { diffDependencies } from "./changed-deps.js";
import type { DependencyEntry } from "./package-json.js";

const entry = (name: string, spec: string): DependencyEntry => ({ name, spec });

describe("diffDependencies", () => {
  it("flags added dependencies", () => {
    expect(diffDependencies([entry("a", "^1.0.0")], [entry("a", "^1.0.0"), entry("b", "^2.0.0")])).toEqual(["b"]);
  });

  it("flags spec changes in either direction", () => {
    expect(diffDependencies([entry("a", "^1.2.0")], [entry("a", "^1.3.0")])).toEqual(["a"]);
    expect(diffDependencies([entry("a", "^1.3.0")], [entry("a", "^1.2.0")])).toEqual(["a"]);
  });

  it("flags protocol changes even when the version looks equal", () => {
    expect(diffDependencies([entry("a", "1.0.0")], [entry("a", "npm:a-fork@1.0.0")])).toEqual(["a"]);
  });

  it("skips unchanged and removed dependencies", () => {
    expect(diffDependencies([entry("a", "^1.0.0"), entry("gone", "^9.0.0")], [entry("a", "^1.0.0")])).toEqual([]);
  });

  it("treats a missing base manifest as all-added", () => {
    expect(diffDependencies(null, [entry("a", "1"), entry("b", "2")])).toEqual(["a", "b"]);
  });

  it("preserves current authored order", () => {
    const current = [entry("zebra", "1"), entry("alpha", "2"), entry("mid", "3")];
    expect(diffDependencies([entry("mid", "0")], current)).toEqual(["zebra", "alpha", "mid"]);
  });

  it("returns empty for identical manifests", () => {
    const entries = [entry("a", "^1.0.0"), entry("b", "~2.1.0")];
    expect(diffDependencies(entries, entries)).toEqual([]);
  });
});
