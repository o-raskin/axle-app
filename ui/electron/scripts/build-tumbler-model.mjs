import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { addTumblerDetails, detailsProvenance } from '../models/tumbler/source/axle-details.mjs';
import { readTumblerSourceBundle } from './tumbler-source-bundle.mjs';

// Geometry conversion is deliberately offline. Source CAD and its complete dependency
// subset are versioned; no model files are fetched by the renderer or normal builds.
const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelRoot = path.join(electronRoot, 'models/tumbler');
const sourceRoot = path.join(modelRoot, 'source');
const provenance = JSON.parse(await readFile(path.join(sourceRoot, 'provenance.json'), 'utf8'));
const sourceBundle = await readTumblerSourceBundle(path.join(sourceRoot, provenance.sourceBundle.path), provenance.sourceBundle.sha256);
// Default paths are logical members of the lossless ZIP. Explicit paths outside
// the package still support source/library overrides for CAD development.
async function readCadFile(filePath) {
  const relative = path.relative(sourceRoot, filePath).replaceAll('\\', '/');
  const archived = sourceBundle.files.get(relative);
  return archived ?? readFile(filePath);
}
const { values: options } = parseArgs({ options: Object.fromEntries(
  ['source', 'library', 'library-input', 'custom', 'output', 'manifest'].map((name) => [name, { type: 'string' }]),
) });
const sourcePath = path.resolve(options.source ?? path.join(modelRoot, 'source/42239.mpd'));
const libraryPath = path.resolve(options.library ?? path.join(modelRoot, 'source/ldraw'));
const libraryInput = path.resolve(options['library-input'] ?? libraryPath);
const customPath = path.resolve(options.custom ?? path.join(modelRoot, 'source/custom'));
const outputPath = path.resolve(options.output ?? path.join(electronRoot, 'src/renderer/src/vehicle/assets/tumbler-42239.glb'));
const manifestPath = path.resolve(options.manifest ?? path.join(modelRoot, 'generated/rig.json'));
const scale = 0.0075;
// 0.12 mm in display units. Simplify each part before batching to preserve
// separate touching liftarms and to avoid nonmanifold welds between LEGO parts.
const maximumError = 0.12 * scale / 0.4;
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
let originalTriangles = 0;
let simplificationError = 0;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const normalizeName = (name) => name.replaceAll('\\', '/').toLowerCase();
const sourceBytes = await readCadFile(sourcePath);
const sourceText = sourceBytes.toString('utf8').replace(/^\uFEFF/, '');
const dependencies = new Map();
const missing = new Set();
const loader = new LDrawLoader().setConditionalLineMaterial(LDrawConditionalLineMaterial);
globalThis.ProgressEvent ??= class extends Event {
  constructor(type, values = {}) { super(type); Object.assign(this, values); }
};

// Pinned Three.js exposes its LDraw cache. Override only file resolution: its parser,
// BFC winding, hard-edge normals, color inheritance and part hierarchy remain intact.
loader.partsCache.parseCache.fetchData = async (requestedName) => {
  const name = normalizeName(requestedName);
  if (name.split('/').includes('..') || path.isAbsolute(name)) throw new Error(`Unsafe part path: ${name}`);
  const candidates = [
    [customPath, name.replace(/^(?:parts|p)\//, '')],
    [libraryInput, `parts/${name}`],
    [libraryInput, `p/${name}`],
    [libraryInput, name],
  ];
  for (const [root, relative] of candidates) {
    let bytes;
    try { bytes = await readCadFile(path.join(root, relative)); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    dependencies.set(`${root === customPath ? 'custom' : 'ldraw'}/${relative}`, {
      sha256: sha256(bytes), bytes: bytes.byteLength,
      author: text.match(/^0 Author:[\t ]*([^\r\n]*)/m)?.[1]?.trim() || null,
      license: text.match(/^0 !LICENSE[\t ]+([^\r\n]*)/m)?.[1]?.trim() || null,
    });
    if (root === libraryInput && libraryInput !== libraryPath) {
      const destination = path.join(libraryPath, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    // Studio custom .dat meshes omit the LDraw part classification. Classifying them
    // enables part caching without changing any vertices or authored placements.
    return root === customPath && !text.includes('!LDRAW_ORG')
      ? `0 !LDRAW_ORG Unofficial_Part\n${text.replace(/^0 FILE .+\r?\n/, '')}` : text;
  }
  missing.add(name);
  throw new Error(`Missing local LDraw dependency: ${requestedName}`);
};

const palette = await readCadFile(path.join(libraryInput, 'LDConfig.ldr'));
if (libraryInput !== libraryPath) {
  await mkdir(libraryPath, { recursive: true });
  await writeFile(path.join(libraryPath, 'LDConfig.ldr'), palette);
}
dependencies.set('ldraw/LDConfig.ldr', { sha256: sha256(palette), bytes: palette.byteLength });
if (libraryInput !== libraryPath) {
  for (const name of ['CAlicense.txt', 'CAlicense4.txt', 'CAreadme.txt', 'Readme.txt']) {
    await writeFile(path.join(libraryPath, name), await readCadFile(path.join(libraryInput, name)));
  }
}
await loader.preloadMaterials(`data:text/plain;base64,${palette.toString('base64')}`);
loader.addDefaultMaterials();
// Studio's main export assigns its transparent hose a private color code. The
// original .io/model2.ldr identifies the same hose as Studio color 12 (Trans Clear).
const sourceColorAliases = { '1009021': { ldraw: '47', source: '42239.io/model2.ldr: Studio color 12 (Trans Clear)' } };
for (const [code, alias] of Object.entries(sourceColorAliases)) {
  const original = loader.getMaterial(alias.ldraw);
  const material = original.clone();
  material.name = 'Studio_Trans_Clear';
  material.userData.code = code;
  loader.edgeMaterialCache.set(material, loader.edgeMaterialCache.get(original));
  loader.addMaterial(material);
}
console.log('Resolving the local Tumbler assembly and LDraw part meshes…');
const authored = await new Promise((resolve, reject) => loader.parse(sourceText, resolve, reject));
if (missing.size) throw new Error(`Model is incomplete: ${[...missing].sort().join(', ')}`);
await addTumblerDetails(authored, loader);
authored.updateMatrixWorld(true);

const coordinateRotation = new THREE.Matrix4().set(
  0, 0, -scale, 0,
  0, -scale, 0, 0,
  -scale, 0, 0, 0,
  0, 0, 0, 1,
);
const rotated = new THREE.Box3();
authored.traverse((object) => {
  if (!object.isMesh) return;
  object.geometry.computeBoundingBox();
  rotated.union(object.geometry.boundingBox.clone().applyMatrix4(
    coordinateRotation.clone().multiply(object.matrixWorld),
  ));
});
const center = rotated.getCenter(new THREE.Vector3());
const normalize = new THREE.Matrix4().makeTranslation(-center.x, -rotated.min.y, -center.z)
  .multiply(coordinateRotation);
const toDisplay = (position) => new THREE.Vector3(...position).applyMatrix4(normalize);
const rig = new THREE.Group();
rig.name = 'Tumbler_42239';
const body = new THREE.Group();
body.name = 'body';
rig.add(body);

const wheelPivots = {
  frontLeft: [-226.3017, -69.8866, 90.1983],
  frontRight: [-226.3, -69.88602, -89.80001],
  rearLeft: [389.8, -86.3, 144],
  rearRight: [389.8, -86.4, -144],
};
const wheelNames = {
  frontLeft: 'wheelFrontLeft', frontRight: 'wheelFrontRight',
  rearLeft: 'wheelRearLeft', rearRight: 'wheelRearRight',
};
const reverseLightNames = ['reverseLightFrontLeft', 'reverseLightFrontRight', 'reverseLightRear'];
const featureNames = ['frontLightLeft', 'frontLightRight', 'jetLight', ...reverseLightNames];
const groups = new Map([['body', body]]);
for (const name of featureNames) {
  const feature = new THREE.Group();
  feature.name = name;
  rig.add(feature);
  groups.set(name, feature);
}
for (const [key, pivot] of Object.entries(wheelPivots)) {
  const spin = new THREE.Group();
  spin.name = wheelNames[key];
  const displayedPivot = toDisplay(pivot);
  if (key.startsWith('front')) {
    const steering = new THREE.Group();
    steering.name = key === 'frontLeft' ? 'frontSteeringLeft' : 'frontSteeringRight';
    steering.position.copy(displayedPivot);
    steering.add(spin);
    rig.add(steering);
  } else {
    spin.position.copy(displayedPivot);
    rig.add(spin);
  }
  groups.set(spin.name, spin);
}
rig.updateMatrixWorld(true);
const batches = new Map();
const materials = new Map();
let sourceMeshes = 0;
const rimParts = new Set(['7655.dat', '7683.dat', '56908.dat', '52985.dat']);
const closestPart = (object) => {
  for (let parent = object.parent; parent; parent = parent.parent) {
    if (rimParts.has(normalizeName(parent.name))) return parent;
  }
  return null;
};
const lightFeature = (object) => {
  if (object.userData.axleFeature) return object.userData.axleFeature;
  const ancestors = [];
  for (let parent = object.parent; parent; parent = parent.parent) ancestors.push(parent);
  const names = ancestors.map((parent) => normalizeName(parent.name));
  // These are the three actual internal green optical assemblies. Isolate
  // their translucent cones and clear light bars, not opaque green85861 plates.
  const coneOrBar = names.includes('59900.dat') || names.includes('30374.dat');
  if (coneOrBar && names.includes('submodel group 9')) return 'reverseLightFrontLeft';
  if (coneOrBar && names.includes('submodel group 10')) return 'reverseLightFrontRight';
  if ((coneOrBar || names.includes('6908.dat')) && names.includes('submodel group 24')) return 'reverseLightRear';
  const lens = ancestors.find((parent) => ['6908.dat', '3626b.dat'].includes(normalizeName(parent.name)));
  if (lens && lens.getWorldPosition(new THREE.Vector3()).x > 450) return 'jetLight';
  return null;
};

const triangleSlice = (geometry, start, count) => {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const result = new THREE.BufferGeometry();
  for (const attributeName of ['position', 'normal']) {
    const attribute = source.getAttribute(attributeName);
    if (!attribute) continue;
    result.setAttribute(attributeName, new THREE.BufferAttribute(
      attribute.array.slice(start * attribute.itemSize, (start + count) * attribute.itemSize),
      attribute.itemSize,
    ));
  }
  if (source !== geometry) source.dispose();
  return result;
};
authored.traverse((object) => {
  if (!object.isMesh) return;
  sourceMeshes += 1;
  const part = closestPart(object);
  let groupName = 'body';
  if (part) {
    const position = part.getWorldPosition(new THREE.Vector3());
    const front = position.x < 0;
    const left = position.z > 0;
    groupName = wheelNames[`${front ? 'front' : 'rear'}${left ? 'Left' : 'Right'}`];
  }
  groupName = lightFeature(object) ?? groupName;
  const target = groups.get(groupName);
  const transform = target.matrixWorld.clone().invert().multiply(normalize).multiply(object.matrixWorld);
  const materialArray = Array.isArray(object.material) ? object.material : [object.material];
  const spans = Array.isArray(object.material) ? object.geometry.groups : [{
    start: 0, count: object.geometry.index?.count ?? object.geometry.getAttribute('position').count, materialIndex: 0,
  }];
  for (const span of spans) {
    const surface = materialArray[span.materialIndex];
    if (!surface || span.count === 0) continue;
    if (surface === loader.missingColorMaterial) throw new Error('An undefined LDraw color was used');
    const materialKey = `${surface.userData.code ?? surface.name}:${surface.color.getHexString()}${groupName.includes('Light') ? `:${groupName}` : ''}`;
    if (!materials.has(materialKey)) {
      const material = surface.clone();
      material.name = `LDraw_${materialKey}`;
      // LEGO ABS and rubber should read as molded plastic, not painted automotive metal.
      material.roughness = material.roughness >= 0.85 ? 0.94 : 0.43;
      material.metalness = Math.min(material.metalness, 0.15);
      materials.set(materialKey, material);
    }
    const sliced = triangleSlice(object.geometry, span.start, span.count).applyMatrix4(transform);
    // Three normally flips the front-face convention for reflected Object3D
    // transforms. Once that transform is baked, preserve winding explicitly.
    if (transform.determinant() < 0) {
      for (const attribute of Object.values(sliced.attributes)) {
        for (let i = 0; i < attribute.count; i += 3) {
          for (let component = 0; component < attribute.itemSize; component += 1) {
            const a = (i + 1) * attribute.itemSize + component;
            const b = (i + 2) * attribute.itemSize + component;
            const temporary = attribute.array[a];
            attribute.array[a] = attribute.array[b];
            attribute.array[b] = temporary;
          }
        }
      }
    }
    const geometry = mergeVertices(sliced, 1e-5);
    sliced.dispose();
    originalTriangles += geometry.index.count / 3;
    const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(
      new Uint32Array(geometry.index.array), geometry.getAttribute('position').array, 3,
      geometry.getAttribute('normal').array, 3, [0.5, 0.5, 0.5], null,
      Math.floor(geometry.index.count * 0.4 / 3) * 3, maximumError, ['ErrorAbsolute', 'Permissive'],
    );
    // Remove vertices discarded by simplification before merging. Retain their
    // original normals; permissive collapses are constrained by normal weights.
    const referenced = [...new Set(indices)];
    const remap = new Map(referenced.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const compact = new Float32Array(referenced.length * attribute.itemSize);
      referenced.forEach((oldIndex, newIndex) => {
        for (let component = 0; component < attribute.itemSize; component += 1) {
          compact[newIndex * attribute.itemSize + component] = attribute.array[oldIndex * attribute.itemSize + component];
        }
      });
      geometry.setAttribute(name, new THREE.BufferAttribute(compact, attribute.itemSize));
    }
    geometry.setIndex(new THREE.BufferAttribute(indices.map((index) => remap.get(index)), 1));
    simplificationError = Math.max(simplificationError, error);
    const key = `${groupName}|${materialKey}`;
    const batch = batches.get(key) ?? { groupName, materialKey, geometries: [] };
    batch.geometries.push(geometry);
    batches.set(key, batch);
  }
});

let triangles = 0;
let vertices = 0;
for (const { groupName, materialKey, geometries } of batches.values()) {
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error(`Cannot merge geometry for ${groupName}/${materialKey}`);
  const indexed = mergeVertices(merged, 1e-5);
  indexed.normalizeNormals();
  const normals = indexed.getAttribute('normal');
  for (let vertex = 0; vertex < normals.count; vertex += 1) {
    if (normals.getX(vertex) === 0 && normals.getY(vertex) === 0 && normals.getZ(vertex) === 0) {
      // Degenerate source faces have no normal; use glTF's exporter fallback.
      normals.setXYZ(vertex, 1, 0, 0);
    }
  }
  const mesh = new THREE.Mesh(indexed, materials.get(materialKey));
  mesh.name = `${groupName}_${materialKey}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  groups.get(groupName).add(mesh);
  triangles += indexed.index.count / 3;
  vertices += indexed.getAttribute('position').count;
  merged.dispose();
  geometries.forEach((geometry) => geometry.dispose());
}

// GLTFExporter uses the browser FileReader API only for Blob conversion. Node has
// native Blob; this small adapter keeps the exported glTF standard and texture-free.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.(); });
  }
};
const bounds = new THREE.Box3().setFromObject(rig);
const rigMetadata = {
  format: 1,
  source: path.relative(electronRoot, sourcePath).replaceAll('\\', '/'),
  sourceSha256: sha256(sourceBytes),
  sourceBundle: {
    path: `models/tumbler/source/${provenance.sourceBundle.path}`,
    sha256: sourceBundle.sha256, bytes: sourceBundle.bytes, fileCount: sourceBundle.files.size,
    sourcePathMeaning: 'source and dependency paths identify logical ZIP members; explicit external overrides retain filesystem paths'
  },
  sourceColorAliases,
  additions: { ...detailsProvenance, source: 'models/tumbler/source/axle-details.mjs', sha256: sha256(await readFile(path.join(modelRoot, 'source/axle-details.mjs'))) },
  coordinateSystem: { forward: '+Z', up: '+Y', wheelRoll: 'X', steeringYaw: 'Y', lduScale: scale },
  bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), size: bounds.getSize(new THREE.Vector3()).toArray() },
  nodes: {
    body: 'body', steering: ['frontSteeringLeft', 'frontSteeringRight'], wheelSpin: Object.values(wheelNames),
    frontLights: ['frontLightLeft', 'frontLightRight'], jetLight: 'jetLight',
    reverseLights: reverseLightNames,
  },
  features: Object.fromEntries(featureNames.map((name) => {
    const featureBounds = new THREE.Box3().setFromObject(groups.get(name));
    if (featureBounds.isEmpty()) throw new Error(`Missing authored light geometry: ${name}`);
    return [name, { center: featureBounds.getCenter(new THREE.Vector3()).toArray(), min: featureBounds.min.toArray(), max: featureBounds.max.toArray() }];
  })),
  pivots: Object.fromEntries(Object.entries(wheelPivots).map(([key, value]) => [wheelNames[key], toDisplay(value).toArray()])),
  geometry: { triangles, vertices, drawCalls: batches.size, sourceMeshes, materials: materials.size },
  dependencies: Object.fromEntries([...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
rig.userData.axleRig = { format: rigMetadata.format, nodes: rigMetadata.nodes, pivots: rigMetadata.pivots };
const originalBuffer = await new GLTFExporter().parseAsync(rig, { binary: true, onlyVisible: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
});
const document = await io.readBinary(new Uint8Array(originalBuffer));
await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 12 }));
const buffer = await io.writeBinary(document);
rigMetadata.optimization = {
  originalTriangles, maximumPartErrorMillimeters: 0.12, normalWeights: [0.5, 0.5, 0.5],
  achievedPartErrorMillimeters: simplificationError * 0.4 / scale,
  positionBits: 16, normalBits: 12, compression: 'EXT_meshopt_compression',
};
rigMetadata.geometry.triangles = document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((count, prim) => count + prim.getIndices().getCount() / 3, 0), 0);
rigMetadata.geometry.vertices = document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((count, prim) => count + prim.getAttribute('POSITION').getCount(), 0), 0);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, new Uint8Array(buffer));
rigMetadata.assetSha256 = sha256(new Uint8Array(buffer));
rigMetadata.assetBytes = buffer.byteLength;
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(rigMetadata, null, 2)}\n`);
const escapeCell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const notices = [
  '# Tumbler 42239 model: third-party notices',
  '',
  `Assembly source: **${provenance.sourceAuthor}**, [original model publication](${provenance.sourcePage}).`,
  `The assembly publication states [${provenance.assemblyLicense}](${provenance.assemblyLicenseUrl}); the derived model is subject to its noncommercial restriction for the rights the publisher can license. Apache-2.0 covers Axle code, not this imported asset.`,
  '',
  'Some custom/embedded Studio meshes have no separate license notice, and their ownership/permission has not been independently verified. A blank creator field means unidentified, not public domain or authorship by the assembly publisher. See the accompanying model RIGHTS.md and LICENSE.md. No vehicle-design, trademark or brand-marking clearance is established by these notices.',
  '',
  'Adaptations: substituted official LDraw part meshes where available; retained supplied custom meshes and the authored assembly layout; converted coordinates and scale with reflected winding correction; separated wheel pivots, external lamp surfaces and the three translucent green internal optical assemblies used for reverse feedback; added reconstructed48mm front guides, pin tips and hand-authored surface graphics from the official instructions; simplified individual parts with normal-aware error control; merged by rig/material; quantized and Meshopt-compressed the local glTF binary. Additions and requested approximate0.12mm simplification tolerance are recorded in rig.json and source/axle-details.mjs. One Studio private transparent color is mapped to LDraw Trans Clear. The source hub is the original author’s earlier CAD approximation; this is not a claim of a complete verified digital twin.',
  '',
  'Official part geometry and the color palette come from the [LDraw.org Parts Library](https://library.ldraw.org/). The retained files preserve each creator, license and history header. Applicable [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) agreements are retained as ldraw/CAlicense4.txt and ldraw/CAlicense.txt inside source/cad-source.zip. Geometry is transformed and combined during conversion; original part bytes are unchanged. All dependency paths below identify ZIP members.',
  '',
  '| Retained dependency | Original creator | License recorded in source header |',
  '| --- | --- | --- |',
  ...[...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, dependency]) =>
    `| ${escapeCell(name)} | ${escapeCell(dependency.author ?? (name.endsWith('LDConfig.ldr') ? 'LDraw.org color configuration contributors; see file headers' : 'Not identified in retained source'))} | ${escapeCell(dependency.license ?? (name.startsWith('custom/') ? 'Source publication: CC BY-NC 4.0; separate mesh license unverified' : 'See retained file headers and LDraw library agreements'))} |`),
  '',
  'LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse Axle. Batman/Batmobile/Tumbler rights remain with their respective DC/Warner Bros. rights holders. Axle is independent of those parties and the source creators. Attribution does not grant missing permissions.',
  '',
].join('\n');
await writeFile(path.join(path.dirname(manifestPath), 'THIRD-PARTY-NOTICES.md'), notices);
console.log(JSON.stringify({ output: path.relative(electronRoot, outputPath), ...rigMetadata.geometry, bytes: buffer.byteLength, bounds: rigMetadata.bounds }, null, 2));
