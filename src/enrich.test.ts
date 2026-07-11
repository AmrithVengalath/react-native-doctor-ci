import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";

import { computeNewArchTier, enrichDependencies } from "./enrich.js";
import { createMswServer } from "./testing/msw-server.js";
import { ENRICHED_FIXTURES, FIXTURE_PACKAGE_NAMES } from "./testing/fixture-packages.js";
import { parseGithubUrl as parseNpmRepoUrl } from "./sources/npm.js";
import { parseGithubUrl as parseGithubRepoUrl } from "./sources/github.js";

const server = createMswServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** The 8-package acceptance matrix (see 03-doctor-ci.md, Phase 1 accept). */
const CATEGORIES = Object.values(FIXTURE_PACKAGE_NAMES);

const RATE_LIMIT_WARNING = {
  source: "github" as const,
  message:
    "GitHub API rate-limited after checking dependencies; remaining packages fall back to cached GitHub data or unknown",
};

describe("enrichDependencies — 8-fixture acceptance matrix", () => {
  it.each(CATEGORIES)("enriches %s to deep-equal its recorded fixture", async (name) => {
    const result = await enrichDependencies([name], { noCache: true });

    expect(result.warnings).toEqual([]);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]).toEqual(ENRICHED_FIXTURES[name]);
  });

  it("enriches all 8 in a single run with no cross-package interference", async () => {
    const result = await enrichDependencies([...CATEGORIES], { noCache: true });

    expect(result.warnings).toEqual([]);
    expect(result.dependencies).toHaveLength(CATEGORIES.length);

    for (const name of CATEGORIES) {
      const dep = result.dependencies.find((d) => d.name === name);
      expect(dep, `missing enriched dependency for ${name}`).toBeDefined();
      expect(dep).toEqual(ENRICHED_FIXTURES[name]);
    }
  });
});

describe("enrichDependencies — GitHub rate-limit degradation", () => {
  it("trips the breaker, warns at run level, and falls back to directory data", async () => {
    // Force every GitHub call to 403 so the circuit breaker trips on the first repo.
    server.use(
      http.get(
        "https://api.github.com/repos/:owner/:repo",
        () =>
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
          }),
      ),
    );

    const result = await enrichDependencies([FIXTURE_PACKAGE_NAMES.healthy], { noCache: true });

    expect(result.dependencies).toHaveLength(1);
    const [dep] = result.dependencies;
    // Same package as `healthy`, but GitHub degraded to the RN Directory snapshot.
    expect(dep).toEqual(ENRICHED_FIXTURES.rateLimited);
    expect(dep?.github.source).toBe("directory-fallback");
    // The warning is run-level, not attached to the dependency.
    expect(dep?.warnings).toEqual([]);
    expect(result.warnings).toEqual([RATE_LIMIT_WARNING]);
  });
});

describe("computeNewArchTier", () => {
  const cases: Array<[string | null, boolean, ReturnType<typeof computeNewArchTier>]> = [
    ["supported", false, "supported"],
    ["new-arch-only", false, "supported"],
    ["unsupported", false, "unsupported"],
    ["unsupported", true, "unsupported"], // directory verdict wins over codegen
    ["untested", true, "passWithNote"],
    ["untested", false, "unknown"],
    [null, true, "passWithNote"],
    [null, false, "unknown"],
  ];

  it.each(cases)("verdict=%s codegen=%s → %s", (directoryVerdict, codegen, expected) => {
    expect(
      computeNewArchTier({
        directoryVerdict,
        hasCodegenConfig: { known: true, value: codegen },
      }),
    ).toBe(expected);
  });
});

describe("parseGithubUrl", () => {
  it("parses npm-style repository URLs (git+ prefix, .git suffix)", () => {
    expect(parseNpmRepoUrl("git+https://github.com/facebook/react-native.git")).toEqual({
      owner: "facebook",
      repo: "react-native",
    });
    expect(parseNpmRepoUrl("https://gitlab.com/foo/bar")).toBeUndefined();
    expect(parseNpmRepoUrl(undefined)).toBeUndefined();
  });

  it("parses https and ssh GitHub URLs", () => {
    expect(parseGithubRepoUrl("https://github.com/react-native-webview/react-native-webview")).toEqual({
      owner: "react-native-webview",
      repo: "react-native-webview",
    });
    expect(parseGithubRepoUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubRepoUrl("https://example.com/owner/repo")).toBeUndefined();
  });
});
