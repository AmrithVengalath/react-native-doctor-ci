/**
 * CI platform detection: maps well-known CI environment variables to the
 * platform whose native inline-feedback mechanism rn-doctor should target.
 * @packageDocumentation
 */

/**
 * A CI platform rn-doctor can emit inline feedback for, or `"none"` when no
 * supported platform is detected/selected.
 */
export type CiPlatformId = "github" | "azure" | "bitbucket" | "gitlab" | "none";

/**
 * Detect the CI platform from the environment.
 *
 * @remarks
 * Detection order (first match wins): GitHub Actions (`GITHUB_ACTIONS=true`),
 * Azure Pipelines (`TF_BUILD=True`, compared case-insensitively), GitLab CI
 * (`GITLAB_CI=true`), Bitbucket Pipelines (`BITBUCKET_BUILD_NUMBER` set and
 * non-empty). The variables are mutually exclusive on real runners, so the
 * order only matters for pathological environments.
 *
 * @param env - The process environment (injectable for tests).
 * @returns The detected platform, or `"none"`.
 */
export function detectCi(env: Readonly<Record<string, string | undefined>>): CiPlatformId {
  if (env.GITHUB_ACTIONS === "true") return "github";
  if (env.TF_BUILD?.toLowerCase() === "true") return "azure";
  if (env.GITLAB_CI === "true") return "gitlab";
  if (env.BITBUCKET_BUILD_NUMBER !== undefined && env.BITBUCKET_BUILD_NUMBER !== "")
    return "bitbucket";
  return "none";
}
