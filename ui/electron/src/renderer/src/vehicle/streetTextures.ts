import * as THREE from "three";

export type StreetSurfaceKind = "brick" | "asphalt" | "concrete" | "metal" | "marking";

export interface StreetSurface {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  /** Physical width and height of one complete tile in metres. */
  readonly tileSize: number;
  /** Resolves after all offline photographed maps replace the fallback atomically. */
  readonly ready: Promise<boolean>;
  dispose(): void;
}

interface SurfacePixels {
  size: number;
  color: Uint8Array;
  normal: Uint8Array;
  roughness: Uint8Array;
}

// CPU pixels can survive a lost WebGL context. Each caller still owns its three
// GPU textures, so disposing one scene never invalidates another scene's maps.
const surfaceCache = new Map<StreetSurfaceKind, SurfacePixels>();
const TAU = Math.PI * 2;
const physicalTileSize: Record<StreetSurfaceKind, number> = {
  brick: 1.9, asphalt: 3, concrete: 2, metal: 2.5, marking: 1
};
const photographicPixels = new Map<StreetSurfaceKind, SurfacePixels>();
const photographicLoads = new Map<StreetSurfaceKind, Promise<SurfacePixels | undefined>>();

// Literal URLs let Vite fingerprint and package every asset. There is no CDN
// request at runtime: installed builds resolve these beside the renderer bundle.
function photographicUrls(kind: StreetSurfaceKind): [string, string, string] | undefined {
  switch (kind) {
    case "brick": return [
      new URL("../../../../environment/textures/brick_wall_10_albedo_2k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/brick_wall_10_normal_2k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/brick_wall_10_roughness_2k.jpg", import.meta.url).href
    ];
    case "asphalt": return [
      new URL("../../../../environment/textures/asphalt_02_albedo_2k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/asphalt_02_normal_2k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/asphalt_02_roughness_2k.jpg", import.meta.url).href
    ];
    case "concrete": return [
      new URL("../../../../environment/textures/concrete_floor_02_albedo_1k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/concrete_floor_02_normal_1k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/concrete_floor_02_roughness_1k.jpg", import.meta.url).href
    ];
    case "metal": return [
      new URL("../../../../environment/textures/blue_metal_plate_albedo_1k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/blue_metal_plate_normal_1k.jpg", import.meta.url).href,
      new URL("../../../../environment/textures/blue_metal_plate_roughness_1k.jpg", import.meta.url).href
    ];
    default: return undefined;
  }
}

function decodePixels(url: string, expectedSize: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onerror = () => reject(new Error("Packaged surface map could not be decoded"));
    image.onload = () => {
      try {
        if (image.naturalWidth !== expectedSize || image.naturalHeight !== expectedSize) {
          throw new Error("Packaged surface map has unexpected dimensions");
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = expectedSize;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Surface decoder is unavailable");
        context.drawImage(image, 0, 0);
        const data = new Uint8Array(context.getImageData(0, 0, expectedSize, expectedSize).data);
        canvas.width = canvas.height = 0;
        image.onload = image.onerror = null;
        resolve(data);
      } catch (error) { reject(error); }
    };
    image.src = url;
  });
}

function loadPhotographicSurface(kind: StreetSurfaceKind): Promise<SurfacePixels | undefined> {
  // Node tests and non-browser consumers retain the deterministic fallback.
  if (kind === "marking" || typeof document === "undefined" || typeof Image === "undefined") {
    return Promise.resolve(undefined);
  }
  let loading = photographicLoads.get(kind);
  if (!loading) {
    const urls = photographicUrls(kind)!;
    const size = kind === "brick" || kind === "asphalt" ? 2048 : 1024;
    loading = Promise.all(urls.map((url) => decodePixels(url, size))).then(([color, normal, roughness]) => {
      const pixels = { size, color, normal, roughness };
      photographicPixels.set(kind, pixels);
      // Loading has completed; retain only the photographed shared CPU pixels.
      surfaceCache.delete(kind);
      return pixels;
    }).catch(() => undefined);
    photographicLoads.set(kind, loading);
  }
  return loading;
}

function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y + seed, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smooth(value: number): number {
  const amount = clamp(value);
  return amount * amount * (3 - 2 * amount);
}

/** Bilinear periodic noise. The tiny lattices are generated once per surface. */
function periodicNoise(cells: number, seed: number): (u: number, v: number) => number {
  const pixels = new Float32Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) pixels[y * cells + x] = hash(x, y, seed);
  }
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const left = ix % cells;
    const right = (left + 1) % cells;
    const top = (iy % cells) * cells;
    const bottom = ((iy + 1) % cells) * cells;
    const upper = pixels[top + left] * (1 - fx) + pixels[top + right] * fx;
    const lower = pixels[bottom + left] * (1 - fx) + pixels[bottom + right] * fx;
    return upper * (1 - fy) + lower * fy;
  };
}

function generateSurface(kind: StreetSurfaceKind): SurfacePixels {
  const size = kind === "brick" || kind === "asphalt" ? 1024 : 512;
  const edge = size - 1;
  const color = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(color.length);
  const roughness = new Uint8Array(color.length);
  const heights = new Float32Array(size * size);
  const macro = periodicNoise(8, 613);
  const detail = periodicNoise(64, 1297);
  const aggregate = periodicNoise(256, 421);
  const crackedX = new Float32Array(size);
  const crackedY = new Float32Array(size);
  for (let pixel = 0; pixel < size; pixel += 1) {
    const coordinate = pixel / edge;
    crackedX[pixel] = 0.24 + 0.035 * Math.sin(coordinate * TAU) + 0.008 * Math.sin(coordinate * TAU * 7);
    crackedY[pixel] = 0.69 + 0.025 * Math.sin(coordinate * TAU * 3) + 0.006 * Math.sin(coordinate * TAU * 11);
  }

  for (let y = 0; y < size; y += 1) {
    const v = y / edge;
    const grainY = y % edge;
    for (let x = 0; x < size; x += 1) {
      const u = x / edge;
      const broad = macro(u, v);
      const middle = detail(u, v);
      const small = aggregate(u, v);
      const grain = hash(x % edge, grainY, 1753);
      let red = 0;
      let green = 0;
      let blue = 0;
      let height = 0;
      let matte = 0;

      if (kind === "brick") {
        const row = Math.floor(v * 16) % 16;
        const horizontal = (u * 8 + (row % 2) * 0.5) % 8;
        const column = Math.floor(horizontal);
        const brickX = horizontal - column;
        const brickY = (v * 16) % 1;
        const edgeDistance = Math.min(brickX, 1 - brickX, brickY * 0.52, (1 - brickY) * 0.52);
        // A beveled edge, chipped unevenly, keeps the mortar recessed instead of
        // treating a darker albedo line as an arbitrary bump-map height.
        const chipped = 0.018 + (middle > 0.69 ? (middle - 0.69) * 0.10 : 0);
        const face = smooth((edgeDistance - chipped) / 0.023);
        const brickTone = hash(column, row, 791) * 25 - 12;
        const weather = (broad - 0.5) * 19 + (middle - 0.5) * 10;
        const fleck = (grain - 0.5) * 15 + (small - 0.5) * 8;
        const lime = smooth((broad - 0.63) * 5) * 14;
        const streak = Math.max(0, 1 - brickY * 4) * (1 - broad) * 9;
        const faceValue = 126 + brickTone + weather + fleck + lime - streak;
        const mortarValue = 78 + weather * 0.35 + fleck * 0.6;
        red = mortarValue * (1 - face) + (faceValue + 9) * face;
        green = (mortarValue + 2) * (1 - face) + faceValue * face;
        blue = (mortarValue + 5) * (1 - face) + (faceValue - 10) * face;
        height = face * (0.63 + middle * 0.10) + (grain - 0.5) * 0.023;
        matte = 0.91 - face * 0.10 + (grain - 0.5) * 0.05;
      } else if (kind === "asphalt") {
        const wet = 0.3 + broad * 0.45;
        const stone = smooth((small - 0.53) * 5.8);
        const crackDistance = Math.min(Math.abs(u - crackedX[y]), Math.abs(v - crackedY[x]));
        const crack = 1 - smooth((crackDistance * edge - 0.6) / 1.7);
        const chips = stone * (3 + grain * 4);
        // Moisture affects reflectance more than albedo. Strong dark islands
        // repeated across a large road would read as camouflage rather than wet
        // pavement; aggregate and thin cracks provide the visible surface detail.
        const value = 54 + (middle - 0.5) * 6 + (grain - 0.5) * 14 + chips - wet * 3 - crack * 10;
        red = value - 2;
        green = value + 1;
        blue = value + 4;
        height = 0.20 + stone * 0.065 + (grain - 0.5) * 0.026 - crack * 0.12;
        matte = 0.73 - wet * 0.20 + (middle - 0.5) * 0.06 + stone * 0.025;
      } else if (kind === "concrete") {
        const slabX = (u * 4) % 1;
        const slabY = (v * 4) % 1;
        const jointDistance = Math.min(slabX, 1 - slabX, slabY, 1 - slabY);
        const joint = 1 - smooth((jointDistance - 0.008) / 0.016);
        const fissure = 1 - smooth((Math.abs(v - crackedY[x]) * edge - 0.2) / 0.8);
        const pore = grain > 0.963 ? 1 : 0;
        const dirt = (1 - broad) * 15;
        const slabTone = hash(Math.floor(u * 4) % 4, Math.floor(v * 4) % 4, 83) * 13;
        const value = 129 + slabTone + (middle - 0.5) * 10 + (grain - 0.5) * 11 - dirt - joint * 40 - fissure * 25 - pore * 17;
        red = value - 3;
        green = value;
        blue = value + 3;
        height = 0.37 - joint * 0.15 - fissure * 0.065 - pore * 0.037 + (small - 0.5) * 0.024;
        matte = 0.91 - broad * 0.08 + (grain - 0.5) * 0.04;
      } else if (kind === "metal") {
        const panelX = (u * 4) % 1;
        const panelY = (v * 4) % 1;
        const seamDistance = Math.min(panelX, 1 - panelX, panelY, 1 - panelY);
        const seam = 1 - smooth((seamDistance - 0.009) / 0.008);
        const rivetDistance = Math.hypot(Math.min(Math.abs(panelX - 0.12), Math.abs(panelX - 0.88)),
          Math.min(Math.abs(panelY - 0.12), Math.abs(panelY - 0.88)));
        const rivet = 1 - smooth((rivetDistance - 0.023) / 0.021);
        const rust = smooth((broad + middle * 0.12 - 0.63) * 5);
        const wear = Math.max(0, middle - 0.75) * 37 + rivet * 8;
        const value = 84 + (middle - 0.5) * 12 + (grain - 0.5) * 9 - seam * 25;
        red = value - 12 + rust * 42 + wear;
        green = value - 2 + rust * 2 + wear;
        blue = value + 6 - rust * 23 + wear;
        height = 0.35 + rivet * 0.22 - seam * 0.08 + rust * (small - 0.5) * 0.042;
        matte = 0.46 + rust * 0.38 + (grain - 0.5) * 0.04;
      } else {
        const worn = smooth((middle - 0.54) * 5) * smooth((small - 0.40) * 5);
        const speck = grain > 0.945 ? 1 : 0;
        const value = 195 + (broad - 0.5) * 13 + (grain - 0.5) * 13 - worn * 109 - speck * 39;
        red = value + 5;
        green = value + 2;
        blue = value - 10;
        height = 0.13 * (1 - worn) + (grain - 0.5) * 0.022;
        matte = 0.76 - broad * 0.14 + worn * 0.13;
      }

      const index = (y * size + x) * 4;
      color[index] = THREE.MathUtils.clamp(Math.round(red), 0, 255);
      color[index + 1] = THREE.MathUtils.clamp(Math.round(green), 0, 255);
      color[index + 2] = THREE.MathUtils.clamp(Math.round(blue), 0, 255);
      color[index + 3] = 255;
      const rough = Math.round(clamp(matte) * 255);
      // Three.js reads green for roughness. Replication also makes the texture
      // straightforward to inspect in an ordinary image viewer.
      roughness[index] = roughness[index + 1] = roughness[index + 2] = rough;
      roughness[index + 3] = 255;
      heights[y * size + x] = height;
    }
  }

  const strength = kind === "brick" ? 6 : kind === "metal" ? 5 : 3.5;
  for (let y = 0; y < size; y += 1) {
    // The duplicate endpoint has the same neighbours as the first endpoint.
    const above = ((y % edge + edge - 1) % edge) * size;
    const below = ((y % edge + 1) % edge) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x % edge + edge - 1) % edge;
      const right = (x % edge + 1) % edge;
      const nx = (heights[y * size + left] - heights[y * size + right]) * strength;
      const ny = (heights[above + x] - heights[below + x]) * strength;
      const length = Math.hypot(nx, ny, 1);
      const index = (y * size + x) * 4;
      normal[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
      normal[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      normal[index + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      normal[index + 3] = 255;
    }
  }
  return { size, color, normal, roughness };
}

/**
 * Scene-owned PBR textures with deterministic procedural fallback. Packaged CC0
 * photographed surfaces replace all three channels together without changing
 * texture references, repeat, offset or colour-space configuration. The ready
 * promise lets an otherwise idle viewer request one render after decoding.
 */
export function createStreetSurface(kind: StreetSurfaceKind,
  loadPixels: (kind: StreetSurfaceKind) => Promise<SurfacePixels | undefined> = loadPhotographicSurface): StreetSurface {
  let pixels = photographicPixels.get(kind) ?? surfaceCache.get(kind);
  if (!pixels) {
    pixels = generateSurface(kind);
    surfaceCache.set(kind, pixels);
  }
  function texture(data: Uint8Array, name: string, colorSpace: THREE.ColorSpace): THREE.DataTexture {
    const item = new THREE.DataTexture(data, pixels!.size, pixels!.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    item.name = `Original street ${kind} ${name}`;
    item.wrapS = item.wrapT = THREE.RepeatWrapping;
    item.magFilter = THREE.LinearFilter;
    item.minFilter = THREE.LinearMipmapLinearFilter;
    item.generateMipmaps = true;
    item.anisotropy = 4;
    item.colorSpace = colorSpace;
    item.needsUpdate = true;
    return item;
  }
  const map = texture(pixels.color, "albedo", THREE.SRGBColorSpace);
  const normalMap = texture(pixels.normal, "normal", THREE.NoColorSpace);
  const roughnessMap = texture(pixels.roughness, "roughness", THREE.NoColorSpace);
  let disposed = false;
  const ready = loadPixels(kind).catch(() => undefined).then((photo) => {
    if (!photo || disposed) return false;
    // Keep the material's existing textures and all caller-owned transforms.
    // A disposed scene cannot be resurrected by a late image decode.
    for (const [item, data, channel] of [
      [map, photo.color, "albedo"], [normalMap, photo.normal, "normal"],
      [roughnessMap, photo.roughness, "roughness"]
    ] as const) {
      // Immutable WebGL texture storage must be released before a size change.
      // The same Texture object remains bound to every material afterwards.
      if (item.image.width !== photo.size || item.image.height !== photo.size) item.dispose();
      item.image = { data, width: photo.size, height: photo.size };
      item.flipY = true;
      item.name = `CC0 Poly Haven ${kind} ${channel}`;
      item.userData.photographicSurface = true;
      item.needsUpdate = true;
    }
    return true;
  });
  return {
    map, normalMap, roughnessMap, tileSize: physicalTileSize[kind], ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    }
  };
}
