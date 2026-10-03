#!/usr/bin/env node
/** Capture the real production UI with simulated telemetry, never real hardware.
 * Build first; pass a temporary frame directory for subsequent GIF encoding.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { fixtureMain, fixturePreload } = require("./smoke-test.cjs");

async function capture() {
  const project = path.resolve(__dirname, "..");
  const output = path.resolve(project, "../../docs/media");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axle-readme-"));
  const frames = process.argv[2] ? path.resolve(process.argv[2]) : path.join(temporary, "frames");
  const renderer = path.join(project, "dist/renderer/index.html");
  await fs.access(renderer);
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(frames, { recursive: true });
  await fs.writeFile(path.join(temporary, "main.cjs"), `(${fixtureMain.toString()})();\n`);
  await fs.writeFile(path.join(temporary, "preload.cjs"), `(${fixturePreload.toString()})();\n`);
  let app;
  const errors = [];
  try {
    app = await electron.launch({
      executablePath: require("electron"),
      args: ["--enable-unsafe-swiftshader", "--force-device-scale-factor=1", path.join(temporary, "main.cjs")],
      env: {
        ...process.env, AXLE_SMOKE_USER_DATA: path.join(temporary, "user-data"),
        AXLE_SMOKE_PRELOAD: path.join(temporary, "preload.cjs"),
        AXLE_SMOKE_RENDERER: renderer, AXLE_SMOKE_SCENARIO: "normal"
      }
    });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 920));
    await page.waitForFunction(() => window.__AXLE_TEST__?.snapshot().status === "running");
    await page.evaluate(() => window.__AXLE_TEST__.setup());
    const stream = (patch = {}) => page.evaluate((patch) => window.__AXLE_TEST__.telemetryStream({
      model_name: "42239 Batmobile Tumbler", max_drive: 100, max_steering: 100,
      throttle: 0, steering: 0, front_lights_on: false, rocket_lights_on: false,
      flicker: false, boost: false, brake: false, crash: false, measured_wheel_rate: 0, ...patch
    }), patch);
    const settled = () => page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.cameraMoving === "false");
    const menu = page.locator(".tumbler-viewer__toolbar");
    const openMenu = async () => { if (await menu.getAttribute("open") === null) await menu.locator("summary").click(); };
    const clearFocus = () => page.evaluate(() => document.activeElement?.blur());

    await stream({ front_lights_on: true });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.dataset.renderTriangles) > 100_000);
    await settled();
    await clearFocus();
    await page.screenshot({ path: path.join(output, "axle-drive.png"), fullPage: true });

    await openMenu();
    await menu.getByLabel("Street scene", { exact: true }).check();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.surfaceTexturesReady === "true");
    await settled();
    await clearFocus();
    await page.screenshot({ path: path.join(output, "axle-night-street.png"), fullPage: true });

    // Capture the vehicle card at a consistent size. Production camera following,
    // encoder interpolation, street travel and real lamp shaders do all animation.
    const clip = await page.locator(".vehicle-card").boundingBox();
    assert.ok(clip && clip.width > 0 && clip.height > 0);
    const scenes = [
      { throttle: 40, measured_wheel_rate: 5, front_lights_on: true },
      { throttle: 70, measured_wheel_rate: 9, front_lights_on: true, boost: true },
      { throttle: -30, measured_wheel_rate: -4, rocket_lights_on: true },
      { flicker: true }
    ];
    const captures = [];
    const beginning = performance.now();
    for (const scene of scenes) {
      await stream(scene);
      for (let index = 0; index < 12; index++) {
        const targetTime = beginning + captures.length * 160;
        const delay = targetTime - performance.now();
        if (delay > 0) await page.waitForTimeout(delay);
        const file = `frame-${String(captures.length).padStart(3, "0")}.png`;
        const time = performance.now();
        await page.screenshot({ path: path.join(frames, file), clip });
        captures.push({ file, time });
      }
    }
    await fs.writeFile(path.join(frames, "timings.json"), JSON.stringify(captures, null, 2));
    assert.deepEqual(errors, [], "Captures must not conceal renderer errors");
    process.stdout.write(`Screenshots: ${output}\nAnimation frames: ${frames}\n`);
  } finally {
    if (app) await app.close();
    // Keep only explicitly requested frames; the private fixture is disposable.
    if (!process.argv[2]) process.stdout.write("Pass a frame directory to retain animation frames.\n");
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
capture().catch((error) => { console.error(error); process.exitCode = 1; });
