import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceError, discoverWorkspaces, expandWorkspacePatterns } from "./workspaces.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rn-doctor-ws-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create directories (and package.json in each unless bare). */
async function makeDirs(paths: string[], { bare = false } = {}): Promise<void> {
  for (const p of paths) {
    const abs = join(root, ...p.split("/"));
    await mkdir(abs, { recursive: true });
    if (!bare) {
      await writeFile(join(abs, "package.json"), `{"name":"${p.replaceAll("/", "-")}"}`, "utf8");
    }
  }
}

const rels = (dirs: readonly string[]): string[] =>
  dirs.map((d) => relative(root, d).split(sep).join("/"));

describe("expandWorkspacePatterns", () => {
  it("expands a single-star segment", async () => {
    await makeDirs(["packages/a", "packages/b", "apps/web"]);
    expect(rels(await expandWorkspacePatterns(root, ["packages/*"]))).toEqual([
      "packages/a",
      "packages/b",
    ]);
  });

  it("expands partial-segment wildcards", async () => {
    await makeDirs(["app-web", "app-native", "tools"]);
    expect(rels(await expandWorkspacePatterns(root, ["app-*"]))).toEqual(["app-native", "app-web"]);
  });

  it("matches literal paths only when the directory exists", async () => {
    await makeDirs(["tools/cli"]);
    expect(rels(await expandWorkspacePatterns(root, ["tools/cli", "tools/missing"]))).toEqual([
      "tools/cli",
    ]);
  });

  it("expands ** at any depth", async () => {
    await makeDirs(["packages/a", "packages/nested/deep"]);
    const out = rels(await expandWorkspacePatterns(root, ["packages/**"]));
    expect(out).toContain("packages/a");
    expect(out).toContain("packages/nested");
    expect(out).toContain("packages/nested/deep");
  });

  it("applies leading-! exclusions", async () => {
    await makeDirs(["packages/a", "packages/test-helpers"]);
    expect(rels(await expandWorkspacePatterns(root, ["packages/*", "!packages/test-*"]))).toEqual([
      "packages/a",
    ]);
  });

  it("never traverses node_modules or dot-directories", async () => {
    await makeDirs(["packages/a", "packages/node_modules/evil", "packages/.hidden"]);
    const out = rels(await expandWorkspacePatterns(root, ["packages/*", "packages/**"]));
    // `**` matches zero directories, so `packages` itself is a legal match.
    expect(out).toEqual(["packages", "packages/a"]);
  });

  it("dedupes across overlapping patterns and sorts by relative path", async () => {
    await makeDirs(["packages/b", "packages/a"]);
    expect(rels(await expandWorkspacePatterns(root, ["packages/*", "packages/a"]))).toEqual([
      "packages/a",
      "packages/b",
    ]);
  });

  it("returns empty for unsupported or unmatched patterns", async () => {
    await makeDirs(["packages/a"]);
    expect(await expandWorkspacePatterns(root, ["nothing/*"])).toEqual([]);
  });
});

describe("discoverWorkspaces", () => {
  it("reads the package.json workspaces array and puts the root first", async () => {
    await makeDirs(["packages/a", "packages/b"]);
    const out = await discoverWorkspaces(root, { workspaces: ["packages/*"] });
    expect(out.map((w) => w.manifestRelPath)).toEqual([
      "package.json",
      "packages/a/package.json",
      "packages/b/package.json",
    ]);
    expect(out[0]?.dir).toBe(root);
  });

  it("reads the { packages: [...] } object form", async () => {
    await makeDirs(["packages/a"]);
    const out = await discoverWorkspaces(root, { workspaces: { packages: ["packages/*"] } });
    expect(out.map((w) => w.manifestRelPath)).toEqual(["package.json", "packages/a/package.json"]);
  });

  it("prefers pnpm-workspace.yaml over the package.json field, like pnpm does", async () => {
    await makeDirs(["packages/a", "libs/b"]);
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - libs/*\n", "utf8");
    const out = await discoverWorkspaces(root, { workspaces: ["packages/*"] });
    expect(out.map((w) => w.manifestRelPath)).toEqual(["package.json", "libs/b/package.json"]);
  });

  it("skips matched directories without a package.json", async () => {
    await makeDirs(["packages/a"]);
    await makeDirs(["packages/no-manifest"], { bare: true });
    const out = await discoverWorkspaces(root, { workspaces: ["packages/*"] });
    expect(out.map((w) => w.manifestRelPath)).toEqual(["package.json", "packages/a/package.json"]);
  });

  it("returns root-only when patterns match nothing", async () => {
    const out = await discoverWorkspaces(root, { workspaces: ["packages/*"] });
    expect(out.map((w) => w.manifestRelPath)).toEqual(["package.json"]);
  });

  it("throws an actionable WorkspaceError when no configuration exists", async () => {
    await expect(discoverWorkspaces(root, { name: "x" })).rejects.toThrow(WorkspaceError);
    await expect(discoverWorkspaces(root, { name: "x" })).rejects.toThrow(
      /--workspaces requires a "workspaces" field/,
    );
  });

  it("rejects a malformed workspaces field", async () => {
    await expect(discoverWorkspaces(root, { workspaces: "packages/*" })).rejects.toThrow(
      /not a list of strings/,
    );
  });

  it("rejects a malformed pnpm-workspace.yaml packages list", async () => {
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: nope\n", "utf8");
    await expect(discoverWorkspaces(root, {})).rejects.toThrow(/not a list of strings/);
  });

  it("ignores a pnpm-workspace.yaml without a packages key", async () => {
    await makeDirs(["packages/a"]);
    await writeFile(join(root, "pnpm-workspace.yaml"), "allowBuilds:\n  - esbuild\n", "utf8");
    const out = await discoverWorkspaces(root, { workspaces: ["packages/*"] });
    expect(out.map((w) => w.manifestRelPath)).toEqual(["package.json", "packages/a/package.json"]);
  });
});
