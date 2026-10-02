import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/decoder";

import { createTumblerStreet } from "../src/renderer/src/vehicle/tumblerStreet.ts";
import { bindTumblerModel } from "../src/renderer/src/vehicle/tumblerModel.ts";
import { CAMERA_SHOTS, CAMERA_FRAMING_MIN_ASPECT } from "../src/renderer/src/vehicle/tumblerCamera.ts";

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-5, `Expected ${expected}, received ${actual}`);
}

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const item = scene.getObjectByName(name);
  assert.ok(item instanceof THREE.InstancedMesh, `${name} should be an instanced mesh`);
  return item;
}

function instancePosition(item: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  item.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

test("the optional street preserves the scene and toggling preserves travelled distance", () => {
  const scene = new THREE.Scene();
  const car = new THREE.Group();
  const light = new THREE.DirectionalLight();
  const background = new THREE.Color("#112233");
  const fog = new THREE.Fog(background, 10, 40);
  scene.background = background;
  scene.fog = fog;
  scene.add(car, light);
  const street = createTumblerStreet(scene);
  const root = scene.getObjectByName("Tumbler street scene");
  assert.ok(root);
  assert.equal(root.visible, false, "The environment must start disabled");
  street.update(5);
  const markings = mesh(scene, "Street passing road markings");
  const position = instancePosition(markings, 1);
  street.setEnabled(true);
  assert.equal(root.visible, true);
  assert.deepEqual(instancePosition(markings, 1), position, "Enabling must not restart the street");
  street.setEnabled(false);
  street.update(8);
  street.setEnabled(true);
  near(instancePosition(markings, 1).z, position.z - 3);
  assert.equal(scene.background, background);
  assert.equal(scene.fog, fog);
  assert.equal(car.parent, scene);
  assert.equal(light.parent, scene);
  assert.deepEqual(car.position.toArray(), [0, 0, 0], "The model stays stationary while the street passes it");
  street.dispose();
  assert.deepEqual(scene.children, [car, light]);
});

test("street movement uses absolute signed wheel travel with deterministic wrapping and no idle drift", () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  try {
    const markings = mesh(scene, "Street passing road markings");
    const warehouses = mesh(scene, "Street looping warehouses");
    const start = instancePosition(markings, 3);
    const buildingStart = instancePosition(warehouses, 2);
    street.update(1.5);
    near(instancePosition(markings, 3).z, start.z - 1.5);
    near(instancePosition(warehouses, 2).z, buildingStart.z - 1.5);
    street.update(-1.5);
    near(instancePosition(markings, 3).z, start.z + 1.5);
    near(instancePosition(warehouses, 2).z, buildingStart.z + 1.5);
    const reversed = instancePosition(markings, 3);
    const uploadVersion = markings.instanceMatrix.version;
    for (let frame = 0; frame < 1000; frame += 1) street.update(-1.5);
    assert.deepEqual(instancePosition(markings, 3), reversed);
    assert.equal(markings.instanceMatrix.version, uploadVersion, "A stalled wheel must not upload a moving street");
    for (const distance of [-1.5 + 48, -1.5 - 48, -1.5 + 48 * 1_000_000]) {
      street.update(distance);
      near(instancePosition(markings, 3).z, reversed.z);
    }
    const beforeInvalid = instancePosition(markings, 3);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) street.update(value);
    assert.deepEqual(instancePosition(markings, 3), beforeInvalid);
    street.update(0);
    assert.deepEqual(instancePosition(markings, 3), start, "Absolute updates cannot accumulate rounding drift");
    const doors = mesh(scene, "Street loading doors");
    for (const distance of [-5, 5, 47, -47, 96]) {
      street.update(distance);
      for (let block = 0; block < warehouses.count; block += 1) {
        near(instancePosition(doors, block).z - instancePosition(warehouses, block).z, 1.85);
      }
    }
  } finally { street.dispose(); }
});

test("the detailed street is bounded, lightweight and leaves the car's lamp sightlines clear", () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  try {
    let triangles = 0;
    let drawCalls = 0;
    let lights = 0;
    let shadowBatches = 0;
    const textureMaps = new Set<THREE.Texture>();
    scene.traverse((object) => {
      if (object instanceof THREE.Light) lights += 1;
      if (!(object instanceof THREE.InstancedMesh)) return;
      drawCalls += 1;
      const count = object.geometry.index?.count ?? object.geometry.getAttribute("position").count;
      triangles += count / 3 * object.count;
      const material = object.material;
      assert.ok(!Array.isArray(material), "A street batch should use one material");
      if ((material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshStandardMaterial) && material.map) {
        assert.ok(material.map instanceof THREE.DataTexture || material.map instanceof THREE.CanvasTexture,
          "Photo surfaces and locally rasterized shop typography use owned texture references");
        textureMaps.add(material.map);
      }
      if (object.castShadow) {
        shadowBatches += 1;
        assert.ok(object.customDepthMaterial instanceof THREE.MeshDepthMaterial,
          "Structural casters must respect camera clearance in the existing key map");
        assert.equal(object.customDepthMaterial.userData.streetSideOpacity, street.clearance);
      }
      for (let index = 0; index < object.count; index += 1) {
        const position = instancePosition(object, index);
        assert.ok(position.toArray().every(Number.isFinite));
        assert.ok(Math.abs(position.z) <= 28, "Repeated instances and attached details remain in the fog-bounded segment");
        if (/warehouses|posts|columns|braces|rails/i.test(object.name)) {
          assert.ok(Math.abs(position.x) > 6, "Tall architecture must stay outside camera views of the vehicle and its lamps");
        }
      }
    });
    assert.equal(lights, 0, "Lantern glows must not add dynamic light costs");
    assert.ok(shadowBatches > 0 && shadowBatches <= 12, "Only bounded structural silhouettes may share the one cached key map");
    assert.equal(mesh(scene, "Street warehouse windows").castShadow, false);
    assert.equal(mesh(scene, "Street steel rivets").castShadow, false);
    assert.ok(triangles < 35000, `Street triangle budget exceeded: ${triangles}`);
    assert.ok(drawCalls <= 60, `Street draw-call budget exceeded: ${drawCalls}`);
    const texturedPixels = [...textureMaps].reduce((sum, map) => sum + map.image.width * map.image.height, 0);
    assert.ok(texturedPixels <= 3.25 * 1024 * 1024, "High-resolution surfaces and one small sign atlas remain shared within a bounded memory budget");
    const brick = mesh(scene, "Street looping warehouses").material;
    assert.ok(brick instanceof THREE.MeshStandardMaterial);
    assert.ok(brick.map instanceof THREE.DataTexture);
    assert.ok(brick.normalMap instanceof THREE.DataTexture && brick.roughnessMap instanceof THREE.DataTexture);
    assert.equal(brick.map.image.width, 1024);
    assert.equal(brick.normalMap.image.width, 1024);
    assert.equal(brick.roughnessMap.image.width, 1024);
    for (const name of ["Street warehouse window frames", "Street fire escape platforms", "Street ventilation slats",
      "Street cast iron bollards and hydrants", "Street manhole covers", "Street curb drainage slots"]) {
      assert.ok(mesh(scene, name).count > 0, `${name} must be actual geometry in the city`);
    }
    assert.ok(instancePosition(mesh(scene, "Street passing road markings"), 0).y > -0.019,
      "Road markings must sit above the cinematic ground and contact-shadow surface");
  } finally { street.dispose(); }
});

test("camera-cleared structures share their coverage with shadow depth instead of casting invisible-wall shadows", () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  try {
    const warehouse = mesh(scene, "Street looping warehouses");
    assert.equal(warehouse.castShadow, true);
    assert.ok(warehouse.customDepthMaterial instanceof THREE.MeshDepthMaterial);
    const shaders = [
      { ...THREE.ShaderLib.standard, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) },
      { ...THREE.ShaderLib.depth, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.depth.uniforms) }
    ];
    const renderer = {} as THREE.WebGLRenderer;
    (warehouse.material as THREE.Material).onBeforeCompile(shaders[0], renderer);
    warehouse.customDepthMaterial.onBeforeCompile(shaders[1], renderer);
    for (const shader of shaders) {
      assert.equal(shader.uniforms.streetSideOpacity.value, street.clearance);
      assert.match(shader.vertexShader, /vStreetSide = sign\(instanceMatrix\[3\]\.x\)/);
      assert.match(shader.fragmentShader, /if \(streetCoverage <= 0\.0 \|\| streetDither >= streetCoverage\) discard/);
    }
    street.update(0, new THREE.Vector3(7, 2, 0));
    for (const shader of shaders) assert.deepEqual(shader.uniforms.streetSideOpacity.value.toArray(), [1, 0]);
    street.update(0, new THREE.Vector3(-7, 2, 0));
    for (const shader of shaders) assert.deepEqual(shader.uniforms.streetSideOpacity.value.toArray(), [0, 1]);
  } finally { street.dispose(); }
});

test("commercial architecture has varied scale, stable room interiors and physical surface density", async () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  try {
    const matrix = new THREE.Matrix4();
    const heights = new Set<number>();
    const depths = new Set<number>();
    const warehouses = mesh(scene, "Street looping warehouses");
    for (let index = 0; index < warehouses.count; index += 1) {
      warehouses.getMatrixAt(index, matrix);
      const dimensions = new THREE.Vector3().setFromMatrixScale(matrix);
      heights.add(dimensions.y);
      depths.add(dimensions.x);
      near(Math.abs(instancePosition(warehouses, index).x) - dimensions.x / 2, 7.4);
    }
    assert.ok(heights.size >= 5 && depths.size >= 4, "Buildings have different storey counts and depth instead of identical boxes");
    assert.ok(mesh(scene, "Street upper floor setbacks").count >= 6);
    const skyline = mesh(scene, "Street distant stepped skyline");
    assert.ok(skyline.count >= 12);
    for (let index = 0; index < skyline.count; index += 1) {
      assert.ok(Math.abs(instancePosition(skyline, index).x) > 15, "The skyline remains behind the street-facing buildings");
    }
    const glazing = mesh(scene, "Street commercial glazing");
    assert.ok(glazing.material instanceof THREE.MeshPhysicalMaterial);
    assert.ok(glazing.material.roughness < 0.2 && glazing.material.clearcoat === 1,
      "Shopfront glass has distinct reflective surface response from rough masonry");
    assert.equal(glazing.count, 24);
    for (const name of ["Street storefront mullions and transoms", "Street entrance porticoes",
      "Street entrance threshold steps", "Street projecting canvas awnings", "Street original storefront signage"]) {
      assert.ok(mesh(scene, name).count > 0, `${name} adds actual facade depth`);
    }

    const rooms = [mesh(scene, "Street warehouse windows"), mesh(scene, "Street shop interior silhouettes"),
      mesh(scene, "Street distant office interiors")];
    const roomSeeds = rooms.map((room) => {
      const attribute = room.geometry.getAttribute("streetRoomSeed");
      assert.ok(attribute instanceof THREE.InstancedBufferAttribute);
      assert.equal(attribute.count, room.count, "Every interior owns exactly one seed");
      const values = Array.from(attribute.array);
      assert.ok(new Set(values).size > 8, "Rooms vary independently rather than repeating the same blind on an entire floor");
      assert.ok(values.every((value) => value >= 0 && value < 1));
      return values;
    });
    street.update(23.75);
    rooms.forEach((room, index) => assert.deepEqual(Array.from(room.geometry.getAttribute("streetRoomSeed").array), roomSeeds[index],
      "Scrolling cannot change room lighting, curtains or furnishing"));

    const masonry = warehouses.material as THREE.MeshStandardMaterial;
    near(masonry.userData.streetSurfaceSize, 1.9);
    assert.deepEqual(masonry.map!.repeat.toArray(), [1, 1]);
    assert.deepEqual(masonry.normalMap!.repeat.toArray(), [1, 1]);
    assert.deepEqual(masonry.roughnessMap!.repeat.toArray(), [1, 1]);
    assert.equal(await street.ready, false, "A renderer without an image decoder keeps the complete procedural fallback");
  } finally { street.dispose(); }
});

test("storefront signs share a readable original atlas with stable label selection", () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  try {
    const signs = mesh(scene, "Street original storefront signage");
    assert.equal(signs.count, 12, "One instanced sign replaces the repeated abstract glyph bars on each shop");
    const material = signs.material as THREE.MeshBasicMaterial;
    assert.ok(material.map instanceof THREE.DataTexture, "The non-DOM renderer uses the original bitmap alphabet fallback");
    assert.deepEqual(material.map.userData.labels,
      ["CORNER MARKET", "CENTRAL GARAGE", "NIGHT COFFEE", "STORAGE", "NORTHSIDE AUTO", "RIVER WAREHOUSE"]);
    assert.deepEqual([material.map.image.width, material.map.image.height], [512, 512]);
    const pixels = material.map.image.data as Uint8Array;
    const distinctRows = new Set<string>();
    for (let row = 0; row < 6; row += 1) {
      const bits: number[] = [];
      for (let index = row * 512 * 64 * 4 + 3; index < (row + 1) * 512 * 64 * 4; index += 4) bits.push(pixels[index]);
      assert.ok(bits.some((alpha) => alpha > 0) && bits.some((alpha) => alpha === 0),
        "Each generic label contains actual painted letterforms and transparent spacing");
      distinctRows.add(bits.join(""));
    }
    assert.equal(distinctRows.size, 6, "The atlas has six distinct words instead of one repeated stripe pattern");
    const rows = signs.geometry.getAttribute("streetSignRow");
    assert.ok(rows instanceof THREE.InstancedBufferAttribute);
    const selection = Array.from(rows.array);
    assert.deepEqual([...new Set(selection)].sort(), [0, 1, 2, 3, 4, 5]);
    street.update(47.9);
    street.update(-48.2);
    assert.deepEqual(Array.from(rows.array), selection, "Shop identities remain attached across forward and reverse wrapping");
    assert.equal(signs.userData.streetSideOpacity, mesh(scene, "Street looping warehouses").userData.streetSideOpacity,
      "Lettering disappears with the camera-side architecture");
  } finally { street.dispose(); }
});

test("camera-side scenery fades while idle and every actual model camera remains unobstructed across street phases", async () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  let model: ReturnType<typeof bindTumblerModel> | undefined;
  try {
    const warehouses = mesh(scene, "Street looping warehouses");
    const material = warehouses.material;
    assert.ok(!Array.isArray(material));
    const shader = {
      vertexShader: "#include <begin_vertex>", fragmentShader: "#include <clipping_planes_fragment>", uniforms: {}
    } as Parameters<THREE.Material["onBeforeCompile"]>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const coverage = shader.uniforms.streetSideOpacity.value as THREE.Vector2;
    assert.ok(shader.vertexShader.includes("sign(instanceMatrix[3].x)"), "Actual shader coverage selects the instance's street side");
    assert.ok(shader.fragmentShader.includes("discard"), "Zero coverage must remove both color and depth, beyond diagnostic metadata");
    const version = warehouses.instanceMatrix.version;
    street.update(0, new THREE.Vector3(0, 4, 8));
    assert.deepEqual(coverage.toArray(), [1, 1]);
    street.update(0, new THREE.Vector3(5.4, 4, 8));
    assert.equal(coverage.x, 1, "The far side remains visible");
    assert.ok(coverage.y > 0 && coverage.y < 1, "Camera approach fades smoothly before crossing the architecture");
    street.update(0, new THREE.Vector3(8, 4, 8));
    assert.deepEqual(coverage.toArray(), [1, 0]);
    street.update(0, new THREE.Vector3(-8, 4, 8));
    assert.deepEqual(coverage.toArray(), [0, 1]);
    assert.equal(warehouses.instanceMatrix.version, version, "Idle camera clearance does not move the street or reupload its geometry");
    for (const name of ["Street warehouse windows", "Street loading doors", "Street lamp posts", "Street lamp arms",
      "Street lantern glow", "Street elevated columns", "Street elevated braces", "Street elevated rails"]) {
      const item = mesh(scene, name);
      assert.equal(item.userData.streetSideOpacity, coverage, `${name} shares the parent architecture's shader coverage`);
    }

    const bytes = new Uint8Array(await readFile(path.join(process.cwd(), "src/renderer/src/vehicle/assets/tumbler-42239.glb")));
    const asset = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer, "");
    model = bindTumblerModel(asset.scene);
    street.setEnabled(true);
    const scenery = Array.from(scene.getObjectByName("Tumbler street scene")!.children)
      .filter((item): item is THREE.InstancedMesh => item instanceof THREE.InstancedMesh && Boolean(item.userData.streetSideOpacity));
    const raycaster = new THREE.Raycaster();
    const instance = new THREE.Matrix4();
    const direction = new THREE.Vector3();
    for (const [name, shot] of Object.entries(CAMERA_SHOTS)) {
      const target = model.cameraTargets[shot.focus].clone();
      target.y += shot.targetYOffset ?? 0;
      for (const aspect of [1, 1.3, 2.4]) {
        const orbit = new THREE.Spherical().setFromVector3(new THREE.Vector3().fromArray(shot.offset));
        orbit.radius = THREE.MathUtils.clamp(orbit.radius * Math.max(1, CAMERA_FRAMING_MIN_ASPECT / aspect), 4.5, 22);
        orbit.phi = THREE.MathUtils.clamp(orbit.phi, 0.18, Math.PI / 2 - 0.035);
        const camera = new THREE.Vector3().setFromSpherical(orbit).add(target);
        for (let travel = 0; travel < 48; travel += 0.5) {
          street.update(travel, camera);
          scene.updateMatrixWorld(true);
          raycaster.set(camera, direction.copy(target).sub(camera).normalize());
          raycaster.far = camera.distanceTo(target) - 0.001;
          const obstruction = raycaster.intersectObjects(scenery, false).find((hit) => {
            const item = hit.object as THREE.InstancedMesh;
            assert.notEqual(hit.instanceId, undefined);
            item.getMatrixAt(hit.instanceId!, instance);
            const opacity = item.userData.streetSideOpacity as THREE.Vector2;
            return (instance.elements[12] < 0 ? opacity.x : opacity.y) > 0;
          });
          assert.equal(obstruction, undefined,
            `${name} at aspect ${aspect}, travel ${travel}: ${obstruction?.object.name} obscures the model target`);
        }
      }
    }
  } finally {
    model?.dispose();
    street.dispose();
  }
});

test("street disposal releases each shared resource exactly once and cannot revive removed meshes", () => {
  const scene = new THREE.Scene();
  const street = createTumblerStreet(scene);
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.InstancedMesh>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.InstancedMesh)) return;
    resources.add(object);
    resources.add(object.geometry);
    if (object.customDepthMaterial) resources.add(object.customDepthMaterial);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      resources.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
    }
  });
  const disposalCounts = new Map<object, number>();
  for (const resource of resources) resource.addEventListener("dispose", () => {
    disposalCounts.set(resource, (disposalCounts.get(resource) ?? 0) + 1);
  });
  street.dispose();
  street.dispose();
  street.setEnabled(true);
  street.update(30);
  assert.equal(scene.children.length, 0);
  assert.ok(resources.size > 0);
  for (const resource of resources) assert.equal(disposalCounts.get(resource), 1, resource.constructor.name);
});
