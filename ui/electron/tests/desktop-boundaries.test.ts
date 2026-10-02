import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopSettingsStore } from "../src/main/desktopSettings";
import { assertTrustedRenderer, isSafeExternalUrl, isTrustedRendererUrl } from "../src/main/rendererSecurity";

for (const rendererUrl of ["http://localhost:5173/", "file:///application/renderer/index.html"]) {
  test(`only the application document and its fragments are trusted: ${rendererUrl}`, () => {
    assert.equal(isTrustedRendererUrl(rendererUrl, rendererUrl), true);
    assert.equal(isTrustedRendererUrl(`${rendererUrl}#main`, rendererUrl), true);
    for (const target of ["file:///tmp/untrusted.html", "https://example.invalid", `${rendererUrl}other`,
      `${rendererUrl}?redirect=1`, "http://localhost:5173.evil.invalid/", "http://localhost:5173@evil.invalid/",
      "http://username:password@localhost:5173/", "http://localhost:5174/", "invalid URL"]) {
      assert.equal(isTrustedRendererUrl(target, rendererUrl), false, target);
    }
  });
}

test("IPC requires the owned main frame as well as an approved document", () => {
  const url = "file:///application/renderer/index.html";
  const frame = { url };
  const contents = { mainFrame: frame };
  assert.doesNotThrow(() => assertTrustedRenderer({ sender: contents, senderFrame: frame }, contents, url));
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { url } },
    { sender: contents, senderFrame: null }
  ]) assert.throws(() => assertTrustedRenderer(event, contents, url), /Desktop IPC/);
  frame.url = "file:///tmp/other.html";
  assert.throws(() => assertTrustedRenderer({ sender: contents, senderFrame: frame }, contents, url), /Desktop IPC/);
  assert.throws(() => assertTrustedRenderer({ sender: contents, senderFrame: frame }, null, url), /Desktop IPC/);
});

test("external links cannot invoke OS command, file, credential or custom protocol handlers", () => {
  for (const url of ["https://github.com/o-raskin/axle-app", "http://localhost/docs"]) assert.equal(isSafeExternalUrl(url), true);
  for (const url of ["file:///Applications/Terminal.app", "javascript:alert(1)", "data:text/html,hello",
    "ms-excel:ofe|u|file:///tmp/a", "https://user:secret@example.invalid", "invalid"])
    assert.equal(isSafeExternalUrl(url), false, url);
});

test("settings round-trip preserves a valid preference and rejects invalid updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "axle-settings-"));
  try {
    const path = join(directory, "nested", "desktop-settings.json");
    const store = new DesktopSettingsStore(path);
    const defaults = store.read();
    defaults.launchFullscreen = true;
    assert.deepEqual(store.read(), { launchFullscreen: false });
    assert.deepEqual(store.update({ launchFullscreen: true }), { launchFullscreen: true });
    assert.deepEqual(new DesktopSettingsStore(path).read(), { launchFullscreen: true });
    const saved = readFileSync(path, "utf8");
    for (const patch of [null, undefined, [], "fullscreen", { launchFullscreen: "true" }, { launchFullscreen: 1 }]) {
      assert.throws(() => store.update(patch));
      assert.equal(readFileSync(path, "utf8"), saved);
    }
    assert.deepEqual(store.update({ unknownSetting: false }), { launchFullscreen: true });
    assert.deepEqual(readdirSync(join(directory, "nested")), ["desktop-settings.json"]);
    store.update({ launchFullscreen: false });
    assert.deepEqual(store.read(), { launchFullscreen: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("corrupt settings recover safely and a failed replacement cleans temporary files", () => {
  const directory = mkdtempSync(join(tmpdir(), "axle-settings-failure-"));
  try {
    const path = join(directory, "desktop-settings.json");
    const store = new DesktopSettingsStore(path);
    for (const text of ["{broken", "null", '"invalid"', '{"launchFullscreen":"true"}']) {
      writeFileSync(path, text);
      assert.deepEqual(store.read(), { launchFullscreen: false });
    }
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => store.update({ launchFullscreen: true }));
    assert.deepEqual(readdirSync(directory), ["desktop-settings.json"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
