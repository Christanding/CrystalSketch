import {
  Camera, Color, DataTexture, EquirectangularReflectionMapping, FloatType,
  Group, LinearFilter, LinearSRGBColorSpace, Matrix4, Quaternion, RectAreaLight, RGBAFormat, Scene, Vector3,
} from "three";
import type { StyleState } from "../model/appearance";
import { DEFAULT_LIGHT_DIRECTION } from "../model/appearance";
import { STUDIO_PRESET_LIGHT_DIRECTIONS, type RenderSettings, type StudioPreset } from "../model/renderSettings";
import { isPhysicalMaterialPreset } from "../model/materialPresets";

interface StudioPanel {
  direction: readonly [number, number];
  distance: number;
  width: number;
  height: number;
  power: number;
  intensity: number;
}
interface StudioRig {
  floor: number;
  sky: number;
  panels: readonly StudioPanel[];
}

/** Only the added presets use these rigs. The four original presets stay on their existing path. */
export const NEW_STUDIO_LIGHTING_RIGS = {
  uniform: { floor: 0.22, sky: 0.10, panels: [
    { direction: STUDIO_PRESET_LIGHT_DIRECTIONS.uniform!, distance: 2.8, width: 4.8, height: 3.8, power: 1.8, intensity: 0.48 },
    { direction: [-80, 15], distance: 2.8, width: 4.2, height: 4.5, power: 1.4, intensity: 0.32 },
    { direction: [80, 15], distance: 2.8, width: 4.2, height: 4.5, power: 1.4, intensity: 0.32 },
    { direction: [180, 45], distance: 3, width: 4.8, height: 4, power: 0.65, intensity: 0.18 },
  ] },
  overhead: { floor: 0.035, sky: 0.04, panels: [
    { direction: STUDIO_PRESET_LIGHT_DIRECTIONS.overhead!, distance: 2.5, width: 3.2, height: 3.2, power: 6, intensity: 1.6 },
    { direction: [0, 15], distance: 3, width: 4.8, height: 3, power: 0.35, intensity: 0.11 },
  ] },
  "dual-strip": { floor: 0.025, sky: 0.025, panels: [
    { direction: STUDIO_PRESET_LIGHT_DIRECTIONS["dual-strip"]!, distance: 2.5, width: 0.55, height: 4.8, power: 8, intensity: 2.2 },
    { direction: [65, 15], distance: 2.5, width: 0.55, height: 4.8, power: 7, intensity: 1.9 },
    { direction: [0, 20], distance: 3, width: 4.5, height: 3, power: 0.2, intensity: 0.06 },
  ] },
  rembrandt: { floor: 0.012, sky: 0.018, panels: [
    { direction: STUDIO_PRESET_LIGHT_DIRECTIONS.rembrandt!, distance: 2.5, width: 1.35, height: 1.9, power: 7, intensity: 3.2 },
    { direction: [60, 15], distance: 3, width: 3.4, height: 3.5, power: 0.2, intensity: 0.06 },
  ] },
} satisfies Partial<Record<StudioPreset, StudioRig>>;

const WORLD_UP = new Vector3(0, 1, 0);
const TOP_PANEL_UP = new Vector3(0, 0, 1);
type PreparedPanel = StudioPanel & {
  center: Vector3; normal: Vector3; right: Vector3; up: Vector3; rotation: Quaternion;
};
const preparedRigs = new Map<StudioPreset, StudioRig & { lights: PreparedPanel[] }>();

function directionVector([azimuth, elevation]: readonly [number, number]): Vector3 {
  const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
  return new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

function addedStudioRig(preset: StudioPreset) {
  const definition = (NEW_STUDIO_LIGHTING_RIGS as Partial<Record<StudioPreset, StudioRig>>)[preset];
  if (!definition) return undefined;
  let rig = preparedRigs.get(preset);
  if (!rig) {
    const lights = definition.panels.map(panel => {
      const normal = directionVector(panel.direction).normalize();
      const center = normal.clone().multiplyScalar(panel.distance);
      const referenceUp = Math.abs(normal.dot(WORLD_UP)) > 0.999 ? TOP_PANEL_UP : WORLD_UP;
      const right = new Vector3().crossVectors(referenceUp, normal).normalize();
      const up = new Vector3().crossVectors(normal, right);
      const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, normal));
      return { ...panel, center, normal, right, up, rotation };
    });
    rig = { ...definition, lights };
    preparedRigs.set(preset, rig);
  }
  return rig;
}

export type StudioEnvironmentConvention = "raster" | "path-traced";

/**
 * Rig-local -> world rotation. Both renderers' actual HDR sampling matrices must
 * equal Matrix4.makeRotationFromQuaternion(result).invert(), despite their different Euler conventions.
 */
export function studioRigWorldRotation(
  camera: Camera, preset: StudioPreset, lightDirection: readonly [number, number] | undefined,
  environmentRotation: number, target = new Quaternion(),
): Quaternion {
  const baseDirection = STUDIO_PRESET_LIGHT_DIRECTIONS[preset];
  if (!baseDirection) throw new Error("This preset uses the original studio lighting path.");
  const aim = new Quaternion().setFromUnitVectors(directionVector(baseDirection), directionVector(lightDirection ?? baseDirection));
  const spin = new Quaternion().setFromAxisAngle(WORLD_UP, environmentRotation * Math.PI / 180);
  return camera.getWorldQuaternion(target).multiply(spin).multiply(aim);
}

/** Linear HDR source, not PMREM/CubeUV: both raster IBL and the path tracer use this source. */
export function createStudioEnvironment(preset: StudioPreset): DataTexture {
  const width = 512, height = 256;
  const data = new Float32Array(width * height * 4);
  const panels = preset === "side"
    ? [{ x: -2.4, y: 1.2, z: 1.7, width: 2.2, height: 4, power: 5 }, { x: 3, y: 1, z: 0, width: 3, height: 4, power: 0.5 }]
    : preset === "rim"
      ? [{ x: -2, y: 2, z: -2, width: 2, height: 4, power: 7 }, { x: 2, y: 1.5, z: -1, width: 2, height: 4, power: 5 }, { x: 0, y: 1, z: 3, width: 5, height: 3, power: 0.7 }]
      : [{ x: -2, y: 2.8, z: 2, width: 4, height: 4, power: 4 }, { x: 2.6, y: 0.7, z: 1, width: 2, height: 5, power: 1.4 }];
  const rig = addedStudioRig(preset);
  const lights = rig?.lights ?? panels.map(p => {
    const center = new Vector3(p.x, p.y, p.z);
    const normal = center.clone().normalize();
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), normal).normalize();
    const up = new Vector3().crossVectors(normal, right);
    return { ...p, center, normal, right, up, distance: center.length() };
  });
  const direction = new Vector3();
  const hit = new Vector3();
  for (let y = 0; y < height; y++) {
    const theta = Math.PI * (1 - (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      direction.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      let radiance = rig ? rig.floor + rig.sky * Math.max(0, direction.y)
        : 0.12 + 0.16 * Math.max(0, direction.y);
      for (const light of lights) {
        const facing = direction.dot(light.normal);
        if (facing <= 0) continue;
        hit.copy(direction).multiplyScalar(light.distance / facing).sub(light.center);
        const u = Math.abs(hit.dot(light.right)) / (light.width / 2);
        const v = Math.abs(hit.dot(light.up)) / (light.height / 2);
        if (u < 1 && v < 1) radiance += light.power * Math.min(1, (1 - u) * 12, (1 - v) * 12);
      }
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = radiance;
      data[offset + 3] = 1;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function usesStudioLighting(style: Pick<StyleState, "materialPreset">): boolean {
  // Toon/Phong do not respond to RectAreaLight or physical environment lighting.
  return isPhysicalMaterialPreset(style.materialPreset);
}

export function configureStudioScene(
  scene: Scene, camera: Camera, settings: RenderSettings,
  style: Pick<StyleState, "mainLightIntensity" | "ambientLightIntensity" | "lightDirection">,
  lightStrength: number,
  environmentConvention: StudioEnvironmentConvention = "path-traced",
): void {
  scene.environmentIntensity = (style.ambientLightIntensity ?? 0.6) / 0.6 * lightStrength;
  scene.environmentRotation.set(0, settings.environmentRotation * Math.PI / 180, 0);
  let group = scene.getObjectByName("crystalsketch-studio-lights") as Group | undefined;
  if (!group) {
    group = new Group();
    group.name = "crystalsketch-studio-lights";
    group.add(new RectAreaLight(new Color("#ffffff"), 1, 1, 1));
    scene.add(group);
  }
  const radius = Math.max(1, Number(scene.userData.studioRadius) || 5);
  const rig = addedStudioRig(settings.studio);
  const lightCount = rig?.lights.length ?? 1;
  while (group.children.length > lightCount) group.remove(group.children[group.children.length - 1]!);
  while (group.children.length < lightCount) group.add(new RectAreaLight(new Color("#ffffff"), 1, 1, 1));
  if (rig) {
    const rotation = studioRigWorldRotation(camera, settings.studio, style.lightDirection, settings.environmentRotation);
    if (environmentConvention === "raster") {
      // r171 builds R(-Euler), whereas the path tracer builds inverse(R(Euler)).
      // Encoding -Euler(Q^-1) here makes the raster sampling matrix equal Q^-1 too.
      scene.environmentRotation.setFromQuaternion(rotation.clone().invert(), "XYZ");
      scene.environmentRotation.set(-scene.environmentRotation.x, -scene.environmentRotation.y, -scene.environmentRotation.z, "XYZ");
    } else scene.environmentRotation.setFromQuaternion(rotation, "XYZ");
    rig.lights.forEach((panel, index) => {
      const light = group.children[index] as RectAreaLight;
      light.position.copy(panel.center).applyQuaternion(rotation).multiplyScalar(radius);
      // Local +Z is outward; RectAreaLight emits along local -Z toward the crystal.
      light.quaternion.copy(rotation).multiply(panel.rotation);
      light.width = panel.width * radius;
      light.height = panel.height * radius;
      light.intensity = (style.mainLightIntensity ?? 0.7) * lightStrength * 2 * panel.intensity;
    });
    group.updateMatrixWorld(true);
    return;
  }
  const light = group.children[0] as RectAreaLight;
  const [azimuth, elevation] = style.lightDirection ?? DEFAULT_LIGHT_DIRECTION;
  const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
  light.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
    .applyQuaternion(camera.quaternion).multiplyScalar(radius * 2);
  light.lookAt(0, 0, 0);
  light.width = radius * 2.5;
  light.height = radius * 2.5;
  light.intensity = (style.mainLightIntensity ?? 0.7) * lightStrength * 2;
  group.updateMatrixWorld(true);
}
