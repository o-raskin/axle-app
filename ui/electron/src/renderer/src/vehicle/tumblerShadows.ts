import * as THREE from "three";

export type TumblerSoftShadows = {
  readonly materialCount: number;
  /** Attach to new materials when the asynchronously loaded car joins the scene. */
  refresh(): void;
  /** Update projection parameters, without invalidating the cached shadow map. */
  update(): void;
  dispose(): void;
};

// This is an original implementation of percentage-closer soft shadows (PCSS),
// not hardware ray tracing. A directional source's angular size determines how
// its penumbra widens with the distance between the blocker and the receiver.
// One existing cached depth map is reused; no tracing extensions, noise textures,
// shadow renders or temporal history are added. Three 0.186's BasicShadowMap
// supplies native non-comparison depth textures, rather than packed RGBA depth.
const softShadowFunctions = /* glsl */ `
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
  uniform vec3 axleShadowExtent;
  uniform vec2 axleShadowClip;
  uniform float axleShadowAngularRadius;

  #if defined(SHADOWMAP_TYPE_BASIC) && NUM_DIR_LIGHT_SHADOWS == 1
  // Fixed disk samples are anchored in light space, with no time-dependent or
  // screen-space noise: stopped wheels and idle cameras keep identical shadows.
  vec2 axleShadowDisk(int index, int count) {
    float radius = sqrt(float(index) / float(count - 1));
    float angle = float(index) * 2.399963229728653;
    return vec2(cos(angle), sin(angle)) * radius;
  }

  bool axleShadowInside(vec2 uv) {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  }

  float axleShadowRawDepth(sampler2D map, vec2 uv) {
    float depth = texture2D(map, uv).r;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      depth = 1.0 - depth;
    #endif
    return depth;
  }

  float axleShadowCompare(sampler2D map, vec2 uv, float receiver, vec2 gradient, vec2 origin) {
    // Outside the map is illuminated, not a repeated dark border texel.
    if (!axleShadowInside(uv)) return 1.0;
    return step(receiver + dot(gradient, uv - origin), axleShadowRawDepth(map, uv));
  }

  float axleShadowFiltered(sampler2D map, vec2 uv, float receiver, vec2 gradient, vec2 origin, vec2 size) {
    // Bilinear filtering of four comparisons, not interpolation of raw depths.
    // The latter invents intermediate blockers along silhouette edges.
    vec2 pixel = uv * size - 0.5;
    vec2 fraction = fract(pixel);
    vec2 corner = (floor(pixel) + 0.5) / size;
    vec2 texel = 1.0 / size;
    float bottom = mix(
      axleShadowCompare(map, corner, receiver, gradient, origin),
      axleShadowCompare(map, corner + vec2(texel.x, 0.0), receiver, gradient, origin), fraction.x);
    float top = mix(
      axleShadowCompare(map, corner + vec2(0.0, texel.y), receiver, gradient, origin),
      axleShadowCompare(map, corner + texel, receiver, gradient, origin), fraction.x);
    return mix(bottom, top, fraction.y);
  }
  #endif

  #if defined(SHADOWMAP_TYPE_PCF)
    float axleDirectionalSoftShadow(sampler2DShadow map, vec2 size, float intensity, float bias, float radius, vec4 coord) {
      return getShadow(map, size, intensity, bias, radius, coord);
    }
  #else
    float axleDirectionalSoftShadow(sampler2D map, vec2 size, float intensity, float bias, float radius, vec4 coord) {
      #if !defined(SHADOWMAP_TYPE_BASIC) || NUM_DIR_LIGHT_SHADOWS != 1
        return getShadow(map, size, intensity, bias, radius, coord);
      #else
        vec3 projected = coord.xyz / coord.w;
        #ifdef USE_REVERSED_DEPTH_BUFFER
          projected.z = 1.0 - projected.z;
        #endif
        // The existing vertex chunk already applies shadowNormalBias. The depth
        // bias is applied once here, in the same canonical direction as Three.
        projected.z += bias;

        // Evaluate derivatives before the varying frustum/blocked branches.
        vec2 dx = dFdx(projected.xy), dy = dFdy(projected.xy);
        float dzdx = dFdx(projected.z), dzdy = dFdy(projected.z);
        float determinant = dx.x * dy.y - dx.y * dy.x;
        vec2 gradient = abs(determinant) > 1e-10
          ? vec2(dzdx * dy.y - dzdy * dx.y, dzdy * dx.x - dzdx * dy.x) / determinant
          : vec2(0.0);
        gradient = clamp(gradient, vec2(-4.0), vec2(4.0));

        if (coord.w <= 0.0 || !axleShadowInside(projected.xy) || projected.z < 0.0 || projected.z > 1.0 || intensity <= 0.0) return 1.0;
        vec2 texel = 1.0 / size;
        // Orthographic depths are linear. Angular-radius geometry differs from
        // the perspective-light PCSS formula: width = gap * tan(source angle).
        float receiverDistance = axleShadowClip.x + projected.z * axleShadowExtent.z;
        vec2 searchRadius = clamp(
          vec2(max(receiverDistance - axleShadowClip.x, 0.0) * tan(axleShadowAngularRadius)) / axleShadowExtent.xy,
          texel, texel * 24.0);
        float blockerGap = 0.0;
        float blockers = 0.0;
        for (int sampleIndex = 0; sampleIndex < 16; sampleIndex++) {
          vec2 offset = axleShadowDisk(sampleIndex, 16) * searchRadius;
          vec2 sampleUv = projected.xy + offset;
          if (axleShadowInside(sampleUv)) {
            float depth = axleShadowRawDepth(map, sampleUv);
            float gap = projected.z + dot(gradient, offset) - depth;
            if (gap > 0.00001) { blockerGap += gap; blockers += 1.0; }
          }
        }
        // Never divide by zero; an empty search means there is no penumbra.
        if (blockers == 0.0) return 1.0;
        vec2 penumbra = vec2(blockerGap / blockers * axleShadowExtent.z * tan(axleShadowAngularRadius)) / axleShadowExtent.xy;
        penumbra = clamp(penumbra, texel * 0.6, texel * 18.0);
        // Four comparisons suffice for the subtexel contact footprint. Larger
        // penumbras use 24 point comparisons: at most 40 reads including search.
        if (all(lessThanEqual(penumbra, texel))) {
          return mix(1.0, axleShadowFiltered(map, projected.xy, projected.z, gradient, projected.xy, size), intensity);
        }
        float visibility = 0.0;
        for (int sampleIndex = 0; sampleIndex < 24; sampleIndex++) {
          vec2 sampleUv = projected.xy + axleShadowDisk(sampleIndex, 24) * penumbra;
          visibility += axleShadowCompare(map, sampleUv, projected.z, gradient, projected.xy);
        }
        return mix(1.0, visibility / 24.0, intensity);
      #endif
    }
  #endif
  #endif
`;

type Hook = THREE.Material["onBeforeCompile"];
type CacheKey = THREE.Material["customProgramCacheKey"];
type Attachment = { material: THREE.Material; previousCompile: Hook; previousKey: CacheKey; compile: Hook; key: CacheKey };

/**
 * Install material-local contact-hardening shadows. Set the renderer's shadow
 * type to BasicShadowMap before its first render, so the depth can be sampled.
 * PCF/VSM and scenes with multiple directional shadow lights safely retain the
 * engine's existing filter. This never mutates global Three ShaderChunks.
 */
export function installTumblerSoftShadows(scene: THREE.Scene, key: THREE.DirectionalLight,
  options: { angularRadius?: number } = {}): TumblerSoftShadows {
  const angularRadius = options.angularRadius ?? 0.045;
  if (!Number.isFinite(angularRadius) || angularRadius < 0 || angularRadius > 0.2) {
    throw new RangeError("Soft shadow angular radius must be between 0 and 0.2 radians");
  }
  const extent = { value: new THREE.Vector3() };
  const clip = { value: new THREE.Vector2() };
  const angular = { value: angularRadius };
  const attachments = new Map<THREE.Material, Attachment>();
  let disposed = false;

  function update(): void {
    if (disposed) return;
    const camera = key.shadow.camera;
    const zoom = Math.max(camera.zoom, 0.0001);
    extent.value.set(Math.max((camera.right - camera.left) / zoom, 0.0001),
      Math.max((camera.top - camera.bottom) / zoom, 0.0001), Math.max(camera.far - camera.near, 0.0001));
    clip.value.set(camera.near, camera.far);
  }

  function refresh(): void {
    if (disposed) return;
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial) || attachments.has(material)) continue;
        const previousCompile = material.onBeforeCompile;
        const previousKey = material.customProgramCacheKey;
        const compile: Hook = function(this: THREE.Material, shader, renderer) {
          previousCompile.call(this, shader, renderer);
          if (!shader.fragmentShader.includes("#include <shadowmap_pars_fragment>")
            || !shader.fragmentShader.includes("#include <lights_fragment_begin>")) return;
          shader.uniforms.axleShadowExtent = extent;
          shader.uniforms.axleShadowClip = clip;
          shader.uniforms.axleShadowAngularRadius = angular;
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <shadowmap_pars_fragment>", `${THREE.ShaderChunk.shadowmap_pars_fragment}\n${softShadowFunctions}`)
            .replace("#include <lights_fragment_begin>", THREE.ShaderChunk.lights_fragment_begin
              .replace(/getShadow\( directionalShadowMap\[/g, "axleDirectionalSoftShadow( directionalShadowMap["));
        };
        const cacheKey: CacheKey = function(this: THREE.Material) {
          return `${previousKey.call(this)}|axle-directional-pcss-v1`;
        };
        material.onBeforeCompile = compile;
        material.customProgramCacheKey = cacheKey;
        material.needsUpdate = true;
        attachments.set(material, { material, previousCompile, previousKey, compile, key: cacheKey });
      }
    });
  }

  update();
  refresh();
  return {
    get materialCount() { return attachments.size; },
    refresh, update,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const attachment of attachments.values()) {
        const material = attachment.material;
        if (material.onBeforeCompile === attachment.compile) material.onBeforeCompile = attachment.previousCompile;
        if (material.customProgramCacheKey === attachment.key) material.customProgramCacheKey = attachment.previousKey;
        material.needsUpdate = true;
      }
      attachments.clear();
    }
  };
}
