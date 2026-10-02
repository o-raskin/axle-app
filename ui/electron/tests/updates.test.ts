import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { replaceAppImage } from "../src/main/appImageUpdate";
import { isNewerVersion, manualRelease, releaseBaseUrl, UpdateController, type UpdateDependencies } from "../src/main/updateController";

function harness(overrides: Partial<UpdateDependencies> = {}) {
  const calls: string[] = [];
  const deps: UpdateDependencies = {
    enabled: true, currentVersion: "0.1.14",
    engine: {
      check: async () => { calls.push("check"); return "0.1.15"; },
      download: async () => { calls.push("download"); },
      install: () => { calls.push("install"); }
    },
    manualCheck: async () => ({ version: "0.1.15", url: "https://example.invalid" }),
    openDownload: async () => { calls.push("open"); },
    consent: async (stage) => { calls.push(`consent:${stage}`); return true; },
    notify: async (kind) => { calls.push(`notify:${kind}`); },
    isDriving: () => false,
    prepareInstall: async () => { calls.push("stop-control"); },
    failedInstall: () => { calls.push("unlock"); },
    busyChanged: (busy) => { calls.push(`busy:${busy}`); },
    logError: () => { calls.push("error"); },
    ...overrides
  };
  return { calls, deps, controller: new UpdateController(deps) };
}

test("startup never downloads or installs after the user declines", async () => {
  const h = harness({ consent: async () => false });
  await h.controller.check();
  assert.deepEqual(h.calls, ["busy:true", "check", "busy:false"]);
});

test("installation requires a second consent and completed vehicle shutdown", async () => {
  const h = harness();
  await h.controller.check();
  assert.deepEqual(h.calls, ["busy:true", "check", "consent:download", "download", "consent:install", "stop-control", "install", "busy:false"]);
  const later = harness({ consent: async (stage) => stage === "download" });
  await later.controller.check();
  assert.ok(later.calls.includes("download"));
  assert.ok(!later.calls.includes("stop-control"));
  assert.ok(!later.calls.includes("install"));
});

test("failed motor cleanup blocks installation and releases the session lock", async () => {
  const h = harness({ prepareInstall: async () => { throw new Error("motor cleanup failed"); } });
  await h.controller.check();
  assert.ok(!h.calls.includes("install"));
  assert.ok(h.calls.includes("unlock"));
  assert.ok(h.calls.includes("notify:error"));
});

test("offline startup stays quiet, manual errors are actionable and checks can be retried", async () => {
  const h = harness({ engine: { check: async () => { throw new Error("offline"); }, download: async () => {}, install: () => {} } });
  await h.controller.check();
  assert.ok(!h.calls.includes("notify:error"));
  await h.controller.check(true);
  assert.equal(h.calls.filter((call) => call === "notify:error").length, 1);
});

test("download failure cannot reach the installer", async () => {
  const h = harness();
  h.deps.engine!.download = async () => { throw new Error("checksum mismatch"); };
  await h.controller.check();
  assert.ok(h.calls.includes("notify:error"));
  assert.ok(!h.calls.includes("install"));
});

test("a drive started during the download defers the restart prompt", async () => {
  let driving = false;
  const h = harness({ isDriving: () => driving });
  h.deps.engine!.download = async () => { driving = true; };
  await h.controller.check();
  assert.ok(!h.calls.includes("consent:install"));
  assert.ok(!h.calls.includes("stop-control"));
});

test("development, active driving and equal or older releases cannot update", async () => {
  for (const overrides of [{ enabled: false }, { isDriving: () => true }]) {
    const h = harness(overrides);
    await h.controller.check();
    assert.deepEqual(h.calls, []);
  }
  for (const version of ["0.1.14", "0.1.13", "0.1.15-beta.1"]) {
    const h = harness();
    h.deps.engine!.check = async () => version;
    await h.controller.check();
    assert.ok(!h.calls.includes("download"));
  }
  assert.equal(isNewerVersion("0.1.100", "0.1.99"), true);
  assert.equal(isNewerVersion("999999999999999999.0.0", "0.1.14"), false);
});

test("overlapping checks and drives starting during a request never duplicate update prompts", async () => {
  let complete!: (version: string) => void;
  let driving = false;
  const h = harness({ isDriving: () => driving });
  h.deps.engine!.check = () => new Promise((resolve) => { complete = resolve; });
  const checking = h.controller.check();
  await h.controller.check(true);
  driving = true;
  complete("0.1.15");
  await checking;
  assert.deepEqual(h.calls, ["busy:true", "busy:false"]);
});

test("unsigned Mac builds offer manual installation and never invoke an automatic installer", async () => {
  const h = harness({ engine: undefined });
  await h.controller.check();
  assert.deepEqual(h.calls, ["busy:true", "consent:manual", "open", "busy:false"]);
});

test("manual releases require stable tags and a matching installer from our GitHub repository", () => {
  const url = `${releaseBaseUrl}/download/v0.1.15/Axle-0.1.15-mac-arm64.dmg`;
  const release = { tag_name: "v0.1.15", draft: false, prerelease: false, assets: [{ name: "Axle-0.1.15-mac-arm64.dmg", size: 123, browser_download_url: url }] };
  assert.deepEqual(manualRelease(release, "darwin", "arm64"), { version: "0.1.15", url });
  assert.equal(manualRelease(release, "darwin", "x64"), null);
  assert.equal(manualRelease({ ...release, prerelease: true }, "darwin", "arm64"), null);
  assert.equal(manualRelease({ ...release, assets: [{ ...release.assets[0], browser_download_url: "https://evil.invalid/file" }] }, "darwin", "arm64"), null);
});

test("AppImage replacement preserves the exact Steam shortcut path and executable permission", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "axle-update-"));
  try {
    const old = join(directory, "Axle-0.1.14-linux-x86_64.AppImage");
    const next = join(directory, "Axle-0.1.15-linux-x86_64.AppImage");
    writeFileSync(old, "old app");
    writeFileSync(next, "verified new app");
    replaceAppImage(next, old);
    assert.equal(readFileSync(old, "utf8"), "verified new app");
    assert.equal(statSync(old).mode & 0o777, 0o755);
    assert.equal(readdirSync(directory).length, 2);
    assert.throws(() => replaceAppImage(join(directory, "missing"), old));
    assert.equal(readFileSync(old, "utf8"), "verified new app");
    const link = join(directory, "shortcut.AppImage");
    symlinkSync(old, link);
    assert.throws(() => replaceAppImage(next, link));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("a drive started while install consent is open is never stopped for an update", async () => {
  let driving = false;
  const h = harness({ isDriving: () => driving, consent: async (stage) => {
    if (stage === "install") driving = true;
    return true;
  } });
  await h.controller.check();
  assert.ok(h.calls.includes("download"));
  assert.ok(!h.calls.includes("stop-control"));
  assert.ok(!h.calls.includes("install"));
});

test("manual release selection never returns an installer for an unsupported platform or architecture", () => {
  const name = "Axle-0.1.15-linux-amd64.deb";
  const url = `${releaseBaseUrl}/download/v0.1.15/${name}`;
  const release = { tag_name: "v0.1.15", draft: false, prerelease: false,
    assets: [{ name, size: 123, browser_download_url: url }] };
  assert.deepEqual(manualRelease(release, "linux", "x64"), { version: "0.1.15", url });
  for (const [platform, arch] of [["linux", "arm64"], ["linux", "ia32"], ["win32", "x64"], ["darwin", "ia32"]]) {
    assert.equal(manualRelease(release, platform, arch), null);
  }
});
