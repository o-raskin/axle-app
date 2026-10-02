const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { generateNotices } = require("../scripts/generate-software-notices.cjs");

function packages(t) {
  const root = mkdtempSync(path.join(tmpdir(), "axle-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = { packages: {} };
  for (const name of ["react", "react-dom", "scheduler", "three", "meshoptimizer", "electron-updater", "child"]) {
    const directory = path.join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    const manifest = { name, version: "1.0.0", license: "MIT" };
    if (name === "electron-updater") manifest.dependencies = { child: "1.0.0" };
    if (name === "child") manifest.dependencies = { "electron-updater": "1.0.0" };
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(directory, name === "meshoptimizer" ? "LICENSE.md" : "LICENSE"), `Copyright ${name}\r\nOriginal license text.\r\n`);
    lock.packages[`node_modules/${name}`] = { version: manifest.version, license: manifest.license };
  }
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  return { root, lock };
}

test("notices preserve original license bytes and include recursive runtime dependencies once", (t) => {
  const { root } = packages(t);
  const output = generateNotices(root);
  for (const name of ["react", "react-dom", "scheduler", "three", "meshoptimizer", "electron-updater", "child"]) {
    const original = readFileSync(path.join(root, "node_modules", name, name === "meshoptimizer" ? "LICENSE.md" : "LICENSE"), "utf8");
    assert.ok(output.includes(original), `Original license text is preserved for ${name}`);
    assert.equal(output.split(`\n${name} 1.0.0\n`).length - 1, 1, "Cycles cannot duplicate runtime notices");
  }
  assert.equal(generateNotices(root), output, "Notice generation is stable for locked inputs");
});

test("notice generation fails when installed dependencies disagree with the lock", (t) => {
  for (const name of ["react", "child"]) {
    const { root, lock } = packages(t);
    lock.packages[`node_modules/${name}`].version = "2.0.0";
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    assert.throws(() => generateNotices(root), /does not match/);
  }
});

test("a symlinked checkout resolves dependency lock entries against its real root", (t) => {
  const { root } = packages(t);
  const link = `${root}-link`;
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rmSync(link, { force: true }));
  assert.equal(generateNotices(link), generateNotices(root));
});

test("empty dependency license files cannot produce a misleading release notice", (t) => {
  for (const name of ["react", "child"]) {
    const { root } = packages(t);
    writeFileSync(path.join(root, "node_modules", name, "LICENSE"), " \n");
    assert.throws(() => generateNotices(root), /empty/);
  }
});

test("renderer license changes and missing runtime notices stop packaging for review", (t) => {
  const changed = packages(t);
  const file = path.join(changed.root, "node_modules", "three", "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.license = "new license";
  changed.lock.packages["node_modules/three"].license = manifest.license;
  writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(path.join(changed.root, "package-lock.json"), JSON.stringify(changed.lock));
  assert.throws(() => generateNotices(changed.root), /no longer declares/);
  const missing = packages(t);
  rmSync(path.join(missing.root, "node_modules", "child", "LICENSE"));
  assert.throws(() => generateNotices(missing.root), /No original license file found/);
});
