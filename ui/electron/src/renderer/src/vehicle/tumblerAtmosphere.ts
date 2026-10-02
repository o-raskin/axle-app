import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { createStreetSurface } from "./streetTextures";
import { createWetRoadReflection } from "./wetRoadReflection";

export type TumblerAtmosphere = {
  readonly ready: Promise<boolean>;
  readonly reflectionCalls: number;
  readonly reflectionTriangles: number;
  /** Cumulative, measured travel; no wall-clock animation while the car is idle. */
  update(travel: number, reducedMotion: boolean, streetEnabled?: boolean): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

// Geometry and light rig are original; packaged CC0 photographic surfaces and
// their provenance live in the Electron environment asset directory.
function texture(size: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) data.set(pixel(x / (size - 1), y / (size - 1)), (y * size + x) * 4);
  }
  const result = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  result.magFilter = THREE.LinearFilter;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.generateMipmaps = true;
  result.needsUpdate = true;
  return result;
}

function grain(x: number, y: number) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const sx = x - ix;
  const sy = y - iy;
  const tx = sx * sx * (3 - 2 * sx);
  const ty = sy * sy * (3 - 2 * sy);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(grain(ix, iy), grain(ix + 1, iy), tx),
    THREE.MathUtils.lerp(grain(ix, iy + 1), grain(ix + 1, iy + 1), tx), ty
  );
}

/** Original HDR light rig for physically based wet-road and ABS reflections. */
export function createNightReflectionMap(): THREE.DataTexture {
  const width = 512;
  const height = 256;
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const azimuth = u * Math.PI * 2;
      const horizon = Math.exp(-(((v - 0.5) / 0.2) ** 2));
      const strip = Math.exp(-(((v - 0.34) / 0.035) ** 2))
        * (Math.max(0, Math.cos(azimuth - 0.8)) ** 18 + Math.max(0, Math.cos(azimuth + 1.5)) ** 24);
      const sodium = Math.exp(-(((v - 0.55) / 0.065) ** 2))
        * Math.max(0, Math.cos(azimuth - 3.8)) ** 36;
      const index = (y * width + x) * 4;
      pixels[index] = 0.035 + horizon * 0.065 + strip * 3.4 + sodium * 3;
      pixels[index + 1] = 0.05 + horizon * 0.09 + strip * 4 + sodium * 1.45;
      pixels[index + 2] = 0.08 + horizon * 0.12 + strip * 4.8 + sodium * 0.45;
      pixels[index + 3] = 1;
    }
  }
  const map = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  map.name = "Original cinematic night HDR reflections";
  map.mapping = THREE.EquirectangularReflectionMapping;
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return map;
}

/** Cold, damp night lighting with a visible floor and restrained low haze. */
export function createTumblerAtmosphere(scene: THREE.Scene, options: { reflections?: boolean; photographicLighting?: boolean } = {}): TumblerAtmosphere {
  const previousBackground = scene.background;
  const previousFog = scene.fog;
  const previousEnvironment = scene.environment;
  const previousEnvironmentIntensity = scene.environmentIntensity;
  const previousEnvironmentRotation = scene.environmentRotation.clone();
  let environment = createNightReflectionMap();
  scene.environment = environment;
  scene.environmentIntensity = 0.8;
  const background = new THREE.Color("#0b111c");
  const fog = new THREE.Fog(background, 13, 38);
  scene.background = background;
  scene.fog = fog;

  const root = new THREE.Group();
  root.name = "Tumbler cinematic atmosphere";
  scene.add(root);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skyGeometry = new THREE.SphereGeometry(60, 32, 16);
  const skyMaterial = new THREE.ShaderMaterial({
    name: "Original polluted night sky", side: THREE.BackSide,
    transparent: true, depthWrite: false, fog: false,
    vertexShader: `varying vec3 skyDirection;
      void main() { skyDirection = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 skyDirection;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 cell = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
          mix(hash(cell + vec2(0.0, 1.0)), hash(cell + 1.0), f.x), f.y);
      }
      void main() {
        vec3 direction = normalize(skyDirection);
        float horizon = exp(-max(direction.y, 0.0) * 5.0);
        vec2 cloudUv = direction.xz / (0.35 + max(direction.y, 0.0));
        float clouds = noise(cloudUv * 1.8) * 0.62 + noise(cloudUv * 5.5) * 0.28 + noise(cloudUv * 13.0) * 0.1;
        vec3 sky = mix(vec3(0.0012, 0.0021, 0.0040), vec3(0.0060, 0.0090, 0.0150), horizon);
        sky += vec3(0.0022, 0.0027, 0.0036) * smoothstep(0.35, 0.8, clouds) * (0.3 + horizon * 0.7);
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  geometries.add(skyGeometry);
  materials.add(skyMaterial);
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.name = "Cinematic Chicago night sky";
  sky.renderOrder = -10;
  root.add(sky);
  const lights: THREE.Light[] = [];
  function light<T extends THREE.Light>(item: T): T {
    lights.push(item);
    root.add(item);
    return item;
  }

  // One key shadow is cached by the viewer; the rim and fill don't add
  // shadow maps. The blue-white rim separates black ABS from the night backdrop.
  light(new THREE.HemisphereLight(0x9aaebf, 0x14181e, 0.75));
  const key = light(new THREE.DirectionalLight(0xe3e7e8, 2.65));
  key.name = "Tumbler cinematic shadow key";
  // Move farther along the same light direction so nearby roofs fit between
  // the shadow camera's near/far planes, while preserving the car lighting.
  key.position.set(-7, 13.35, 10);
  key.target.position.set(0, 0.65, 0);
  root.add(key.target);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -7;
  key.shadow.camera.right = key.shadow.camera.top = 7;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 32;
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.008;
  key.shadow.radius = 1.6;
  const rim = light(new THREE.DirectionalLight(0x7fa3c3, 2.8));
  rim.position.set(4, 3.8, -6);
  const fill = light(new THREE.DirectionalLight(0xa1b4c5, 1.1));
  fill.position.set(-5, 2, -2);
  const sodium = light(new THREE.DirectionalLight(0xe8b87c, 0.35));
  sodium.position.set(-6, 4, -6);
  // Only the two neighbouring lamp rows affect the car. Four unshadowed local
  // lights give actual warm falloff and highlights without a light per window.
  const streetLights = [-1, 1].flatMap((side) => [0, 1].map((row) => {
    const lamp = light(new THREE.PointLight(0xffc38a, 0, 18, 2));
    lamp.name = `Nearby sodium streetlamp ${side}:${row}`;
    lamp.position.set(side * 5.42, 4.28, 0);
    return { lamp, row };
  }));

  const asphalt = createStreetSurface("asphalt");
  for (const map of [asphalt.map, asphalt.normalMap, asphalt.roughnessMap]) map.repeat.set(80 / asphalt.tileSize, 80 / asphalt.tileSize);
  const groundGeometry = new THREE.PlaneGeometry(80, 80);
  geometries.add(groundGeometry);
  const groundMaterial = new THREE.MeshPhysicalMaterial({
    name: "Cinematic damp asphalt", color: "#b4c1ca", map: asphalt.map,
    normalMap: asphalt.normalMap, normalScale: new THREE.Vector2(0.22, 0.22),
    roughnessMap: asphalt.roughnessMap, roughness: 0.9, metalness: 0,
    clearcoat: 0.24, clearcoatRoughness: 0.5, clearcoatRoughnessMap: asphalt.roughnessMap,
    envMapIntensity: 0.65
  });
  materials.add(groundMaterial);
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = "Cinematic asphalt ground";
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.026;
  ground.receiveShadow = true;
  root.add(ground);
  const reflection = options.reflections ? createWetRoadReflection(scene) : null;

  const softMask = texture(256, (x, y) => {
    const radius = Math.hypot((x - 0.5) * 2, (y - 0.5) * 2);
    const alpha = Math.max(0, 1 - radius * radius) ** 2;
    return [255, 255, 255, Math.round(255 * alpha)];
  });
  textures.add(softMask);
  const overlayGeometry = new THREE.PlaneGeometry(1, 1);
  geometries.add(overlayGeometry);
  const contactMaterial = new THREE.MeshBasicMaterial({
    name: "Soft vehicle contact shadow", color: 0x02060d, map: softMask,
    transparent: true, opacity: 0.63, depthWrite: false
  });
  materials.add(contactMaterial);
  const contact = new THREE.Mesh(overlayGeometry, contactMaterial);
  contact.name = "Cinematic vehicle contact shadow";
  contact.rotation.x = -Math.PI / 2;
  contact.scale.set(5, 7.2, 1);
  contact.position.set(0, -0.019, 0);
  root.add(contact);

  const hazeTexture = texture(512, (x, y) => {
    const edge = Math.max(0, 1 - Math.hypot((x - 0.5) * 2, (y - 0.5) * 2));
    // Stretch the noise horizontally so the feathered cloud reads as ground
    // wisps rather than a uniformly lit circular billow.
    const cloud = 0.12 + 0.64 * noise(x * 3, y * 9) + 0.24 * noise(x * 12, y * 23);
    return [255, 255, 255, Math.round(255 * edge ** 1.05 * cloud)];
  });
  textures.add(hazeTexture);
  const hazeMaterial = new THREE.SpriteMaterial({
    name: "Low cinematic ground haze", color: 0x86a7cc, map: hazeTexture,
    transparent: true, opacity: 0.42, depthWrite: false, fog: true
  });
  materials.add(hazeMaterial);
  const haze: Array<{ sprite: THREE.Sprite; x: number; z: number }> = [];
  // Keep the footprint beyond the wheels and lamps: this is a low atmospheric
  // backdrop, never a veil placed directly over an active part.
  for (const [x, z, width, height] of [[-2.7, -4.9, 6.8, 1.7], [3.4, -5.8, 6.6, 1.8], [-4.3, 0.7, 3.8, 0.9], [4.4, 1.7, 3.8, 1]]) {
    const sprite = new THREE.Sprite(hazeMaterial);
    sprite.name = "Cinematic ground haze";
    sprite.position.set(x, height * 0.35, z);
    sprite.scale.set(width, height, 1);
    root.add(sprite);
    haze.push({ sprite, x, z });
  }

  let previousTravel: number | null = null;
  let phase = 0;
  let reflectionTravel = 0;
  let lampTravel = 0;
  let disposed = false;
  const lightingReady = options.photographicLighting && typeof document !== "undefined"
    ? new HDRLoader().loadAsync(new URL("../../../../environment/lighting/modern_buildings_night_1k.hdr", import.meta.url).href)
      .then((map) => {
        if (disposed || scene.environment !== environment) { map.dispose(); return false; }
        map.name = "CC0 Poly Haven Modern Buildings Night";
        map.mapping = THREE.EquirectangularReflectionMapping;
        const fallback = environment;
        environment = map;
        scene.environment = map;
        // The source's exposed lamp pixels contain extreme radiance. Match its
        // exposure to this night rig rather than making damp asphalt look like
        // daylight; retain their natural shape and HDR contrast for reflections.
        scene.environmentIntensity = 0.035;
        scene.environmentRotation.y = Math.PI * 0.3;
        fallback.dispose();
        return true;
      }).catch(() => false)
    : Promise.resolve(false);
  return {
    ready: Promise.all([asphalt.ready, lightingReady]).then(([surfaceReady, hdrReady]) =>
      surfaceReady && (!options.photographicLighting || hdrReady)),
    get reflectionCalls() { return reflection?.calls ?? 0; },
    get reflectionTriangles() { return reflection?.triangles ?? 0; },
    resize(width, height) { reflection?.resize(width, height); },
    update(travel, reducedMotion, streetEnabled = false) {
      if (disposed || !Number.isFinite(travel)) return;
      reflection?.setEnabled(streetEnabled);
      if (!reducedMotion) lampTravel = travel;
      const forwardLamp = ((6 - lampTravel) % 12 + 12) % 12;
      for (const { lamp, row } of streetLights) {
        const z = forwardLamp - row * 12;
        lamp.position.z = z;
        lamp.intensity = streetEnabled ? 16 * (1 - THREE.MathUtils.smoothstep(Math.abs(z), 8, 12)) : 0;
      }
      const difference = previousTravel === null ? 0 : travel - previousTravel;
      previousTravel = travel;
      if (reducedMotion || difference === 0) return;
      if (streetEnabled) {
        // Plane -PI/2 rotation maps +UV.y toward -Z. Move all PBR channels
        // together, at the same measured distance as the physical lane markings.
        for (const map of [asphalt.map, asphalt.normalMap, asphalt.roughnessMap]) {
          map.offset.y = (map.offset.y - difference * map.repeat.y / 80) % 1;
        }
        reflectionTravel += difference;
        reflection?.setTravel(reflectionTravel);
      }
      phase = (phase + difference * 0.045) % (Math.PI * 2);
      haze.forEach(({ sprite, x, z }, index) => {
        sprite.position.x = x + (Math.sin(phase + index) - Math.sin(index)) * 0.12;
        sprite.position.z = z + (Math.cos(phase + index) - Math.cos(index)) * 0.16;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      root.clear();
      lights.forEach((item) => item.dispose());
      geometries.forEach((item) => item.dispose());
      materials.forEach((item) => item.dispose());
      textures.forEach((item) => item.dispose());
      reflection?.dispose();
      asphalt.dispose();
      environment.dispose();
      if (scene.environment === environment) {
        scene.environment = previousEnvironment;
        scene.environmentIntensity = previousEnvironmentIntensity;
        scene.environmentRotation.copy(previousEnvironmentRotation);
      }
      if (scene.background === background) scene.background = previousBackground;
      if (scene.fog === fog) scene.fog = previousFog;
    }
  };
}
