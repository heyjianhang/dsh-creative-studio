import { build } from "esbuild";
import { transform } from "lightningcss";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { basename } from "node:path";
await mkdir("lib", { recursive: true });
await copyFile("resources/volc-catalog.json", "lib/volc-catalog.json");
await copyFile("src/client/assets/LICENSE-lobe-icons", "lib/LICENSE-lobe-icons");
await build({
  entryPoints: ["src/host/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
await build({
  entryPoints: ["src/client/index.tsx"],
  outfile: "lib/client.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  jsx: "automatic",
  loader: { ".svg": "dataurl" },
  sourcemap: true,
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-creative-studio",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: "return module.exports;}});" },
  plugins: [
    {
      name: "dsh-css-modules",
      setup(b) {
        b.onLoad({ filter: /base\.css$/ }, async ({ path }) => ({
          loader: "js",
          contents: `export default ${JSON.stringify((await readFile(path)).toString())};`,
        }));
        b.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
          const o = transform({
            filename: basename(path),
            code: await readFile(path),
            cssModules: { pattern: "creative_[local]_[hash]" },
          });
          return {
            loader: "js",
            contents: `export const cssText=${JSON.stringify(o.code.toString())};export default ${JSON.stringify(
              Object.fromEntries(
                Object.entries(o.exports)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => [k, v.name]),
              ),
            )};`,
            watchFiles: [path],
          };
        });
      },
    },
  ],
});
console.log("Built DSH Host and Client artifacts.");
