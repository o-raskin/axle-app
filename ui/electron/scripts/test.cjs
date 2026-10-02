// Compile TypeScript tests with the existing build tool so tests also run on Node 20.
const { buildSync } = require("esbuild");
const { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const directory = resolve(__dirname, "../tests");
// Resolve macOS /var aliases before generating relative source-map paths.
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "axle-tests-")));
try {
  const files = readdirSync(directory).filter((file) => /\.test\.(ts|cjs)$/.test(file));
  const tests = files.map((file) => {
    const source = join(directory, file);
    if (file.endsWith(".cjs")) return source;
    const outfile = join(temporary, file.replace(/\.ts$/, ".cjs"));
    buildSync({ entryPoints: [source], outfile, bundle: true, platform: "node", format: "cjs", target: "node20", sourcemap: "inline", logLevel: "silent" });
    return outfile;
  });
  const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...tests], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (process.env.NODE_V8_COVERAGE) {
    // Node caches sources as file URLs; c8 filters each mapped range before
    // resolving those URLs, otherwise incorrectly marking entire TS files as
    // covered without their branches. Normalize names, preserving all counts.
    for (const file of readdirSync(process.env.NODE_V8_COVERAGE)) {
      if (!file.endsWith(".json")) continue;
      const target = join(process.env.NODE_V8_COVERAGE, file);
      const coverage = JSON.parse(readFileSync(target, "utf8"));
      for (const entry of Object.values(coverage["source-map-cache"] || {})) {
        if (entry.data?.sources) {
          entry.data.sources = entry.data.sources.map((source) => source.startsWith("file://") ? fileURLToPath(source) : source);
        }
      }
      writeFileSync(target, JSON.stringify(coverage));
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
