import * as THREE from "three";
import type { TumblerModel } from "./tumblerModel";

export interface TumblerSignals {
  /** Lamp brightness already resolved from live telemetry, including its blink phase. */
  update(signals: { white: number; green: number; boost: number }): void;
  dispose(): void;
}

/** Source lights and optical haloes; the cheap cones remain a fallback for GPUs
 * without the HDR depth-aware volumetric pipeline. */
export function createTumblerSignals(scene: THREE.Scene, model: TumblerModel,
  options: { volumetric?: boolean } = {}): TumblerSignals {
  const root = new THREE.Group();
  root.name = "Tumbler signal effects";
  // Keep the lit shader's projector count constant across lamp phases and
  // reflection passes. Hiding a light with its optical effects caused expensive
  // shader recompilation on software GPUs; zero intensity is already dark.
  const projectorRoot = new THREE.Group();
  projectorRoot.name = "Tumbler headlight projectors";
  const geometry = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const radialSize = 256;
  const pixels = new Uint8Array(radialSize * radialSize * 4);
  for (let y = 0; y < radialSize; y += 1) {
    for (let x = 0; x < radialSize; x += 1) {
      const radius = Math.hypot((x + 0.5) / radialSize * 2 - 1, (y + 0.5) / radialSize * 2 - 1);
      const index = (y * radialSize + x) * 4;
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
      const halo = Math.exp(-radius * radius * 11) * Math.pow(Math.max(0, 1 - radius), 0.8);
      pixels[index + 3] = Math.round(halo * 255);
    }
  }
  const radialTexture = new THREE.DataTexture(pixels, radialSize, radialSize, THREE.RGBAFormat);
  radialTexture.name = "Procedural lamp scattering";
  radialTexture.magFilter = THREE.LinearFilter;
  radialTexture.minFilter = THREE.LinearMipmapLinearFilter;
  radialTexture.generateMipmaps = true;
  radialTexture.anisotropy = 4;
  radialTexture.needsUpdate = true;

  const poolGeometry = new THREE.PlaneGeometry(1, 1);
  const coneGeometry = options.volumetric ? null : new THREE.ConeGeometry(1, 1, 32, 8, true);
  geometry.add(poolGeometry);
  if (coneGeometry) geometry.add(coneGeometry);
  const up = new THREE.Vector3(0, 1, 0);
  const projectors: THREE.SpotLight[] = [];
  let disposed = false;

  function signalGroup(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    group.visible = false;
    group.userData.signal = 0;
    root.add(group);
    return group;
  }
  const headlights = signalGroup("White headlight effects");
  const greens = signalGroup("Green optical effects");
  const boost = signalGroup("Orange boost effects");
  const brightness = new Map<THREE.Group, Array<(value: number) => void>>([
    [headlights, []], [greens, []], [boost, []]
  ]);

  function halo(group: THREE.Group, anchor: THREE.Vector3, color: string, size: number, opacity: number): void {
    const material = new THREE.SpriteMaterial({
      color, map: radialTexture, blending: THREE.AdditiveBlending, transparent: true,
      depthTest: true, depthWrite: false, toneMapped: false, opacity: 0
    });
    materials.add(material);
    const sprite = new THREE.Sprite(material);
    sprite.name = `${group.name}: optical halo`;
    sprite.position.copy(anchor);
    sprite.scale.set(size, size, 1);
    // Keep depth testing on: hidden optics must not shine through opaque body panels.
    group.add(sprite);
    brightness.get(group)!.push((value) => { material.opacity = value * opacity; });
  }

  function pool(group: THREE.Group, center: THREE.Vector3, color: string, width: number, length: number, opacity: number): void {
    const material = new THREE.MeshBasicMaterial({
      color, map: radialTexture, blending: THREE.AdditiveBlending, transparent: true,
      depthTest: true, depthWrite: false, toneMapped: false, opacity: 0
    });
    materials.add(material);
    const mesh = new THREE.Mesh(poolGeometry, material);
    mesh.name = `${group.name}: asphalt reflection`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(center);
    mesh.scale.set(width, length, 1);
    group.add(mesh);
    brightness.get(group)!.push((value) => { material.opacity = value * opacity; });
  }

  function beam(group: THREE.Group, anchor: THREE.Vector3, end: THREE.Vector3, color: string, radius: number, opacity: number): void {
    if (!coneGeometry) return;
    const material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, brightness: { value: 0 } },
      vertexShader: `varying vec2 beamUv;
varying vec3 beamPosition;
varying vec3 beamNormal;
varying vec3 beamLocal;
void main() {
  beamUv = uv;
  beamLocal = position;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  beamPosition = viewPosition.xyz;
  beamNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * viewPosition;
}`,
      fragmentShader: `uniform vec3 color;
uniform float brightness;
varying vec2 beamUv;
varying vec3 beamPosition;
varying vec3 beamNormal;
varying vec3 beamLocal;
void main() {
  // A view-facing density fade removes the hard triangular silhouette of a
  // transparent cone. Smooth, static wisps cannot invent signal flickering.
  float edge = pow(abs(dot(normalize(beamNormal), normalize(-beamPosition))), 1.6);
  float ends = smoothstep(0.0, 0.22, beamUv.y) * (1.0 - smoothstep(0.82, 1.0, beamUv.y));
  float wisps = 0.86 + 0.14 * sin(beamLocal.y * 17.0 + beamLocal.x * 8.0) * sin(beamLocal.y * 7.0 + beamLocal.z * 11.0);
  gl_FragColor = vec4(color, edge * ends * wisps * brightness);
  #include <colorspace_fragment>
}`,
      transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      depthTest: true, depthWrite: false, toneMapped: false
    });
    materials.add(material);
    const mesh = new THREE.Mesh(coneGeometry, material);
    mesh.name = `${group.name}: short scattering beam`;
    const direction = end.clone().sub(anchor);
    mesh.position.copy(anchor).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(up, direction.clone().normalize().negate());
    mesh.scale.set(radius, direction.length(), radius);
    group.add(mesh);
    brightness.get(group)!.push((value) => { material.uniforms.brightness.value = value * opacity; });
  }

  function projector(anchor: THREE.Vector3, target: THREE.Vector3): void {
    const light = new THREE.SpotLight("#dcecff", 0, 7, 0.28, 0.85, 2);
    light.name = "White headlight projector";
    light.position.copy(anchor);
    light.target.position.copy(target);
    light.castShadow = false;
    projectorRoot.add(light, light.target);
    projectors.push(light);
    brightness.get(headlights)!.push((value) => { light.intensity = value * 30; });
  }

  function jet(anchor: THREE.Vector3): void {
    const material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color("#ff8a32") }, brightness: { value: 0 } },
      vertexShader: "varying vec2 jetUv; void main() { jetUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform vec3 color;
uniform float brightness;
varying vec2 jetUv;
void main() {
  float edge = pow(max(0.0, 1.0 - abs(jetUv.x * 2.0 - 1.0)), 2.0);
  float ends = smoothstep(0.0, 0.4, jetUv.y) * (1.0 - smoothstep(0.88, 1.0, jetUv.y));
  gl_FragColor = vec4(color, brightness * edge * ends);
  #include <colorspace_fragment>
}`,
      transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      depthTest: true, depthWrite: false, toneMapped: false
    });
    materials.add(material);
    // Crossed feathered sheets give the short exhaust volume from either side
    // without adding another rigid cone or a continuously animated flame.
    for (const turn of [0, Math.PI / 2]) {
      const mesh = new THREE.Mesh(poolGeometry, material);
      mesh.name = "Orange boost effects: short exhaust scattering";
      mesh.rotation.set(-Math.PI / 2, turn, 0);
      mesh.position.copy(anchor).add(new THREE.Vector3(0, 0, -0.22));
      mesh.scale.set(0.24, 0.5, 1);
      boost.add(mesh);
    }
    brightness.get(boost)!.push((value) => { material.uniforms.brightness.value = value * 0.2; });
  }

  // The ground is at -0.026; reflection planes sit above it to avoid z fighting.
  const poolY = -0.021;
  for (const lamp of model.partAnchors.lights.slice(0, 2)) {
    const anchor = lamp.clone();
    anchor.z += 0.015;
    const end = new THREE.Vector3(anchor.x, poolY + 0.01, anchor.z + 2.8);
    halo(headlights, anchor, "#dcecff", 0.55, 0.8);
    beam(headlights, anchor, end, "#ccdeff", 0.72, 0.065);
    projector(anchor, end);
  }
  for (const lamp of model.partAnchors.reverse) {
    halo(greens, lamp, "#51ff35", 0.48, 0.8);
    pool(greens, new THREE.Vector3(lamp.x, poolY, lamp.z), "#43ed2b", 0.7, 0.8, 0.1);
  }
  for (const lamp of model.partAnchors.boost) {
    const anchor = lamp.clone();
    anchor.z -= 0.02;
    halo(boost, anchor, "#ff9a31", 0.9, 0.65);
    jet(anchor);
    pool(boost, new THREE.Vector3(anchor.x, poolY, anchor.z - 0.5), "#f88732", 1, 1.4, 0.24);
  }
  scene.add(root, projectorRoot);

  function setSignal(group: THREE.Group, input: number): void {
    const value = Number.isFinite(input) ? THREE.MathUtils.clamp(input, 0, 1) : 0;
    group.visible = value > 0;
    group.userData.signal = value;
    brightness.get(group)!.forEach((set) => set(value));
  }
  return {
    update(signals) {
      if (disposed) return;
      setSignal(headlights, signals.white);
      setSignal(greens, signals.green);
      setSignal(boost, signals.boost);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      root.clear();
      projectorRoot.removeFromParent();
      projectorRoot.clear();
      geometry.forEach((resource) => resource.dispose());
      materials.forEach((resource) => resource.dispose());
      projectors.forEach((light) => light.dispose());
      radialTexture.dispose();
      brightness.clear();
    }
  };
}
