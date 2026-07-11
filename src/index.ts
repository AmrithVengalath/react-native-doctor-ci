/**
 * react-native-doctor-ci — a policy-as-code CI gate for React Native dependency
 * health. It fails pull requests that add abandoned, non-New-Architecture, or
 * npm-deprecated dependencies, with readable annotations and an allowlist
 * workflow.
 *
 * This bootstrap release exposes only the package version and the top-level
 * options seam. The enrichment engine, policy engine, and reporters land in
 * later releases.
 *
 * @packageDocumentation
 */

/**
 * The current package version.
 *
 * @remarks
 * Kept in sync with `package.json` by hand for now; a later release wires it to
 * the manifest at build time.
 */
export const VERSION = "0.0.0";

/**
 * Top-level options for a `rn-doctor` run.
 *
 * @remarks
 * Placeholder surface. Fields are added as the enrichment and policy engines
 * are implemented.
 */
export interface RnDoctorOptions {
  /**
   * Path to the project's `package.json`, or a directory containing one.
   * Defaults to the current working directory when omitted.
   */
  readonly cwd?: string;
}
