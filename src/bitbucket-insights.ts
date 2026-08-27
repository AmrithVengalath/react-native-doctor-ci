/**
 * Bitbucket Pipelines Code Insights reporter: publishes the run as a report
 * plus per-finding annotations on the commit, so findings appear inline on
 * the pull-request diff. Inside Pipelines the Reports API is reached through
 * the pipeline-local auth proxy (`http://localhost:29418`) over plain HTTP,
 * which injects credentials - no token handling on our side.
 * @packageDocumentation
 */

import { request } from "node:http";

import type { Finding } from "./policy.js";
import { computeExitCode, summarize } from "./report.js";
import type { Report } from "./report.js";

/** Where to publish: the repository and commit identifying the report. */
export interface BitbucketTarget {
  /** The workspace (`BITBUCKET_WORKSPACE`). */
  readonly workspace: string;
  /** The repository slug (`BITBUCKET_REPO_SLUG`). */
  readonly repoSlug: string;
  /** The commit the pipeline runs against (`BITBUCKET_COMMIT`). */
  readonly commit: string;
}

/** The Code Insights report document rn-doctor publishes. */
export interface BitbucketReportPayload {
  readonly title: string;
  readonly details: string;
  readonly report_type: "BUG";
  readonly reporter: string;
  readonly result: "PASSED" | "FAILED";
  readonly link?: string;
}

/** A single Code Insights annotation (one finding). */
export interface BitbucketAnnotationPayload {
  /** Stable per-finding id so re-runs upsert instead of duplicating. */
  readonly external_id: string;
  readonly title: string;
  readonly annotation_type: "CODE_SMELL";
  readonly summary: string;
  readonly severity: "LOW" | "MEDIUM" | "HIGH";
  readonly path: string;
  readonly line?: number;
  readonly link?: string;
}

/** The report id under which rn-doctor publishes (stable across runs). */
export const BITBUCKET_REPORT_ID = "rn-doctor";

/** Bitbucket rejects more than this many annotations per report. */
const MAX_ANNOTATIONS = 1000;
/** Bitbucket rejects more than this many annotations per bulk request. */
const ANNOTATIONS_PER_REQUEST = 100;
/** Defensive cap for annotation summaries (Bitbucket truncates around 450). */
const MAX_SUMMARY_LENGTH = 450;

/**
 * Read the publish target from Bitbucket Pipelines' environment, or `null`
 * when any piece is missing (e.g. running outside Pipelines).
 */
export function bitbucketTargetFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BitbucketTarget | null {
  const workspace = env.BITBUCKET_WORKSPACE || env.BITBUCKET_REPO_OWNER;
  const repoSlug = env.BITBUCKET_REPO_SLUG;
  const commit = env.BITBUCKET_COMMIT;
  if (!workspace || !repoSlug || !commit) return null;
  return { workspace, repoSlug, commit };
}

/**
 * Build the Code Insights report document for a run. Published on clean runs
 * too - a green report is part of the feature.
 */
export function buildBitbucketReport(report: Report): BitbucketReportPayload {
  const s = summarize(report.findings);
  const failed = computeExitCode(report.findings) === 1;
  return {
    title: "rn-doctor dependency health",
    details:
      `Checked ${String(report.checkedCount)} dependencies: ` +
      `${String(s.errors)} error(s), ${String(s.warnings)} warning(s), ` +
      `${String(s.notes)} note(s), ${String(s.suppressed)} allowlisted.` +
      (report.findings.length > MAX_ANNOTATIONS
        ? ` Showing the first ${String(MAX_ANNOTATIONS)} findings by severity.`
        : ""),
    report_type: "BUG",
    reporter: "rn-doctor",
    result: failed ? "FAILED" : "PASSED",
    link: "https://www.npmjs.com/package/react-native-doctor-ci",
  };
}

function severityFor(f: Finding): BitbucketAnnotationPayload["severity"] {
  if (f.suppressedBy !== null || f.severity === "note") return "LOW";
  return f.severity === "error" ? "HIGH" : "MEDIUM";
}

/** Gating rank for the annotation cap: errors survive first, then warnings. */
function rankFor(f: Finding): number {
  if (f.suppressedBy === null && f.severity === "error") return 0;
  if (f.suppressedBy === null && f.severity === "warn") return 1;
  return 2;
}

/**
 * Build the annotation list for a run, capped at Bitbucket's 1000-annotation
 * report limit (dropping the least severe findings first, in stable order).
 */
export function buildBitbucketAnnotations(
  report: Report,
  lineOf: (file: string, packageName: string) => number | null,
): readonly BitbucketAnnotationPayload[] {
  let findings: readonly (Finding & { readonly file: string })[] = report.findings;
  if (findings.length > MAX_ANNOTATIONS) {
    const kept: (Finding & { readonly file: string })[] = [];
    for (const rank of [0, 1, 2]) {
      for (const f of report.findings) {
        if (kept.length >= MAX_ANNOTATIONS) break;
        if (rankFor(f) === rank) kept.push(f);
      }
    }
    findings = kept;
  }

  return findings.map((f) => {
    const suffix =
      f.suppressedBy !== null
        ? ` [allowed${f.suppressedBy.reason ? `: ${f.suppressedBy.reason}` : ""}` +
          `${f.suppressedBy.expires ? `, expires ${f.suppressedBy.expires}` : ""}]`
        : "";
    const summary = `${f.package}: ${f.message}${suffix}`;
    const line = lineOf(f.file, f.package);
    return {
      external_id: `rn-doctor:${f.rule}:${f.package}:${f.file}`,
      title: `rn-doctor: ${f.rule}`,
      annotation_type: "CODE_SMELL" as const,
      summary:
        summary.length > MAX_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : summary,
      severity: severityFor(f),
      path: f.file,
      ...(line !== null ? { line } : {}),
      ...(f.evidenceUrl !== null ? { link: f.evidenceUrl } : {}),
    };
  });
}

/**
 * A minimal injectable HTTP-via-proxy transport (the `GitRunner` pattern):
 * send `body` as JSON to the absolute `url` through the plain-HTTP proxy at
 * `proxyUrl`. Never throws - failures come back as `ok: false`.
 */
export type ProxyHttpRequest = (opts: {
  readonly proxyUrl: string;
  readonly method: "PUT" | "POST";
  readonly url: string;
  readonly body: string;
  readonly timeoutMs: number;
}) => Promise<{ readonly ok: boolean; readonly status: number; readonly message?: string }>;

/**
 * The real transport: a `node:http` request to the proxy host with the
 * absolute target URI as the request path (standard HTTP/1.1 proxy form) and
 * a `Host` header for the target. Plain HTTP by design - the Pipelines proxy
 * only speaks HTTP and injects auth itself.
 */
export const defaultProxyHttpRequest: ProxyHttpRequest = (opts) =>
  new Promise((resolve) => {
    let proxy: URL;
    let target: URL;
    try {
      proxy = new URL(opts.proxyUrl);
      target = new URL(opts.url);
    } catch (err) {
      resolve({ ok: false, status: 0, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const req = request(
      {
        host: proxy.hostname,
        port: proxy.port ? Number(proxy.port) : 80,
        method: opts.method,
        path: opts.url,
        headers: {
          host: target.host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(opts.body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on("end", () => {
          resolve({ ok: status >= 200 && status < 300, status });
        });
      },
    );
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, message: `timed out after ${String(opts.timeoutMs)}ms` });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, message: err.message });
    });
    req.end(opts.body);
  });

/** Options for {@link publishBitbucketInsights}. */
export interface BitbucketPublishOptions {
  /** Proxy base URL; defaults to the Pipelines proxy `http://localhost:29418`. */
  readonly proxyUrl?: string;
  /** Transport override for tests. */
  readonly put?: ProxyHttpRequest;
}

/**
 * Publish the run to Bitbucket Code Insights: upsert the report document,
 * then bulk-create its annotations in chunks of 100.
 *
 * @remarks
 * Never throws and never affects the exit code - any failure (proxy missing
 * outside Pipelines, non-2xx, timeout) is reported as `ok: false` for the
 * caller to surface as a warning. Degrading gracefully here is a hard rule:
 * an insights hiccup must not fail a CI run whose policy verdict is sound.
 */
export async function publishBitbucketInsights(
  report: Report,
  lineOf: (file: string, packageName: string) => number | null,
  target: BitbucketTarget,
  options: BitbucketPublishOptions = {},
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const proxyUrl = options.proxyUrl ?? "http://localhost:29418";
  const send = options.put ?? defaultProxyHttpRequest;
  const base =
    `http://api.bitbucket.org/2.0/repositories/${encodeURIComponent(target.workspace)}/` +
    `${encodeURIComponent(target.repoSlug)}/commit/${encodeURIComponent(target.commit)}/reports/` +
    BITBUCKET_REPORT_ID;

  const reportResult = await send({
    proxyUrl,
    method: "PUT",
    url: base,
    body: JSON.stringify(buildBitbucketReport(report)),
    timeoutMs: 10_000,
  });
  if (!reportResult.ok) {
    return {
      ok: false,
      message: `report upload failed (${reportResult.message ?? `HTTP ${String(reportResult.status)}`})`,
    };
  }

  const annotations = buildBitbucketAnnotations(report, lineOf);
  for (let i = 0; i < annotations.length; i += ANNOTATIONS_PER_REQUEST) {
    const chunk = annotations.slice(i, i + ANNOTATIONS_PER_REQUEST);
    const chunkResult = await send({
      proxyUrl,
      method: "POST",
      url: `${base}/annotations`,
      body: JSON.stringify(chunk),
      timeoutMs: 10_000,
    });
    if (!chunkResult.ok) {
      return {
        ok: false,
        message: `annotation upload failed (${chunkResult.message ?? `HTTP ${String(chunkResult.status)}`})`,
      };
    }
  }

  return { ok: true };
}
