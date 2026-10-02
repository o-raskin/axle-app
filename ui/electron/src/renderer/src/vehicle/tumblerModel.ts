import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/decoder";

import type { VehiclePart } from "../lib/vehicleState";

export interface TumblerModel {
  root: THREE.Group;
  frontSteering: THREE.Object3D[];
  wheelSpins: THREE.Object3D[];
  wheelRollRatios: number[];
  lightMaterials: THREE.MeshStandardMaterial[];
  reverseLightMaterials: THREE.MeshStandardMaterial[];
  boostMaterial: THREE.MeshStandardMaterial;
  partAnchors: Record<VehiclePart, THREE.Vector3[]>;
  cameraTargets: Record<VehiclePart | "overview", THREE.Vector3>;
  setReverseLights(on: boolean): void;
  dispose(): void;
}

/** Positive controller steering turns right; with forward +Z, right is -X. */
export function steeringYawForCommand(command: number): number {
  return -Math.max(-1, Math.min(1, command)) * 0.48;
}

/**
 * The baked asset is derived from the editable 42239 Studio/LDraw assembly in
 * ui/electron/models/tumbler. It is bundled by Vite and never uses a remote CAD
 * service. Assembly/license notes and the reproducible converter live there too.
 */
export async function createTumblerModel(): Promise<TumblerModel> {
  const url = new URL("./assets/tumbler-42239.glb", import.meta.url).href;
  const { scene: root } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  return bindTumblerModel(root);
}

/** Bind feedback to named CAD nodes; glTF nodes can be Object3D, Group or Mesh. */
export function bindTumblerModel(root: THREE.Group): TumblerModel {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    root.clear();
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
  }
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const surfaces = Array.isArray(object.material) ? object.material : [object.material];
    for (const surface of surfaces) {
      materials.add(surface);
      for (const value of Object.values(surface)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
      if (!(surface instanceof THREE.MeshStandardMaterial)) continue;
      // Black ABS stays neutral rather than taking LDraw's navy display tint.
      if (/^LDraw_0:/.test(surface.name)) {
        surface.color.set("#17191b");
        surface.roughness = 0.55;
      }
      if (/^LDraw_256:/.test(surface.name)) surface.color.set("#161817");
      surface.metalness = 0;
    }
    object.castShadow = true;
    object.receiveShadow = true;
  });
  function group(name: string): THREE.Object3D {
    const object = root.getObjectByName(name);
    if (!object) {
      dispose();
      throw new Error(`Missing Tumbler assembly: ${name}`);
    }
    return object;
  }
  const frontSteering = [group("frontSteeringLeft"), group("frontSteeringRight")];
  const wheelSpins = [group("wheelFrontLeft"), group("wheelFrontRight"), group("wheelRearLeft"), group("wheelRearRight")];
  const frontLights = [group("frontLightLeft"), group("frontLightRight")];
  const reverseLights = [group("reverseLightFrontLeft"), group("reverseLightFrontRight"), group("reverseLightRear")];
  const jetLight = group("jetLight");
  root.updateMatrixWorld(true);
  function geometryBounds(object: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
      dispose();
      throw new Error(`Invalid Tumbler assembly geometry: ${object.name}`);
    }
    return box;
  }
  const bounds = geometryBounds(root);
  const wheelBounds = wheelSpins.map(geometryBounds);
  const radii = wheelBounds.map((box) => (box.max.y - box.min.y) / 2);
  if (radii.some((radius) => radius <= 0)) {
    dispose();
    throw new Error("Invalid Tumbler wheel radius");
  }
  const rollRadius = (radii[2] + radii[3]) / 2;
  const wheelRollRatios = radii.map((radius) => rollRadius / radius);
  const lampBounds = frontLights.map(geometryBounds);
  const jetBounds = geometryBounds(jetLight);
  const reverseAnchors = reverseLights.map((light) => geometryBounds(light).getCenter(new THREE.Vector3()));
  const frontMaterial = new THREE.MeshStandardMaterial({
    name: "Tumbler front light feedback", color: "#eef4db", emissive: "#eef4db", emissiveIntensity: 0.04,
    roughness: 0.25
  });
  const boostMaterial = new THREE.MeshStandardMaterial({
    name: "Tumbler jet light feedback", color: "#d5741b", emissive: "#ff8c21", emissiveIntensity: 0.04,
    roughness: 0.28
  });
  materials.add(frontMaterial);
  materials.add(boostMaterial);
  function illuminate(feature: THREE.Object3D, material: THREE.MeshStandardMaterial) {
    feature.traverse((object) => { if (object instanceof THREE.Mesh) object.material = material; });
  }
  frontLights.forEach((feature) => illuminate(feature, frontMaterial));
  illuminate(jetLight, boostMaterial);
  // Preserve translucent green cones and clear optical bars. These three
  // assemblies glow on reverse and Attack; opaque green supports remain ordinary plastic.
  const reverseLightMaterials: THREE.MeshStandardMaterial[] = [];
  const reverseLightColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  const reverseTransmission = new THREE.Color("#43df28");
  for (const feature of reverseLights) {
    const clones = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
    feature.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const surfaces = Array.isArray(object.material) ? object.material : [object.material];
      const illuminated = surfaces.map((surface) => {
        if (!(surface instanceof THREE.MeshStandardMaterial)) return surface;
        let clone = clones.get(surface);
        if (!clone) {
          clone = surface.clone();
          clone.name = `Tumbler reverse light feedback: ${surface.name}`;
          clone.emissive.set("#43ff28");
          clone.emissiveIntensity = 0.04;
          clones.set(surface, clone);
          reverseLightMaterials.push(clone);
          reverseLightColors.set(clone, clone.color.clone());
          materials.add(clone);
        }
        return clone;
      });
      object.material = Array.isArray(object.material) ? illuminated : illuminated[0];
    });
  }
  const steeringAnchors = wheelBounds.slice(0, 2).map((box) => {
    const anchor = box.getCenter(new THREE.Vector3());
    anchor.z = box.max.z - 0.035;
    return anchor;
  });
  const driveAnchors = wheelBounds.slice(2).map((box) => {
    const anchor = box.getCenter(new THREE.Vector3());
    anchor.x = anchor.x < 0 ? box.min.x + 0.035 : box.max.x - 0.035;
    return anchor;
  });
  const lightAnchors = lampBounds.map((box) => {
    const anchor = box.getCenter(new THREE.Vector3());
    anchor.z = box.max.z;
    return anchor;
  });
  const boostAnchor = jetBounds.getCenter(new THREE.Vector3());
  boostAnchor.z = jetBounds.min.z;
  const midpoint = (points: THREE.Vector3[]) => points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length);
  return {
    root, frontSteering, wheelSpins, wheelRollRatios, lightMaterials: [frontMaterial], reverseLightMaterials, boostMaterial,
    partAnchors: { steering: steeringAnchors, drive: driveAnchors, lights: lightAnchors, attack: lightAnchors, boost: [boostAnchor], reverse: reverseAnchors },
    cameraTargets: {
      overview: bounds.getCenter(new THREE.Vector3()),
      steering: midpoint(frontSteering.map((wheel) => wheel.getWorldPosition(new THREE.Vector3()))),
      drive: midpoint(wheelBounds.slice(2).map((box) => box.getCenter(new THREE.Vector3()))),
      lights: midpoint(lightAnchors), attack: midpoint(lightAnchors), boost: boostAnchor.clone(),
      reverse: midpoint(reverseAnchors)
    },
    setReverseLights(on) {
      for (const light of reverseLightMaterials) {
        light.color.copy(reverseLightColors.get(light)!);
        // A lit clear optical bar transmits the green light. Tinting its lit
        // surface keeps the signal visible under the scene's white fill lights.
        if (on) light.color.multiply(reverseTransmission);
        light.emissiveIntensity = on ? 2.4 : 0.04;
      }
    },
    dispose
  };
}
