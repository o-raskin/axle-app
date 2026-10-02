import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createWetRoadReflection } from "../src/renderer/src/vehicle/wetRoadReflection";

test("wet-road reflections are optional, bounded and release their target and geometry once", () => {
  const scene = new THREE.Scene();
  const road = createWetRoadReflection(scene);
  const resources = [road.mesh.geometry, road.mesh.material, road.mesh.getRenderTarget()];
  const counts = resources.map(() => 0);
  resources.forEach((item, i) => item.addEventListener("dispose", () => { counts[i] += 1; }));
  assert.equal(road.mesh.visible, false);
  road.setEnabled(true);
  assert.equal(road.mesh.visible, true);
  assert.equal(road.mesh.material.transparent, true, "Puddles cannot replace the underlying asphalt");
  assert.equal(road.mesh.material.depthWrite, false, "Scattering/contact occlusion cannot treat water as an opaque obstacle");
  road.resize(3840, 2160);
  assert.equal(road.mesh.getRenderTarget().width, 768);
  assert.equal(road.mesh.getRenderTarget().height, 432);
  assert.equal(road.mesh.getRenderTarget().samples, 0);
  road.resize(1280, 800);
  assert.deepEqual([road.mesh.getRenderTarget().width, road.mesh.getRenderTarget().height], [640, 400]);
  road.setTravel(3);
  road.setTravel(NaN);
  assert.equal(road.mesh.material.uniforms.travel.value, 3);
  counts.fill(0); // Target resizing releases only the previous storage.
  road.dispose();
  road.dispose();
  road.setEnabled(true);
  road.resize(10, 10);
  road.setTravel(100);
  assert.deepEqual(scene.children, []);
  assert.deepEqual(counts, [1, 1, 1]);
  assert.equal(road.mesh.material.uniforms.travel.value, 3);
});

test("a failed reflection render restores visibility, renderer state and beauty-frame statistics", () => {
  const scene = new THREE.Scene();
  const road = createWetRoadReflection(scene);
  const sprite = new THREE.Sprite();
  const signals = new THREE.Group();
  signals.name = "Tumbler signal effects";
  const hiddenSprite = new THREE.Sprite();
  hiddenSprite.visible = false;
  scene.add(sprite, signals, hiddenSprite);
  road.setEnabled(true);
  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.1, 80);
  camera.position.set(0, 3, 7);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();
  const target = new THREE.WebGLRenderTarget(4, 4);
  let currentTarget: THREE.WebGLRenderTarget | null = target;
  const renderer = {
    info: { autoReset: true, render: { frame: 8, calls: 34, triangles: 1234, points: 0, lines: 0 } },
    xr: { enabled: true }, shadowMap: { autoUpdate: true, needsUpdate: true }, autoClear: true,
    state: { buffers: { depth: { setMask() {} } } },
    getRenderTarget: () => currentTarget,
    setRenderTarget: (value: THREE.WebGLRenderTarget | null) => { currentTarget = value; },
    render() {
      assert.equal(renderer.shadowMap.needsUpdate, false, "Reflection cannot consume a pending beauty shadow update");
      assert.equal(sprite.visible, false);
      assert.equal(signals.visible, false);
      assert.equal(hiddenSprite.visible, false);
      renderer.info.render.calls += 15;
      renderer.info.render.triangles += 500;
      throw new Error("GPU context lost");
    }
  } as unknown as THREE.WebGLRenderer;
  const previous = { ...renderer.info.render };
  try {
    assert.throws(() => road.mesh.onBeforeRender(renderer, scene, camera,
      road.mesh.geometry, road.mesh.material, null), /GPU context lost/);
    assert.equal(sprite.visible, true);
    assert.equal(signals.visible, true);
    assert.equal(hiddenSprite.visible, false);
    assert.equal(road.mesh.visible, true);
    assert.equal(currentTarget, target);
    assert.equal(renderer.xr.enabled, true);
    assert.equal(renderer.shadowMap.autoUpdate, true);
    assert.equal(renderer.shadowMap.needsUpdate, true);
    assert.equal(renderer.info.autoReset, true);
    assert.deepEqual(renderer.info.render, previous);
  } finally {
    road.dispose(); target.dispose(); sprite.material.dispose(); hiddenSprite.material.dispose();
  }
});
