const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Keep packaging native: Electron and its frozen helper must have the same ABI.
module.exports = async (context, electronRoot = path.resolve(__dirname, "..")) => {
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  assert.equal(context.electronPlatformName, process.platform, "Build on the target operating system");
  assert.equal(arch, process.arch, "Build with the target CPU architecture");
  const name = `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`;
  const source = path.resolve(electronRoot, "../../dist", name);
  assert.ok(fs.existsSync(source), "Build the native bridge first: python scripts/build_release.py");
  assert.ok(!fs.lstatSync(source).isSymbolicLink() && fs.statSync(source).isFile(), "The native bridge must be a regular file");
  const destination = path.resolve(electronRoot, "resources/bridge");
  assert.ok(!fs.existsSync(destination) || !fs.lstatSync(destination).isSymbolicLink(), "Bridge resources cannot be a symlink");
  fs.mkdirSync(destination, { recursive: true });
  const target = path.join(destination, name);
  assert.ok(!fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink(), "Bundled bridge cannot be a symlink");
  const temporary = fs.mkdtempSync(path.join(destination, ".bundle-"));
  try {
    const copy = path.join(temporary, name);
    fs.copyFileSync(source, copy);
    fs.chmodSync(copy, 0o755);
    fs.renameSync(copy, target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};
