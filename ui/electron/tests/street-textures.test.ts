import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

import { createStreetSurface, type StreetSurfaceKind } from "../src/renderer/src/vehicle/streetTextures.ts";

const kinds: StreetSurfaceKind[] = ["brick", "asphalt", "concrete", "metal", "marking"];

test("original street surfaces supply high-resolution correctly coloured PBR channels", () => {
  for (const kind of kinds) {
    const surface = createStreetSurface(kind);
    try {
      const size = kind === "brick" || kind === "asphalt" ? 1024 : 512;
      for (const texture of [surface.map, surface.normalMap, surface.roughnessMap]) {
        assert.equal(texture.image.width, size);
        assert.equal(texture.image.height, size);
        assert.equal(texture.image.data.length, size * size * 4);
        assert.equal(texture.wrapS, THREE.RepeatWrapping);
        assert.equal(texture.wrapT, THREE.RepeatWrapping);
        assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
        assert.equal(texture.generateMipmaps, true, "Distant fine details need mipmaps to avoid shimmering");
        assert.equal(texture.anisotropy, 4);
      }
      assert.equal(surface.map.colorSpace, THREE.SRGBColorSpace);
      assert.equal(surface.normalMap.colorSpace, THREE.NoColorSpace);
      assert.equal(surface.roughnessMap.colorSpace, THREE.NoColorSpace);
      const bytes = surface.roughnessMap.image.data as Uint8Array;
      const roughnessValues = new Set<number>();
      for (let index = 0; index < bytes.length; index += 4 * 127) {
        assert.equal(bytes[index], bytes[index + 1]);
        assert.equal(bytes[index + 2], bytes[index + 1]);
        assert.equal(bytes[index + 3], 255);
        roughnessValues.add(bytes[index + 1]);
      }
      assert.ok(roughnessValues.size >= 8, `${kind} must have actual PBR roughness variation`);
    } finally { surface.dispose(); }
  }
});

test("every albedo, normal and roughness edge joins seamlessly in both directions", () => {
  for (const kind of kinds) {
    const surface = createStreetSurface(kind);
    try {
      for (const texture of [surface.map, surface.normalMap, surface.roughnessMap]) {
        const { width, height } = texture.image;
        const bytes = texture.image.data as Uint8Array;
        for (let pixel = 0; pixel < width; pixel += 1) {
          for (let channel = 0; channel < 4; channel += 1) {
            assert.equal(bytes[pixel * 4 + channel], bytes[((height - 1) * width + pixel) * 4 + channel],
              `${texture.name}, vertical join at ${pixel}:${channel}`);
            assert.equal(bytes[(pixel * width) * 4 + channel], bytes[(pixel * width + width - 1) * 4 + channel],
              `${texture.name}, horizontal join at ${pixel}:${channel}`);
          }
        }
      }
    } finally { surface.dispose(); }
  }
});

test("height-derived tangent normals point outward and retain unit length after byte encoding", () => {
  for (const kind of kinds) {
    const surface = createStreetSurface(kind);
    try {
      const bytes = surface.normalMap.image.data as Uint8Array;
      let relief = false;
      for (let index = 0; index < bytes.length; index += 4 * 43) {
        const x = bytes[index] / 255 * 2 - 1;
        const y = bytes[index + 1] / 255 * 2 - 1;
        const z = bytes[index + 2] / 255 * 2 - 1;
        assert.ok(z > 0, `${kind} normal must point away from the surface`);
        assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.012, `${kind} normal must be normalized`);
        relief ||= Math.abs(x) > 0.1 || Math.abs(y) > 0.1;
      }
      assert.ok(relief, `${kind} must contain real relief rather than a constant normal`);
    } finally { surface.dispose(); }
  }
});

test("cached original pixel data is deterministic while texture configuration and disposal remain scene-owned", () => {
  for (const kind of kinds) {
    const first = createStreetSurface(kind);
    const second = createStreetSurface(kind);
    const disposals = new Map<THREE.Texture, number>();
    for (const texture of [first.map, first.normalMap, first.roughnessMap, second.map, second.normalMap, second.roughnessMap]) {
      texture.addEventListener("dispose", () => disposals.set(texture, (disposals.get(texture) ?? 0) + 1));
    }
    assert.notEqual(first.map, second.map);
    assert.deepEqual(first.map.image.data, second.map.image.data);
    assert.deepEqual(first.normalMap.image.data, second.normalMap.image.data);
    assert.deepEqual(first.roughnessMap.image.data, second.roughnessMap.image.data);
    first.map.repeat.set(7, 12);
    first.normalMap.repeat.set(7, 12);
    first.map.anisotropy = 1;
    assert.deepEqual(second.map.repeat.toArray(), [1, 1]);
    assert.deepEqual(second.normalMap.repeat.toArray(), [1, 1]);
    assert.equal(second.map.anisotropy, 4);
    first.dispose();
    first.dispose();
    assert.equal(disposals.get(first.map), 1);
    assert.equal(disposals.get(first.normalMap), 1);
    assert.equal(disposals.get(first.roughnessMap), 1);
    assert.equal(disposals.get(second.map), undefined, "Disposing one scene cannot destroy another scene's texture");
    second.dispose();
    second.dispose();
    for (const texture of disposals.keys()) assert.equal(disposals.get(texture), 1);
  }
});


function photoPixels(size = 2) {
  return {
    size,
    color: new Uint8Array(size * size * 4).fill(57),
    normal: new Uint8Array(size * size * 4).fill(128),
    roughness: new Uint8Array(size * size * 4).fill(179)
  };
}

test("offline photo upgrade preserves material references and physical transforms while releasing old GPU storage", async () => {
  let complete!: (pixels: ReturnType<typeof photoPixels>) => void;
  const surface = createStreetSurface("brick", () => new Promise((resolve) => { complete = resolve; }));
  const textures = [surface.map, surface.normalMap, surface.roughnessMap];
  const previous = textures.map((item) => item.image);
  const disposalCounts = textures.map(() => 0);
  for (const [index, item] of textures.entries()) {
    item.repeat.set(7.5, 3.25);
    item.offset.set(0.23, 0.61);
    item.anisotropy = 2;
    item.addEventListener("dispose", () => { disposalCounts[index] += 1; });
  }
  await Promise.resolve();
  assert.deepEqual(textures.map((item) => item.image), previous, "Every fallback channel remains usable while decoding");
  const pixels = photoPixels();
  complete(pixels);
  assert.equal(await surface.ready, true);
  assert.deepEqual([surface.map, surface.normalMap, surface.roughnessMap], textures);
  assert.deepEqual(textures.map((item) => item.image.data), [pixels.color, pixels.normal, pixels.roughness]);
  for (const item of textures) {
    assert.deepEqual(item.repeat.toArray(), [7.5, 3.25]);
    assert.deepEqual(item.offset.toArray(), [0.23, 0.61]);
    assert.equal(item.anisotropy, 2);
    assert.equal(item.image.width, 2);
    assert.equal(item.flipY, true, "All photographed channels must share orientation");
    assert.equal(item.userData.photographicSurface, true);
  }
  assert.equal(surface.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(surface.normalMap.colorSpace, THREE.NoColorSpace);
  assert.equal(surface.roughnessMap.colorSpace, THREE.NoColorSpace);
  assert.equal(surface.tileSize, 1.9);
  assert.deepEqual(disposalCounts, [1, 1, 1], "A dimension change cannot reuse immutable old WebGL storage");
  surface.dispose(); surface.dispose();
  assert.deepEqual(disposalCounts, [2, 2, 2], "Only final scene-owned storage is released during cleanup");
});

test("late photographed maps never resurrect a disposed scene", async () => {
  let complete!: (pixels: ReturnType<typeof photoPixels>) => void;
  const surface = createStreetSurface("asphalt", () => new Promise((resolve) => { complete = resolve; }));
  const images = [surface.map.image, surface.normalMap.image, surface.roughnessMap.image];
  const version = surface.map.version;
  surface.dispose();
  complete(photoPixels());
  assert.equal(await surface.ready, false);
  assert.deepEqual([surface.map.image, surface.normalMap.image, surface.roughnessMap.image], images);
  assert.equal(surface.map.version, version, "A late decode must not schedule a new GPU upload");
});

test("decode failure and non-DOM consumers retain deterministic PBR fallback without throwing", async () => {
  const failed = createStreetSurface("metal", () => Promise.reject(new Error("Unavailable local image decoder")));
  const data = failed.map.image.data;
  assert.equal(await failed.ready, false);
  assert.equal(failed.map.image.data, data);
  failed.dispose();
  for (const kind of kinds) {
    const surface = createStreetSurface(kind);
    assert.equal(await surface.ready, false, "Node consumers must not request local renderer assets");
    assert.equal(surface.tileSize, { brick: 1.9, asphalt: 3, concrete: 2, metal: 2.5, marking: 1 }[kind]);
    surface.dispose();
  }
});

function jpegSize(data: Buffer): [number, number] {
  assert.equal(data.readUInt16BE(0), 0xffd8, "The packaged source must be a real JPEG");
  let offset = 2;
  while (offset < data.length) {
    assert.equal(data[offset], 0xff);
    const marker = data[offset + 1];
    offset += 2;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
    offset += data.readUInt16BE(offset);
  }
  throw new Error("JPEG has no dimensions");
}

test("all shipped photographed channels retain their verified CC0 provenance, source hashes and authored resolution", () => {
  const directory = join(process.cwd(), "environment");
  const manifest = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8"));
  assert.equal(manifest.license, "CC0-1.0");
  assert.equal(manifest.assets.length, 4);
  let bytes = 0;
  for (const asset of manifest.assets) {
    assert.equal(asset.license, "CC0-1.0");
    assert.equal(asset.licenseUrl, "https://polyhaven.com/license");
    assert.ok(asset.author.length > 0);
    assert.ok(asset.source.startsWith("https://polyhaven.com/a/"));
    assert.equal(asset.tileSizeMeters, { brick: 1.9, asphalt: 3, concrete: 2, metal: 2.5 }[asset.surface as "brick"]);
    assert.deepEqual(Object.keys(asset.maps), ["albedo", "normal", "roughness"]);
    for (const item of Object.values(asset.maps) as Array<{ file: string; bytes: number; sha256: string; sourceMd5: string }>) {
      const data = readFileSync(join(directory, item.file));
      assert.equal(data.length, item.bytes);
      assert.equal(createHash("sha256").update(data).digest("hex"), item.sha256);
      assert.equal(createHash("md5").update(data).digest("hex"), item.sourceMd5, "Use original maps, never unlicensed preview renders");
      assert.deepEqual(jpegSize(data), [asset.resolution, asset.resolution]);
      bytes += data.length;
    }
  }
  assert.ok(bytes < 21 * 1024 * 1024, "Photographed surfaces must stay compact for desktop downloads");
  assert.ok(readFileSync(join(directory, "CC0-1.0.txt"), "utf8").includes("CC0 1.0 Universal"));
});


test("packaged night-city panorama preserves verified CC0 source and unclipped HDR radiance", () => {
  const directory = join(process.cwd(), "environment");
  const manifest = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8"));
  const source = manifest.lighting;
  assert.equal(source.license, "CC0-1.0");
  assert.equal(source.author, "Greg Zaal");
  assert.equal(source.source, "https://polyhaven.com/a/modern_buildings_night");
  const bytes = readFileSync(join(directory, source.file));
  assert.equal(bytes.length, source.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  assert.equal(createHash("md5").update(bytes).digest("hex"), source.sourceMd5);
  const decoded = new HDRLoader().setDataType(THREE.FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(decoded);
  assert.equal(decoded.width, source.width);
  assert.equal(decoded.height, source.height);
  assert.equal(decoded.width, decoded.height * 2, "Environment reflections require a complete equirectangular panorama");
  const values = decoded.data as Float32Array;
  let highest = 0;
  let belowOne = false;
  for (let index = 0; index < values.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = values[index + channel];
      assert.ok(Number.isFinite(value) && value >= 0, "HDR radiance must decode without NaN or invalid light values");
      highest = Math.max(highest, value);
      belowOne ||= value < 1;
    }
    assert.equal(values[index + 3], 1);
  }
  assert.ok(highest > 2 && belowOne, "Do not substitute a tone-mapped LDR photo for real night-light radiance");
});
