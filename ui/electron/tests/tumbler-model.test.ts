import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { bindTumblerModel, steeringYawForCommand } from "../src/renderer/src/vehicle/tumblerModel.ts";
import { CAMERA_SHOTS, CAMERA_FRAMING_MIN_ASPECT } from "../src/renderer/src/vehicle/tumblerCamera.ts";
import { extractTumblerSourceBundle, packTumblerSourceBundle, readTumblerSourceBundle } from "../scripts/tumbler-source-bundle.mjs";

const electronRoot = process.cwd();
const modelRoot = path.join(electronRoot, "models/tumbler");
const assetPath = path.join(electronRoot, "src/renderer/src/vehicle/assets/tumbler-42239.glb");
const millimetersPerUnit = 0.4 / 0.0075;
const spinNames = ["wheelFrontLeft", "wheelFrontRight", "wheelRearLeft", "wheelRearRight"];
const steeringNames = ["frontSteeringLeft", "frontSteeringRight"];
const lampNames = ["frontLightLeft", "frontLightRight", "jetLight"];
const reverseLampNames = ["reverseLightFrontLeft", "reverseLightFrontRight", "reverseLightRear"];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface RigManifest {
  source: string;
  sourceSha256: string;
  sourceBundle: { path: string; sha256: string; fileCount: number; bytes: number };
  assetSha256: string;
  assetBytes: number;
  additions: { source: string; sha256: string };
  nodes: { reverseLights: string[] };
  geometry: { triangles: number; vertices: number; drawCalls: number };
  dependencies: Record<string, { sha256: string; bytes: number }>;
}

interface SourceProvenance {
  sourcePage: string;
  assemblyLicense: string;
  sourceBundle: { path: string; sha256: string; fileCount: number; bytes: number };
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

interface GLBJson {
  buffers?: Array<{ uri?: string }>;
  images?: Array<{ uri?: string }>;
  extensionsUsed?: string[];
}

let scene: THREE.Group;
let assetBytes: Buffer;
let manifest: RigManifest;
let glbJson: GLBJson;
let sourceBundle: Awaited<ReturnType<typeof readTumblerSourceBundle>>;

function node(name: string): THREE.Object3D {
  const result = scene.getObjectByName(name);
  assert.ok(result, `Missing authored rig node: ${name}`);
  return result;
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) result.push(object);
  });
  return result;
}

function localVertices(root: THREE.Object3D, rubberOnly = false): THREE.Vector3[] {
  scene.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const result: THREE.Vector3[] = [];
  for (const mesh of meshes(root)) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (rubberOnly && !materials.some((material) => /^LDraw_256:/.test(material.name))) continue;
    const transform = inverse.clone().multiply(mesh.matrixWorld);
    const positions = mesh.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i += 1) {
      result.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(transform));
    }
  }
  assert.ok(result.length, `No ${rubberOnly ? "rubber " : ""}vertices in ${root.name}`);
  return result;
}

function near(actual: number, expected: number, tolerance: number, explanation: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${explanation}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

before(async () => {
  assetBytes = await readFile(assetPath);
  assert.equal(assetBytes.readUInt32LE(0), 0x46546c67, "The checked-in asset must be a binary glTF");
  assert.equal(assetBytes.readUInt32LE(4), 2);
  assert.equal(assetBytes.readUInt32LE(8), assetBytes.byteLength);
  assert.equal(assetBytes.readUInt32LE(16), 0x4e4f534a, "The first GLB chunk must contain JSON");
  const jsonLength = assetBytes.readUInt32LE(12);
  glbJson = JSON.parse(assetBytes.subarray(20, 20 + jsonLength).toString("utf8"));
  assert.ok(glbJson.buffers?.length, "The model must contain embedded geometry");
  assert.ok(glbJson.buffers.every((buffer) => buffer.uri === undefined), "Geometry cannot need a separate file or network request");
  assert.ok((glbJson.images ?? []).every((image) => image.uri === undefined), "The model cannot fetch external textures");
  manifest = JSON.parse(await readFile(path.join(modelRoot, "generated/rig.json"), "utf8"));
  const provenance: SourceProvenance = JSON.parse(await readFile(path.join(modelRoot, "source/provenance.json"), "utf8"));
  sourceBundle = await readTumblerSourceBundle(path.join(modelRoot, "source", provenance.sourceBundle.path), provenance.sourceBundle.sha256);
  const bytes = new Uint8Array(assetBytes);
  scene = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer, "")).scene;
  scene.updateMatrixWorld(true);
});

after(() => {
  if (!scene) return;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const mesh of meshes(scene)) {
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
});

test("the packaged Tumbler resolves entirely offline and matches its retained sources", async () => {
  assert.ok(!(glbJson.extensionsUsed ?? []).some((extension) => /draco|basisu/i.test(extension)),
    "The model cannot require an additional external texture or geometry decoder");
  assert.equal(assetBytes.byteLength, manifest.assetBytes);
  assert.equal(sha256(assetBytes), manifest.assetSha256);
  const assembly = sourceBundle.files.get(path.relative(path.join(modelRoot, "source"), path.join(electronRoot, manifest.source)).replaceAll("\\", "/"));
  assert.ok(assembly, "Assembly source must be retained in the CAD archive");
  assert.equal(sha256(assembly), manifest.sourceSha256);
  assert.equal(sourceBundle.sha256, manifest.sourceBundle.sha256);
  assert.equal(sourceBundle.bytes, manifest.sourceBundle.bytes);
  assert.equal(sourceBundle.files.size, manifest.sourceBundle.fileCount);
  assert.equal(sha256(await readFile(path.join(electronRoot, manifest.additions.source))), manifest.additions.sha256);
  const provenance: SourceProvenance = JSON.parse(await readFile(path.join(modelRoot, "source/provenance.json"), "utf8"));
  assert.equal(provenance.sourcePage, "https://fogeyman.tistory.com/1770");
  assert.equal(provenance.assemblyLicense, "CC-BY-NC-4.0");
  const original = provenance.files.find((file) => file.path === "42239.io");
  assert.equal(original?.sha256, "fbe46eea36d95e77779475fd5f463b8b9fa43c6f3f98806643ba02fca696d68f");
  await Promise.all(provenance.files.map(async (file) => {
    const bytes = sourceBundle.files.get(file.path);
    assert.ok(bytes, file.path);
    assert.equal(bytes.byteLength, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
  }));
  await Promise.all(Object.entries(manifest.dependencies).map(async ([relative, dependency]) => {
    const bytes = sourceBundle.files.get(relative);
    assert.ok(bytes, relative);
    assert.equal(bytes.byteLength, dependency.bytes, relative);
    assert.equal(sha256(bytes), dependency.sha256, relative);
  }));
});

test("extracting and repacking retains the editable Studio project, every CAD byte and license header", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "axle-cad-roundtrip-"));
  try {
    const directory = path.join(temporary, "editable");
    await extractTumblerSourceBundle(sourceBundle, directory);
    for (const [name, bytes] of sourceBundle.files) {
      assert.deepEqual(await readFile(path.join(directory, name)), bytes, name);
    }
    const archive = path.join(temporary, "roundtrip.zip");
    const repacked = await packTumblerSourceBundle(directory, archive);
    assert.equal(repacked.sha256, sourceBundle.sha256, "Repacking an unchanged source tree must be deterministic");
    assert.ok(repacked.files.has("ldraw/CAlicense.txt"));
    assert.ok(repacked.files.has("ldraw/CAlicense4.txt"));
    assert.ok(repacked.files.has("42239.io"), "Editable Studio file must not be replaced by flattened geometry");
    const notice = repacked.files.get("ARCHIVE-NOTICE.md")?.toString("utf8") ?? "";
    assert.ok(notice.includes("Fogeyman") && notice.includes("creativecommons.org/licenses/by-nc/4.0/legalcode.en"),
      "Standalone CAD archive must carry creator attribution and the assembly license link");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("source extraction refuses existing edits and changed archive bytes fail before use", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "axle-cad-safety-"));
  try {
    const sentinel = path.join(temporary, "42239.mpd");
    await writeFile(sentinel, "user edits");
    await assert.rejects(extractTumblerSourceBundle(sourceBundle, temporary), { code: "EEXIST" });
    assert.equal(await readFile(sentinel, "utf8"), "user edits");
    const bytes = await readFile(path.join(electronRoot, manifest.sourceBundle.path));
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    const changed = path.join(temporary, "changed.zip");
    await writeFile(changed, bytes);
    await assert.rejects(readTumblerSourceBundle(changed, sourceBundle.sha256), /checksum mismatch/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("the LEGO assembly has finite indexed surfaces and bounded rendering cost", () => {
  let triangles = 0;
  let vertices = 0;
  const surfaces = meshes(scene);
  assert.ok(surfaces.length >= 12 && surfaces.length <= 40, `Unexpected draw-call count: ${surfaces.length}`);
  for (const mesh of surfaces) {
    const geometry = mesh.geometry;
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    assert.ok(positions && normals, `${mesh.name} must retain positions and surface normals`);
    assert.equal(positions.itemSize, 3);
    assert.equal(normals.count, positions.count);
    for (const attribute of [positions, normals]) {
      for (const value of attribute.array) assert.ok(Number.isFinite(value), `Non-finite geometry in ${mesh.name}`);
    }
    assert.ok(geometry.index, `${mesh.name} must reuse shared vertices`);
    assert.equal(geometry.index.count % 3, 0);
    for (const index of geometry.index.array) assert.ok(index >= 0 && index < positions.count, `Invalid index in ${mesh.name}`);
    triangles += geometry.index.count / 3;
    vertices += positions.count;
  }
  assert.equal(triangles, manifest.geometry.triangles);
  assert.equal(vertices, manifest.geometry.vertices);
  assert.equal(surfaces.length, manifest.geometry.drawCalls);
  // These ceilings constrain regressions of the full Technic assembly. They do
  // not substitute for measuring frame rate on the application's target hardware.
  // Retaining the Technic holes and hard normals at the documented0.12mm
  // tolerance settles near903k triangles. Bound this verified asset closely;
  // static shadow caching avoids a second full pass during orbit/rolling.
  assert.ok(triangles >= 100_000 && triangles <= 1_000_000, `Unexpected triangle count: ${triangles}`);
  assert.ok(vertices <= 1_100_000, `Unexpected vertex count: ${vertices}`);
  assert.ok(assetBytes.byteLength <= 10 * 1024 * 1024, "The offline model must fit its bounded asset budget");
});

test("two steered front wheels and two rear wheel pairs retain six correctly sized tires", () => {
  let tires = 0;
  for (const name of spinNames) {
    const wheel = node(name);
    const vertices = localVertices(wheel, true);
    const clusters = name.startsWith("wheelRear")
      ? [vertices.filter((vertex) => vertex.x < 0), vertices.filter((vertex) => vertex.x >= 0)]
      : [vertices];
    for (const cluster of clusters) {
      assert.ok(cluster.length > 100, `${name} must contain each complete tire`);
      const size = new THREE.Box3().setFromPoints(cluster).getSize(new THREE.Vector3());
      const expected = name.startsWith("wheelRear") ? 68.7 : 56;
      near(size.y * millimetersPerUnit, expected, 0.7, `${name} tire vertical diameter in mm`);
      near(size.z * millimetersPerUnit, expected, 0.7, `${name} tire longitudinal diameter in mm`);
      assert.ok(size.x < size.y * 0.65, `${name} tire should have the actual narrow Technic cross-section`);
      tires += 1;
    }
  }
  assert.equal(tires, 6);
  for (const [index, name] of steeringNames.entries()) {
    assert.equal(node(spinNames[index]).parent, node(name), "Front wheel spin must remain inside its steering pivot");
    near(node(spinNames[index]).position.length(), 0, 0.00001, "Front roll and yaw must share their wheel center");
  }
  assert.ok(!steeringNames.includes(node("wheelRearLeft").parent?.name ?? ""));
  assert.ok(!steeringNames.includes(node("wheelRearRight").parent?.name ?? ""));
});

test("wheel geometry retains the original wheelbase, front track, and paired rear width", () => {
  const frontLeft = node("wheelFrontLeft").getWorldPosition(new THREE.Vector3());
  const frontRight = node("wheelFrontRight").getWorldPosition(new THREE.Vector3());
  const rearLeft = node("wheelRearLeft").getWorldPosition(new THREE.Vector3());
  const rearRight = node("wheelRearRight").getWorldPosition(new THREE.Vector3());
  const frontCenter = frontLeft.clone().add(frontRight).multiplyScalar(0.5);
  const rearCenter = rearLeft.clone().add(rearRight).multiplyScalar(0.5);
  assert.ok(frontCenter.z > rearCenter.z, "The model front must point toward +Z for steering camera views");
  near((frontCenter.z - rearCenter.z) * millimetersPerUnit, 246.4, 0.3, "Wheelbase in mm");
  near(Math.abs(frontLeft.x - frontRight.x) * millimetersPerUnit, 72, 0.3, "Front track in mm");
  const rearBounds = new THREE.Box3();
  for (const name of ["wheelRearLeft", "wheelRearRight"]) {
    const wheel = node(name);
    for (const vertex of localVertices(wheel, true)) rearBounds.expandByPoint(vertex.applyMatrix4(wheel.matrixWorld));
  }
  near(rearBounds.getSize(new THREE.Vector3()).x * millimetersPerUnit, 169, 1, "Overall rear tire width in mm");
});

test("both front wheels turn toward the driver's right for positive controller input", () => {
  const front = node("wheelFrontLeft").getWorldPosition(new THREE.Vector3())
    .add(node("wheelFrontRight").getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  const rear = node("wheelRearLeft").getWorldPosition(new THREE.Vector3())
    .add(node("wheelRearRight").getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  const forward = front.sub(rear).normalize();
  const up = new THREE.Vector3(0, 1, 0).transformDirection(scene.matrixWorld);
  const right = forward.clone().cross(up).normalize();
  for (const name of steeringNames) {
    const pivot = node(name);
    const previous = pivot.rotation.y;
    try {
      pivot.rotation.y = 0;
      scene.updateMatrixWorld(true);
      const localForward = forward.clone().transformDirection(pivot.matrixWorld.clone().invert());
      for (const command of [-1, -0.25, 0, 0.25, 1]) {
        pivot.rotation.y = steeringYawForCommand(command);
        scene.updateMatrixWorld(true);
        const wheelDirection = localForward.clone().transformDirection(pivot.matrixWorld);
        const sideways = wheelDirection.dot(right);
        if (command === 0) near(sideways, 0, 0.000001, `${name} straight ahead`);
        else assert.ok(sideways * command > 0, `${name} must turn in the controller's direction at ${command}`);
        assert.ok(wheelDirection.dot(forward) > 0.8, "Steering must remain within the forward-facing wheel range");
      }
    } finally {
      pivot.rotation.y = previous;
      scene.updateMatrixWorld(true);
    }
  }
});

test("rolling and steering rotate tires about their actual centers without eccentric orbit", () => {
  for (const name of spinNames) {
    const wheel = node(name);
    const center = new THREE.Box3().setFromPoints(localVertices(wheel, true)).getCenter(new THREE.Vector3());
    near(center.x, 0, 0.006, `${name} tire assembly centered across its roll pivot`);
    near(center.y, 0, 0.006, `${name} tire center on roll-axis Y`);
    near(center.z, 0, 0.006, `${name} tire center on roll-axis Z`);
    const start = wheel.getWorldPosition(new THREE.Vector3());
    const previous = wheel.rotation.x;
    try {
      wheel.rotation.x = Math.PI / 2;
      scene.updateMatrixWorld(true);
      near(wheel.getWorldPosition(new THREE.Vector3()).distanceTo(start), 0, 0.000001, `${name} fixed roll pivot`);
      const rolled = localVertices(wheel, true).map((vertex) => vertex.applyMatrix4(wheel.matrixWorld));
      const rolledCenter = new THREE.Box3().setFromPoints(rolled).getCenter(new THREE.Vector3());
      near(rolledCenter.distanceTo(start), 0, 0.006, `${name} center after a quarter turn`);
    } finally {
      wheel.rotation.x = previous;
      scene.updateMatrixWorld(true);
    }
  }
  for (const name of steeringNames) {
    const steering = node(name);
    const wheel = steering.children.find((child) => spinNames.includes(child.name));
    assert.ok(wheel);
    const start = wheel.getWorldPosition(new THREE.Vector3());
    const previous = steering.rotation.y;
    try {
      steering.rotation.y = Math.PI / 6;
      scene.updateMatrixWorld(true);
      near(wheel.getWorldPosition(new THREE.Vector3()).distanceTo(start), 0, 0.000001, `${name} fixed yaw pivot`);
      const steered = localVertices(wheel, true).map((vertex) => vertex.applyMatrix4(wheel.matrixWorld));
      const steeredCenter = new THREE.Box3().setFromPoints(steered).getCenter(new THREE.Vector3());
      near(steeredCenter.distanceTo(start), 0, 0.006, `${name} tire geometry remains centered while steering`);
    } finally {
      steering.rotation.y = previous;
      scene.updateMatrixWorld(true);
    }
  }
});

test("the real front lamps and rear jet lens remain separate emissive animation targets", () => {
  const body = node("body");
  assert.ok(meshes(body).length > 5, "The body must retain the multicolor Technic construction");
  const bodyMaterials = meshes(body).flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  assert.ok(bodyMaterials.some((material) => /^LDraw_1:/.test(material.name)), "Authored blue Technic pins must remain visible");
  assert.ok(bodyMaterials.some((material) => /^LDraw_4:/.test(material.name)), "Authored red Technic connectors must remain visible");
  const centers = lampNames.map((name) => {
    const lamp = node(name);
    assert.ok(meshes(lamp).length, `Missing lamp geometry: ${name}`);
    for (const mesh of meshes(lamp)) {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      assert.ok(material instanceof THREE.MeshStandardMaterial, `${name} must support emissive light feedback`);
      assert.ok(!bodyMaterials.includes(material), `${name} lamp feedback cannot recolor fixed body panels`);
    }
    return new THREE.Box3().setFromObject(lamp).getCenter(new THREE.Vector3());
  });
  assert.ok(centers[0].z > centers[2].z && centers[1].z > centers[2].z, "Front and rear light camera targets must follow the actual assembly");
  assert.ok(Math.abs(centers[0].x - centers[1].x) > 0.4, "The two front lamps must occupy separate sides");
});

test("three internal optical couplers have isolated green and clear surfaces for reverse feedback", () => {
  assert.deepEqual(manifest.nodes.reverseLights, reverseLampNames);
  const fixed = meshes(node("body")).flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  const external = lampNames.flatMap((name) => meshes(node(name)))
    .flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  const isolated = new Set<THREE.Material>();
  const centers = reverseLampNames.map((name) => {
    const lamp = node(name);
    const materials = meshes(lamp).flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    assert.ok(materials.some((material) => /^LDraw_35:/.test(material.name)), `${name} must retain its translucent green cones`);
    assert.ok(materials.some((material) => /^LDraw_47:/.test(material.name)), `${name} must retain its clear optical bar`);
    for (const material of materials) {
      assert.ok(material instanceof THREE.MeshStandardMaterial, `${name} must support emissive feedback`);
      assert.ok(!fixed.includes(material) && !external.includes(material), `${name} cannot recolor body, white tips or orange jet`);
      assert.ok(!isolated.has(material), `${name} must have an independent material for its optical assembly`);
      isolated.add(material);
    }
    return new THREE.Box3().setFromObject(lamp).getCenter(new THREE.Vector3());
  });
  assert.ok(Math.abs(centers[0].x - centers[1].x) > 0.4, "Front reverse couplers must remain on opposite sides");
  assert.ok(centers[2].z < centers[0].z && centers[2].z < centers[1].z, "The third reverse coupler must be the internal rear assembly");
  assert.ok(fixed.some((material) => /^LDraw_2:/.test(material.name)), "Opaque green85861 plates must stay in the fixed body");
  assert.ok(!fixed.some((material) => /^LDraw_35:/.test(material.name)), "Translucent green optical surfaces cannot remain baked into the fixed body");
});

test("cinematic whole-car shots keep the decoded model framed across desktop and narrow windows", () => {
  const center = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3());
  const point = new THREE.Vector3();
  const cropped = [];
  for (const name of ["overview", "drive", "boost", "combined"] as const) {
    const shot = CAMERA_SHOTS[name];
    const target = center.clone();
    target.y += shot.targetYOffset ?? 0;
    for (const aspect of [1.0, 1.3, 2.4]) {
      const camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 80);
      const offset = new THREE.Vector3().fromArray(shot.offset).multiplyScalar(Math.max(1, CAMERA_FRAMING_MIN_ASPECT / aspect));
      camera.position.copy(target).add(offset);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      let extent = 0;
      for (const mesh of meshes(scene)) {
        const positions = mesh.geometry.getAttribute("position");
        const transform = projection.clone().multiply(mesh.matrixWorld);
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(transform);
          extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
          assert.ok(point.z > -1 && point.z < 1, "Camera clipping planes must retain the car");
        }
      }
      if (extent >= 0.95) cropped.push({ view: name, aspect, extent });
    }
  }
  assert.deepEqual(cropped, [], "Whole-car shots must retain a margin around the actual decoded car");
});

test("the reverse camera exposes green surfaces in all three optical assemblies while steering", () => {
  const lamps = reverseLampNames.map(node);
  const target = lamps.reduce((sum, lamp) => sum.add(new THREE.Box3().setFromObject(lamp).getCenter(new THREE.Vector3())),
    new THREE.Vector3()).divideScalar(lamps.length);
  const steering = steeringNames.map(node);
  const previousRotations = steering.map((pivot) => pivot.rotation.y);
  const ray = new THREE.Raycaster();
  // Reject hidden lamps against the actual decoded chassis, including wheels.
  // Cached bounds keep these 192 surface probes inexpensive on the full model.
  for (const mesh of meshes(scene)) mesh.geometry.computeBoundingBox();
  try {
    for (const aspect of [1.0, 1.3, 2.4]) for (const steeringBias of [0, 0.3, -1, 1]) {
      for (const pivot of steering) pivot.rotation.y = steeringYawForCommand(steeringBias);
      scene.updateMatrixWorld(true);
      const orbit = new THREE.Spherical().setFromVector3(new THREE.Vector3().fromArray(CAMERA_SHOTS.reverse.offset));
      // Match the viewer's moving reverse composition and steering adjustment.
      const turn = Math.abs(steeringBias);
      orbit.theta += Math.min(turn, 0.3) * 0.2;
      orbit.radius *= 1 + turn * 0.08 + 0.03;
      orbit.radius *= Math.max(1, CAMERA_FRAMING_MIN_ASPECT / aspect);
      const camera = new THREE.Vector3().setFromSpherical(orbit).add(target);
      const framing = new THREE.PerspectiveCamera(38, aspect, 0.1, 80);
      framing.position.copy(camera);
      framing.lookAt(target);
      framing.updateMatrixWorld(true);
      const projection = new THREE.Matrix4().multiplyMatrices(framing.projectionMatrix, framing.matrixWorldInverse);
      const point = new THREE.Vector3();
      let frameExtent = 0;
      let minimumDepth = Infinity;
      let maximumDepth = -Infinity;
      // Check decoded surface vertices, rather than oversized box corners, at
      // both desktop and narrow-window framing. Keep the closer shot uncropped.
      for (const mesh of meshes(scene)) {
        const positions = mesh.geometry.getAttribute("position");
        const transform = projection.clone().multiply(mesh.matrixWorld);
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(transform);
          frameExtent = Math.max(frameExtent, Math.abs(point.x), Math.abs(point.y));
          minimumDepth = Math.min(minimumDepth, point.z);
          maximumDepth = Math.max(maximumDepth, point.z);
        }
      }
      assert.ok(frameExtent < 0.95, `The reverse camera crops the actual car at ${steeringBias * 100}% steering, aspect ${aspect}: extent ${frameExtent}`);
      assert.ok(minimumDepth > -1 && maximumDepth < 1, "The reverse view must retain the whole car inside its clipping planes");
      for (const lamp of lamps) {
        const green = meshes(lamp).filter((mesh) =>
          (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => /^LDraw_35:/.test(material.name)));
        assert.ok(green.length, `${lamp.name} must have actual green surfaces to inspect`);
        let visible = 0;
        for (const mesh of green) {
          const positions = mesh.geometry.getAttribute("position");
          for (let sample = 0; sample < 16; sample += 1) {
            const point = new THREE.Vector3()
              .fromBufferAttribute(positions, Math.floor(sample * (positions.count - 1) / 15))
              .applyMatrix4(mesh.matrixWorld);
            ray.set(camera, point.clone().sub(camera).normalize());
            ray.far = camera.distanceTo(point) + 0.03;
            const first = ray.intersectObject(scene, true)[0];
            // A coupler's own clear optical bar may lie in front of its green
            // cone; another assembly or body panel must not hide that surface.
            for (let hit: THREE.Object3D | null = first?.object ?? null; hit; hit = hit.parent) {
              if (hit === lamp) { visible += 1; break; }
            }
          }
        }
        const minimumVisible = lamp.name === "reverseLightRear" ? 10 : 2;
        assert.ok(visible >= minimumVisible,
          `${lamp.name} is occluded from the reverse camera at ${steeringBias * 100}% steering: ${visible} green probes visible`);
      }
    }
  } finally {
    for (const [index, pivot] of steering.entries()) pivot.rotation.y = previousRotations[index];
    scene.updateMatrixWorld(true);
  }
});

test("the runtime binder isolates white, orange and internal green reverse feedback", () => {
  const copy = scene.clone(true);
  // Object3D cloning shares GPU resources by default. Give the binder private
  // resources so its material changes and cleanup cannot alter the fixture.
  const copiedMaterials = new Map<THREE.Material, THREE.Material>();
  const copiedGeometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  for (const mesh of meshes(copy)) {
    if (!copiedGeometries.has(mesh.geometry)) copiedGeometries.set(mesh.geometry, mesh.geometry.clone());
    mesh.geometry = copiedGeometries.get(mesh.geometry)!;
    const copyMaterial = (material: THREE.Material) => {
      if (!copiedMaterials.has(material)) copiedMaterials.set(material, material.clone());
      return copiedMaterials.get(material)!;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copyMaterial) : copyMaterial(mesh.material);
  }
  const bound = bindTumblerModel(copy);
  try {
    assert.deepEqual(bound.frontSteering.map((part) => part.name), steeringNames);
    assert.deepEqual(bound.wheelSpins.map((part) => part.name), spinNames);
    near(bound.wheelRollRatios[0], 68.7 / 56, 0.02, "Smaller front tires roll faster for the same ground travel");
    near(bound.wheelRollRatios[1], 68.7 / 56, 0.02, "The other front tire retains the same rolling ratio");
    near(bound.wheelRollRatios[2], 1, 0.003, "Rear pair defines the reference rolling radius");
    near(bound.wheelRollRatios[3], 1, 0.003, "The other rear pair retains the same rolling radius");
    const rearBounds = new THREE.Box3().setFromObject(bound.wheelSpins[2]);
    near(bound.rearWheelRadius, (rearBounds.max.y - rearBounds.min.y) / 2, 0.003,
      "Street travel must use the displayed rear tire radius");
    assert.ok(bound.frontSteering.every((part) => part instanceof THREE.Object3D));
    assert.equal(bound.lightMaterials.length, 1);
    const white = bound.lightMaterials[0];
    assert.ok(Math.min(white.color.r, white.color.g, white.color.b) > 0.65, "Front feedback must use the white external lamp tips");
    assert.ok(bound.boostMaterial.color.r > 0.5 && bound.boostMaterial.color.g < 0.5 && bound.boostMaterial.color.b < 0.1,
      "Jet feedback must use the orange rear lens");
    assert.notEqual(white, bound.boostMaterial);
    for (const name of lampNames.slice(0, 2)) {
      const lamp = copy.getObjectByName(name);
      assert.ok(lamp);
      for (const mesh of meshes(lamp)) assert.equal(mesh.material, white);
    }
    const jet = copy.getObjectByName("jetLight");
    assert.ok(jet);
    for (const mesh of meshes(jet)) assert.equal(mesh.material, bound.boostMaterial);
    const body = copy.getObjectByName("body");
    assert.ok(body);
    const fixed = meshes(body).flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    assert.ok(!fixed.includes(white) && !fixed.includes(bound.boostMaterial), "Lamp animation must leave internal Technic parts fixed");
    assert.ok(fixed.some((material) => /^LDraw_2:/.test(material.name)), "Opaque green plates must retain their fixed body material");
    assert.ok(bound.reverseLightMaterials.length >= 6, "Each reverse coupler must expose its green cones and clear optical bar");
    assert.ok(bound.reverseLightMaterials.some((material) => /LDraw_35:/.test(material.name)
      && material.color.g > material.color.r * 3 && material.color.g > material.color.b * 3),
    "Transparent green reverse couplers must retain their original color");
    for (const material of bound.reverseLightMaterials) {
      assert.notEqual(material, white);
      assert.notEqual(material, bound.boostMaterial);
      assert.ok(!fixed.includes(material), "Reverse feedback cannot recolor opaque body parts");
      near(material.emissiveIntensity, 0.04, 0.00001, "Reverse optical surfaces start at the dark green baseline");
    }
    const reverseColors = bound.reverseLightMaterials.map((material) => material.color.clone());
    const clearBars = bound.reverseLightMaterials.filter((material) => /LDraw_47:/.test(material.name));
    assert.equal(clearBars.length, 3, "Each optical assembly must contain its independently tinted clear bar");
    const fixedColors = [...new Set(fixed)].filter((material): material is THREE.MeshStandardMaterial =>
      material instanceof THREE.MeshStandardMaterial)
      .map((material) => ({ material, color: material.color.clone(), intensity: material.emissiveIntensity }));
    const frontColor = white.color.clone();
    const boostColor = bound.boostMaterial.color.clone();
    bound.setReverseLights(true);
    for (const material of bound.reverseLightMaterials) {
      near(material.emissiveIntensity, 2.4, 0.00001, "Every reverse optical surface illuminates together");
    }
    for (const material of clearBars) {
      const original = reverseColors[bound.reverseLightMaterials.indexOf(material)];
      assert.ok(!material.color.equals(original), "A lit clear optical bar must transmit visibly green shading");
      assert.ok(material.color.g > material.color.r * 3 && material.color.g > material.color.b * 3,
        "White scene lighting cannot wash the reverse bars back to white");
    }
    const litColors = bound.reverseLightMaterials.map((material) => material.color.clone());
    bound.setReverseLights(true);
    for (const [index, material] of bound.reverseLightMaterials.entries()) {
      assert.ok(material.color.equals(litColors[index]), "Repeated live frames cannot accumulate the green tint");
    }
    assert.ok(white.color.equals(frontColor) && bound.boostMaterial.color.equals(boostColor),
      "Reverse activation must preserve white front lamps and the orange jet lens");
    near(white.emissiveIntensity, 0.04, 0.00001, "Reverse activation cannot turn on the front lamps");
    near(bound.boostMaterial.emissiveIntensity, 0.04, 0.00001, "Reverse activation cannot turn on the jet");
    for (const { material, color, intensity } of fixedColors) {
      assert.ok(material.color.equals(color), "Reverse activation cannot tint the fixed Technic body");
      assert.equal(material.emissiveIntensity, intensity, "Reverse activation cannot illuminate fixed body panels");
    }
    bound.setReverseLights(false);
    for (const [index, material] of bound.reverseLightMaterials.entries()) {
      assert.ok(material.color.equals(reverseColors[index]), "Turning reverse off must restore the exact original optical color");
      near(material.emissiveIntensity, 0.04, 0.00001, "Turning reverse off must restore the dark green baseline");
    }
    assert.equal(bound.partAnchors.steering.length, 2);
    assert.equal(bound.partAnchors.drive.length, 2);
    assert.equal(bound.partAnchors.lights.length, 2);
    assert.equal(bound.partAnchors.boost.length, 1);
    assert.equal(bound.partAnchors.reverse.length, 3);
    for (const target of Object.values(bound.cameraTargets)) {
      assert.ok(target.toArray().every(Number.isFinite), "Camera views must derive valid targets from the loaded CAD geometry");
    }
    const steeringMidpoint = bound.frontSteering.reduce((sum, part) => sum.add(part.getWorldPosition(new THREE.Vector3())),
      new THREE.Vector3()).divideScalar(2);
    near(bound.cameraTargets.steering.distanceTo(steeringMidpoint), 0, 0.00001, "The steering camera follows the actual axle");
  } finally {
    bound.dispose();
  }
});
