/**
 * Live upstream-API drift canary.
 *
 * rn-doctor's entire value rests on three external response shapes - the npm
 * registry, the React Native Directory, and the GitHub API. Every unit test
 * mocks them, so a silent shape change ships green. This canary hits the real
 * endpoints for a known-good package and asserts the enrichment still parses.
 * It runs on a schedule (see .github/workflows/api-canary.yml), never in the
 * unit suite.
 *
 * Exit code 0 = shapes intact; 1 = drift (the workflow opens an issue).
 */
import { enrichDependencies } from "../dist/index.js";

const CANARY = "react-native-webview";

function fail(message, dep) {
  console.error(`API canary FAILED: ${message}`);
  if (dep) console.error("Enriched record:\n" + JSON.stringify(dep, null, 2));
  process.exit(1);
}

const { dependencies, warnings } = await enrichDependencies([CANARY], { noCache: true });
const dep = dependencies[0];
if (!dep) fail(`no enrichment returned for ${CANARY}`);

const checks = [
  ["npm manifest parsed (found)", dep.npm.found === true],
  ["directory check parsed (listed)", dep.directory.listed === true],
  ["directory verdict parsed (newArch supported)", dep.newArch.tier === "supported"],
  // The next two only hold if the /api/library detail envelope is unwrapped
  // correctly - the exact shape drift that motivated this canary.
  ["directory detail parsed (githubUrl present)", typeof dep.directory.githubUrl === "string"],
  ["archived state resolved", dep.github.archived.known === true],
  ["last-publish date resolved", dep.lastPublish.known === true],
];

const failures = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failures.length > 0) {
  fail(`checks failed: ${failures.join("; ")}\nrun-level warnings: ${JSON.stringify(warnings)}`, dep);
}

console.log(`API canary OK for ${CANARY}:`);
console.log(
  `  listed=${dep.directory.listed} newArch=${dep.newArch.tier} ` +
    `archivedSource=${dep.github.source} lastPublish=${dep.lastPublish.known}`,
);
