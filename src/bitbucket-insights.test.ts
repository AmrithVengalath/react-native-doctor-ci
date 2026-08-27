import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  BITBUCKET_REPORT_ID,
  bitbucketTargetFromEnv,
  buildBitbucketAnnotations,
  buildBitbucketReport,
  defaultProxyHttpRequest,
  publishBitbucketInsights,
} from "./bitbucket-insights.js";
import type { BitbucketTarget } from "./bitbucket-insights.js";
import type { Finding } from "./policy.js";
import { locateFindings } from "./report.js";
import type { Report } from "./report.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    package: "example-pkg",
    rule: "npmDeprecated",
    severity: "error",
    message: "example message",
    evidenceUrl: null,
    suppressedBy: null,
    ...overrides,
  };
}

function reportOf(findings: Finding[]): Report {
  return {
    findings: locateFindings(findings, "package.json"),
    warnings: [],
    checkedCount: findings.length,
  };
}

const noLine = (): number | null => null;

const TARGET: BitbucketTarget = { workspace: "acme", repoSlug: "app", commit: "abc123" };

describe("bitbucketTargetFromEnv", () => {
  it("reads workspace, repo slug and commit from the Pipelines environment", () => {
    expect(
      bitbucketTargetFromEnv({
        BITBUCKET_WORKSPACE: "acme",
        BITBUCKET_REPO_SLUG: "app",
        BITBUCKET_COMMIT: "abc123",
      }),
    ).toEqual(TARGET);
  });

  it("falls back to the legacy BITBUCKET_REPO_OWNER for the workspace", () => {
    expect(
      bitbucketTargetFromEnv({
        BITBUCKET_REPO_OWNER: "acme",
        BITBUCKET_REPO_SLUG: "app",
        BITBUCKET_COMMIT: "abc123",
      }),
    ).toEqual(TARGET);
  });

  it("returns null when any piece is missing or empty", () => {
    expect(bitbucketTargetFromEnv({})).toBeNull();
    expect(
      bitbucketTargetFromEnv({ BITBUCKET_WORKSPACE: "acme", BITBUCKET_REPO_SLUG: "app" }),
    ).toBeNull();
    expect(
      bitbucketTargetFromEnv({
        BITBUCKET_WORKSPACE: "",
        BITBUCKET_REPO_SLUG: "app",
        BITBUCKET_COMMIT: "abc123",
      }),
    ).toBeNull();
  });
});

describe("buildBitbucketReport", () => {
  it("summarizes the run and marks it FAILED when an unsuppressed error exists", () => {
    const payload = buildBitbucketReport(reportOf([finding({})]));
    expect(payload.result).toBe("FAILED");
    expect(payload.report_type).toBe("BUG");
    expect(payload.reporter).toBe("rn-doctor");
    expect(payload.details).toContain("1 error(s)");
  });

  it("marks warning-only and clean runs PASSED", () => {
    expect(buildBitbucketReport(reportOf([finding({ severity: "warn" })])).result).toBe("PASSED");
    expect(buildBitbucketReport(reportOf([])).result).toBe("PASSED");
  });

  it("marks runs with only suppressed errors PASSED", () => {
    const payload = buildBitbucketReport(
      reportOf([finding({ suppressedBy: { reason: "ok", expires: null } })]),
    );
    expect(payload.result).toBe("PASSED");
    expect(payload.details).toContain("1 allowlisted");
  });
});

describe("buildBitbucketAnnotations", () => {
  it("maps severities: error -> HIGH, warn -> MEDIUM, note/suppressed -> LOW", () => {
    const annotations = buildBitbucketAnnotations(
      reportOf([
        finding({ severity: "error" }),
        finding({ severity: "warn" }),
        finding({ severity: "note" }),
        finding({ severity: "error", suppressedBy: { reason: "ok", expires: null } }),
      ]),
      noLine,
    );
    expect(annotations.map((a) => a.severity)).toEqual(["HIGH", "MEDIUM", "LOW", "LOW"]);
    expect(annotations[3]?.summary).toContain("[allowed: ok]");
  });

  it("builds a deterministic external_id from rule, package and file", () => {
    const [a] = buildBitbucketAnnotations(reportOf([finding({})]), noLine);
    expect(a?.external_id).toBe("rn-doctor:npmDeprecated:example-pkg:package.json");
  });

  it("includes the line when resolved and the evidence link when present", () => {
    const [a] = buildBitbucketAnnotations(
      reportOf([finding({ evidenceUrl: "https://example.com/e" })]),
      () => 7,
    );
    expect(a?.line).toBe(7);
    expect(a?.link).toBe("https://example.com/e");
    const [b] = buildBitbucketAnnotations(reportOf([finding({})]), noLine);
    expect(b?.line).toBeUndefined();
    expect(b?.link).toBeUndefined();
  });

  it("truncates over-long summaries defensively", () => {
    const [a] = buildBitbucketAnnotations(reportOf([finding({ message: "x".repeat(600) })]), noLine);
    expect(a?.summary.length).toBeLessThanOrEqual(450);
    expect(a?.summary.endsWith("…")).toBe(true);
  });

  it("caps at 1000 annotations, dropping the least severe first", () => {
    const findings: Finding[] = [
      ...Array.from({ length: 600 }, (_, i) => finding({ package: `note-${String(i)}`, severity: "note" as const })),
      ...Array.from({ length: 600 }, (_, i) => finding({ package: `err-${String(i)}`, severity: "error" as const })),
    ];
    const annotations = buildBitbucketAnnotations(reportOf(findings), noLine);
    expect(annotations).toHaveLength(1000);
    expect(annotations.filter((a) => a.severity === "HIGH")).toHaveLength(600);
    expect(annotations.filter((a) => a.severity === "LOW")).toHaveLength(400);
  });
});

describe("publishBitbucketInsights over a real local proxy", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  async function startProxy(
    handler: (req: IncomingMessage, body: string) => { status: number },
  ): Promise<{ proxyUrl: string; requests: { method: string; url: string; host: string; body: string }[] }> {
    const requests: { method: string; url: string; host: string; body: string }[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          host: req.headers.host ?? "",
          body,
        });
        res.statusCode = handler(req, body).status;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { proxyUrl: `http://127.0.0.1:${String(port)}`, requests };
  }

  it("PUTs the report and POSTs annotations with absolute-URI request lines", { timeout: 15_000 }, async () => {
    const { proxyUrl, requests } = await startProxy(() => ({ status: 200 }));
    const result = await publishBitbucketInsights(reportOf([finding({})]), () => 7, TARGET, {
      proxyUrl,
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe(
      `http://api.bitbucket.org/2.0/repositories/acme/app/commit/abc123/reports/${BITBUCKET_REPORT_ID}`,
    );
    expect(requests[0]?.host).toBe("api.bitbucket.org");
    expect(JSON.parse(requests[0]?.body ?? "")).toMatchObject({ reporter: "rn-doctor" });
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe(
      `http://api.bitbucket.org/2.0/repositories/acme/app/commit/abc123/reports/${BITBUCKET_REPORT_ID}/annotations`,
    );
    const annotations = JSON.parse(requests[1]?.body ?? "") as unknown[];
    expect(annotations).toHaveLength(1);
  });

  it("skips the annotations request when there are no findings", { timeout: 15_000 }, async () => {
    const { proxyUrl, requests } = await startProxy(() => ({ status: 200 }));
    const result = await publishBitbucketInsights(reportOf([]), noLine, TARGET, { proxyUrl });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PUT");
  });

  it("chunks annotations into requests of at most 100", { timeout: 15_000 }, async () => {
    const { proxyUrl, requests } = await startProxy(() => ({ status: 200 }));
    const findings = Array.from({ length: 250 }, (_, i) => finding({ package: `p-${String(i)}` }));
    const result = await publishBitbucketInsights(reportOf(findings), noLine, TARGET, { proxyUrl });
    expect(result.ok).toBe(true);
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => (JSON.parse(r.body) as unknown[]).length)).toEqual([100, 100, 50]);
  });

  it("returns ok: false on a non-2xx response, never throwing", { timeout: 15_000 }, async () => {
    const { proxyUrl } = await startProxy(() => ({ status: 404 }));
    const result = await publishBitbucketInsights(reportOf([finding({})]), noLine, TARGET, {
      proxyUrl,
    });
    expect(result).toEqual({ ok: false, message: "report upload failed (HTTP 404)" });
  });

  it("returns ok: false when the proxy is unreachable (ECONNREFUSED)", { timeout: 15_000 }, async () => {
    const result = await publishBitbucketInsights(reportOf([finding({})]), noLine, TARGET, {
      proxyUrl: "http://127.0.0.1:1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("report upload failed");
  });

  it("returns ok: false on an invalid proxy URL", async () => {
    const result = await defaultProxyHttpRequest({
      proxyUrl: "not a url",
      method: "PUT",
      url: "http://api.bitbucket.org/2.0/x",
      body: "{}",
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
  });

  it("times out a hung proxy", { timeout: 15_000 }, async () => {
    server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const result = await defaultProxyHttpRequest({
      proxyUrl: `http://127.0.0.1:${String(port)}`,
      method: "PUT",
      url: "http://api.bitbucket.org/2.0/x",
      body: "{}",
      timeoutMs: 250,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("timed out");
  });
});
