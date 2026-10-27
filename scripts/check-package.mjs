import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const required = [
  manifest.main,
  manifest.exports["./client"],
  manifest.dsh.bundle.patch,
  "README.md",
  "LICENSE",
].map((path) => path.replace(/^\.\//, ""));
for (const path of required) assert((await readFile(path)).length > 0, path);
const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "pack", "--dry-run", "--json", "--ignore-scripts",
  ], { encoding: "utf8", shell: process.platform === "win32" });
const [pack] = JSON.parse(output.slice(output.lastIndexOf("\n[") + 1));
const files = pack.files.map(({ path }) => path);
for (const path of required) assert(files.includes(path), `Missing ${path}`);
for (const path of files) {
  assert(
    /^(lib\/|docs\/|README\.md$|LICENSE$|package\.json$|cordis\.patch\.yml$)/.test(path),
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
