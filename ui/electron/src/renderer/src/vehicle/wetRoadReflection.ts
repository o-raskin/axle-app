import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";

export type WetRoadReflection = {
  readonly mesh: Reflector;
  readonly calls: number;
  readonly triangles: number;
  setEnabled(enabled: boolean): void;
  setTravel(travel: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

/** Puddles use a single bounded reflection of the real scene, rather than
 * painted light streaks. The surface remains asphalt between shallow water. */
export function createWetRoadReflection(scene: THREE.Scene): WetRoadReflection {
  const geometry = new THREE.PlaneGeometry(20, 64);
  const mesh = new Reflector(geometry, { textureWidth: 512, textureHeight: 512,
    multisample: 0, clipBias: 0.001, color: 0xffffff });
  mesh.name = "City wet-road reflections";
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.024;
  mesh.visible = false;
  mesh.renderOrder = 1;
  const surface = mesh.material as THREE.ShaderMaterial;
  surface.name = "Fresnel puddles with rough city reflections";
  surface.transparent = true;
  surface.depthWrite = false;
  surface.uniforms.travel = { value: 0 };
  surface.uniforms.texel = { value: new THREE.Vector2(1 / 512, 1 / 512) };
  surface.vertexShader = `
    uniform mat4 textureMatrix;
    varying vec4 reflectionUv;
    varying vec3 roadWorld;
    void main() {
      reflectionUv = textureMatrix * vec4(position, 1.0);
      roadWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  surface.fragmentShader = `
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    uniform float travel;
    varying vec4 reflectionUv;
    varying vec3 roadWorld;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 cell = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
        mix(hash(cell + vec2(0.0, 1.0)), hash(cell + 1.0), f.x), f.y);
    }
    void main() {
      vec2 road = vec2(roadWorld.x, roadWorld.z + travel);
      float edge = 1.0 - smoothstep(4.8, 5.65, abs(road.x));
      float water = smoothstep(0.54, 0.70, noise(road * 0.38) * 0.74 + noise(road * 1.7) * 0.26);
      // Break up puddle edges, without moving water independently of the road.
      float grain = noise(road * 17.0);
      float mask = water * edge * (0.82 + grain * 0.18);
      if (mask < 0.015) discard;
      vec2 uv = reflectionUv.xy / reflectionUv.w;
      if (reflectionUv.w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
      vec3 view = normalize(cameraPosition - roadWorld);
      float fresnel = 0.035 + 0.76 * pow(1.0 - max(view.y, 0.0), 5.0);
      vec2 spread = texel * (1.1 + (1.0 - water) * 1.8);
      uv += vec2(grain - 0.5, noise(road * 13.0) - 0.5) * texel * 0.7;
      vec3 reflected = texture2D(tDiffuse, uv).rgb * 0.28;
      reflected += (texture2D(tDiffuse, uv + vec2(spread.x, 0.0)).rgb
        + texture2D(tDiffuse, uv - vec2(spread.x, 0.0)).rgb
        + texture2D(tDiffuse, uv + vec2(0.0, spread.y)).rgb
        + texture2D(tDiffuse, uv - vec2(0.0, spread.y)).rgb) * 0.12;
      reflected += (texture2D(tDiffuse, uv + spread).rgb + texture2D(tDiffuse, uv - spread).rgb
        + texture2D(tDiffuse, uv + vec2(spread.x, -spread.y)).rgb
        + texture2D(tDiffuse, uv + vec2(-spread.x, spread.y)).rgb) * 0.06;
      gl_FragColor = vec4(reflected * vec3(0.91, 0.96, 1.0), mask * fresnel);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  scene.add(mesh);

  const reflect = mesh.onBeforeRender;
  let calls = 0;
  let triangles = 0;
  let disposed = false;
  mesh.onBeforeRender = (renderer, actualScene, camera, actualGeometry, material, group) => {
    const hidden: THREE.Object3D[] = [];
    // Mist sprites and scattering cones are camera-facing approximations. Their
    // source optics still reflect through the model's physical lamp materials.
    actualScene.traverse((object) => {
      if (object.visible && (object instanceof THREE.Sprite || object.name === "Tumbler signal effects")) {
        hidden.push(object); object.visible = false;
      }
    });
    const previous = { ...renderer.info.render };
    const autoReset = renderer.info.autoReset;
    const target = renderer.getRenderTarget();
    const xr = renderer.xr.enabled;
    const shadowUpdate = renderer.shadowMap.autoUpdate;
    const shadowDirty = renderer.shadowMap.needsUpdate;
    renderer.info.autoReset = false;
    // A reflection must reuse the beauty frame's key map, never consume a
    // pending update while signal groups have temporarily been hidden.
    renderer.shadowMap.needsUpdate = false;
    try {
      reflect.call(mesh, renderer, actualScene, camera, actualGeometry, material, group);
      calls = renderer.info.render.calls - previous.calls;
      triangles = renderer.info.render.triangles - previous.triangles;
    } finally {
      hidden.forEach((object) => { object.visible = true; });
      mesh.visible = true;
      renderer.xr.enabled = xr;
      renderer.shadowMap.autoUpdate = shadowUpdate;
      renderer.shadowMap.needsUpdate = shadowDirty;
      renderer.setRenderTarget(target);
      renderer.info.autoReset = autoReset;
      Object.assign(renderer.info.render, previous);
    }
  };
  return {
    mesh,
    get calls() { return calls; },
    get triangles() { return triangles; },
    setEnabled(enabled) { if (!disposed) mesh.visible = enabled; },
    setTravel(travel) { if (!disposed && Number.isFinite(travel)) surface.uniforms.travel.value = travel; },
    resize(width, height) {
      if (disposed || width <= 0 || height <= 0) return;
      // Half-resolution reflection, with a fixed maximum regardless of Retina.
      const scale = Math.min(0.5, 768 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      mesh.getRenderTarget().setSize(w, h);
      surface.uniforms.texel.value.set(1 / w, 1 / h);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
    }
  };
}
