import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createTumblerSignals } from "../src/renderer/src/vehicle/tumblerSignals";
import type { TumblerModel } from "../src/renderer/src/vehicle/tumblerModel";

function fixture(options: { volumetric?: boolean } = {}) {
  const scene = new THREE.Scene();
  const model = {
    partAnchors: {
      lights: [new THREE.Vector3(-0.6, 0.8, 2), new THREE.Vector3(0.6, 0.8, 2)],
      reverse: [new THREE.Vector3(-0.4, 1, 1), new THREE.Vector3(0.4, 1, 1), new THREE.Vector3(0, 0.9, -2)],
      boost: [new THREE.Vector3(0, 0.7, -2.4)]
    }
  } as TumblerModel;
  const effects = createTumblerSignals(scene, model, options);
  const root = scene.getObjectByName("Tumbler signal effects")!;
  const groups = {
    white: root.getObjectByName("White headlight effects")!,
    green: root.getObjectByName("Green optical effects")!,
    boost: root.getObjectByName("Orange boost effects")!
  };
  return { scene, model, effects, root, groups };
}

test("volumetric lighting replaces cheap headlight cones while retaining exact live sources and signal optics", () => {
  const { effects, scene, root, groups } = fixture({ volumetric: true });
  try {
    const projectors: THREE.SpotLight[] = [];
    scene.traverse((object) => {
      assert.ok(!object.name.includes("short scattering beam"), "Fog cannot be rendered twice by both cones and ray marching");
      if (object instanceof THREE.SpotLight) projectors.push(object);
    });
    assert.equal(projectors.length, 2);
    assert.equal(groups.white.children.filter((object) => object instanceof THREE.Sprite).length, 2);
    assert.equal(groups.green.children.filter((object) => object instanceof THREE.Sprite).length, 3);
    assert.ok(groups.boost.children.some((object) => object.name.includes("exhaust scattering")));
    effects.update({ white: 0.6, green: 1, boost: 0.4 });
    assert.ok(projectors.every((light) => light.intensity === 18));
    assert.equal(groups.green.userData.signal, 1);
    effects.update({ white: 0, green: 0, boost: 0 });
    assert.ok(projectors.every((light) => light.intensity === 0));
    assert.ok(root.children.every((group) => !group.visible));
  } finally { effects.dispose(); }
});

test("signal scattering uses the resolved lamp phase and goes fully dark between reverse and Attack flashes", () => {
  const { effects, scene, root, groups } = fixture();
  try {
    assert.ok(root.children.every((group) => !group.visible));
    for (const phase of [0, 1, 0, 1, 0]) {
      effects.update({ white: 0.6, green: phase, boost: 0 });
      assert.equal(groups.green.visible, phase === 1);
      assert.equal(groups.green.userData.signal, phase);
      assert.equal(groups.white.userData.signal, 0.6);
      assert.equal(groups.boost.visible, false);
      scene.traverse((object) => {
        if (object instanceof THREE.SpotLight) assert.equal(object.intensity, 18);
      });
    }
    effects.update({ white: 0.4, green: 1, boost: 0.4 });
    assert.equal(groups.white.userData.signal, 0.4);
    assert.equal(groups.green.userData.signal, 1);
    assert.equal(groups.boost.userData.signal, 0.4);
    effects.update({ white: 0, green: 0, boost: 0 });
    scene.traverse((object) => {
      if (object instanceof THREE.SpotLight) assert.equal(object.intensity, 0);
      if (object instanceof THREE.Sprite || object instanceof THREE.Mesh) {
        const material = object.material as THREE.SpriteMaterial | THREE.MeshBasicMaterial | THREE.ShaderMaterial;
        const intensity = material instanceof THREE.ShaderMaterial ? material.uniforms.brightness.value : material.opacity;
        assert.equal(intensity, 0, `${object.name} must switch off with its real lamp`);
      }
    });
    assert.ok(root.children.every((group) => !group.visible));
  } finally {
    effects.dispose();
  }
});

test("signals remain depth tested at all three green optics and keep scattering geometry and projector lights bounded", () => {
  const { effects, scene, model, root, groups } = fixture();
  try {
    const greenHalos = groups.green.children.filter((object) => object instanceof THREE.Sprite);
    assert.equal(greenHalos.length, 3);
    greenHalos.forEach((halo, index) => {
      assert.deepEqual(halo.position.toArray(), model.partAnchors.reverse[index].toArray());
    });
    let triangles = 0;
    let draws = 0;
    let lights = 0;
    scene.traverse((object) => {
      if (object instanceof THREE.Light) {
        lights += 1;
        assert.ok(object instanceof THREE.SpotLight, "Only real white headlights need dynamic projector illumination");
        assert.equal(object.castShadow, false, "Lamp effects cannot add shadow map passes");
      }
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
      draws += 1;
      const material = object.material as THREE.Material;
      assert.equal(material.depthTest, true, "Hidden optics cannot shine through the body");
      assert.equal(material.depthWrite, false, "Transparent scattering cannot mask the model");
      assert.equal(object.castShadow, false);
      if (object instanceof THREE.Mesh) {
        triangles += object.geometry.index!.count / 3;
      } else triangles += 2;
    });
    assert.equal(lights, 2, "The dense CAD model can afford only its two nonshadow white headlights");
    assert.ok(triangles <= 1000, `Expected a small scattering budget; received ${triangles} triangles`);
    assert.ok(draws < 24, `Expected fewer than 24 scattering draws; received ${draws}`);
    assert.deepEqual(model.partAnchors.lights[0].toArray(), [-0.6, 0.8, 2], "Authoritative model anchors must stay unchanged");
    effects.update({ white: Number.NaN, green: -1, boost: Number.POSITIVE_INFINITY });
    assert.ok(root.children.every((group) => !group.visible));
    effects.update({ white: 2, green: 3, boost: 4 });
    assert.ok(root.children.every((group) => group.userData.signal === 1));
  } finally {
    effects.dispose();
  }
});

test("white projectors start at the real headlights and shine forward/down with physical distance falloff", () => {
  const { effects, scene, model } = fixture();
  try {
    const projectors: THREE.SpotLight[] = [];
    scene.traverse((object) => { if (object instanceof THREE.SpotLight) projectors.push(object); });
    projectors.forEach((light, index) => {
      const anchor = model.partAnchors.lights[index];
      assert.equal(light.position.x, anchor.x);
      assert.equal(light.position.y, anchor.y);
      assert.ok(Math.abs(light.position.z - anchor.z) <= 0.02);
      assert.ok(light.target.position.z > light.position.z, "Forward is +Z");
      assert.ok(light.target.position.y < light.position.y, "Headlights must illuminate the damp asphalt ahead");
      assert.ok(light.target.parent, "A projector target must be in the rendered scene");
      assert.equal(light.decay, 2, "Projectors use inverse-square falloff");
      assert.ok(light.distance <= 7 && light.distance > 0);
      assert.ok(light.penumbra >= 0.8, "The projector cannot make a hard polygonal ground pool");
      assert.equal(light.castShadow, false);
    });
    effects.update({ white: 0.4, green: 0, boost: 0 });
    assert.ok(projectors.every((light) => light.intensity === 12));
    effects.update({ white: 1, green: 0, boost: 0 });
    assert.ok(projectors.every((light) => light.intensity === 30));
    effects.update({ white: 0, green: 0, boost: 0 });
    assert.ok(projectors.every((light) => light.intensity === 0));
  } finally {
    effects.dispose();
  }
});

test("lamp phases and hidden reflection optics retain a stable projector layout without light leakage", () => {
  const { scene, effects, root, groups } = fixture({ volumetric: true });
  const visibleProjectors = () => {
    const lights: THREE.SpotLight[] = [];
    scene.traverseVisible((object) => { if (object instanceof THREE.SpotLight) lights.push(object); });
    return lights;
  };
  try {
    const initial = visibleProjectors();
    assert.equal(initial.length, 2);
    for (const phase of [0, 1, 0, 0.4, 0]) {
      effects.update({ white: phase, green: phase, boost: phase });
      assert.deepEqual(visibleProjectors(), initial, "Lamp switching must not change the shader's light count");
      assert.ok(initial.every((light) => light.intensity === phase * 30));
      assert.equal(groups.white.visible, phase > 0);
      // Wet-road reflections hide the scattering optics, but still need real
      // source illumination and the same lit shader as the beauty pass.
      root.visible = false;
      assert.deepEqual(visibleProjectors(), initial);
      root.visible = true;
    }
  } finally { effects.dispose(); }
});

test("signals release every owned shared geometry, material and procedural texture exactly once", () => {
  const { scene, effects, root } = fixture();
  const resources = new Set<THREE.Material | THREE.BufferGeometry | THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
    if (object instanceof THREE.Mesh) resources.add(object.geometry);
    const material = object.material as THREE.Material;
    resources.add(material);
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) resources.add(value);
    }
  });
  const disposals = new Map<object, number>();
  const shadowDisposals = new Map<THREE.SpotLight, number>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.SpotLight)) return;
    const disposeShadow = object.shadow.dispose.bind(object.shadow);
    object.shadow.dispose = () => {
      shadowDisposals.set(object, (shadowDisposals.get(object) ?? 0) + 1);
      disposeShadow();
    };
  });
  resources.forEach((resource) => resource.addEventListener("dispose", () => disposals.set(resource, (disposals.get(resource) ?? 0) + 1)));
  effects.dispose();
  effects.dispose();
  effects.update({ white: 1, green: 1, boost: 1 });
  assert.equal(scene.getObjectByName("Tumbler signal effects"), undefined);
  assert.equal(scene.getObjectByName("Tumbler headlight projectors"), undefined);
  assert.equal(root.children.length, 0);
  for (const resource of resources) assert.equal(disposals.get(resource), 1, "Each resource must be released once on context loss or unmount");
  assert.equal(shadowDisposals.size, 2);
  for (const count of shadowDisposals.values()) assert.equal(count, 1);
});
