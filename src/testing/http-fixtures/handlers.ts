/**
 * MSW HTTP handlers for test fixtures.
 * @packageDocumentation
 */

import { http } from "msw";
import { FIXTURE_PACKAGE_NAMES } from "../fixture-packages.js";

// Import fixture data
import npmHealthy from "./npm/healthy.json" with { type: "json" };
import npmDeprecated from "./npm/deprecated.json" with { type: "json" };
import npmArchived from "./npm/archived.json" with { type: "json" };
import npmStale24mo from "./npm/stale-24mo.json" with { type: "json" };
import npmDirectoryUnmaintained from "./npm/directory-unmaintained.json" with { type: "json" };
import npmNewArchUnsupported from "./npm/new-arch-unsupported.json" with { type: "json" };
import npmUnknownWithCodegen from "./npm/unknown-with-codegen.json" with { type: "json" };
import npmUnknownBare from "./npm/unknown-bare.json" with { type: "json" };

import dirCheckResponse from "./directory/check-response.json" with { type: "json" };
import dirHealthy from "./directory/library-detail-healthy.json" with { type: "json" };
import dirArchived from "./directory/library-detail-archived.json" with { type: "json" };
import dirStale24mo from "./directory/library-detail-stale-24mo.json" with { type: "json" };
import dirDirectoryUnmaintained from "./directory/library-detail-directory-unmaintained.json" with { type: "json" };
import dirNewArchUnsupported from "./directory/library-detail-new-arch-unsupported.json" with { type: "json" };

import githubHealthy from "./github/repo-healthy.json" with { type: "json" };
import githubDeprecated from "./github/repo-deprecated.json" with { type: "json" };
import githubNewArchUnsupported from "./github/repo-new-arch-unsupported.json" with { type: "json" };
import githubUnknownWithCodegen from "./github/repo-unknown-with-codegen.json" with { type: "json" };
import githubRateLimited from "./github/rate-limited.json" with { type: "json" };

const npmFixtures: Record<string, unknown> = {
  [FIXTURE_PACKAGE_NAMES.healthy]: npmHealthy,
  [FIXTURE_PACKAGE_NAMES.deprecated]: npmDeprecated,
  [FIXTURE_PACKAGE_NAMES.archived]: npmArchived,
  [FIXTURE_PACKAGE_NAMES.stale24mo]: npmStale24mo,
  [FIXTURE_PACKAGE_NAMES.directoryUnmaintained]: npmDirectoryUnmaintained,
  [FIXTURE_PACKAGE_NAMES.newArchUnsupported]: npmNewArchUnsupported,
  [FIXTURE_PACKAGE_NAMES.unknownWithCodegen]: npmUnknownWithCodegen,
  [FIXTURE_PACKAGE_NAMES.unknownBare]: npmUnknownBare,
};

const directoryDetailFixtures: Record<string, unknown> = {
  [FIXTURE_PACKAGE_NAMES.healthy]: dirHealthy,
  [FIXTURE_PACKAGE_NAMES.archived]: dirArchived,
  [FIXTURE_PACKAGE_NAMES.stale24mo]: dirStale24mo,
  [FIXTURE_PACKAGE_NAMES.directoryUnmaintained]: dirDirectoryUnmaintained,
  [FIXTURE_PACKAGE_NAMES.newArchUnsupported]: dirNewArchUnsupported,
};

const githubFixtures: Record<string, unknown> = {
  [FIXTURE_PACKAGE_NAMES.healthy]: githubHealthy,
  [FIXTURE_PACKAGE_NAMES.deprecated]: githubDeprecated,
  [FIXTURE_PACKAGE_NAMES.newArchUnsupported]: githubNewArchUnsupported,
  [FIXTURE_PACKAGE_NAMES.unknownWithCodegen]: githubUnknownWithCodegen,
};

/**
 * Create all MSW HTTP handlers for the test fixtures.
 */
export function createFixtureHandlers() {
  return [
    // npm /latest endpoint
    http.get("https://registry.npmjs.org/:package/latest", ({ params }) => {
      const packageName = params.package as string;
      const decoded = decodeURIComponent(packageName);

      const fixture = npmFixtures[decoded];
      if (fixture) {
        return new Response(JSON.stringify(fixture), { status: 200 });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }),

    // npm search endpoint
    http.get("https://registry.npmjs.org/-/v1/search", ({ request }) => {
      const url = new URL(request.url);
      const text = url.searchParams.get("text");

      // For fixtures, return a minimal search result for the known packages
      const knownPackages = Object.values(FIXTURE_PACKAGE_NAMES) as string[];
      const match = knownPackages.find((pkg) => pkg.includes(text || ""));

      if (!match) {
        return new Response(JSON.stringify({ objects: [] }), { status: 200 });
      }

      const fixture = npmFixtures[match] as any;
      if (fixture) {
        return new Response(
          JSON.stringify({
            objects: [
              {
                package: {
                  name: match,
                  version: fixture.version || "1.0.0",
                  date: fixture.date || new Date().toISOString(),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ objects: [] }), { status: 200 });
    }),

    // RN Directory check endpoint
    http.get("https://reactnative.directory/api/libraries/check", ({ request }) => {
      const url = new URL(request.url);
      const packages = url.searchParams.get("packages");

      if (!packages) {
        return new Response(JSON.stringify({}), { status: 200 });
      }

      const names = packages.split(",").map((n) => n.trim());
      const result = {} as Record<string, unknown>;

      for (const name of names) {
        const fixture = dirCheckResponse as any;
        if (fixture[name]) {
          result[name] = fixture[name];
        }
      }

      return new Response(JSON.stringify(result), { status: 200 });
    }),

    // RN Directory library detail endpoint
    http.get("https://reactnative.directory/api/library", ({ request }) => {
      const url = new URL(request.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({}), { status: 200 });
      }

      const fixture = directoryDetailFixtures[name];
      if (fixture) {
        return new Response(JSON.stringify(fixture), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    }),

    // GitHub API endpoint
    http.get("https://api.github.com/repos/:owner/:repo", ({ params }) => {
      const owner = params.owner as string;
      const repo = params.repo as string;

      // Build a fake repo name from parts for fixture lookup
      // This is simplified; in real tests we'd make lookups more sophisticated
      const key = `${owner}/${repo}`;

      // Map fixture lookups
      for (const [pkgName, fixture] of Object.entries(githubFixtures)) {
        const detail = directoryDetailFixtures[pkgName] as any;
        if (detail?.githubUrl?.includes(key)) {
          return new Response(JSON.stringify(fixture), { status: 200 });
        }
      }

      return new Response(JSON.stringify({ archived: false }), { status: 200 });
    }),
  ];
}
