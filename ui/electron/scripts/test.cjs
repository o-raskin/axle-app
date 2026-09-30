// Compile TypeScript tests with the existing build tool so tests also run on Node 20.
const { buildSync } = require("esbuild");
const { mkdtempSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const directory = resolve(__dirname, "../tests");
const temporary = mkdtempSync(join(tmpdir(), "axle-tests-"));
try {
  const files = readdirSync(directory).filter((file) => /\.test\.(ts|cjs)$/.test(file));
  const tests = files.map((file) => {
    const source = join(directory, file);
    if (file.endsWith(".cjs")) return source;
    const outfile = join(temporary, file.replace(/\.ts$/, ".cjs"));
    buildSync({ entryPoints: [source], outfile, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
    return outfile;
  });
  const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
