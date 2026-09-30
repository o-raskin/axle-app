/** Launch a real packaged app, with its real preload and frozen bridge, without hardware. */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const metadata = require("../package.json");

async function main() {
  const defaultExecutable = process.platform === "darwin"
    ? `release/mac${process.arch === "arm64" ? "-arm64" : ""}/Axle.app/Contents/MacOS/Axle`
    : process.platform === "win32" ? "release/win-unpacked/Axle.exe" : "release/linux-unpacked/axle";
  const executablePath = path.resolve(__dirname, "..", process.argv[2] || defaultExecutable);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axle-package-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(PYTHON|PYI_|_PYI_|LEGO_BRIDGE_|ELECTRON_)/i.test(key)
  ));
  // Deliberately invalid overrides prove the packaged app cannot fall back to source mode.
  env.LEGO_BRIDGE_PROJECT_ROOT = path.join(temporary, "missing-source");
  env.LEGO_BRIDGE_PYTHON = path.join(temporary, "missing-python");
  let application;
  try {
    application = await electron.launch({
      executablePath, cwd: temporary, env,
      args: [`--user-data-dir=${path.join(temporary, "user-data")}`], timeout: 90000
    });
    const runtime = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged, version: app.getVersion(),
      resources: process.resourcesPath, userData: app.getPath("userData"), arch: process.arch
    }));
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.version, process.env.RELEASE_VERSION || metadata.version);
    assert.equal(runtime.arch, process.arch);
    assert.equal(await fs.realpath(runtime.userData), await fs.realpath(path.join(temporary, "user-data")));
    const helper = path.join(runtime.resources, "bridge", `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`);
    const root = path.resolve(__dirname, "../../..");
    const hash = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
    assert.equal(await hash(helper), await hash(path.join(root, "dist", path.basename(helper))));
    assert.equal(await hash(path.join(runtime.resources, "LICENSE")), await hash(path.join(root, "LICENSE")));
    const window = await application.firstWindow();
    const errors = [];
    window.on("pageerror", (error) => errors.push(error.message));
    await window.waitForFunction(() => Boolean(window.legoBridgeUi), undefined, { timeout: 30000 });
    const result = await window.evaluate(async () => ({
      bootstrap: await window.legoBridgeUi.getBootstrapState(),
      catalog: await window.legoBridgeUi.getBridgeProfiles(),
      status: await window.legoBridgeUi.getBridgeStatus()
    }));
    assert.equal(result.bootstrap.appVersion, runtime.version);
    for (const category of ["models", "gamepads"]) {
      const profiles = (await fs.readdir(path.join(root, "config", category)))
        .filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
      if (category === "gamepads") profiles.push("auto");
      assert.deepEqual(result.catalog[category].map((item) => item.id).sort(), profiles.sort());
    }
    assert.equal(result.status.status, "idle");
    await window.locator("main.workspace").waitFor({ timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log(`Verified packaged Axle ${runtime.version} (${process.platform}/${runtime.arch}) and bundled bridge`);
  } finally {
    if (application) await application.close();
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
