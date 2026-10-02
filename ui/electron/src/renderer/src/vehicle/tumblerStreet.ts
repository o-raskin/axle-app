import * as THREE from "three";
import { createStreetSurface, type StreetSurface, type StreetSurfaceKind } from "./streetTextures";

export interface TumblerStreet {
  /** Resolves once the optional packaged photo surfaces have loaded or fallen back. */
  ready: Promise<boolean>;
  /** Coverage of camera-side architecture, also used by its shadow casters. */
  readonly clearance: THREE.Vector2;
  setEnabled(enabled: boolean): void;
  /** Absolute signed distance travelled by the displayed rear wheels, in scene units. */
  update(travel: number, cameraPosition?: THREE.Vector3): void;
  dispose(): void;
}

const REPEAT_DISTANCE = 48;
const SHOP_LABELS = ["CORNER MARKET", "CENTRAL GARAGE", "NIGHT COFFEE", "STORAGE", "NORTHSIDE AUTO", "RIVER WAREHOUSE"];
// Large silhouettes share the existing key map. Window panes, signs, rivets and
// distant skyline add no shadow draws; tiny details use contact occlusion.
const SHADOW_CASTERS = new Set([
  "Street looping warehouses", "Street upper floor setbacks", "Street roof parapets",
  "Street projecting canvas awnings", "Street lamp posts", "Street lamp arms",
  "Street elevated columns", "Street elevated braces", "Street elevated rails",
  "Street elevated truss members", "Street hydrants bins and utility cabinets",
  "Street cast iron bollards and hydrants"
]);

/** Original, generic shop signs; system typography is rasterized locally. */
function storefrontSignAtlas(): THREE.Texture {
  const size = 512;
  const rowHeight = size / 8;
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    context = canvas.getContext("2d");
  }
  let texture: THREE.Texture;
  if (canvas && context) {
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#ffffff";
    SHOP_LABELS.forEach((label, row) => {
      let fontSize = 46;
      context!.font = `600 ${fontSize}px Arial, sans-serif`;
      while (context!.measureText(label).width > size - 42 && fontSize > 24) {
        fontSize -= 1;
        context!.font = `600 ${fontSize}px Arial, sans-serif`;
      }
      context!.fillText(label, size / 2, rowHeight * (row + 0.5));
    });
    // Restrained, deterministic paint chips preserve the clean letterforms.
    context.globalCompositeOperation = "destination-out";
    for (let chip = 0; chip < 900; chip += 1) {
      context.globalAlpha = 0.2 + (chip % 4) * 0.08;
      context.fillRect((chip * 137.31) % size, (chip * 47.73) % (rowHeight * SHOP_LABELS.length),
        0.6 + (chip % 3) * 0.35, 0.6);
    }
    texture = new THREE.CanvasTexture(canvas);
  } else {
    // A tiny original bitmap alphabet gives non-DOM renderers a readable atlas
    // and lets the same resource/UV contracts be tested without system fonts.
    const glyphs: Record<string, string[]> = {
      A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
      C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
      D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
      E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
      F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
      G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
      H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
      I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
      K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
      L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
      M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
      N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
      O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
      R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
      S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
      T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
      U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
      V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
      W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"]
    };
    const pixels = new Uint8Array(size * size * 4);
    SHOP_LABELS.forEach((label, row) => {
      const pixelScale = Math.min(6, Math.floor((size - 42) / (label.length * 6)));
      const left = Math.floor((size - (label.length * 6 - 1) * pixelScale) / 2);
      const top = row * rowHeight + Math.floor((rowHeight - 7 * pixelScale) / 2);
      for (let character = 0; character < label.length; character += 1) {
        glyphs[label[character]]?.forEach((line, y) => {
          for (let x = 0; x < line.length; x += 1) {
            if (line[x] !== "1") continue;
            for (let py = 0; py < pixelScale; py += 1) {
              for (let px = 0; px < pixelScale; px += 1) {
                const index = ((top + y * pixelScale + py) * size + left + (character * 6 + x) * pixelScale + px) * 4;
                pixels.fill(255, index, index + 4);
              }
            }
          }
        });
      }
    });
    texture = new THREE.DataTexture(pixels, size, size);
    texture.flipY = true;
  }
  texture.name = "Original generic storefront typography atlas";
  texture.userData.labels = [...SHOP_LABELS];
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

interface StreetInstance {
  x: number;
  y: number;
  z: number;
  scale: [number, number, number];
  /** Wrap attached details together with their building or streetlamp row. */
  anchorZ?: number;
  rotation?: THREE.Quaternion;
  color?: THREE.Color;
  signRow?: number;
}

/**
 * An original, entirely procedural night avenue. The car stays at the origin;
 * road markings and architecture pass it using wheel travel, never a timer.
 * Windows and streetlamp pools are baked surfaces rather than extra lights.
 */
export function createTumblerStreet(scene: THREE.Scene): TumblerStreet {
  const root = new THREE.Group();
  root.name = "Tumbler street scene";
  root.visible = false;
  scene.add(root);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const surfaces = new Map<StreetSurfaceKind, StreetSurface>();
  const meshes = new Set<THREE.InstancedMesh>();
  const depthMaterials = new Map<THREE.Material, THREE.MeshDepthMaterial>();
  const moving: Array<{ mesh: THREE.InstancedMesh; matrices: THREE.Matrix4[]; anchors: number[]; offsets: number[] }> = [];
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  // Left/right coverage is shared by all attached tall scenery. Dithering keeps
  // opaque depth handling and adds neither sorting nor another draw pass.
  const sideOpacity = { value: new THREE.Vector2(1, 1) };
  let phase = Number.NaN;
  let disposed = false;

  const box = new THREE.BoxGeometry(1, 1, 1);
  const plane = new THREE.PlaneGeometry(1, 1);
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const rivet = new THREE.OctahedronGeometry(0.5, 0);
  const disc = new THREE.CircleGeometry(0.5, 16);
  geometries.add(box);
  geometries.add(plane);
  geometries.add(cylinder);
  geometries.add(rivet);
  geometries.add(disc);

  function standard(name: string, color: string, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ name, color, roughness, metalness });
    materials.add(material);
    return material;
  }

  function basic(name: string, color: string, opacity = 1): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({ name, color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 });
    materials.add(material);
    return material;
  }

  function surface(material: THREE.MeshStandardMaterial, kind: StreetSurfaceKind,
    repeatX: number, repeatY: number, normalStrength: number): void {
    let maps = surfaces.get(kind);
    if (!maps) {
      maps = createStreetSurface(kind);
      surfaces.set(kind, maps);
      for (const texture of [maps.map, maps.normalMap, maps.roughnessMap]) texture.repeat.set(repeatX, repeatY);
    }
    material.map = maps.map;
    material.normalMap = maps.normalMap;
    material.roughnessMap = maps.roughnessMap;
    material.normalScale.setScalar(normalStrength);
    if (material.userData.streetSurfaceSize) material.userData.streetSurfaceSize = maps.tileSize;
  }

  function cameraClearance(material: THREE.Material): void {
    material.userData.streetSideOpacity = sideOpacity.value;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.streetSideOpacity = sideOpacity;
      shader.vertexShader = `varying float vStreetSide;\n${shader.vertexShader}`.replace(
        "#include <begin_vertex>", "#include <begin_vertex>\nvStreetSide = sign(instanceMatrix[3].x);"
      );
      // Texture density follows the size of the authored instance, rather than
      // stretching one brick tile over an entire six-storey building. Instance
      // translation is excluded so masonry remains attached while it scrolls.
      if (material.userData.streetSurfaceSize) {
        const tileSize = Number(material.userData.streetSurfaceSize).toFixed(3);
        shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>
          vec3 streetInstanceSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vec3 streetSurfacePosition = position * streetInstanceSize;
          vec2 streetPhysicalUv = abs(normal.x) > 0.5 ? vec2(streetSurfacePosition.z, streetSurfacePosition.y)
            : abs(normal.y) > 0.5 ? vec2(streetSurfacePosition.x, streetSurfacePosition.z)
            : vec2(streetSurfacePosition.x, streetSurfacePosition.y);
          streetPhysicalUv /= ${tileSize};
          #ifdef USE_MAP
            vMapUv = (mapTransform * vec3(streetPhysicalUv, 1.0)).xy;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv = (normalMapTransform * vec3(streetPhysicalUv, 1.0)).xy;
          #endif
          #ifdef USE_ROUGHNESSMAP
            vRoughnessMapUv = (roughnessMapTransform * vec3(streetPhysicalUv, 1.0)).xy;
          #endif`);
      }
      if (material.userData.streetInteriors) {
        shader.vertexShader = `attribute float streetRoomSeed;\nvarying vec2 vStreetRoomUv;\nvarying float vStreetRoomSeed;\nvarying vec3 vStreetRoomView;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>", `#include <begin_vertex>
          vStreetRoomUv = uv;
          vStreetRoomSeed = streetRoomSeed;
          vec3 roomView = cameraPosition - (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
          vStreetRoomView = vec3(dot(roomView, normalize(instanceMatrix[0].xyz)),
            dot(roomView, normalize(instanceMatrix[1].xyz)), dot(roomView, normalize(instanceMatrix[2].xyz)));`
        );
        shader.fragmentShader = `varying vec2 vStreetRoomUv;\nvarying float vStreetRoomSeed;\nvarying vec3 vStreetRoomView;\n${shader.fragmentShader}`.replace(
          "#include <color_fragment>", `#include <color_fragment>
          // Room detail shifts behind the frame as the viewing angle changes.
          vec2 roomUv = clamp(vStreetRoomUv + vStreetRoomView.xy / max(abs(vStreetRoomView.z), 0.3) * 0.1, 0.0, 1.0);
          float wall = smoothstep(0.12, 0.25, roomUv.x) * smoothstep(0.12, 0.25, 1.0 - roomUv.x);
          float ceiling = smoothstep(0.02, 0.22, 1.0 - roomUv.y);
          float roomDepth = mix(0.18, 1.0, wall) * ceiling;
          float blind = step(0.5, vStreetRoomSeed) * (0.6 + 0.4 * smoothstep(0.08, 0.12, fract(roomUv.y * 18.0)));
          float curtain = 0.75 + 0.25 * sin(roomUv.x * 90.0 + vStreetRoomSeed * 6.28);
          float desk = step(roomUv.y, 0.25) * step(0.24, roomUv.x) * step(roomUv.x, 0.78);
          float officeBeam = step(0.82, roomUv.y) * step(roomUv.y, 0.9) * step(0.28, roomUv.x) * step(roomUv.x, 0.73);
          diffuseColor.rgb *= roomDepth * mix(1.0, blind, step(0.5, vStreetRoomSeed)) * mix(1.0, curtain, step(0.7, vStreetRoomSeed));
          diffuseColor.rgb *= 1.0 - desk * 0.7;
          diffuseColor.rgb += diffuseColor.rgb * officeBeam * 0.7;`
        );
      }
      if (material.userData.streetSignAtlas) {
        shader.vertexShader = `attribute float streetSignRow;\n${shader.vertexShader}`.replace(
          "#include <uv_vertex>", `#include <uv_vertex>
          #ifdef USE_MAP
            vMapUv = vec2(uv.x, (uv.y + 7.0 - streetSignRow) / 8.0);
          #endif`
        );
      }
      shader.fragmentShader = `uniform vec2 streetSideOpacity;\nvarying float vStreetSide;\n${shader.fragmentShader}`.replace(
        "#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        float streetCoverage = vStreetSide < 0.0 ? streetSideOpacity.x : streetSideOpacity.y;
        float streetDither = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        if (streetCoverage <= 0.0 || streetDither >= streetCoverage) discard;`
      );
    };
    material.customProgramCacheKey = () => `tumbler-street-camera-clearance-v3-${material.userData.streetSurfaceSize ?? 0}-${Boolean(material.userData.streetInteriors)}-${Boolean(material.userData.streetSignAtlas)}`;
  }

  function instances(name: string, geometry: THREE.BufferGeometry, material: THREE.Material,
    items: StreetInstance[], scroll = true): THREE.InstancedMesh {
    if (material.userData.streetInteriors) {
      geometry = geometry.clone();
      geometries.add(geometry);
      geometry.setAttribute("streetRoomSeed", new THREE.InstancedBufferAttribute(new Float32Array(items.map((item) => {
        const seed = Math.sin(item.x * 17.31 + item.y * 8.47 + item.z * 12.37) * 517.3;
        return seed - Math.floor(seed);
      })), 1));
    }
    if (material.userData.streetSignAtlas) {
      geometry = geometry.clone();
      geometries.add(geometry);
      geometry.setAttribute("streetSignRow", new THREE.InstancedBufferAttribute(new Float32Array(
        items.map((item) => item.signRow ?? 0)), 1));
    }
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    meshes.add(mesh);
    mesh.name = name;
    if (material.userData.streetSideOpacity) mesh.userData.streetSideOpacity = sideOpacity.value;
    mesh.receiveShadow = true;
    mesh.castShadow = SHADOW_CASTERS.has(name);
    if (mesh.castShadow) {
      let depth = depthMaterials.get(material);
      if (!depth) {
        depth = new THREE.MeshDepthMaterial({ name: `${material.name}: matching clearance depth` });
        // A faded wall must disappear from BOTH the beauty depth and the key
        // shadow map, otherwise invisible architecture casts ghost shadows.
        cameraClearance(depth);
        materials.add(depth);
        depthMaterials.set(material, depth);
      }
      mesh.customDepthMaterial = depth;
    }
    // An aggregate box would need recomputing when the instances wrap. This tiny
    // scene is cheaper to draw as a whole than recalculate per-frame bounds.
    mesh.frustumCulled = false;
    const matrices = items.map((item, index) => {
      const matrix = new THREE.Matrix4().compose(
        position.set(item.x, item.y, item.z), item.rotation ?? orientation,
        scale.set(...item.scale));
      mesh.setMatrixAt(index, matrix);
      if (item.color) mesh.setColorAt(index, item.color);
      return matrix;
    });
    if (scroll) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      moving.push({ mesh, matrices, anchors: items.map((item) => item.anchorZ ?? item.z),
        offsets: items.map((item) => item.z - (item.anchorZ ?? item.z)) });
    }
    root.add(mesh);
    return mesh;
  }

  const sidewalk = standard("Street concrete", "#8e9daa", 0.92);
  const brick = standard("Street brick warehouses", "#ffffff", 0.93);
  const steel = standard("Street elevated steel", "#738190", 0.9, 0.68);
  const markings = standard("Street worn road markings", "#d5d1c0", 0.91);
  const windows = basic("Street lit warehouse windows", "#ffffff");
  windows.color.multiplyScalar(2.1);
  windows.userData.streetInteriors = true;
  const lanterns = basic("Street warm lanterns", "#e8b775");
  lanterns.color.multiplyScalar(3);
  const shutters = standard("Street warehouse shutters", "#8d99a8", 0.95, 0.42);
  const stone = standard("Street warehouse stone trim", "#a7b4c2", 0.93);
  const props = standard("Street urban fixtures", "#ffffff", 0.64, 0.28);
  const recess = standard("Street dark window recesses", "#111924", 0.86);
  const glass = new THREE.MeshPhysicalMaterial({ name: "Street reflecting storefront glazing", color: "#627785",
    metalness: 0, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.35,
    transparent: true, opacity: 0.42, depthWrite: false });
  materials.add(glass);
  const awnings = standard("Street weathered canvas awnings", "#34434b", 0.96);
  const signage = basic("Street shop lettering and warm signs", "#d0b99a");
  signage.color.multiplyScalar(1.1);
  signage.map = storefrontSignAtlas();
  signage.alphaTest = 0.25;
  signage.userData.streetSignAtlas = true;
  textures.add(signage.map);
  const shopRooms = basic("Street deep shop interiors", "#d8ad79");
  shopRooms.color.multiplyScalar(1.5);
  shopRooms.userData.streetInteriors = true;
  for (const [material, size] of [[brick, 1.8], [stone, 2.8], [sidewalk, 2.8], [steel, 2], [shutters, 2], [props, 2]] as const) {
    material.userData.streetSurfaceSize = size;
  }
  for (const material of [brick, steel, windows, lanterns, shutters, stone, sidewalk, props, recess]) cameraClearance(material);
  for (const material of [glass, awnings, signage, shopRooms]) cameraClearance(material);

  surface(brick, "brick", 1, 1, 0.55);
  surface(sidewalk, "concrete", 1, 1, 0.36);
  surface(stone, "concrete", 1, 1, 0.32);
  for (const material of [steel, shutters, props]) surface(material, "metal", 1, 1, 0.25);
  surface(markings, "marking", 1, 1, 0.12);

  // The cinematic preview already supplies a high-resolution pavement. Keep a
  // self-contained fallback for standalone previews without another hidden road.
  if (!scene.getObjectByName("Cinematic asphalt ground")) {
    const asphalt = standard("Street damp asphalt", "#a4b2c4", 0.93, 0.16);
    surface(asphalt, "asphalt", 8, 24, 0.38);
    instances("Street asphalt", plane, asphalt, [{ x: 0, y: -0.055, z: 0, scale: [11.6, 72, 1], rotation: flat }], false);
  }
  instances("Street sidewalks", box, sidewalk, [-1, 1].map((side) => ({
    x: side * 6.55, y: -0.02, z: 0, scale: [1.5, 0.24, 72]
  })), false);
  instances("Street curbs", box, sidewalk, [-1, 1].map((side) => ({
    x: side * 5.81, y: 0.025, z: 0, scale: [0.12, 0.33, 72]
  })), false);

  const dashes: StreetInstance[] = [];
  for (const x of [-3.5, 3.5]) {
    for (let z = -24; z < 24; z += 4) dashes.push({ x, y: -0.015, z, scale: [0.1, 1.7, 1], rotation: flat });
  }
  instances("Street passing road markings", plane, markings, dashes);

  const buildings: StreetInstance[] = [];
  const litWindows: StreetInstance[] = [];
  const doors: StreetInstance[] = [];
  const windowRecesses: StreetInstance[] = [];
  const frames: StreetInstance[] = [];
  const sills: StreetInstance[] = [];
  const pilasters: StreetInstance[] = [];
  const cornices: StreetInstance[] = [];
  const roofTrim: StreetInstance[] = [];
  const rooftopUnits: StreetInstance[] = [];
  const ventSlats: StreetInstance[] = [];
  const pipes: StreetInstance[] = [];
  const firePlatforms: StreetInstance[] = [];
  const fireRails: StreetInstance[] = [];
  const ladderRungs: StreetInstance[] = [];
  const roofTanks: StreetInstance[] = [];
  const setbacks: StreetInstance[] = [];
  const masonryInfill: StreetInstance[] = [];
  const shopGlass: StreetInstance[] = [];
  const shopInteriors: StreetInstance[] = [];
  const shopFrames: StreetInstance[] = [];
  const shopCanopies: StreetInstance[] = [];
  const shopSignPanels: StreetInstance[] = [];
  const shopSignText: StreetInstance[] = [];
  const entryFrames: StreetInstance[] = [];
  const stairSteps: StreetInstance[] = [];
  const roofCaps: StreetInstance[] = [];
  const aerials: StreetInstance[] = [];
  const skyline: StreetInstance[] = [];
  const skylineWindows: StreetInstance[] = [];
  const shades = ["#c0aea0", "#b9b9b4", "#b09f92", "#c7c0af", "#aeb3b7", "#c9b7aa"];
  for (const side of [-1, 1]) {
    const facadeRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * -Math.PI / 2);
    for (let block = 0; block < 6; block += 1) {
      const z = -20 + block * 8;
      const style = (block + (side > 0 ? 2 : 0)) % 6;
      const height = [5.1, 7.85, 6.45, 9.2, 4.85, 7.1][style];
      const width = [7.1, 6.6, 7.4, 6.9, 7.3, 7][style];
      const depth = [4.6, 5.2, 4.6, 5.7, 4.8, 5.3][style];
      const wallColor = new THREE.Color(shades[style]);
      buildings.push({ x: side * (7.4 + depth / 2), y: height / 2 - 0.1, z,
        scale: [depth, height, width], color: wallColor });
      // Raised rear storeys and stepped caps break the repeated box skyline.
      if (style === 1 || style === 3 || style === 5) {
        setbacks.push({ x: side * (9.4 + depth / 2), y: height + 1.35, z: z + 0.32, anchorZ: z,
          scale: [depth - 1.6, 2.9, width - 1.35], color: wallColor });
        roofCaps.push({ x: side * (9.4 + depth / 2), y: height + 2.84, z: z + 0.32, anchorZ: z,
          scale: [depth - 1.42, 0.16, width - 1.17] });
      }
      if (style === 2 || style === 4) {
        masonryInfill.push({ x: side * 7.29, y: height - 0.55, z: z + 0.3, anchorZ: z,
          scale: [0.18, 0.55, width - 0.55], color: new THREE.Color("#939793") });
      }
      doors.push({ x: side * 7.387, y: 1.0, z: z + 1.85, anchorZ: z, scale: [1.45, 1.78, 1], rotation: facadeRotation });
      entryFrames.push({ x: side * 7.16, y: 2.04, z: z + 1.85, anchorZ: z, scale: [0.46, 0.19, 1.75] });
      for (const dz of [1.02, 2.68]) entryFrames.push({ x: side * 7.19, y: 1.04, z: z + dz,
        anchorZ: z, scale: [0.35, 1.94, 0.16] });
      for (let step = 0; step < 2; step += 1) stairSteps.push({ x: side * (7.08 - step * 0.16),
        y: 0.105 + step * 0.06, z: z + 1.85, anchorZ: z, scale: [0.48, 0.12 + step * 0.12, 1.65] });

      // Independent shop bays occupy the ground floor. Glossy glazing, opaque
      // room silhouettes, projecting transoms and canopy shade read as depth
      // without requiring per-window lights or expensive transmission passes.
      for (const shopZ of [-2.32, -0.43]) {
        shopGlass.push({ x: side * 7.32, y: 1.04, z: z + shopZ, anchorZ: z,
          scale: [1.6, 1.47, 1], rotation: facadeRotation });
        if ((style + Math.round(shopZ)) % 3 !== 0) {
          shopInteriors.push({ x: side * 7.35, y: 1.03, z: z + shopZ, anchorZ: z,
            scale: [1.31, 1.16, 1], rotation: facadeRotation,
            color: new THREE.Color(style % 2 === 0 ? "#b29f83" : "#8ba4b1") });
        }
        for (const dz of [-0.81, 0, 0.81]) shopFrames.push({ x: side * 7.265, y: 1.04,
          z: z + shopZ + dz, anchorZ: z, scale: [0.12, 1.53, 0.045] });
        for (const y of [0.29, 1.29, 1.8]) shopFrames.push({ x: side * 7.265, y,
          z: z + shopZ, anchorZ: z, scale: [0.12, 0.055, 1.67] });
      }
      shopSignPanels.push({ x: side * 7.21, y: 2.18, z: z - 1.38, anchorZ: z,
        scale: [0.22, 0.44, 3.7], color: new THREE.Color(style % 2 === 0 ? "#293e43" : "#443a35") });
      shopSignText.push({ x: side * 7.087, y: 2.18, z: z - 1.38, anchorZ: z,
        scale: [3.42, 0.39, 1], rotation: facadeRotation, signRow: style,
        color: new THREE.Color(style % 2 === 0 ? "#e6d9bc" : "#d3dce0") });
      if (style % 3 !== 1) {
        shopCanopies.push({ x: side * 6.85, y: 1.98, z: z - 1.38, anchorZ: z,
          scale: [0.9, 0.13, 3.75],
          rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), side * 0.13) });
        shopCanopies.push({ x: side * 6.41, y: 1.87, z: z - 1.38, anchorZ: z,
          scale: [0.065, 0.18, 3.75] });
      }
      for (const dz of [-(width / 2 - 0.15), 0, width / 2 - 0.15]) {
        pilasters.push({ x: side * 7.31, y: height / 2, z: z + dz, anchorZ: z, scale: [0.2, height, 0.23] });
      }
      for (const y of [0.28, 2.51, height - 0.12, height + 0.12]) {
        cornices.push({ x: side * 7.27, y, z, anchorZ: z, scale: [0.36, 0.16, width + 0.24] });
      }
      roofTrim.push({ x: side * (7.4 + depth / 2), y: height + 0.27, z: z - width / 2, anchorZ: z,
        scale: [depth + 0.12, 0.33, 0.12] },
        { x: side * (7.4 + depth / 2), y: height + 0.27, z: z + width / 2, anchorZ: z,
          scale: [depth + 0.12, 0.33, 0.12] },
        { x: side * (7.4 + depth), y: height + 0.27, z, anchorZ: z, scale: [0.12, 0.33, width] });
      for (const dz of [-1.6, 1.35]) {
        rooftopUnits.push({ x: side * 9.0, y: height + 0.36, z: z + dz, anchorZ: z,
          scale: [1.08, 0.62, 1.25], color: new THREE.Color("#606b75") });
        for (let slat = 0; slat < 5; slat += 1) {
          ventSlats.push({ x: side * 8.435, y: height + 0.13 + slat * 0.11, z: z + dz, anchorZ: z,
            scale: [0.035, 0.035, 1.08] });
        }
      }
      pipes.push({ x: side * 7.18, y: height / 2, z: z - 3.0, anchorZ: z, scale: [0.09, height, 0.09] },
        { x: side * 10.3, y: height + 0.72, z: z - 0.3, anchorZ: z, scale: [0.24, 1.35, 0.24] });
      if (block % 3 === 0) roofTanks.push({ x: side * 10.35, y: height + 0.57, z: z + 1.5,
        anchorZ: z, scale: [0.9, 1.02, 0.9] });
      if (style % 2 === 1) {
        aerials.push({ x: side * 9.05, y: height + 1.43, z: z - 1.05, anchorZ: z, scale: [0.035, 2.3, 0.035] },
          { x: side * 9.05, y: height + 2.16, z: z - 1.05, anchorZ: z, scale: [0.035, 0.035, 0.95] });
      }
      if (block % 2 === 0) {
        for (let y = 2.65; y < height - 0.5; y += 1.48) {
          firePlatforms.push({ x: side * 6.94, y, z: z - 0.85, anchorZ: z, scale: [0.85, 0.08, 1.8] });
          fireRails.push({ x: side * 6.54, y: y + 0.67, z: z - 0.85, anchorZ: z, scale: [0.055, 0.06, 1.88] });
          for (const dz of [-1.7, -1.15, -0.55, 0]) {
            fireRails.push({ x: side * 6.54, y: y + 0.35, z: z + dz, anchorZ: z, scale: [0.055, 0.7, 0.055] });
          }
          fireRails.push({ x: side * 6.84, y: y + 0.67, z: z - 1.74, anchorZ: z, scale: [0.65, 0.06, 0.055] },
            { x: side * 6.84, y: y + 0.67, z: z + 0.04, anchorZ: z, scale: [0.65, 0.06, 0.055] });
          for (const dz of [-1.6, -1.02]) {
            fireRails.push({ x: side * 6.57, y: y - 0.73, z: z + dz, anchorZ: z, scale: [0.06, 1.42, 0.06] });
          }
          for (let rung = 0; rung < 6; rung += 1) {
            ladderRungs.push({ x: side * 6.57, y: y - 1.35 + rung * 0.23, z: z - 1.31,
              anchorZ: z, scale: [0.075, 0.048, 0.65] });
          }
        }
      }
      for (let row = 0; row < 6; row += 1) {
        const y = 3.15 + row * 1.48;
        if (y > height - 0.65) continue;
        const columnCount = style % 3 === 0 ? 4 : 5;
        const columnSpacing = (width - 1.2) / columnCount;
        for (let column = 0; column < columnCount; column += 1) {
          const color = new THREE.Color((block * 7 + row * 3 + column) % 9 === 0
            ? "#e0c096" : (block + row + column) % 3 === 0 ? "#536a80" : "#8d7b59");
          const windowZ = z - (columnCount - 1) * columnSpacing / 2 + column * columnSpacing;
          windowRecesses.push({ x: side * 7.365, y, z: windowZ, anchorZ: z,
            scale: [0.81, 1.1, 1], rotation: facadeRotation });
          // Dark apertures and real frames remain even in unlit rooms.
          if ((block * 11 + row * 7 + column * 3 + side) % 5 !== 0) {
            litWindows.push({ x: side * 7.342, y, z: windowZ, anchorZ: z,
              scale: [0.67, 0.91, 1], rotation: facadeRotation, color });
          }
          for (const dz of [-0.38, 0.38]) frames.push({ x: side * 7.315, y, z: windowZ + dz,
            anchorZ: z, scale: [0.07, 1.08, 0.048] });
          for (const dy of [-0.52, 0, 0.52]) frames.push({ x: side * 7.315, y: y + dy, z: windowZ,
            anchorZ: z, scale: [0.07, 0.04, 0.81] });
          sills.push({ x: side * 7.28, y: y - 0.58, z: windowZ, anchorZ: z, scale: [0.28, 0.09, 0.93] });
        }
      }
    }
  }
  instances("Street looping warehouses", box, brick, buildings);
  instances("Street recessed window apertures", plane, recess, windowRecesses);
  instances("Street warehouse windows", plane, windows, litWindows);
  instances("Street warehouse window frames", box, steel, frames);
  instances("Street stone window sills", box, stone, sills);
  instances("Street loading doors", plane, shutters, doors);
  instances("Street facade pilasters", box, brick, pilasters);
  instances("Street cornices and floor bands", box, stone, cornices);
  instances("Street roof parapets", box, stone, roofTrim);
  instances("Street rooftop ventilation units", box, props, rooftopUnits);
  instances("Street ventilation slats", box, steel, ventSlats);
  instances("Street drains and exhaust pipes", cylinder, steel, pipes);
  instances("Street rooftop tanks", cylinder, shutters, roofTanks);
  instances("Street upper floor setbacks", box, brick, setbacks);
  instances("Street masonry facade infill", box, stone, masonryInfill);
  instances("Street raised roof coping", box, stone, roofCaps);
  instances("Street rooftop aerials", box, steel, aerials);
  instances("Street commercial glazing", plane, glass, shopGlass);
  instances("Street shop interior silhouettes", plane, shopRooms, shopInteriors);
  instances("Street storefront mullions and transoms", box, steel, shopFrames);
  instances("Street projecting canvas awnings", box, awnings, shopCanopies);
  instances("Street shop sign fascia", box, props, shopSignPanels);
  instances("Street original storefront signage", plane, signage, shopSignText);
  instances("Street entrance porticoes", box, stone, entryFrames);
  instances("Street entrance threshold steps", box, stone, stairSteps);
  for (const side of [-1, 1]) {
    const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * -Math.PI / 2);
    for (let tower = 0; tower < 3; tower += 1) {
      const z = -16 + tower * 16;
      const height = [13, 17, 14.5][(tower + (side > 0 ? 1 : 0)) % 3];
      skyline.push({ x: side * 16.2, y: height / 2, z, scale: [6.1, height, 10.5],
        color: new THREE.Color("#818e98") },
      { x: side * 17, y: height + 1.1, z: z + 0.65, anchorZ: z,
        scale: [3.8, 2.3, 7.8], color: new THREE.Color("#73818d") });
      for (let row = 0; row < 8; row += 1) {
        const y = 4.0 + row * 1.48;
        if (y > height - 0.65) continue;
        for (let column = 0; column < 6; column += 1) {
          if ((row * 7 + column * 3 + tower) % 5 === 0) continue;
          skylineWindows.push({ x: side * 13.142, y, z: z - 4.1 + column * 1.64, anchorZ: z,
            scale: [0.62, 0.83, 1], rotation: facing,
            color: new THREE.Color((row + column + tower) % 8 === 0 ? "#867457" : "#334958") });
        }
      }
    }
  }
  instances("Street distant stepped skyline", box, stone, skyline);
  instances("Street distant office interiors", plane, windows, skylineWindows);
  instances("Street fire escape platforms", box, steel, firePlatforms);
  instances("Street fire escape balustrades", box, steel, fireRails);
  instances("Street fire escape ladder rungs", box, steel, ladderRungs);

  const poles: StreetInstance[] = [];
  const arms: StreetInstance[] = [];
  const lamps: StreetInstance[] = [];
  const pools: StreetInstance[] = [];
  const columns: StreetInstance[] = [];
  const braces: StreetInstance[] = [];
  for (const side of [-1, 1]) {
    for (let z = -18; z < 24; z += 12) {
      poles.push({ x: side * 6.1, y: 2.2, z, scale: [0.09, 4.4, 0.09] });
      arms.push({ x: side * 5.76, y: 4.36, z, scale: [0.76, 0.08, 0.08] });
      lamps.push({ x: side * 5.42, y: 4.28, z, scale: [0.23, 0.08, 0.42] });
      pools.push({ x: side * 4.65, y: -0.014, z, scale: [3.2, 5.6, 1], rotation: flat });
      columns.push({ x: side * 6.95, y: 3.0, z: z + 3.5, anchorZ: z, scale: [0.18, 6, 0.2] });
      braces.push({ x: side * 6.95, y: 5.2, z: z + 1.9, anchorZ: z, scale: [0.14, 0.14, 3.8],
        rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.37) });
    }
  }
  instances("Street lamp posts", box, steel, poles);
  instances("Street lamp arms", box, steel, arms);
  instances("Street lantern glow", box, lanterns, lamps);
  instances("Street elevated columns", box, steel, columns);
  instances("Street elevated braces", box, steel, braces);
  instances("Street elevated rails", box, steel, [-1, 1].map((side) => ({
    x: side * 6.95, y: 5.88, z: 0, scale: [0.22, 0.28, 72]
  })), false);

  const fixtures: StreetInstance[] = [];
  const fixtureCaps: StreetInstance[] = [];
  const hardware: StreetInstance[] = [];
  const trusses: StreetInstance[] = [];
  const bolts: StreetInstance[] = [];
  const streetSigns: StreetInstance[] = [];
  const signPaint: StreetInstance[] = [];
  const grates: StreetInstance[] = [];
  const manholes: StreetInstance[] = [];
  const parking: StreetInstance[] = [];
  const warm = new THREE.Color("#b48752");
  const rustRed = new THREE.Color("#8f4936");
  for (const side of [-1, 1]) {
    for (let row = 0; row < 4; row += 1) {
      const z = -18 + row * 12;
      // Cast-iron hydrants, protective bollards, recycling bins and utility
      // cabinets make a working industrial avenue rather than an empty set.
      hardware.push({ x: side * 6.1, y: 0.46, z: z + 2, anchorZ: z,
        scale: [0.22, 0.65, 0.22], color: rustRed });
      fixtureCaps.push({ x: side * 6.1, y: 0.8, z: z + 2, anchorZ: z,
        scale: [0.3, 0.1, 0.3], color: rustRed });
      fixtures.push({ x: side * 6.1, y: 0.56, z: z + 2, anchorZ: z,
        scale: [0.38, 0.12, 0.14], color: rustRed });
      for (const dz of [3.15, 4.3]) {
        hardware.push({ x: side * 5.97, y: 0.42, z: z + dz, anchorZ: z,
          scale: [0.105, 0.64, 0.105], color: warm });
        fixtureCaps.push({ x: side * 5.97, y: 0.75, z: z + dz, anchorZ: z,
          scale: [0.13, 0.06, 0.13], color: warm });
      }
      fixtures.push({ x: side * 6.6, y: 0.55, z: z - 2.3, anchorZ: z,
        scale: [0.65, 0.85, 0.55], color: new THREE.Color("#405b56") },
      { x: side * 7.08, y: 0.78, z: z + 4.95, anchorZ: z,
        scale: [0.45, 1.3, 0.72], color: new THREE.Color("#758288") });
      fixtures.push({ x: side * 6.6, y: 1, z: z - 2.3, anchorZ: z,
        scale: [0.7, 0.08, 0.59], color: new THREE.Color("#273d3a") });
      for (let slat = 0; slat < 6; slat += 1) {
        fixtures.push({ x: side * 6.834, y: 0.9 + slat * 0.055, z: z + 4.95, anchorZ: z,
          scale: [0.025, 0.022, 0.49], color: new THREE.Color("#263138") });
      }
      const face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * -Math.PI / 2);
      hardware.push({ x: side * 6.45, y: 1.25, z: z - 4, anchorZ: z, scale: [0.055, 2.3, 0.055] });
      streetSigns.push({ x: side * 6.42, y: 2.1, z: z - 4, anchorZ: z,
        scale: [0.38, 0.52, 1], rotation: face, color: new THREE.Color("#d5d6c8") });
      for (const dy of [-0.12, 0.02, 0.13]) {
        signPaint.push({ x: side * 6.408, y: 2.1 + dy, z: z - 4, anchorZ: z,
          scale: [0.26, 0.025, 1], rotation: face, color: new THREE.Color("#8d4c35") });
      }
      // Repeated steel cross bracing and bolt heads catch a narrow rim light.
      for (const dz of [-3.2, -0.8, 1.6, 4]) {
        trusses.push({ x: side * 6.95, y: 5.54, z: z + dz, anchorZ: z,
          scale: [0.11, 0.12, 2.5], rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.28) });
        for (const dy of [5.43, 5.83]) {
          bolts.push({ x: side * 6.81, y: dy, z: z + dz, anchorZ: z, scale: [0.065, 0.065, 0.065] });
        }
      }
      for (let bar = 0; bar < 8; bar += 1) {
        grates.push({ x: side * 5.43, y: -0.007, z: z + 0.2 + bar * 0.07, anchorZ: z,
          scale: [0.42, 0.013, 0.032] });
      }
      manholes.push({ x: side * 2.12, y: -0.01, z: z - 3, anchorZ: z,
        scale: [0.68, 0.68, 1], rotation: flat });
      for (const dz of [-4.8, -0.9, 3]) parking.push({ x: side * 4.8, y: -0.014, z: z + dz,
        anchorZ: z, scale: [1.25, 0.045, 1], rotation: flat });
    }
  }
  instances("Street hydrants bins and utility cabinets", box, props, fixtures);
  instances("Street cast iron bollards and hydrants", cylinder, props, hardware);
  instances("Street fixture caps", cylinder, props, fixtureCaps);
  instances("Street elevated truss members", box, steel, trusses);
  instances("Street steel rivets", rivet, steel, bolts);
  instances("Street parking and loading signs", plane, props, streetSigns);
  instances("Street sign markings", plane, props, signPaint);
  const roadMetal = standard("Street cast iron road covers", "#606b76", 0.78, 0.65);
  surface(roadMetal, "metal", 2, 3, 0.25);
  instances("Street curb drainage slots", box, roadMetal, grates);
  instances("Street manhole covers", disc, roadMetal, manholes);
  instances("Street loading bay paint", plane, markings, parking);

  // Original radial gradient, retained as code instead of fetching a texture.
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radius = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const index = (y * size + x) * 4;
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = Math.round(Math.max(0, 1 - radius) ** 2 * 255);
    }
  }
  const gradient = new THREE.DataTexture(pixels, size, size);
  gradient.magFilter = THREE.LinearFilter;
  gradient.minFilter = THREE.LinearFilter;
  gradient.needsUpdate = true;
  textures.add(gradient);
  const poolMaterial = basic("Street baked amber light pools", "#b17b40", 0.28);
  poolMaterial.map = gradient;
  poolMaterial.polygonOffset = true;
  poolMaterial.polygonOffsetFactor = -1;
  poolMaterial.polygonOffsetUnits = -1;
  instances("Street amber light pools", plane, poolMaterial, pools);

  function update(travel: number, cameraPosition?: THREE.Vector3): void {
    if (disposed || !Number.isFinite(travel)) return;
    if (cameraPosition && Number.isFinite(cameraPosition.x)) {
      sideOpacity.value.set(
        1 - THREE.MathUtils.smoothstep(-cameraPosition.x, 4.6, 6.3),
        1 - THREE.MathUtils.smoothstep(cameraPosition.x, 4.6, 6.3)
      );
    }
    // Reduce the absolute input before subtracting it from each authored position.
    // This works in both directions, with no accumulated per-frame rounding drift.
    const nextPhase = ((travel % REPEAT_DISTANCE) + REPEAT_DISTANCE) % REPEAT_DISTANCE;
    if (nextPhase === phase) return;
    phase = nextPhase;
    for (const { mesh, matrices, anchors, offsets } of moving) {
      for (let index = 0; index < matrices.length; index += 1) {
        const z = anchors[index] - phase;
        matrices[index].elements[14] = ((z + REPEAT_DISTANCE / 2) % REPEAT_DISTANCE + REPEAT_DISTANCE) % REPEAT_DISTANCE - REPEAT_DISTANCE / 2 + offsets[index];
        mesh.setMatrixAt(index, matrices[index]);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  update(0);

  return {
    ready: Promise.all([...surfaces.entries()].filter(([kind]) => kind !== "marking")
      .map(([, maps]) => maps.ready)).then((loaded) => loaded.every(Boolean)),
    get clearance() { return sideOpacity.value; },
    setEnabled(enabled) { if (!disposed) root.visible = enabled; },
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      root.clear();
      meshes.forEach((mesh) => mesh.dispose());
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      surfaces.forEach((maps) => maps.dispose());
    }
  };
}
