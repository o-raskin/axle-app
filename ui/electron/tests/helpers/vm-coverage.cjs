const { createHash } = require("node:crypto");
const { mkdirSync, realpathSync, writeFileSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
const { fileURLToPath } = require("node:url");

/** V8 reports VM execution but does not cache its source maps. Leave the exact
 * generated script available until c8 reads it after the test processes exit. */
function vmCoverageFilename(code, filename) {
  if (!process.env.NODE_V8_COVERAGE) return filename;
  const directory = join(process.env.NODE_V8_COVERAGE, "generated");
  mkdirSync(directory, { recursive: true });
  const digest = createHash("sha256").update(filename).update(code).digest("hex").slice(0, 16);
  const generated = join(realpathSync(directory), `${basename(filename)}-${process.pid}-${digest}.cjs`);
  // v8-to-istanbul filters bundle ranges before resolving sourceRoot. Absolute
  // source names prevent unvisited methods from being marked covered by default.
  const savedCode = code.replace(/(sourceMappingURL=data:application\/json;base64,)([^\n]+)/, (_match, prefix, encoded) => {
    const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const sourceRoot = map.sourceRoot?.startsWith("file://") ? fileURLToPath(map.sourceRoot) : map.sourceRoot || "";
    map.sources = map.sources.map((source) => source.startsWith("file://")
      ? fileURLToPath(source) : resolve(dirname(filename), sourceRoot, source));
    map.sourceRoot = "";
    return `${prefix}${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  });
  writeFileSync(generated, savedCode, "utf8");
  return generated;
}

module.exports = { vmCoverageFilename };
