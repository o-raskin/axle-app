import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { cleanupBridgeRuntimes, resolveBridgeLaunch } from "../src/main/bridgeRuntime";

test("AppImage runs an identical private bridge copy outside the mount and cleans it up", () => {
  const temporary = mkdtempSync(join(tmpdir(), "axle-appimage-runtime-"));
  try {
    const resourcesPath = join(temporary, "mounted", "resources");
    const userDataPath = join(temporary, "user-data");
    const source = join(resourcesPath, "bridge", "lego-technic-gamepad-bridge");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "frozen-bridge-code", { mode: 0o555 });
    const options = {
      isPackaged: true, platform: "linux" as const, resourcesPath, userDataPath,
      environment: { APPIMAGE: "/downloads/Axle.AppImage", LEGO_BRIDGE_PYTHON: "/invalid/python" }
    };
    const launch = resolveBridgeLaunch(options, () => assert.fail("No source fallback"));
    assert.notEqual(launch.command, source);
    assert.equal(dirname(dirname(launch.command)), userDataPath);
    assert.deepEqual(readFileSync(launch.command), readFileSync(source));
    if (process.platform !== "win32") {
      assert.equal(statSync(dirname(launch.command)).mode & 0o777, 0o700);
      assert.equal(statSync(launch.command).mode & 0o777, 0o700);
    }
    assert.equal(resolveBridgeLaunch(options, () => assert.fail()).command, launch.command);
    cleanupBridgeRuntimes();
    assert.equal(existsSync(launch.command), false);
    assert.equal(readFileSync(source, "utf8"), "frozen-bridge-code");
    assert.equal(existsSync(userDataPath), true);
  } finally {
    cleanupBridgeRuntimes();
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const platform of ["darwin", "win32", "linux"] as const) {
  test(`packaged ${platform} launches its bundled bridge with writable storage and no Python`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "axle-runtime-"));
    try {
      const resourcesPath = join(temporary, "Application Resources");
      const userDataPath = join(temporary, "User Data");
      const command = join(resourcesPath, "bridge", `lego-technic-gamepad-bridge${platform === "win32" ? ".exe" : ""}`);
      mkdirSync(join(resourcesPath, "bridge"), { recursive: true });
      writeFileSync(command, "bundled-test-runtime");
      const launch = resolveBridgeLaunch({
        isPackaged: true, platform, resourcesPath, userDataPath,
        environment: { LEGO_BRIDGE_PYTHON: "/invalid/python", LEGO_BRIDGE_HOME: "/read-only/home" }
      }, () => assert.fail("Packaged apps must never discover source or system Python"));
      assert.equal(launch.command, command);
      assert.deepEqual(launch.args, ["--frontend", "jsonl"]);
      assert.equal(launch.cwd, userDataPath);
      assert.equal(launch.env.LEGO_BRIDGE_HOME, userDataPath);
      assert.equal(launch.env.PYTHONIOENCODING, "utf-8");
      assert.equal(existsSync(userDataPath), true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test("an incomplete package reports a missing bridge instead of falling back to local Python", () => {
  const temporary = mkdtempSync(join(tmpdir(), "axle-runtime-missing-"));
  try {
    assert.throws(() => resolveBridgeLaunch({
      isPackaged: true, platform: "linux", resourcesPath: temporary, userDataPath: join(temporary, "user"), environment: {}
    }, () => assert.fail("Unexpected source fallback")), /bundled bridge is missing/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("development preserves interpreter arguments, source script and explicit runtime storage", () => {
  const launch = resolveBridgeLaunch({
    isPackaged: false, platform: "win32", resourcesPath: "/unused", userDataPath: "/unused",
    environment: { LEGO_BRIDGE_HOME: "/development/data", SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS: "0" }
  }, () => ({ command: "py", args: ["-3"], root: "/development/source" }));
  assert.equal(launch.command, "py");
  assert.deepEqual(launch.args, ["-3", "-u", join("/development/source", "gamepad_bridge.py"), "--frontend", "jsonl"]);
  assert.equal(launch.cwd, "/development/source");
  assert.equal(launch.env.LEGO_BRIDGE_HOME, "/development/data");
  assert.equal(launch.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "0");
});
