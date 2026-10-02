const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const moduleReady = import("../scripts/tumbler-source-bundle.mjs");
const zipReady = import("three/addons/libs/fflate.module.js");

async function sourceFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "axle-cad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  await mkdir(path.join(source, "custom"), { recursive: true });
  await mkdir(path.join(source, "ldraw"), { recursive: true });
  for (const [name, bytes] of Object.entries({ "42239.io": "original studio bytes", "42239.mpd": "assembly",
    "custom/axle.dat": "0 Author: test\r\n", "ldraw/LDConfig.ldr": "palette", "ARCHIVE-NOTICE.md": "rights" })) {
    await writeFile(path.join(source, name), bytes);
  }
  return { directory, source, archive: path.join(directory, "bundle.zip") };
}

test("packing is deterministic and extracted sources retain exact bytes", async (t) => {
  const { source, archive, directory } = await sourceFixture(t);
  const { packTumblerSourceBundle, extractTumblerSourceBundle } = await moduleReady;
  const first = await packTumblerSourceBundle(source, archive);
  const second = await packTumblerSourceBundle(source, archive);
  assert.equal(second.sha256, first.sha256);
  const destination = path.join(directory, "extracted");
  await extractTumblerSourceBundle(second, destination);
  assert.equal(await readFile(path.join(destination, "custom/axle.dat"), "utf8"), "0 Author: test\r\n");
  await assert.rejects(extractTumblerSourceBundle(second, destination), { code: "EEXIST" });
});

test("packing cannot overwrite user files through a predictable partial-file symlink", async (t) => {
  const { source, archive, directory } = await sourceFixture(t);
  const { packTumblerSourceBundle } = await moduleReady;
  const outside = path.join(directory, "user-edits");
  await writeFile(outside, "preserve my edits");
  await symlink(outside, `${archive}.partial`);
  await packTumblerSourceBundle(source, archive);
  assert.equal(await readFile(outside, "utf8"), "preserve my edits");
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".cad-source-")), []);
});

test("packing rejects symlinked source files and cleans up failed inventories", async (t) => {
  const { source, archive } = await sourceFixture(t);
  const { packTumblerSourceBundle } = await moduleReady;
  await symlink(path.join(source, "42239.mpd"), path.join(source, "custom/linked.dat"));
  await assert.rejects(packTumblerSourceBundle(source, archive), /cannot contain symlinks/);
  await assert.rejects(readFile(archive), { code: "ENOENT" });
});

test("malformed source inventories are rejected with explicit validation errors", async (t) => {
  const { source, archive, directory } = await sourceFixture(t);
  const { packTumblerSourceBundle, readTumblerSourceBundle } = await moduleReady;
  const { unzipSync, zipSync } = await zipReady;
  await packTumblerSourceBundle(source, archive);
  const original = unzipSync(await readFile(archive));
  for (const inventory of [null, [], { format: 1, files: [] }]) {
    const entries = { ...original, "bundle-manifest.json": Buffer.from(JSON.stringify(inventory)) };
    await writeFile(archive, zipSync(entries));
    await assert.rejects(readTumblerSourceBundle(archive), /Unsupported CAD archive inventory/);
  }
  const inventory = JSON.parse(Buffer.from(original["bundle-manifest.json"]).toString());
  inventory.files["42239.io"] = null;
  await writeFile(archive, zipSync({ ...original, "bundle-manifest.json": Buffer.from(JSON.stringify(inventory)) }));
  await assert.rejects(readTumblerSourceBundle(archive), /CAD source checksum mismatch/);
  await assert.rejects(readTumblerSourceBundle(archive, "0".repeat(64)), /CAD archive checksum mismatch/);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".cad-source-")), []);
});

test("invalid packing leaves the previous archive intact and no partial output", async (t) => {
  const { source, archive, directory } = await sourceFixture(t);
  const { packTumblerSourceBundle } = await moduleReady;
  await writeFile(archive, "previous verified archive");
  await rm(path.join(source, "ARCHIVE-NOTICE.md"));
  await assert.rejects(packTumblerSourceBundle(source, archive), /missing the original project/);
  assert.equal(await readFile(archive, "utf8"), "previous verified archive");
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".cad-source-")), []);
});

test("source archives and extraction reject traversal before creating any output", async (t) => {
  const { source, archive, directory } = await sourceFixture(t);
  const { packTumblerSourceBundle, readTumblerSourceBundle, extractTumblerSourceBundle, sha256 } = await moduleReady;
  const { unzipSync, zipSync } = await zipReady;
  await packTumblerSourceBundle(source, archive);
  const original = unzipSync(await readFile(archive));
  const inventory = JSON.parse(Buffer.from(original["bundle-manifest.json"]).toString());
  const bytes = Buffer.from("escape");
  inventory.files["../outside.dat"] = { bytes: bytes.length, sha256: sha256(bytes) };
  await writeFile(archive, zipSync({ ...original, "../outside.dat": bytes,
    "bundle-manifest.json": Buffer.from(JSON.stringify(inventory)) }));
  await assert.rejects(readTumblerSourceBundle(archive), /Unsafe CAD archive path/);
  const destination = path.join(directory, "new-extraction");
  await assert.rejects(extractTumblerSourceBundle({ files: new Map([
    ["42239.io", Buffer.from("valid first member")], ["../outside.dat", bytes]
  ]) }, destination), /Unsafe CAD archive path/);
  await assert.rejects(readFile(path.join(destination, "42239.io")), { code: "ENOENT" });
  assert.equal((await readdir(directory)).includes("new-extraction"), false);
});
