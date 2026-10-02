import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createVolumeRayIntervals, VolumetricLightingPass } from "../src/renderer/src/vehicle/tumblerVolumetrics";

test("surface-biased ray intervals cover the entire medium and preserve homogeneous extinction", () => {
  const intervals = createVolumeRayIntervals();
  assert.equal(intervals.length, 25, "The existing bounded 24-step budget remains unchanged");
  assert.equal(intervals[0], 0);
  assert.equal(intervals.at(-1), 1);
  const lengths = Array.from(intervals.slice(1), (end, index) => end - intervals[index]);
  assert.ok(lengths.every((length) => length > 0));
  assert.ok(lengths[0] > lengths.at(-1)! * 30,
    "Thin low beams near the visible surface receive more samples than clear air near the camera");
  for (const distance of [0.1, 5, 22]) {
    const density = 0.035;
    const transmission = lengths.reduce((result, interval) => result * Math.exp(-density * distance * interval), 1);
    assert.ok(Math.abs(transmission - Math.exp(-density * distance)) < 1e-12,
      "Redistributing samples must not create extra fog or lose the integrated ray length");
  }
  const depth = new THREE.DepthTexture(1, 1);
  const pass = new VolumetricLightingPass(new THREE.Scene(), new THREE.PerspectiveCamera(), depth);
  try {
    assert.deepEqual(pass.scatteringMaterial.uniforms.rayIntervals.value, intervals,
      "The verified partition is the actual sampling schedule delivered to the GPU");
  } finally { pass.dispose(); depth.dispose(); }
});

test("participating fog packs the rendered lamp poses and exact resolved phases without stale light", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 80);
  camera.position.set(3, 2, 6);
  camera.lookAt(0, 0.5, 0);
  const lamps = new THREE.Group();
  lamps.position.set(2, 0.5, -1);
  const spot = new THREE.SpotLight(0xdcecff, 30, 7, 0.28, 0.85, 2);
  spot.name = "White headlight projector";
  spot.position.set(0.4, 0.6, 1.8);
  spot.target.position.set(0.4, 0, 4.6);
  lamps.add(spot, spot.target);
  const street = new THREE.PointLight(0xffc38a, 15, 18, 2);
  street.name = "Nearby sodium streetlamp -1:0";
  street.position.set(-5.42, 4.28, 3);
  const ignored = new THREE.PointLight(0xff0000, 1000);
  const green = new THREE.PointLight(0x00ff00, 1000);
  scene.add(lamps, street, ignored, green, camera);
  scene.updateMatrixWorld(true);
  const depth = new THREE.DepthTexture(1280, 800, THREE.UnsignedIntType);
  const pass = new VolumetricLightingPass(scene, camera, depth);
  try {
    pass.updateLighting();
    const state = pass.scatteringMaterial.uniforms;
    assert.equal(state.tDepth.value, depth, "Depth must come from visible beauty rather than the vehicle-only AO target");
    assert.deepEqual(state.spotPosition.value[0].toArray(), [2.4, 1.1, 0.8]);
    const direction = spot.target.getWorldPosition(new THREE.Vector3()).sub(spot.getWorldPosition(new THREE.Vector3())).normalize();
    assert.ok(state.spotDirection.value[0].distanceTo(direction) < 1e-10);
    assert.ok(state.spotColor.value[0].equals(spot.color.clone().multiplyScalar(30)));
    assert.deepEqual(state.spotShape.value[0].toArray(), [Math.cos(0.28), Math.cos(0.28 * 0.15), 7, 2]);
    assert.ok(state.pointColor.value[0].equals(street.color.clone().multiplyScalar(15)));
    assert.ok(state.pointColor.value.slice(1).every((color: THREE.Color) => color.r === 0 && color.g === 0 && color.b === 0),
      "Unrelated lights and diagnostic green signals cannot turn into street lighting");
    assert.ok(state.cameraWorld.value.equals(camera.matrixWorld));
    assert.ok(state.viewProjection.value.equals(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)));
    spot.intensity = 7.5;
    pass.updateLighting();
    assert.ok(state.spotColor.value[0].equals(spot.color.clone().multiplyScalar(7.5)), "Partial trigger/phase resolves immediately");
    lamps.visible = false;
    street.intensity = 0;
    pass.updateLighting();
    assert.ok(state.spotColor.value.every((color: THREE.Color) => color.r === 0 && color.g === 0 && color.b === 0));
    assert.ok(state.pointColor.value.every((color: THREE.Color) => color.r === 0 && color.g === 0 && color.b === 0));
    lamps.visible = true;
    spot.intensity = 0;
    pass.updateLighting();
    assert.equal(state.spotColor.value[0].getHex(), 0, "An off projector cannot leave a beam after reconnection or a flash");
  } finally { pass.dispose(); depth.dispose(); }
});

test("volumetric key shadows use the existing native raw depth and never create another shadow render", () => {
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xaaccee, 2.65);
  key.name = "Tumbler cinematic shadow key";
  key.castShadow = true;
  key.position.set(-3, 6, 2);
  key.target.position.set(1, 0, 0);
  key.shadow.map = new THREE.WebGLRenderTarget(2048, 2048);
  key.shadow.map.depthTexture = new THREE.DepthTexture(2048, 2048, THREE.UnsignedIntType);
  key.shadow.map.depthTexture.compareFunction = null;
  key.shadow.bias = -0.00015;
  key.shadow.matrix.makeTranslation(0.2, 0.3, 0.4);
  scene.add(key, key.target);
  scene.updateMatrixWorld(true);
  const depth = new THREE.DepthTexture(1, 1);
  const pass = new VolumetricLightingPass(scene, new THREE.PerspectiveCamera(), depth);
  try {
    pass.updateLighting();
    const state = pass.scatteringMaterial.uniforms;
    assert.equal(state.hasShadow.value, 1);
    assert.equal(state.tShadow.value, key.shadow.map.depthTexture);
    assert.ok(state.shadowMatrix.value.equals(key.shadow.matrix));
    assert.deepEqual(state.shadowTexel.value.toArray(), [1 / 2048, 1 / 2048]);
    assert.equal(state.shadowBias.value, -0.00015);
    assert.ok(state.keyDirection.value.distanceTo(new THREE.Vector3(-4, 6, 2).normalize()) < 1e-10);
    key.shadow.map.depthTexture.compareFunction = THREE.LessEqualCompare;
    pass.updateLighting();
    assert.equal(state.hasShadow.value, 0, "A raw-depth shader must never bind a comparison sampler with an incompatible GL type");
    assert.notEqual(state.tShadow.value, key.shadow.map.depthTexture);
    key.visible = false;
    pass.updateLighting();
    assert.equal(state.keyColor.value.getHex(), 0);
    assert.equal(key.shadow.map.width, 2048, "The original cached map is reused without resizing or allocating another light map");
  } finally {
    pass.dispose(); depth.dispose(); key.shadow.map.depthTexture.dispose(); key.shadow.map.dispose();
  }
});

test("volumetric HDR integration is bounded, restores renderer state on failure and releases owners once", () => {
  const depth = new THREE.DepthTexture(1920, 1200);
  const pass = new VolumetricLightingPass(new THREE.Scene(), new THREE.PerspectiveCamera(), depth);
  const read = new THREE.WebGLRenderTarget(16, 16);
  const write = new THREE.WebGLRenderTarget(16, 16);
  const previous = new THREE.WebGLRenderTarget(16, 16);
  let target: THREE.WebGLRenderTarget | null = previous;
  const targets: Array<THREE.WebGLRenderTarget | null> = [];
  const draws: THREE.Material[] = [];
  let fail = false;
  const renderer = {
    autoClear: true,
    getRenderTarget: () => target,
    setRenderTarget(next: THREE.WebGLRenderTarget | null) { targets.push(next); target = next; },
    render(mesh: THREE.Mesh) {
      draws.push(mesh.material as THREE.Material);
      if (fail) throw new Error("Context unavailable");
    }
  } as unknown as THREE.WebGLRenderer;
  try {
    pass.setSize(1280, 800);
    assert.equal(pass.volumeTarget.width, 640);
    assert.equal(pass.volumeTarget.height, 400);
    pass.setSize(3840, 2160);
    assert.equal(pass.volumeTarget.width, 640);
    assert.equal(pass.volumeTarget.height, 360, "High-DPI windows cannot multiply ray-march work without bound");
    assert.equal(pass.volumeTarget.depthBuffer, false);
    assert.equal(pass.volumeTarget.texture.type, THREE.HalfFloatType);
    assert.equal(pass.volumeTarget.samples, 0);
    assert.equal(pass.volumeTarget.texture.minFilter, THREE.NearestFilter, "Only the bilateral composite can mix neighbouring depth layers");
    assert.equal(pass.scatteringMaterial.toneMapped, false);
    assert.equal(pass.compositeMaterial.toneMapped, false, "The sole output pass tone maps the resulting linear HDR radiance");
    pass.render(renderer, write, read);
    assert.deepEqual(draws, [pass.scatteringMaterial, pass.compositeMaterial], "Fog adds two fullscreen triangles, no scene/shadow geometry render");
    assert.deepEqual(targets, [pass.volumeTarget, write, previous]);
    assert.equal(pass.compositeMaterial.uniforms.tDiffuse.value, read.texture);
    assert.equal(renderer.autoClear, true);
    targets.length = 0;
    fail = true;
    assert.throws(() => pass.render(renderer, write, read), /Context unavailable/);
    assert.equal(renderer.autoClear, true);
    assert.equal(target, previous, "Interrupted GPU work must not strand subsequent rendering in the fog target");
    const owners = [pass.volumeTarget, pass.scatteringMaterial, pass.compositeMaterial,
      pass.scatteringMaterial.uniforms.tShadow.value as THREE.Texture];
    const disposed = owners.map(() => 0);
    owners.forEach((owner, index) => owner.addEventListener("dispose", () => { disposed[index] += 1; }));
    let externalDepthDisposed = 0;
    depth.addEventListener("dispose", () => { externalDepthDisposed += 1; });
    pass.dispose(); pass.dispose();
    assert.deepEqual(disposed, owners.map(() => 1));
    assert.equal(externalDepthDisposed, 0, "The beauty pass retains ownership of scene depth");
    const drawCount = draws.length;
    pass.render(renderer, write, read);
    assert.equal(draws.length, drawCount);
    pass.setSize(1280, 800);
    assert.equal(pass.volumeTarget.width, 640);
  } finally { pass.dispose(); depth.dispose(); read.dispose(); write.dispose(); previous.dispose(); }
});
