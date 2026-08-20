// Two entry points, one graph each.
//
// `dist/index.js` is the plugin the daemon spawns. `dist/mcp-shim.js` is the
// inert MCP server the CLI spawns, one per turn — a separate process because
// MCP over stdio is what the CLIs know how to launch, and `index.js` locates
// it as a sibling at run time.
//
// The registry's release workflow walks every `.js` in the finished bundle and
// refuses one that resolves a package at run time, so both are bundled with
// nothing external. Comments go with them: that guard is a regular expression
// over the built file, and a JSDoc `{import('x')}` in somebody else's source
// reads to it as a live require.

import { build } from "esbuild";

const forTests = process.argv.includes("--test-bundle");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minifyWhitespace: true,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
};

const outputs = [];

const main = await build({
  ...common,
  entryPoints: [forTests ? "src/test-entry.ts" : "src/index.ts"],
  outfile: forTests ? ".test-build/plugin.cjs" : "dist/index.js",
  // The SDK stays external in the test build and only there: the harness
  // drives the plugin through its own copy, and two copies of a module do not
  // recognise each other's objects.
  external: forTests ? ["astra-plugin-sdk"] : [],
});
outputs.push(main);

// The shim is built either way — the tests spawn the real one.
const shim = await build({ ...common, entryPoints: ["src/mcp-shim.ts"], outfile: "dist/mcp-shim.js" });
outputs.push(shim);

for (const result of outputs) {
  for (const [name, meta] of Object.entries(result.metafile.outputs)) {
    if (name.endsWith(".map")) continue;
    console.log(`  ${name} — ${(meta.bytes / 1024).toFixed(1)} KB`);
  }
}
