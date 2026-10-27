import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
} from "@deepseek-ai/dsh-app-boot";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const runtimeVersion = getDshRuntimeVersion();
assert.equal(
  runtimeVersion,
  manifest.devDependencies["@deepseek-ai/dsh-app-boot"],
);
const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
assert.equal(issue, undefined, JSON.stringify(issue));
// Older runtimes check dsh peers even when engines.dsh is present.
const { engines, ...withPeersOnly } = manifest;
const peerIssue = evaluatePluginCompatibility(
  withPeersOnly,
  {},
  runtimeVersion,
);
assert.equal(peerIssue, undefined, JSON.stringify(peerIssue));
console.log(
  `${manifest.name}@${manifest.version}: DSH ${runtimeVersion} compatibility accepted without exemptions.`,
);
