const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const bundleBridge = require("../scripts/bundle-bridge.cjs");

const context = { arch: process.arch === "arm64" ? 3 : 1, electronPlatformName: process.platform };
const binaryName = `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`;
async function checkout(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "axle-package-hook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "ui/electron");
  await mkdir(root, { recursive: true });
  await mkdir(path.join(directory, "dist"));
  const source = path.join(directory, "dist", binaryName);
  await writeFile(source, "native executable");
  return { directory, root, source, destination: path.join(root, "resources/bridge"), target: path.join(root, "resources/bridge", binaryName) };
}

test("packaging copies the verified bridge bytes, grants execution and leaves no partial resources", async (t) => {
  const fixture = await checkout(t);
  await bundleBridge(context, fixture.root);
  assert.deepEqual(await readFile(fixture.target), await readFile(fixture.source));
  if (process.platform !== "win32") assert.equal((await stat(fixture.target)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(fixture.destination), [binaryName]);
});

test("packaging refuses nonnative operating systems and architectures before writing resources", async (t) => {
  const fixture = await checkout(t);
  await assert.rejects(bundleBridge({ ...context, electronPlatformName: "other" }, fixture.root), /target operating system/);
  await assert.rejects(bundleBridge({ ...context, arch: context.arch === 1 ? 3 : 1 }, fixture.root), /target CPU architecture/);
  await assert.rejects(stat(fixture.destination), { code: "ENOENT" });
});

test("missing or linked source executables cannot enter a desktop package", async (t) => {
  const fixture = await checkout(t);
  await rm(fixture.source);
  await assert.rejects(bundleBridge(context, fixture.root), /Build the native bridge first/);
  const outside = path.join(fixture.directory, "foreign-bridge");
  await writeFile(outside, "foreign executable");
  await symlink(outside, fixture.source);
  await assert.rejects(bundleBridge(context, fixture.root), /regular file/);
});

test("packaging cannot overwrite a user file through an existing bridge symlink", async (t) => {
  const fixture = await checkout(t);
  await mkdir(fixture.destination, { recursive: true });
  const outside = path.join(fixture.directory, "user-edits");
  await writeFile(outside, "preserve my edits");
  await symlink(outside, fixture.target);
  await assert.rejects(bundleBridge(context, fixture.root), /cannot be a symlink/);
  assert.equal(await readFile(outside, "utf8"), "preserve my edits");
});
