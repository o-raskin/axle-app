/** Launch a real packaged app, with its real preload and frozen bridge, without hardware. */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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
  let privateBridgeDirectory;
  try {
    if (process.platform === "darwin") {
      execFileSync("codesign", ["--verify", "--deep", "--strict", path.resolve(executablePath, "../../..")], { stdio: "inherit" });
    }
    application = await electron.launch({
      executablePath, cwd: temporary, env,
      // AppRun must make the same sandbox decision as a normal desktop launch.
      // Playwright otherwise injects --no-sandbox and can conceal startup failures.
      chromiumSandbox: executablePath.endsWith(".AppImage"),
      args: [`--user-data-dir=${path.join(temporary, "user-data")}`], timeout: 90000
    });
    const runtime = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged, version: app.getVersion(),
      resources: process.resourcesPath, userData: app.getPath("userData"), arch: process.arch,
      appImage: process.env.APPIMAGE, appDir: process.env.APPDIR
    }));
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.version, process.env.RELEASE_VERSION || metadata.version);
    assert.equal(runtime.arch, process.arch);
    if (process.platform === "linux" && executablePath.endsWith(".AppImage")) {
      assert.ok(runtime.appImage && runtime.appDir, "The AppImage runtime must start the app");
      assert.equal(runtime.resources, path.join(runtime.appDir, "resources"));
      const mounted = (await fs.statfs(runtime.resources)).type === 0x65735546; // FUSE_SUPER_MAGIC
      const extractAndRun = env.APPIMAGE_EXTRACT_AND_RUN === "1";
      assert.equal(mounted, !extractAndRun, "Verify the requested mounted or extract-and-run path");
      console.log(`Verified AppImage ${extractAndRun ? "extract-and-run" : "FUSE mount"}`);
    }
    assert.equal(await fs.realpath(runtime.userData), await fs.realpath(path.join(temporary, "user-data")));
    const helper = path.join(runtime.resources, "bridge", `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`);
    const root = path.resolve(__dirname, "../../..");
    const hash = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
    const sourceHelper = path.join(root, "dist", path.basename(helper));
    if (process.platform === "darwin") {
      // Signing seals the bundled helper too. Compare its code with only the signatures
      // removed from disposable copies; never change the binaries being tested.
      execFileSync("codesign", ["--verify", "--strict", helper], { stdio: "inherit" });
      const copies = [path.join(temporary, "source-helper"), path.join(temporary, "packaged-helper")];
      await fs.copyFile(sourceHelper, copies[0]);
      await fs.copyFile(helper, copies[1]);
      for (const copy of copies) execFileSync("codesign", ["--remove-signature", copy]);
      assert.equal(await hash(copies[0]), await hash(copies[1]), "Signing must not change the bundled bridge code");
    } else {
      assert.equal(await hash(helper), await hash(sourceHelper));
    }
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
    if (process.platform === "linux" && runtime.appImage) {
      const copies = (await fs.readdir(runtime.userData)).filter((name) => name.startsWith(".bridge-runtime-"));
      assert.equal(copies.length, 1, "AppImage must reuse one private bridge copy per app process");
      privateBridgeDirectory = path.join(runtime.userData, copies[0]);
      assert.equal(await hash(path.join(privateBridgeDirectory, path.basename(helper))), await hash(helper));
      assert.equal((await fs.stat(privateBridgeDirectory)).mode & 0o777, 0o700);
    }
    await window.locator("main.workspace").waitFor({ timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log(`Verified packaged Axle ${runtime.version} (${process.platform}/${runtime.arch}) and bundled bridge`);
  } finally {
    if (application) await application.close();
    if (privateBridgeDirectory) {
      await assert.rejects(fs.access(privateBridgeDirectory), { code: "ENOENT" }, "App exit must clean up its private bridge copy");
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
