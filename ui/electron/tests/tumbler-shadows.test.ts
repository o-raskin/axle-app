import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { installTumblerSoftShadows } from "../src/renderer/src/vehicle/tumblerShadows";

type Shader = Parameters<THREE.Material["onBeforeCompile"]>[0];
const renderer = {} as THREE.WebGLRenderer;

function shader(): Shader {
  return { vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} } as Shader;
}

function fixture() {
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight();
  key.castShadow = true;
  key.shadow.camera.left = key.shadow.camera.bottom = -4.5;
  key.shadow.camera.right = key.shadow.camera.top = 4.5;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);
  const material = new THREE.MeshPhysicalMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return { scene, key, material, mesh };
}

test("PCSS patches the pinned native-depth directional lighting locally and retains portable fallback filters", () => {
  const { scene, key, material } = fixture();
  const originalShadowChunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const originalLightChunk = THREE.ShaderChunk.lights_fragment_begin;
  const soft = installTumblerSoftShadows(scene, key);
  const compiled = shader();
  material.onBeforeCompile(compiled, renderer);
  assert.match(compiled.fragmentShader, /axleDirectionalSoftShadow\( directionalShadowMap\[ i \]/,
    "The actual pinned directional-light query must call the contact-hardening filter");
  assert.match(compiled.fragmentShader, /texture2D\(map, uv\)\.r/,
    "Three 0.186 shadow depth is native red-channel data, not old RGBA packing");
  assert.match(compiled.fragmentShader, /SHADOWMAP_TYPE_BASIC\) && NUM_DIR_LIGHT_SHADOWS == 1/);
  assert.match(compiled.fragmentShader, /sampler2DShadow map/,
    "Comparison-sampler renderers must retain a type-correct PCF fallback");
  assert.match(compiled.fragmentShader, /getShadow\( spotShadowMap\[/,
    "Spot and point shadow cameras must retain their own projection behavior");
  assert.equal(THREE.ShaderChunk.shadowmap_pars_fragment, originalShadowChunk);
  assert.equal(THREE.ShaderChunk.lights_fragment_begin, originalLightChunk);
  soft.dispose();
});

test("receiver slope, depth direction, map boundaries and empty blocker searches are guarded in the real shader", () => {
  const { scene, key, material } = fixture();
  const soft = installTumblerSoftShadows(scene, key);
  const compiled = shader();
  material.onBeforeCompile(compiled, renderer);
  const source = compiled.fragmentShader;
  assert.ok(source.indexOf("dFdx(projected.xy)") < source.indexOf("if (coord.w <= 0.0"),
    "Derivatives must execute before divergent per-pixel frustum branches");
  assert.match(source, /USE_REVERSED_DEPTH_BUFFER/);
  assert.match(source, /if \(!axleShadowInside\(uv\)\) return 1\.0/);
  assert.match(source, /projected\.z < 0\.0 \|\| projected\.z > 1\.0/);
  assert.match(source, /if \(blockers == 0\.0\) return 1\.0/);
  assert.equal((source.match(/projected\.z \+= bias/g) ?? []).length, 1,
    "The existing normal bias must not be applied a second time");
  assert.match(source, /blockerGap \/ blockers \* axleShadowExtent\.z/,
    "Directional penumbra must use linear orthographic blocker distance");
  assert.match(source, /texel \* 0\.6, texel \* 18\.0/);
  assert.equal((source.match(/sampleIndex < 16/g) ?? []).length, 1);
  assert.equal((source.match(/sampleIndex < 24/g) ?? []).length, 1,
    "Filtering has a fixed 16-blocker and 24-comparison maximum budget");
  assert.doesNotMatch(source.slice(source.indexOf("vec2 axleShadowDisk"), source.indexOf("bool axleShadowInside")), /time|gl_FragCoord|noise/,
    "The shadow sampling pattern must remain still while the car is idle");
  soft.dispose();
});

test("projection uniforms follow the key shadow camera without allocating maps or scheduling shadow renders", () => {
  const { scene, key, material } = fixture();
  key.shadow.autoUpdate = false;
  key.shadow.needsUpdate = false;
  const soft = installTumblerSoftShadows(scene, key, { angularRadius: 0.06 });
  const compiled = shader();
  material.onBeforeCompile(compiled, renderer);
  const extent = compiled.uniforms.axleShadowExtent.value as THREE.Vector3;
  const clip = compiled.uniforms.axleShadowClip.value as THREE.Vector2;
  assert.deepEqual(extent.toArray(), [9, 9, 19.5]);
  assert.deepEqual(clip.toArray(), [0.5, 20]);
  assert.equal(compiled.uniforms.axleShadowAngularRadius.value, 0.06);
  key.shadow.camera.right = 6.5;
  key.shadow.camera.top = 5.5;
  key.shadow.camera.far = 30;
  soft.update();
  assert.deepEqual(extent.toArray(), [11, 10, 29.5]);
  assert.deepEqual(clip.toArray(), [0.5, 30]);
  key.shadow.camera.zoom = 2;
  soft.update();
  assert.deepEqual(extent.toArray(), [5.5, 5, 29.5], "Shadow zoom changes the world-space texel footprint");
  assert.equal(key.shadow.map, null);
  assert.equal(key.shadow.autoUpdate, false);
  assert.equal(key.shadow.needsUpdate, false);
  assert.deepEqual(key.shadow.mapSize.toArray(), [2048, 2048]);
  soft.dispose();
});

test("shared and asynchronously arriving materials are installed once and existing street hooks survive", () => {
  const { scene, key, material, mesh } = fixture();
  let hookCalls = 0;
  const previousCompile: THREE.Material["onBeforeCompile"] = function(this: THREE.Material, compiled) {
    assert.equal(this, material);
    hookCalls += 1;
    compiled.uniforms.streetSideOpacity = { value: new THREE.Vector2(0, 1) };
    compiled.fragmentShader = `// Existing camera-side fade\n${compiled.fragmentShader}`;
  };
  const previousKey = () => "street-camera-clearance";
  material.onBeforeCompile = previousCompile;
  material.customProgramCacheKey = previousKey;
  scene.add(new THREE.Mesh(mesh.geometry, [material, material]));
  const basic = new THREE.MeshBasicMaterial();
  const basicHook = basic.onBeforeCompile;
  scene.add(new THREE.Mesh(mesh.geometry, basic));
  const soft = installTumblerSoftShadows(scene, key);
  assert.equal(soft.materialCount, 1);
  const version = material.version;
  soft.refresh();
  assert.equal(material.version, version, "Refreshing must not recompile already installed materials");
  const compiled = shader();
  material.onBeforeCompile(compiled, renderer);
  assert.equal(hookCalls, 1);
  assert.ok(compiled.uniforms.streetSideOpacity);
  assert.ok(compiled.fragmentShader.startsWith("// Existing camera-side fade"));
  assert.equal(material.customProgramCacheKey(), "street-camera-clearance|axle-directional-pcss-v1");
  assert.equal(basic.onBeforeCompile, basicHook);
  const late = new THREE.MeshStandardMaterial();
  const lateHook = late.onBeforeCompile;
  scene.add(new THREE.Mesh(mesh.geometry, late));
  soft.refresh();
  assert.equal(soft.materialCount, 2);
  assert.notEqual(late.onBeforeCompile, lateHook);
  soft.dispose();
  soft.dispose();
  assert.equal(material.onBeforeCompile, previousCompile);
  assert.equal(material.customProgramCacheKey, previousKey);
  assert.equal(late.onBeforeCompile, lateHook);
  assert.equal(soft.materialCount, 0);
  soft.refresh();
  assert.equal(soft.materialCount, 0, "Unmount must prevent late async additions from reinstalling hooks");
});

test("cleanup preserves newer material owners and does not dispose scene resources", () => {
  const { scene, key, material, mesh } = fixture();
  let disposed = 0;
  for (const resource of [material, mesh.geometry, key.shadow]) {
    const previousDispose = resource.dispose.bind(resource);
    resource.dispose = () => { disposed += 1; previousDispose(); };
  }
  const soft = installTumblerSoftShadows(scene, key);
  const newerHook: THREE.Material["onBeforeCompile"] = () => {};
  const newerKey = () => "new-owner";
  material.onBeforeCompile = newerHook;
  material.customProgramCacheKey = newerKey;
  soft.dispose();
  assert.equal(disposed, 0);
  assert.equal(material.onBeforeCompile, newerHook);
  assert.equal(material.customProgramCacheKey, newerKey);
});

test("invalid source angles are rejected before changing material hooks", () => {
  const { scene, key, material } = fixture();
  const before = material.onBeforeCompile;
  for (const angularRadius of [NaN, Infinity, -0.01, 0.21]) {
    assert.throws(() => installTumblerSoftShadows(scene, key, { angularRadius }), RangeError);
    assert.equal(material.onBeforeCompile, before);
  }
});
