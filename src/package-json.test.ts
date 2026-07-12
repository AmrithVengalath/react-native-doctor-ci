import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ManifestError,
  entriesFromManifestText,
  findDependencyLine,
  listDependencies,
  listDependencyEntries,
  readManifestAt,
  readPackageJson,
} from "./package-json.js";

describe("findDependencyLine", () => {
  const MANIFEST = [
    "{",                                          // 1
    '  "name": "example-app",',                   // 2
    '  "scripts": {',                             // 3
    '    "react-native-webview": "echo decoy"',   // 4
    "  },",                                       // 5
    '  "dependencies": {',                        // 6
    '    "react-native-webview": "^14.0.1",',     // 7
    '    "left-pad": "^1.3.0",',                  // 8
    '    "@scope/pkg": "1.0.0"',                  // 9
    "  },",                                       // 10
    '  "devDependencies": {',                     // 11
    '    "left-pad": "^1.0.0",',                  // 12
    '    "vitest": "^4.0.0"',                     // 13
    "  }",                                        // 14
    "}",                                          // 15
  ].join("\n");

  it("resolves the declaration line inside dependencies", () => {
    expect(findDependencyLine(MANIFEST, "react-native-webview")).toBe(7);
    expect(findDependencyLine(MANIFEST, "left-pad")).toBe(8);
    expect(findDependencyLine(MANIFEST, "@scope/pkg")).toBe(9);
  });

  it("ignores same-named keys in scripts and devDependencies", () => {
    // "react-native-webview" also appears in scripts (line 4); "left-pad"
    // also appears in devDependencies (line 12). Both must resolve to the
    // dependencies section.
    expect(findDependencyLine(MANIFEST, "vitest")).toBeNull();
  });

  it("does not match a name that is a substring of another name", () => {
    const text = '{\n  "dependencies": {\n    "react-native-webview-plus": "1.0.0"\n  }\n}';
    expect(findDependencyLine(text, "react-native-webview")).toBeNull();
  });

  it("returns null when the package is absent or dependencies is missing", () => {
    expect(findDependencyLine(MANIFEST, "not-a-dep")).toBeNull();
    expect(findDependencyLine('{ "name": "x" }', "left-pad")).toBeNull();
  });

  it("ignores a nested object under a scalar dependencies key", () => {
    const text = '{\n  "dependencies": "none",\n  "other": {\n    "left-pad": "1.0.0"\n  }\n}';
    expect(findDependencyLine(text, "left-pad")).toBeNull();
  });

  it("handles single-line manifests", () => {
    expect(findDependencyLine('{"dependencies":{"a":"1"},"devDependencies":{"b":"1"}}', "a")).toBe(1);
  });
});

describe("listDependencies", () => {
  it("preserves authored order", () => {
    expect(listDependencies({ dependencies: { zebra: "1", alpha: "2" } })).toEqual(["zebra", "alpha"]);
  });

  it("returns empty when the section is absent", () => {
    expect(listDependencies({ name: "x" })).toEqual([]);
  });

  it("rejects a non-object dependencies field", () => {
    expect(() => listDependencies({ dependencies: "oops" })).toThrow(ManifestError);
    expect(() => listDependencies({ dependencies: ["a"] })).toThrow(ManifestError);
  });

  it("rejects a non-object manifest", () => {
    expect(() => listDependencies("not json object")).toThrow(ManifestError);
  });
});

describe("listDependencyEntries", () => {
  it("preserves authored order with specs", () => {
    expect(listDependencyEntries({ dependencies: { zebra: "^1.0.0", alpha: "~2.0.0" } })).toEqual([
      { name: "zebra", spec: "^1.0.0" },
      { name: "alpha", spec: "~2.0.0" },
    ]);
  });

  it("returns empty when the section is absent", () => {
    expect(listDependencyEntries({ name: "x" })).toEqual([]);
  });

  it("rejects a non-string version spec, naming the dependency", () => {
    expect(() => listDependencyEntries({ dependencies: { a: 1 } }, "here")).toThrow(
      /here has a non-string version for dependency "a"/,
    );
  });
});

describe("entriesFromManifestText", () => {
  it("parses a raw manifest blob", () => {
    expect(entriesFromManifestText('{"dependencies":{"a":"^1.0.0"}}', "blob")).toEqual([
      { name: "a", spec: "^1.0.0" },
    ]);
  });

  it("tolerates a UTF-8 BOM", () => {
    expect(entriesFromManifestText("\uFEFF" + '{"dependencies":{"a":"1"}}', "blob")).toEqual([
      { name: "a", spec: "1" },
    ]);
  });

  it("throws ManifestError naming the location on invalid JSON", () => {
    expect(() => entriesFromManifestText("{ nope", "package.json at origin/main")).toThrow(
      /package\.json at origin\/main is not valid JSON/,
    );
  });
});

describe("readManifestAt", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reads a manifest at an exact path with entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-test-"));
    const path = join(dir, "package.json");
    await writeFile(path, '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n', "utf8");

    const manifest = await readManifestAt(path);
    expect(manifest.path).toBe(path);
    expect(manifest.entries).toEqual([{ name: "left-pad", spec: "^1.3.0" }]);
    expect(manifest.dependencies).toEqual(["left-pad"]);
  });

  it("uses the provided missing-file message", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-test-"));
    await expect(readManifestAt(join(dir, "package.json"), "custom message")).rejects.toThrow(
      "custom message",
    );
  });
});

describe("readPackageJson", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reads text and dependency names", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-test-"));
    const text = '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n';
    await writeFile(join(dir, "package.json"), text, "utf8");

    const manifest = await readPackageJson(dir);
    expect(manifest.text).toBe(text);
    expect(manifest.dependencies).toEqual(["left-pad"]);
    expect(manifest.path).toBe(join(dir, "package.json"));
  });

  it("tolerates a UTF-8 BOM, like npm does", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-test-"));
    const text = "\uFEFF" + '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n';
    await writeFile(join(dir, "package.json"), text, "utf8");

    const manifest = await readPackageJson(dir);
    expect(manifest.dependencies).toEqual(["left-pad"]);
    expect(findDependencyLine(manifest.text, "left-pad")).toBe(3);
  });

  it("throws an actionable ManifestError when package.json is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-test-"));
    await expect(readPackageJson(dir)).rejects.toThrow(/No package\.json found in .*project root/);
  });

  it("throws ManifestError on invalid JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-doctor-test-"));
    await writeFile(join(dir, "package.json"), "{ nope", "utf8");
    await expect(readPackageJson(dir)).rejects.toThrow(/not valid JSON/);
  });
});
