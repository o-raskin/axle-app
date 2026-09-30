/** Check the delivered containers, including signatures, before launching their payloads. */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const metadata = require("../package.json");

assert.equal(process.platform, "darwin", "macOS package verification requires macOS");
const root = path.resolve(__dirname, "..");
const version = process.env.RELEASE_VERSION || metadata.version;
const stem = path.join(root, "release", `Axle-${version}-mac-${process.arch}`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "axle-macos-"));
const mount = path.join(temporary, "dmg");
const run = (command, args) => execFileSync(command, args, { stdio: "inherit", timeout: 180000 });
const check = (directory) => run(process.execPath, [path.join(__dirname, "verify-package.cjs"), path.join(directory, "Axle.app/Contents/MacOS/Axle")]);
let mounted = false;
try {
  run("hdiutil", ["verify", `${stem}.dmg`]);
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, `${stem}.dmg`]);
  mounted = true;
  check(mount);
  const zip = path.join(temporary, "zip");
  run("ditto", ["-x", "-k", `${stem}.zip`, zip]);
  check(zip);
} finally {
  // If unmounting fails, leave the directory intact rather than traversing a mount.
  if (mounted) run("hdiutil", ["detach", mount]);
  fs.rmSync(temporary, { recursive: true, force: true });
}
