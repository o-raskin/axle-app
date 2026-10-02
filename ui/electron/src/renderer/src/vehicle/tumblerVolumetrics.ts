import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const VOLUME_STEPS = 24;

/** Partition the whole ray while concentrating bounded work near its visible
 * surface. These actual shader intervals retain their own world-space lengths,
 * so changing the sample distribution cannot change homogeneous extinction. */
export function createVolumeRayIntervals(): Float32Array {
  return Float32Array.from({ length: VOLUME_STEPS + 1 }, (_, index) => {
    const fraction = index / VOLUME_STEPS;
    return 1 - (1 - fraction) * (1 - fraction);
  });
}

/** Single-scattering participating fog. The ray terminates at the actual
 * beauty depth, including the city's material dither. No replacement depth
 * material, frame history, animated random seed or extra scene render. */
export class VolumetricLightingPass extends Pass {
  readonly volumeTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter
  });
  readonly scatteringMaterial: THREE.ShaderMaterial;
  readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  private readonly targetPosition = new THREE.Vector3();
  private released = false;

  constructor(readonly scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera,
    readonly beautyDepth: THREE.DepthTexture) {
    super();
    this.volumeTarget.texture.name = "Half-resolution depth-clipped participating fog";
    this.white.needsUpdate = true;
    this.scatteringMaterial = new THREE.ShaderMaterial({
      name: "Bounded 24-step single-scattering volumetric light",
      defines: { VOLUME_STEPS },
      uniforms: {
        tDepth: { value: beautyDepth }, tShadow: { value: this.white },
        cameraWorld: { value: new THREE.Matrix4() }, projectionInverse: { value: new THREE.Matrix4() },
        viewProjection: { value: new THREE.Matrix4() }, cameraPositionWorld: { value: new THREE.Vector3() },
        shadowMatrix: { value: new THREE.Matrix4() }, shadowTexel: { value: new THREE.Vector2(1, 1) },
        shadowBias: { value: 0 }, hasShadow: { value: 0 },
        keyDirection: { value: new THREE.Vector3(0, 1, 0) }, keyColor: { value: new THREE.Color(0) },
        spotPosition: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        spotDirection: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        spotColor: { value: [new THREE.Color(0), new THREE.Color(0)] },
        spotShape: { value: [new THREE.Vector4(), new THREE.Vector4()] },
        pointPosition: { value: Array.from({ length: 4 }, () => new THREE.Vector3()) },
        pointColor: { value: Array.from({ length: 4 }, () => new THREE.Color(0)) },
        pointShape: { value: Array.from({ length: 4 }, () => new THREE.Vector2()) },
        rayIntervals: { value: createVolumeRayIntervals() }
      },
      vertexShader,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDepth;
        uniform sampler2D tShadow;
        uniform mat4 cameraWorld, projectionInverse, viewProjection, shadowMatrix;
        uniform vec3 cameraPositionWorld, keyDirection, keyColor;
        uniform vec2 shadowTexel;
        uniform float shadowBias, hasShadow;
        uniform vec3 spotPosition[2], spotDirection[2], spotColor[2];
        uniform vec4 spotShape[2];
        uniform vec3 pointPosition[4], pointColor[4];
        uniform vec2 pointShape[4];
        uniform float rayIntervals[VOLUME_STEPS + 1];

        vec3 worldAt(vec2 uv, float depth) {
          vec4 view = projectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          return (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
        }
        float phase(float cosine) {
          // Henyey-Greenstein: moderate forward scattering without a white veil.
          const float g = 0.38;
          return (1.0 - g * g) / (12.5663706 * pow(max(1.0 + g * g - 2.0 * g * cosine, 0.001), 1.5));
        }
        float attenuation(float distanceToLight, float cutoff, float decay) {
          float result = 1.0 / max(pow(distanceToLight, decay), 0.01);
          if (cutoff > 0.0) {
            float ratio = distanceToLight / cutoff;
            float fade = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
            result *= fade * fade;
          }
          return result;
        }
        float keyVisibility(vec3 world) {
          if (hasShadow < 0.5) return 1.0;
          vec4 coord = shadowMatrix * vec4(world, 1.0);
          vec3 projected = coord.xyz / coord.w;
          if (any(lessThan(projected, vec3(0.0))) || any(greaterThan(projected, vec3(1.0)))) return 1.0;
          float visibility = 0.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              float blocker = texture2D(tShadow, projected.xy + vec2(float(x), float(y)) * shadowTexel).r;
              visibility += step(projected.z + shadowBias, blocker);
            }
          }
          return visibility / 9.0;
        }
        float visibleLightSegment(vec3 source, vec3 samplePosition) {
          // Visible-depth occlusion complements the cached key shadow. It is
          // deliberately bounded; offscreen geometry cannot be inferred here.
          float visible = 1.0;
          for (int j = 1; j <= 3; j++) {
            vec3 world = mix(source, samplePosition, float(j) * 0.24);
            vec4 projected = viewProjection * vec4(world, 1.0);
            if (projected.w <= 0.0) continue;
            vec3 ndc = projected.xyz / projected.w;
            vec2 uv = ndc.xy * 0.5 + 0.5;
            if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
            float depth = texture2D(tDepth, uv).r;
            if (depth >= 0.999999) continue;
            float surfaceDistance = distance(worldAt(uv, depth), cameraPositionWorld);
            // The first camera surface represents a finite shell, not an
            // infinitely deep blocker. Only intersections close behind that
            // shell count; distant samples behind an unrelated facade cannot
            // erase an otherwise visible headlight shaft.
            float difference = distance(world, cameraPositionWorld) - surfaceDistance;
            if (difference > 0.08 && difference < 0.5) visible = 0.0;
          }
          return visible;
        }
        void main() {
          float depth = texture2D(tDepth, vUv).r;
          vec3 surface = worldAt(vUv, depth);
          vec3 ray = surface - cameraPositionWorld;
          float surfaceDistance = length(ray);
          vec3 direction = ray / max(surfaceDistance, 0.00001);
          float maximumDistance = min(surfaceDistance, 22.0);
          // Stable interleaved gradient noise distributes banding spatially,
          // rather than flickering or accumulating when the vehicle is idle.
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float transmission = 1.0;
          vec3 scattering = vec3(0.0);
          for (int i = 0; i < VOLUME_STEPS; i++) {
            float start = rayIntervals[i] * maximumDistance;
            float end = rayIntervals[i + 1] * maximumDistance;
            float stepLength = end - start;
            vec3 world = cameraPositionWorld + direction * mix(start, end, jitter);
            // Low-lying damp air, continuous in world space as the camera moves.
            float variation = 0.88 + 0.12 * sin(world.x * 0.73 + world.z * 0.43) * sin(world.z * 0.27 - world.y * 0.62);
            float density = (0.035 * exp(-max(world.y, 0.0) * 0.7) + 0.0015) * variation;
            vec3 illumination = keyColor * phase(dot(direction, keyDirection)) * keyVisibility(world);
            for (int lamp = 0; lamp < 2; lamp++) {
              if (max(max(spotColor[lamp].r, spotColor[lamp].g), spotColor[lamp].b) <= 0.0) continue;
              vec3 toLight = spotPosition[lamp] - world;
              float lightDistance = length(toLight);
              vec3 lightDirection = toLight / max(lightDistance, 0.00001);
              float cone = smoothstep(spotShape[lamp].x, spotShape[lamp].y, dot(-lightDirection, spotDirection[lamp]));
              if (cone > 0.0001 && lightDistance < spotShape[lamp].z) {
                // Art-directed local scattering reveals the low damp-air
                // shafts without increasing the global fog or surface light.
                illumination += spotColor[lamp] * 3.0 * cone * attenuation(lightDistance, spotShape[lamp].z, spotShape[lamp].w)
                  * phase(dot(direction, lightDirection)) * visibleLightSegment(spotPosition[lamp], world);
              }
            }
            for (int lamp = 0; lamp < 4; lamp++) {
              if (max(max(pointColor[lamp].r, pointColor[lamp].g), pointColor[lamp].b) <= 0.0) continue;
              vec3 toLight = pointPosition[lamp] - world;
              float lightDistance = length(toLight);
              illumination += pointColor[lamp] * attenuation(lightDistance, pointShape[lamp].x, pointShape[lamp].y)
                * phase(dot(direction, toLight / max(lightDistance, 0.00001)));
            }
            float absorption = exp(-density * stepLength);
            scattering += transmission * (1.0 - absorption) * illumination * 0.9;
            transmission *= absorption;
          }
          gl_FragColor = vec4(scattering, transmission);
        }
      `,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: "Depth-aware linear HDR fog composite",
      uniforms: {
        tDiffuse: { value: null }, tVolume: { value: this.volumeTarget.texture }, tDepth: { value: beautyDepth },
        resolution: { value: new THREE.Vector2(1, 1) }, projectionInverse: { value: new THREE.Matrix4() }
      },
      vertexShader,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform sampler2D tDiffuse, tVolume, tDepth;
        uniform vec2 resolution;
        uniform mat4 projectionInverse;
        float viewDistance(vec2 uv) {
          float depth = texture2D(tDepth, uv).r;
          vec4 view = projectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          return min(length(view.xyz / view.w), 22.0);
        }
        void main() {
          float centerDistance = viewDistance(vUv);
          vec2 pixel = vUv * resolution - 0.5;
          vec2 base = floor(pixel);
          vec2 fraction = fract(pixel);
          vec4 fog = vec4(0.0);
          float total = 0.0;
          for (int y = 0; y < 2; y++) {
            for (int x = 0; x < 2; x++) {
              vec2 uv = (base + vec2(float(x), float(y)) + 0.5) / resolution;
              vec2 bilinear = mix(vec2(1.0) - fraction, fraction, vec2(float(x), float(y)));
              float weight = bilinear.x * bilinear.y * exp(-abs(viewDistance(uv) - centerDistance) * 8.0);
              fog += texture2D(tVolume, uv) * weight;
              total += weight;
            }
          }
          // Thin silhouettes can reject all four half-resolution neighbours.
          // Keep their own clear beauty instead of bleeding a distant shaft.
          fog = total > 0.00001 ? fog / total : vec4(0.0, 0.0, 0.0, 1.0);
          vec4 beauty = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(beauty.rgb * fog.a + fog.rgb, beauty.a);
        }
      `,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    });
  }

  /** All lights follow the actual rendered hierarchy and latest resolved state.
   * Hidden/off lamps are cleared, so disconnected controls cannot leave trails. */
  updateLighting(): void {
    const uniforms = this.scatteringMaterial.uniforms;
    const spotColors = uniforms.spotColor.value as THREE.Color[];
    const pointColors = uniforms.pointColor.value as THREE.Color[];
    spotColors.forEach((color) => color.setRGB(0, 0, 0));
    pointColors.forEach((color) => color.setRGB(0, 0, 0));
    uniforms.keyColor.value.setRGB(0, 0, 0);
    uniforms.hasShadow.value = 0;
    uniforms.tShadow.value = this.white;
    let spots = 0;
    let points = 0;
    this.scene.traverseVisible((object) => {
      if (object instanceof THREE.SpotLight && object.name === "White headlight projector" && spots < 2) {
        const slot = spots++;
        object.getWorldPosition(uniforms.spotPosition.value[slot]);
        object.target.getWorldPosition(this.targetPosition);
        uniforms.spotDirection.value[slot].subVectors(this.targetPosition, uniforms.spotPosition.value[slot]).normalize();
        spotColors[slot].copy(object.color).multiplyScalar(Math.max(0, object.intensity));
        uniforms.spotShape.value[slot].set(Math.cos(object.angle), Math.cos(object.angle * (1 - object.penumbra)),
          object.distance > 0 ? object.distance : 22, object.decay);
      } else if (object instanceof THREE.PointLight && object.name.startsWith("Nearby sodium streetlamp ") && points < 4) {
        const slot = points++;
        object.getWorldPosition(uniforms.pointPosition.value[slot]);
        pointColors[slot].copy(object.color).multiplyScalar(Math.max(0, object.intensity));
        uniforms.pointShape.value[slot].set(object.distance, object.decay);
      } else if (object instanceof THREE.DirectionalLight && object.name === "Tumbler cinematic shadow key") {
        object.getWorldPosition(uniforms.keyDirection.value);
        object.target.getWorldPosition(this.targetPosition);
        uniforms.keyDirection.value.sub(this.targetPosition).normalize();
        uniforms.keyColor.value.copy(object.color).multiplyScalar(Math.max(0, object.intensity));
        const depth = object.shadow.map?.depthTexture;
        // The scene's PCSS rig uses BasicShadowMap and raw native depth. A
        // comparison sampler is not compatible with this raw-depth shader.
        if (object.castShadow && depth && depth.compareFunction === null) {
          uniforms.hasShadow.value = 1;
          uniforms.tShadow.value = depth;
          uniforms.shadowMatrix.value.copy(object.shadow.matrix);
          uniforms.shadowTexel.value.set(1 / object.shadow.map!.width, 1 / object.shadow.map!.height);
          uniforms.shadowBias.value = object.shadow.bias;
        }
      }
    });
    uniforms.cameraWorld.value.copy(this.camera.matrixWorld);
    uniforms.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    uniforms.viewProjection.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.camera.getWorldPosition(uniforms.cameraPositionWorld.value);
    this.compositeMaterial.uniforms.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
  }

  override setSize(width: number, height: number): void {
    if (this.released) return;
    const scale = Math.min(0.5, 640 / Math.max(1, width, height));
    const w = Math.max(1, Math.ceil(width * scale));
    const h = Math.max(1, Math.ceil(height * scale));
    this.volumeTarget.setSize(w, h);
    this.compositeMaterial.uniforms.resolution.value.set(w, h);
  }

  override render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget,
    read: THREE.WebGLRenderTarget): void {
    if (this.released) return;
    const target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      this.updateLighting();
      this.quad.material = this.scatteringMaterial;
      renderer.setRenderTarget(this.volumeTarget);
      this.quad.render(renderer);
      this.compositeMaterial.uniforms.tDiffuse.value = read.texture;
      this.quad.material = this.compositeMaterial;
      renderer.setRenderTarget(this.renderToScreen ? null : write);
      this.quad.render(renderer);
    } finally {
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target);
    }
  }

  override dispose(): void {
    if (this.released) return;
    this.released = true;
    this.volumeTarget.dispose();
    this.scatteringMaterial.dispose();
    this.compositeMaterial.dispose();
    this.white.dispose();
    this.quad.dispose();
  }
}
