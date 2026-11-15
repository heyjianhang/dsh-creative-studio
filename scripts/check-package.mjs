import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readPluginMeta } from "@deepseek-ai/dsh-app-boot";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const artwork = [
  manifest.icon,
  ...manifest.dsh.actveroWorkbenchPreviews,
].map((path) => path.replace(/^\.\//, ""));
const required = [
  ...artwork,
  manifest.main,
  manifest.exports["./client"],
  manifest.dsh.bundle.patch,
  "README.md",
  "DESIGN.md",
  "workbench.json",
  "LICENSE",
  "LICENSE-asset-library",
  "skills/asset-library-assistant/SKILL.md",
  "skills/creative-studio-assistant/SKILL.md",
  "docs/agent-workflow.md",
  "docs/creative-workbench.md",
].map((path) => path.replace(/^\.\//, ""));
for (const path of required) assert((await readFile(path)).length > 0, path);
const metadata = readPluginMeta(manifest.name, new URL("../package.json", import.meta.url).href);
assert(!metadata?.error, metadata?.error);
assert(metadata?.icon, "Host metadata reader did not load the workbench icon");
assert.equal(manifest.dsh.actveroWorkbenchIcon, manifest.icon, "Workbench icon declarations differ");
for (const path of manifest.dsh.actveroWorkbenchPreviews) {
  assert((await readFile(path)).length <= 128 * 1024, `Workbench preview exceeds 128 KiB: ${path}`);
}
const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "pack", "--dry-run", "--json", "--ignore-scripts",
  ], { encoding: "utf8", shell: process.platform === "win32" });
const [pack] = JSON.parse(output.slice(output.lastIndexOf("\n[") + 1));
const files = pack.files.map(({ path }) => path);
for (const path of required) assert(files.includes(path), `Missing ${path}`);
for (const path of files) {
  assert(
    artwork.includes(path) ||
      /^(lib\/|docs\/|skills\/|(?:README|DESIGN)\.md$|workbench\.json$|LICENSE(?:-asset-library)?$|package\.json$|cordis\.patch\.yml$)/.test(path),
    `Unexpected published file: ${path}`,
  );
  assert(!/(^|\/)(\.env|credentials|\.dsh|node_modules)(\/|\.|$)|\.(sqlite|db|zip)$/i.test(path), path);
}
const client = await readFile(manifest.exports["./client"], "utf8");
assert(client.includes(`id:"${manifest.name}"`), "Client loader ID mismatch");
for (const hook of ["prepare", "prepack", "prepublish", "preinstall", "install", "postinstall"]) {
  assert(!manifest.scripts?.[hook], `Git installs must use prebuilt artifacts, without ${hook}`);
}
const tracked = new Set(execFileSync("git", ["ls-files", "lib"], { encoding: "utf8" }).trim().split("\n"));
for (const path of files.filter((path) => path.startsWith("lib/"))) {
  assert(tracked.has(path), `Git install is missing committed artifact: ${path}`);
}
console.log(`${manifest.name}@${manifest.version}: ${files.length} package files; Host, Client and bundle entries verified.`);
