import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createTumblerRendering, DetailAntialiasPass, MeasuredScenePass, NightOutputPass, selectBeautySamples, VehicleOcclusionPass, withVehicleOccluders } from "../src/renderer/src/vehicle/tumblerRendering";

test("contact occlusion releases every GPU target, sampling material and noise texture once", () => {
  const pass = new VehicleOcclusionPass(new THREE.Scene(), new THREE.PerspectiveCamera(), 1, 1, 16);
  const resources = [pass.normalRenderTarget, pass.ssaoRenderTarget, pass.blurRenderTarget,
    pass.normalMaterial, pass.ssaoMaterial, pass.blurMaterial, pass.depthRenderMaterial,
    pass.copyMaterial, pass.noiseTexture];
  const counts = resources.map(() => 0);
  resources.forEach((resource, index) => resource.addEventListener("dispose", () => { counts[index] += 1; }));
  pass.setSize(1000, 600);
  assert.equal(pass.normalRenderTarget.width, 500);
  assert.equal(pass.normalRenderTarget.height, 300);
  // Resizing render targets legitimately disposes their old storage.
  counts.fill(0);
  pass.dispose();
  pass.dispose();
  assert.ok(counts.every((value) => value === 1), "The extra depth pass cannot leak resources on unmount or lost contexts");
});

test("contact occlusion excludes faded city walls and transparent haze, then restores the exact scene", () => {
  const scene = new THREE.Scene();
  const car = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const road = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
  const street = new THREE.Group();
  street.name = "Tumbler street scene";
  const signals = new THREE.Group();
  signals.name = "Tumbler signal effects";
  const haze = new THREE.Sprite();
  const transparent = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3 }));
  const lines = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  const points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
  const alreadyHidden = new THREE.Group();
  alreadyHidden.visible = false;
  scene.add(car, road, street, signals, haze, transparent, lines, points, alreadyHidden);
  const original = scene.children.map((object) => object.visible);
  try {
    assert.throws(() => withVehicleOccluders(scene, () => {
      assert.equal(car.visible, true);
      assert.equal(road.visible, true);
      for (const object of [street, signals, haze, transparent, lines, points]) assert.equal(object.visible, false);
      throw new Error("Context lost during depth pass");
    }), /Context lost/);
    assert.deepEqual(scene.children.map((object) => object.visible), original);
  } finally {
    for (const object of [car, road, transparent, lines, points]) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); }
    haze.material.dispose();
  }
});

test("sharp anti-aliasing waits for both lookup images and releases pending callbacks and GPU resources", async () => {
  const previousImage = globalThis.Image;
  const images: Array<EventTarget & { complete: boolean; naturalWidth: number; onload: unknown; onerror: unknown }> = [];
  class LookupImage extends EventTarget {
    complete = false;
    naturalWidth = 0;
    src = "";
    onload: unknown = null;
    onerror: unknown = null;
    constructor() { super(); images.push(this); }
  }
  globalThis.Image = LookupImage as unknown as typeof Image;
  let pass: DetailAntialiasPass | undefined;
  try {
    pass = new DetailAntialiasPass();
    const internal = pass as unknown as {
      _edgesRT: THREE.WebGLRenderTarget; _weightsRT: THREE.WebGLRenderTarget;
      _areaTexture: THREE.Texture; _searchTexture: THREE.Texture;
      _materialEdges: THREE.Material; _materialWeights: THREE.Material; _materialBlend: THREE.Material;
    };
    assert.equal(pass.ready, false, "An undecoded lookup cannot reach the GPU on the first frame");
    Object.assign(images[0], { complete: true, naturalWidth: 160 });
    images[0].dispatchEvent(new Event("load"));
    assert.equal(pass.ready, false, "One decoded lookup is not sufficient");
    Object.assign(images[1], { complete: true, naturalWidth: 66 });
    images[1].dispatchEvent(new Event("load"));
    assert.equal(pass.ready, true);
    assert.equal(await pass.settled, true, "The idle viewer can request its final antialiased frame after decoding");
    pass.setSize(1280, 800);
    assert.equal(internal._edgesRT.width, 1280);
    assert.equal(internal._weightsRT.height, 800);
    const resources = Object.values(internal).filter((value) => value instanceof THREE.Texture
      || value instanceof THREE.Material || value instanceof THREE.WebGLRenderTarget);
    // The public pass has other fields too; explicitly count its seven owners.
    const owned = [internal._edgesRT, internal._weightsRT, internal._areaTexture,
      internal._searchTexture, internal._materialEdges, internal._materialWeights, internal._materialBlend];
    assert.ok(resources.length >= owned.length);
    const counts = owned.map(() => 0);
    owned.forEach((resource, index) => resource.addEventListener("dispose", () => { counts[index] += 1; }));
    pass.dispose();
    pass.dispose();
    assert.deepEqual(counts, owned.map(() => 1));
    assert.equal(pass.ready, false);
    assert.ok(images.every((image) => image.onload === null && image.onerror === null),
      "Late image loads cannot mark disposed textures dirty after unmount");
    const failed = new DetailAntialiasPass();
    Object.assign(images[2], { complete: true, naturalWidth: 0 });
    images[2].dispatchEvent(new Event("error"));
    Object.assign(images[3], { complete: true, naturalWidth: 66 });
    images[3].dispatchEvent(new Event("load"));
    assert.equal(await failed.settled, false, "A failed lookup resolves without enabling an invalid sampler");
    failed.dispose();
    const cancelled = new DetailAntialiasPass();
    cancelled.dispose();
    assert.equal(await cancelled.settled, false, "Unmount during decode cannot leave an unresolved ready wait");
  } finally {
    pass?.dispose();
    if (previousImage) globalThis.Image = previousImage;
    else delete (globalThis as unknown as { Image?: typeof Image }).Image;
  }
});

test("beauty multisampling respects HDR/depth format support and the fixed attachment memory budget", () => {
  assert.equal(selectBeautySamples([8, 4, 2], [4, 2], 1_000_000), 4);
  assert.equal(selectBeautySamples([4, 2], [2], 1_000_000), 2);
  assert.equal(selectBeautySamples([4], [2], 1_000_000), 0);
  assert.equal(selectBeautySamples([4, 2], [4, 2], 2_000_000), 2);
  assert.equal(selectBeautySamples([4, 2], [4, 2], 3_000_000), 0,
    "Large drawing buffers retain SMAA instead of allocating excessive multisample attachments");
  assert.equal(selectBeautySamples([4, 2], [4, 2], 1_000_000, 2), 2);
  for (const pixels of [NaN, Infinity, 0, -1]) assert.equal(selectBeautySamples([4, 2], [4, 2], pixels), 0);
});

test("beauty multisampling renders geometry once, keeps scene measurements and disposes its resolve resources", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const targets: Array<THREE.WebGLRenderTarget | null> = [];
  const draws: THREE.Object3D[] = [];
  const info = { render: { calls: 0, triangles: 0 } };
  const renderer = {
    capabilities: { maxSamples: 4 },
    getContext: () => ({
      RENDERBUFFER: 1, RGBA16F: 2, DEPTH_COMPONENT24: 3, SAMPLES: 4,
      getInternalformatParameter: () => new Int32Array([4, 2])
    }),
    autoClear: true,
    info,
    getRenderTarget: () => null,
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) => targets.push(target),
    clear() {},
    render(object: THREE.Object3D) {
      draws.push(object);
      info.render.calls = object === scene ? 74 : 1;
      info.render.triangles = object === scene ? 950_000 : 2;
    }
  } as unknown as THREE.WebGLRenderer;
  const pass = new MeasuredScenePass(renderer, scene, camera);
  const write = new THREE.WebGLRenderTarget(8, 8);
  const read = new THREE.WebGLRenderTarget(8, 8);
  try {
    pass.setSize(1280, 800);
    assert.equal(pass.beautyTarget.samples, 4);
    assert.ok(pass.beautyTarget.depthTexture instanceof THREE.DepthTexture);
    assert.equal(pass.beautyTarget.depthTexture.compareFunction, null);
    assert.equal(pass.beautyTarget.resolveDepthBuffer, true, "Depth must resolve together with HDR multisample color");
    pass.render(renderer, write, read, 0, false);
    assert.deepEqual(targets, [pass.beautyTarget, read]);
    assert.equal(draws.filter((object) => object === scene).length, 1);
    assert.equal(draws.length, 2, "Only a cheap resolved-color quad is added to the beauty render");
    assert.equal(pass.calls, 74);
    assert.equal(pass.triangles, 950_000);
    assert.equal(renderer.info.render.triangles, 2, "Diagnostics must not accidentally measure the resolve quad");
    pass.setSize(2560, 1440);
    assert.equal(pass.beautyTarget.samples, 0);
    targets.length = 0;
    draws.length = 0;
    pass.render(renderer, write, read, 0, false);
    assert.deepEqual(targets, [pass.beautyTarget, read]);
    assert.equal(draws.filter((object) => object === scene).length, 1,
      "Even without MSAA, fog receives actual depth from the sole beauty scene render");
    assert.equal(draws.length, 2);
    const counts = [0, 0, 0];
    pass.beautyTarget.addEventListener("dispose", () => { counts[0] += 1; });
    pass.resolvePass.material.addEventListener("dispose", () => { counts[1] += 1; });
    pass.beautyTarget.depthTexture.addEventListener("dispose", () => { counts[2] += 1; });
    pass.dispose();
    pass.dispose();
    assert.deepEqual(counts, [1, 1, 1]);
    pass.render(renderer, write, read, 0, false);
    assert.equal(draws.length, 2, "A released beauty pass cannot redraw or allocate storage");
  } finally { pass.dispose(); write.dispose(); read.dispose(); }
});

test("the night grade retains filmic exposure and performs a single final sRGB output", () => {
  const pass = new NightOutputPass();
  const write = new THREE.WebGLRenderTarget(8, 8);
  const read = new THREE.WebGLRenderTarget(8, 8);
  let drawn = 0;
  const renderer = {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1.12,
    setRenderTarget(target: THREE.WebGLRenderTarget | null) { assert.equal(target, null); },
    render(mesh: THREE.Mesh) {
      assert.equal(mesh.material, pass.material);
      drawn += 1;
    }
  } as unknown as THREE.WebGLRenderer;
  try {
    pass.renderToScreen = true;
    pass.render(renderer, write, read, 0, false);
    assert.equal(pass.uniforms.tDiffuse.value, read.texture);
    assert.equal(pass.uniforms.toneMappingExposure.value, 1.12);
    assert.ok("ACES_FILMIC_TONE_MAPPING" in pass.material.defines);
    assert.ok("SRGB_TRANSFER" in pass.material.defines);
    const source = pass.material.fragmentShader;
    assert.ok(source.indexOf("vec3 graded") < source.indexOf("// tone mapping"),
      "Shadow and warm-highlight adjustments operate on HDR light before output compression");
    assert.equal((source.match(/sRGBTransferOETF/g) || []).length, 1);
    renderer.toneMappingExposure = 0.95;
    pass.render(renderer, write, read, 0, false);
    assert.equal(pass.uniforms.toneMappingExposure.value, 0.95);
    assert.equal(drawn, 2);
  } finally { pass.dispose(); write.dispose(); read.dispose(); }
});

test("beauty diagnostics separate dirty cached shadow work and restore the renderer hook", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const target = new THREE.WebGLRenderTarget(2, 2);
  const info = { render: { calls: 0, triangles: 0 } };
  let dirty = true;
  let fail = false;
  let reflectionReset = false;
  const shadowMap = {
    render() {
      assert.equal(this, shadowMap, "The temporary observer must preserve the real shadow renderer receiver");
      if (dirty) {
        info.render.calls += 60;
        info.render.triangles += 910_000;
        dirty = false;
      }
      if (fail) throw new Error("Shadow GPU context interrupted");
    }
  };
  const original = shadowMap.render;
  const renderer = {
    capabilities: { maxSamples: 0 }, getContext: () => ({}), autoClear: true,
    shadowMap, info,
    getRenderTarget: () => null, setRenderTarget() {}, clear() {},
    render(object: THREE.Object3D) {
      if (object === scene) {
        info.render.calls = 0;
        info.render.triangles = 0;
        shadowMap.render();
        if (reflectionReset) {
          info.render.calls = 0;
          info.render.triangles = 0;
          shadowMap.render();
        }
        info.render.calls += 90;
        info.render.triangles += 931_026;
      } else {
        info.render.calls = 1;
        info.render.triangles = 2;
      }
    }
  } as unknown as THREE.WebGLRenderer;
  const pass = new MeasuredScenePass(renderer, scene, camera);
  try {
    pass.render(renderer, target, target, 0, false);
    assert.equal(pass.calls, 90);
    assert.equal(pass.triangles, 931_026);
    assert.equal(pass.shadowCalls, 60);
    assert.equal(pass.shadowTriangles, 910_000);
    assert.equal(shadowMap.render, original);
    pass.render(renderer, target, target, 0, false);
    assert.equal(pass.calls, 90);
    assert.equal(pass.triangles, 931_026);
    assert.equal(pass.shadowCalls, 0, "Cached shadow frames cannot be reported as new shadow draws");
    assert.equal(pass.shadowTriangles, 0);
    dirty = true;
    reflectionReset = true;
    pass.render(renderer, target, target, 0, false);
    assert.equal(pass.calls, 90, "A nested reflector reset cannot cause shadow subtraction twice");
    assert.equal(pass.triangles, 931_026);
    assert.equal(pass.shadowCalls, 60, "Total shadow work remains visible even when Three resets its geometry counters");
    assert.equal(pass.shadowTriangles, 910_000);
    fail = true;
    assert.throws(() => pass.render(renderer, target, target, 0, false), /Shadow GPU context interrupted/);
    assert.equal(shadowMap.render, original, "Interrupted rendering cannot leave a metrics wrapper installed");
    assert.equal(renderer.autoClear, true);
  } finally { pass.dispose(); target.dispose(); }
});

test("a failed beauty depth draw restores renderer state and the original material override", () => {
  const scene = new THREE.Scene();
  const original = new THREE.MeshBasicMaterial();
  scene.overrideMaterial = original;
  const previous = new THREE.WebGLRenderTarget(2, 2);
  let target: THREE.WebGLRenderTarget | null = previous;
  const renderer = {
    capabilities: { maxSamples: 0 }, getContext: () => ({}),
    autoClear: true,
    info: { render: { calls: 0, triangles: 0 } },
    getRenderTarget: () => target,
    setRenderTarget(next: THREE.WebGLRenderTarget | null) { target = next; },
    clear() {},
    render() { throw new Error("GPU context interrupted"); }
  } as unknown as THREE.WebGLRenderer;
  const pass = new MeasuredScenePass(renderer, scene, new THREE.PerspectiveCamera());
  const override = new THREE.MeshNormalMaterial();
  pass.overrideMaterial = override;
  try {
    assert.throws(() => pass.render(renderer, previous, previous, 0, false), /GPU context interrupted/);
    assert.equal(renderer.autoClear, true);
    assert.equal(target, previous);
    assert.equal(scene.overrideMaterial, original, "A lost context must not strand the car and city in a replacement shader");
  } finally { pass.dispose(); previous.dispose(); original.dispose(); override.dispose(); }
});

test("GPUs without float render buffers keep the direct renderer and cannot draw after cleanup", () => {
  let frames = 0;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const renderer = {
    extensions: { has: () => false },
    info: { render: { calls: 32, triangles: 900_000 } },
    render(actualScene: THREE.Scene, actualCamera: THREE.Camera) {
      assert.equal(actualScene, scene);
      assert.equal(actualCamera, camera);
      frames += 1;
    }
  } as unknown as THREE.WebGLRenderer;
  const graphics = createTumblerRendering(renderer, scene, camera);
  assert.equal(graphics.enhanced, false);
  assert.equal(graphics.volumetric, false);
  graphics.resize(1280, 800);
  graphics.render();
  assert.equal(graphics.calls, 32);
  assert.equal(graphics.triangles, 900_000);
  assert.equal(frames, 1);
  graphics.dispose();
  graphics.dispose();
  graphics.render();
  assert.equal(frames, 1);
});
