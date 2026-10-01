// Render the actual bundled asset from six inspection views in isolated Electron.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");
const { _electron: electron } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const output = process.env.AXLE_MODEL_PREVIEW_DIR || path.join(root, "test-results/tumbler-model");
const asset = process.env.AXLE_MODEL_ASSET || path.join(root, "src/renderer/src/vehicle/assets/tumbler-42239.glb");
const views = [
  ["front-three-quarter", "Front three-quarter", [6, 4, 8]],
  ["rear-three-quarter", "Rear three-quarter", [-6, 3.6, -8]],
  ["front", "Front", [0, 2, 10]],
  ["left-side", "Left side", [-10, 1.6, 0]],
  ["right-side", "Right side", [10, 1.6, 0]],
  ["overhead", "Overhead", [0, 12, 0.001]]
];

async function run() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axle-model-preview-"));
  let app;
  try {
    await fs.mkdir(output, { recursive: true });
    await fs.copyFile(asset, path.join(temporary, "model.glb"));
    await build({
      stdin: {
        resolveDir: root,
        sourcefile: "tumbler-inspection.ts",
        contents: `
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { bindTumblerModel } from "./src/renderer/src/vehicle/tumblerModel";
(async () => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(1040, 680);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#eceee9");
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777b72, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 8, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -5;
  key.shadow.camera.right = key.shadow.camera.top = 5;
  key.shadow.bias = -0.001;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdde7ed, 1.4);
  rim.position.set(-4, 4, -6);
  scene.add(rim);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.025;
  ground.receiveShadow = true;
  scene.add(ground);
  const { scene: assembly } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("./model.glb");
  const model = bindTumblerModel(assembly);
  scene.add(model.root);
  const bounds = new THREE.Box3().setFromObject(model.root);
  const center = bounds.getCenter(new THREE.Vector3());
  const aspect = 1040 / 680;
  const camera = new THREE.OrthographicCamera(-aspect * 4, aspect * 4, 4, -4, 0.1, 100);
  window.preview = {
    ready: true,
    render(position) {
      camera.position.set(...position).add(center);
      camera.lookAt(center);
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      let extent = 0;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(camera);
        extent = Math.max(extent, Math.abs(projected.x), Math.abs(projected.y));
      }
      camera.zoom = 0.84 / extent;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      return { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };
    }
  };
})().catch(error => { window.preview = { error: error.stack || String(error) }; });`
      },
      bundle: true, platform: "browser", format: "iife", target: "es2022",
      outfile: path.join(temporary, "preview.js"), logLevel: "silent"
    });
    await fs.writeFile(path.join(temporary, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline'"><style>body{margin:0;overflow:hidden}canvas{display:block}</style><script defer src="preview.js"></script>`);
    await fs.writeFile(path.join(temporary, "main.cjs"), `const {app,BrowserWindow}=require("electron");app.setPath("userData",${JSON.stringify(path.join(temporary, "user-data"))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1040,height:680,useContentSize:true,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(temporary, "index.html"))});});app.on("window-all-closed",()=>app.quit());`);
    app = await electron.launch({ executablePath: require("electron"), args: ["--enable-unsafe-swiftshader", path.join(temporary, "main.cjs")] });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => window.preview?.ready || window.preview?.error);
    const error = await page.evaluate(() => window.preview.error);
    if (error) throw new Error(error);
    for (const [name, label, position] of views) {
      const stats = await page.evaluate(position => window.preview.render(position), position);
      await page.locator("canvas").screenshot({ path: path.join(output, `${name}.png`) });
      process.stdout.write(`${label}: ${stats.triangles} triangles, ${stats.calls} calls including shadows\n`);
    }
    const sheet = `<!doctype html><meta charset="utf-8"><title>Axle Tumbler 42239 inspection</title><style>body{margin:0;padding:32px;background:#eceee9;font:15px system-ui;color:#252a26}h1{margin:0 0 8px;font-size:28px}p{margin:0 0 24px;color:#5b625d}main{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}figure{margin:0;background:#fff;border-radius:12px;overflow:hidden}img{width:100%;display:block}figcaption{padding:12px 18px;font-weight:600}</style><h1>LEGO Technic 42239 · Tumbler</h1><p>Actual bundled geometry · editable Studio/LDraw source retained in the Electron package</p><main>${views.map(([name, label]) => `<figure><img src="${name}.png"><figcaption>${label}</figcaption></figure>`).join("")}</main>`;
    await fs.writeFile(path.join(output, "index.html"), sheet);
    await page.goto(`file://${path.join(output, "index.html")}`);
    await page.locator("img").last().waitFor();
    await page.waitForFunction(() => [...document.images].every(image => image.complete));
    await page.screenshot({ path: path.join(output, "inspection.png"), fullPage: true });
    process.stdout.write(`Saved inspection views: ${output}\n`);
  } finally {
    await app?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
run().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
