import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { createNightReflectionMap, createTumblerAtmosphere } from "../src/renderer/src/vehicle/tumblerAtmosphere.ts";

test("night atmosphere has an opaque backdrop, visible asphalt and one bounded shadow map", () => {
  const scene = new THREE.Scene();
  const atmosphere = createTumblerAtmosphere(scene);
  assert.ok(scene.background instanceof THREE.Color);
  assert.ok(scene.fog instanceof THREE.Fog);
  assert.equal(scene.fog.color.getHex(), scene.background.getHex());
  assert.ok(scene.fog.near > 10, "Near views remain clear of distance fog");
  const ground = scene.getObjectByName("Cinematic asphalt ground");
  assert.ok(ground instanceof THREE.Mesh);
  assert.ok(ground.material instanceof THREE.MeshStandardMaterial);
  assert.equal(ground.material.transparent, false);
  assert.equal(ground.receiveShadow, true);
  assert.ok(ground.material.map instanceof THREE.DataTexture);
  const shadows: THREE.DirectionalLight[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.DirectionalLight && object.castShadow) shadows.push(object);
  });
  assert.equal(shadows.length, 1);
  assert.deepEqual(shadows[0].shadow.mapSize.toArray(), [2048, 2048]);
  assert.equal(ground.material.map.image.width, 1024);
  assert.ok(ground.material.normalMap && ground.material.roughnessMap);
  assert.ok(scene.environment instanceof THREE.DataTexture);
  atmosphere.dispose();
});

test("low haze moves only with measured travel and freezes under reduced motion", () => {
  const scene = new THREE.Scene();
  const atmosphere = createTumblerAtmosphere(scene);
  const haze: THREE.Sprite[] = [];
  scene.traverse((object) => { if (object instanceof THREE.Sprite) haze.push(object); });
  const positions = () => haze.map((sprite) => sprite.position.toArray());
  assert.equal(haze.length, 4);
  atmosphere.update(100, false);
  const idle = positions();
  for (let index = 0; index < 20; index += 1) atmosphere.update(100, false);
  assert.deepEqual(positions(), idle);
  atmosphere.update(100.001, false);
  const onset = positions();
  onset.forEach((position, index) => {
    assert.ok(new THREE.Vector3(...position).distanceTo(new THREE.Vector3(...idle[index])) < 0.0001,
      "An infinitesimal wheel movement must not make the haze jump to an initial orbit phase");
  });
  atmosphere.update(101, false);
  const moving = positions();
  assert.notDeepEqual(moving, idle);
  atmosphere.update(120, true);
  atmosphere.update(140, true);
  assert.deepEqual(positions(), moving);
  atmosphere.update(140, false);
  assert.deepEqual(positions(), moving, "Leaving reduced motion does not replay accumulated travel");
  atmosphere.update(NaN, false);
  assert.deepEqual(positions(), moving);
  atmosphere.update(139, false);
  assert.notDeepEqual(positions(), moving, "Measured reverse travel moves the atmosphere too");
  atmosphere.dispose();
});

test("atmosphere disposes shared textures and surfaces once and restores the scene", () => {
  const scene = new THREE.Scene();
  const previousBackground = new THREE.Color(0x334433);
  const previousFog = new THREE.Fog(0x334433, 2, 10);
  scene.background = previousBackground;
  scene.fog = previousFog;
  const existing = new THREE.Group();
  scene.add(existing);
  const atmosphere = createTumblerAtmosphere(scene);
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  resources.add(scene.environment!);
  const key = scene.getObjectByName("Tumbler cinematic shadow key") as THREE.DirectionalLight;
  // A real renderer allocates this lazily. Exercise its cleanup without WebGL.
  const shadowMap = new THREE.WebGLRenderTarget(8, 8);
  key.shadow.map = shadowMap;
  let shadowReleased = 0;
  shadowMap.addEventListener("dispose", () => { shadowReleased += 1; });
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
    if (object instanceof THREE.Mesh) resources.add(object.geometry);
    const surfaces = Array.isArray(object.material) ? object.material : [object.material];
    for (const surface of surfaces) {
      resources.add(surface);
      for (const item of Object.values(surface)) if (item instanceof THREE.Texture) resources.add(item);
    }
  });
  const released = new Map<unknown, number>();
  for (const resource of resources) {
    released.set(resource, 0);
    resource.addEventListener("dispose", () => released.set(resource, released.get(resource)! + 1));
  }
  atmosphere.dispose();
  atmosphere.dispose();
  atmosphere.update(20, false);
  assert.deepEqual(scene.children, [existing]);
  assert.equal(scene.background, previousBackground);
  assert.equal(scene.fog, previousFog);
  assert.equal(scene.environment, null);
  assert.equal(shadowReleased, 1);
  for (const count of released.values()) assert.equal(count, 1);
});

test("high-definition road color, normals and reflections travel together and pause without catching up", () => {
  const scene = new THREE.Scene();
  const atmosphere = createTumblerAtmosphere(scene);
  try {
    const ground = scene.getObjectByName("Cinematic asphalt ground") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
    const maps = [ground.material.map!, ground.material.normalMap!, ground.material.roughnessMap!];
    atmosphere.update(0, false, true);
    atmosphere.update(1, false, true);
    assert.ok(maps.every((map) => Math.abs(map.offset.y + 1 / 3) < 1e-10), "Forward travel moves each channel toward -Z at the physical road scale");
    atmosphere.update(-1, false, true);
    assert.ok(maps.every((map) => Math.abs(map.offset.y - 1 / 3) < 1e-10), "Reverse must reverse the actual asphalt texture too");
    atmosphere.update(10, true, true);
    atmosphere.update(10, false, true);
    assert.ok(maps.every((map) => Math.abs(map.offset.y - 1 / 3) < 1e-10), "Reduced motion cannot replay missed surface travel");
    atmosphere.update(11, false, false);
    assert.ok(maps.every((map) => Math.abs(map.offset.y - 1 / 3) < 1e-10), "The static vehicle preview keeps its floor stationary");
  } finally { atmosphere.dispose(); }
});

test("night reflections contain finite HDR lights with a continuous panoramic seam", () => {
  const map = createNightReflectionMap();
  try {
    assert.equal(map.mapping, THREE.EquirectangularReflectionMapping);
    assert.equal(map.colorSpace, THREE.NoColorSpace);
    assert.equal(map.type, THREE.FloatType);
    const { width, height, data } = map.image;
    assert.equal(width, 512);
    assert.equal(height, 256);
    assert.ok(data.every(Number.isFinite));
    assert.ok(data.some((value) => value > 2), "HDR fixtures must survive until the bloom and filmic output passes");
    for (let y = 0; y < height; y += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        assert.ok(Math.abs(data[(y * width) * 4 + channel] - data[(y * width + width - 1) * 4 + channel]) < 0.00001);
      }
    }
  } finally { map.dispose(); }
});

test("nearby streetlights track physical lamp rows, fall off smoothly and freeze under reduced motion", () => {
  const scene = new THREE.Scene();
  const atmosphere = createTumblerAtmosphere(scene, { reflections: true });
  const lamps: THREE.PointLight[] = [];
  scene.traverse((object) => { if (object instanceof THREE.PointLight) lamps.push(object); });
  try {
    assert.equal(lamps.length, 4);
    atmosphere.update(0, false, false);
    assert.ok(lamps.every((lamp) => lamp.intensity === 0 && !lamp.castShadow));
    atmosphere.update(2, false, true);
    assert.deepEqual(lamps.map((lamp) => lamp.position.z), [4, -8, 4, -8]);
    assert.ok(lamps.every((lamp) => lamp.intensity > 0 && lamp.decay === 2));
    const held = lamps.map((lamp) => lamp.position.z);
    atmosphere.update(40, true, true);
    assert.deepEqual(lamps.map((lamp) => lamp.position.z), held);
    // Crossing a repeated lamp row exchanges the two neighbouring light slots,
    // preserving the actual spatial field instead of making illumination pop.
    atmosphere.update(6 - 0.001, false, true);
    const before = lamps.reduce((sum, lamp) => sum + lamp.intensity / (1 + lamp.position.z ** 2), 0);
    atmosphere.update(6 + 0.001, false, true);
    const after = lamps.reduce((sum, lamp) => sum + lamp.intensity / (1 + lamp.position.z ** 2), 0);
    assert.ok(Math.abs(before - after) < 0.0001);
    atmosphere.update(7, false, false);
    assert.ok(lamps.every((lamp) => lamp.intensity === 0));
  } finally { atmosphere.dispose(); }
});
