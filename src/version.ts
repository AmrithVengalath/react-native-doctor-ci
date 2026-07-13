/**
 * Tool version, kept in a leaf module so reporters can embed it without
 * importing the package entry point (which would create an import cycle).
 * @packageDocumentation
 */

import packageJson from "../package.json" with { type: "json" };

/**
 * The rn-doctor tool version. Read from package.json and inlined into the
 * build, so `prepublishOnly` (which runs after release-it bumps the version)
 * always ships the released number.
 */
export const VERSION: string = packageJson.version;
