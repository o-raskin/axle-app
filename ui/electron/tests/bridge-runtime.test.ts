import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveBridgeLaunch } from "../src/main/bridgeRuntime";

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
