const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Keep packaging native: Electron and its frozen helper must have the same ABI.
module.exports = async (context) => {
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  assert.equal(context.electronPlatformName, process.platform, "Build on the target operating system");
  assert.equal(arch, process.arch, "Build with the target CPU architecture");
  const name = `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`;
  const source = path.resolve(__dirname, "../../../dist", name);
  assert.ok(fs.existsSync(source), "Build the native bridge first: python scripts/build_release.py");
  const destination = path.resolve(__dirname, "../resources/bridge");
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, name));
  fs.chmodSync(path.join(destination, name), 0o755);
};
