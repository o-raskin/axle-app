import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { CopyShader } from "three/addons/shaders/CopyShader.js";
import { VolumetricLightingPass } from "./tumblerVolumetrics";

/** Transparent mist, lamp scattering and faded city walls cannot contribute
 * opaque depth to the car's contact occlusion. Always restore visibility, even
 * if a context is lost during the additional depth render. */
export function withVehicleOccluders(scene: THREE.Scene, operation: () => void): void {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((object) => {
    const transparent = object instanceof THREE.Mesh && (Array.isArray(object.material)
      ? object.material.every((material) => material.transparent && material.alphaTest === 0)
      : object.material.transparent && object.material.alphaTest === 0);
    if (object.visible && (object instanceof THREE.Sprite || object instanceof THREE.Line
      || object instanceof THREE.Points || transparent
      || object.name === "Tumbler street scene" || object.name === "Tumbler signal effects")) {
      hidden.push(object);
      object.visible = false;
    }
  });
  try { operation(); } finally { hidden.forEach((object) => { object.visible = true; }); }
}

export class VehicleOcclusionPass extends SSAOPass {
  private released = false;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, width = 1, height = 1, samples = 24) {
    super(scene, camera, width, height, samples);
    // AO is a contact effect in world units, rather than a vehicle-sized dark
    // halo. Preserve silhouette and panel edges when filtering its small buffer.
    this.kernelRadius = 0.65;
    this.minDistance = 0.00008;
    this.maxDistance = 0.012;
    this.blurMaterial.uniforms.tDepth = { value: this.normalRenderTarget.depthTexture };
    this.blurMaterial.uniforms.tNormal = { value: this.normalRenderTarget.texture };
    this.blurMaterial.uniforms.cameraNear = { value: camera.near };
    this.blurMaterial.uniforms.cameraFar = { value: camera.far };
    this.blurMaterial.fragmentShader = /* glsl */`
      uniform sampler2D tDiffuse;
      uniform highp sampler2D tDepth;
      uniform sampler2D tNormal;
      uniform vec2 resolution;
      uniform float cameraNear;
      uniform float cameraFar;
      varying vec2 vUv;
      #include <packing>
      void main() {
        float depth = texture2D(tDepth, vUv).r;
        if (depth >= 0.9999997) { gl_FragColor = vec4(1.0); return; }
        float centerZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
        vec3 centerNormal = unpackRGBToNormal(texture2D(tNormal, vUv).rgb);
        float result = 0.0;
        float total = 0.0;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 shift = vec2(float(x), float(y));
            vec2 uv = vUv + shift / resolution;
            float sampleDepth = texture2D(tDepth, uv).r;
            float sampleZ = perspectiveDepthToViewZ(sampleDepth, cameraNear, cameraFar);
            vec3 sampleNormal = unpackRGBToNormal(texture2D(tNormal, uv).rgb);
            float weight = exp(-dot(shift, shift) * 0.65 - abs(sampleZ - centerZ) * 12.0)
              * pow(max(dot(centerNormal, sampleNormal), 0.0), 8.0)
              * (1.0 - step(0.9999997, sampleDepth));
            result += texture2D(tDiffuse, uv).r * weight;
            total += weight;
          }
        }
        gl_FragColor = vec4(vec3(result / max(total, 0.00001)), 1.0);
      }
    `;
    // Keep the black body readable, and leave lighting to the actual scene.
    this.copyMaterial.fragmentShader = this.copyMaterial.fragmentShader.replace(
      "gl_FragColor = opacity * texel;",
      "gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, 0.32), 1.0);"
    );
  }

  override dispose(): void {
    if (this.released) return;
    this.released = true;
    // The bundled SSAOPass releases its targets and most surfaces, but omits
    // the sampling shader and noise texture. Release those owned resources too.
    this.ssaoMaterial.dispose();
    this.noiseTexture.dispose();
    super.dispose();
  }

  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width * 0.5)), Math.max(1, Math.round(height * 0.5)));
  }

  override render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget,
    read: THREE.WebGLRenderTarget, delta: number, mask: boolean): void {
    const previousOverride = this.scene.overrideMaterial;
    try {
      withVehicleOccluders(this.scene, () => super.render(renderer, write, read, delta, mask));
    } finally { this.scene.overrideMaterial = previousOverride; }
  }
}

/** Split toning happens in HDR before tone mapping. The luminance-normalized
 * tint only affects neutral surfaces: green control optics keep their hue and
 * the hottest white headlight cores remain neutral. No grain or vignette. */
export class NightOutputPass extends OutputPass {
  constructor() {
    super();
    this.material.fragmentShader = this.material.fragmentShader.replace(
      "// tone mapping",
      /* glsl */`
        vec3 color = max(gl_FragColor.rgb, vec3(0.0));
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float peak = max(max(color.r, color.g), color.b);
        float floorValue = min(min(color.r, color.g), color.b);
        float chroma = (peak - floorValue) / max(peak, 0.00001);
        float neutral = 1.0 - smoothstep(0.2, 0.65, chroma);
        float shadows = 1.0 - smoothstep(0.015, 0.35, luminance);
        float highlights = smoothstep(0.35, 1.4, luminance)
          * (1.0 - smoothstep(1.8, 3.5, luminance));
        vec3 gain = vec3(1.0)
          + neutral * shadows * vec3(-0.045, 0.005, 0.07)
          + neutral * highlights * vec3(0.035, 0.0, -0.035);
        vec3 graded = color * gain;
        graded *= luminance / max(dot(graded, vec3(0.2126, 0.7152, 0.0722)), 0.00001);
        float contrast = mix(0.985, 1.025, smoothstep(0.035, 0.75, luminance));
        gl_FragColor.rgb = graded * contrast;
        // tone mapping
      `
    );
  }
}

/** SMAA keeps micro-texture and railings sharper than FXAA. Its bundled lookup
 * images decode asynchronously; until both are ready we use FXAA, avoiding an
 * incomplete texture upload on the first on-demand frame. */
export class DetailAntialiasPass extends SMAAPass {
  private released = false;
  readonly settled: Promise<boolean>;
  private finishLookup: (success: boolean) => void = () => {};

  constructor() {
    super();
    const images = this.lookupImages();
    const completed = new Set<HTMLImageElement>();
    const removeListeners: Array<() => void> = [];
    let finished = false;
    this.settled = new Promise<boolean>((resolve) => {
      this.finishLookup = (success) => {
        if (finished) return;
        finished = true;
        removeListeners.forEach((remove) => remove());
        resolve(success);
      };
      for (const image of images) {
        if (image.complete) { completed.add(image); continue; }
        const complete = () => {
          completed.add(image);
          if (completed.size === images.length) this.finishLookup(this.ready);
        };
        image.addEventListener("load", complete);
        image.addEventListener("error", complete);
        removeListeners.push(() => {
          image.removeEventListener("load", complete);
          image.removeEventListener("error", complete);
        });
      }
      if (completed.size === images.length) this.finishLookup(this.ready);
    });
  }

  private lookupImages(): HTMLImageElement[] {
    // Three 0.186 moved these to private fields before its declaration package.
    const internal = this as unknown as { _areaTexture: THREE.Texture; _searchTexture: THREE.Texture };
    return [internal._areaTexture.image, internal._searchTexture.image] as HTMLImageElement[];
  }

  get ready(): boolean {
    if (this.released) return false;
    return this.lookupImages().every((image) => image.complete && image.naturalWidth > 0);
  }

  override dispose(): void {
    if (this.released) return;
    this.released = true;
    this.finishLookup(false);
    for (const image of this.lookupImages()) {
      image.onload = null;
      image.onerror = null;
    }
    super.dispose();
  }
}

/** The driver must support the same sample count for HDR color and depth.
 * Keep multisampling confined to the beauty target and below an estimated
 * 80 MiB attachment budget, rather than duplicating it for every effect. */
export function selectBeautySamples(colorSamples: readonly number[], depthSamples: readonly number[],
  pixels: number, maximum = 4): number {
  if (!Number.isFinite(pixels) || pixels <= 0) return 0;
  return [4, 2].find((samples) => samples <= maximum && colorSamples.includes(samples)
    && depthSamples.includes(samples) && pixels * (12 * samples + 12) <= 80 * 1024 * 1024) ?? 0;
}

export class MeasuredScenePass extends RenderPass {
  calls = 0;
  triangles = 0;
  shadowCalls = 0;
  shadowTriangles = 0;
  readonly beautyTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  readonly resolvePass = new ShaderPass(CopyShader);
  private readonly colorSamples: number[];
  private readonly depthSamples: number[];
  private released = false;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    super(scene, camera);
    const context = renderer.getContext();
    if ("getInternalformatParameter" in context) {
      const gl = context as WebGL2RenderingContext;
      this.colorSamples = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array)
        .filter((samples) => samples <= renderer.capabilities.maxSamples);
      this.depthSamples = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) as Int32Array);
    } else {
      this.colorSamples = [];
      this.depthSamples = [];
    }
    this.beautyTarget.texture.name = "Tumbler multisampled HDR beauty";
    this.beautyTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.beautyTarget.depthTexture.name = "Actual car and dithered city beauty depth";
    this.beautyTarget.depthTexture.minFilter = THREE.NearestFilter;
    this.beautyTarget.depthTexture.magFilter = THREE.NearestFilter;
    this.beautyTarget.resolveDepthBuffer = true;
  }

  override setSize(width: number, height: number): void {
    const physicalWidth = Math.max(1, Math.floor(width));
    const physicalHeight = Math.max(1, Math.floor(height));
    const samples = selectBeautySamples(this.colorSamples, this.depthSamples, physicalWidth * physicalHeight);
    if (this.beautyTarget.samples !== samples && this.beautyTarget.width === physicalWidth
      && this.beautyTarget.height === physicalHeight) this.beautyTarget.dispose();
    this.beautyTarget.samples = samples;
    this.beautyTarget.setSize(physicalWidth, physicalHeight);
  }

  override render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget,
    read: THREE.WebGLRenderTarget, delta: number, mask: boolean): void {
    if (this.released) return;
    const previousAutoClear = renderer.autoClear;
    const previousOverride = this.scene.overrideMaterial;
    const previousTarget = renderer.getRenderTarget();
    const shadowMap = renderer.shadowMap;
    const shadowRender = shadowMap?.render;
    let retainedShadowCalls = 0;
    let retainedShadowTriangles = 0;
    this.shadowCalls = 0;
    this.shadowTriangles = 0;
    if (shadowRender) {
      shadowMap.render = (...args) => {
        const beforeCalls = renderer.info.render.calls;
        const beforeTriangles = renderer.info.render.triangles;
        // Reflector's nested renderer can reset info halfway through beauty.
        // Preserve the total shadow work, but subtract only retained counters.
        if (beforeCalls < retainedShadowCalls || beforeTriangles < retainedShadowTriangles) {
          retainedShadowCalls = 0;
          retainedShadowTriangles = 0;
        }
        try { shadowRender.apply(shadowMap, args); } finally {
          const calls = Math.max(0, renderer.info.render.calls - beforeCalls);
          const triangles = Math.max(0, renderer.info.render.triangles - beforeTriangles);
          this.shadowCalls += calls;
          this.shadowTriangles += triangles;
          retainedShadowCalls += calls;
          retainedShadowTriangles += triangles;
        }
      };
    }
    try {
      // Always render actual beauty and depth together. This captures the same
      // material dither/discards, even when HDR/depth formats cannot use MSAA.
      super.render(renderer, write, this.beautyTarget, delta, mask);
      // Measure the real scene rather than the final fullscreen postprocess quad.
      this.calls = Math.max(0, renderer.info.render.calls - retainedShadowCalls);
      this.triangles = Math.max(0, renderer.info.render.triangles - retainedShadowTriangles);
      this.resolvePass.renderToScreen = this.renderToScreen;
      this.resolvePass.render(renderer, read, this.beautyTarget, delta, mask);
    } catch (error) {
      renderer.setRenderTarget(previousTarget);
      throw error;
    } finally {
      if (shadowRender) shadowMap.render = shadowRender;
      renderer.autoClear = previousAutoClear;
      this.scene.overrideMaterial = previousOverride;
    }
  }

  override dispose(): void {
    if (this.released) return;
    this.released = true;
    // Detach before releasing the target: Three's initialized framebuffer also
    // releases attached depth on dispose, so ownership must not be duplicated.
    const depth = this.beautyTarget.depthTexture;
    this.beautyTarget.depthTexture = null;
    depth?.dispose();
    this.beautyTarget.dispose();
    this.resolvePass.dispose();
  }
}

export type TumblerRendering = {
  readonly enhanced: boolean;
  readonly volumetric: boolean;
  readonly ready: Promise<boolean>;
  readonly samples: number;
  readonly antialias: "native" | "fxaa" | "smaa";
  readonly calls: number;
  readonly triangles: number;
  readonly shadowCalls: number;
  readonly shadowTriangles: number;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
};

/** A bounded HDR pipeline: edge-preserving half-resolution contact AO,
 * restrained bloom, sharp SMAA and a neutral-aware filmic grade. It uses the
 * viewer's existing on-demand loop and requires no accumulating frame history. */
export function createTumblerRendering(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
  camera: THREE.PerspectiveCamera): TumblerRendering {
  let disposed = false;
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    return {
      enhanced: false,
      volumetric: false,
      ready: Promise.resolve(true),
      samples: 0,
      antialias: "native",
      get calls() { return renderer.info.render.calls; },
      get triangles() { return renderer.info.render.triangles; },
      shadowCalls: 0,
      shadowTriangles: 0,
      resize() {},
      render() { if (!disposed) renderer.render(scene, camera); },
      dispose() { disposed = true; }
    };
  }

  const composer = new EffectComposer(renderer);
  const beauty = new MeasuredScenePass(renderer, scene, camera);
  const occlusion = new VehicleOcclusionPass(scene, camera);
  const volumetrics = new VolumetricLightingPass(scene, camera, beauty.beautyTarget.depthTexture!);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.24, 0.32, 1.35);
  const antialias = new DetailAntialiasPass();
  antialias.enabled = false;
  const output = new NightOutputPass();
  const finishing = new ShaderPass(FXAAShader);
  composer.addPass(beauty);
  composer.addPass(occlusion);
  composer.addPass(volumetrics);
  composer.addPass(bloom);
  // SMAA works in linear-sRGB; FXAA's temporary fallback follows sRGB output.
  composer.addPass(antialias);
  composer.addPass(output);
  composer.addPass(finishing);

  return {
    enhanced: true,
    volumetric: true,
    ready: antialias.settled,
    get samples() { return beauty.beautyTarget.samples; },
    get antialias() { return antialias.enabled ? "smaa" : "fxaa"; },
    get calls() { return beauty.calls; },
    get triangles() { return beauty.triangles; },
    get shadowCalls() { return beauty.shadowCalls; },
    get shadowTriangles() { return beauty.shadowTriangles; },
    resize(width, height) {
      if (disposed) return;
      composer.setSize(width, height);
      const density = renderer.getPixelRatio();
      finishing.uniforms.resolution.value.set(1 / Math.max(1, width * density), 1 / Math.max(1, height * density));
    },
    render() {
      if (disposed) return;
      antialias.enabled = antialias.ready;
      finishing.enabled = !antialias.enabled;
      composer.render(0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    }
  };
}
