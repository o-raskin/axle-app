import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { bindTumblerModel } from "../src/renderer/src/vehicle/tumblerModel.ts";

function assembly() {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  for (const name of ["frontSteeringLeft", "frontSteeringRight", "wheelFrontLeft", "wheelFrontRight",
    "wheelRearLeft", "wheelRearRight", "frontLightLeft", "frontLightRight", "jetLight",
    "reverseLightFrontLeft", "reverseLightFrontRight", "reverseLightRear"]) {
    const group = new THREE.Group();
    group.name = name;
    group.add(new THREE.Mesh(geometry, material));
    root.add(group);
  }
  return { root, geometry, material, texture };
}

test("model disposal releases shared geometry, surfaces and textures once", () => {
  const source = assembly();
  const released = { geometry: 0, material: 0, texture: 0 };
  for (const key of ["geometry", "material", "texture"] as const) {
    source[key].addEventListener("dispose", () => { released[key] += 1; });
  }
  const bound = bindTumblerModel(source.root);
  const feedback = [...bound.lightMaterials, bound.boostMaterial, ...bound.reverseLightMaterials];
  let feedbackReleased = 0;
  feedback.forEach((material) => material.addEventListener("dispose", () => { feedbackReleased += 1; }));
  bound.dispose();
  bound.dispose();
  assert.deepEqual(released, { geometry: 1, material: 1, texture: 1 });
  assert.equal(feedbackReleased, feedback.length);
  assert.equal(source.root.children.length, 0);
});

test("a missing rig node releases already loaded model resources", () => {
  const source = assembly();
  source.root.remove(source.root.getObjectByName("jetLight")!);
  let released = 0;
  source.geometry.addEventListener("dispose", () => { released += 1; });
  source.texture.addEventListener("dispose", () => { released += 1; });
  assert.throws(() => bindTumblerModel(source.root), /Missing Tumbler assembly: jetLight/);
  assert.equal(released, 2);
  assert.equal(source.root.children.length, 0);
});

test("empty required geometry fails before producing invalid camera targets or wheel ratios", () => {
  for (const name of ["wheelFrontLeft", "frontLightRight", "jetLight", "reverseLightRear"]) {
    const source = assembly();
    source.root.getObjectByName(name)!.clear();
    let released = 0;
    source.geometry.addEventListener("dispose", () => { released += 1; });
    assert.throws(() => bindTumblerModel(source.root), /Invalid Tumbler assembly geometry/);
    assert.equal(released, 1);
  }
});

test("zero-radius tires fail instead of corrupting wheel rotation with infinity", () => {
  const source = assembly();
  source.root.getObjectByName("wheelRearRight")!.scale.y = 0;
  assert.throws(() => bindTumblerModel(source.root), /Invalid Tumbler wheel radius/);
});
