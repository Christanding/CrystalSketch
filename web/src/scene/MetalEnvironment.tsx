import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import { Color, Euler, Mesh, MeshBasicMaterial, PlaneGeometry, PMREMGenerator, Quaternion, Scene } from "three";

import { isMetalMaterialPreset } from "../model/materialPresets";

export function MetalEnvironment({
  presetId,
  ambientIntensity = 0.6,
  intensityScale = 1,
}: {
  presetId: string;
  ambientIntensity?: number;
  intensityScale?: number;
}) {
  const { camera, gl, scene, invalidate } = useThree();
  const enabled = isMetalMaterialPreset(presetId);
  const inverseCamera = useMemo(() => new Quaternion(), []);

  useLayoutEffect(() => {
    if (!enabled) return;
    const studio = createMetalStudio();
    const generator = new PMREMGenerator(gl);
    const target = (() => {
      try { return generator.fromScene(studio.scene, 0.04); }
      finally { studio.dispose(); generator.dispose(); }
    })();
    const previous = {
      environment: scene.environment,
      intensity: scene.environmentIntensity,
      rotation: scene.environmentRotation.clone(),
    };
    // One prefiltered map per active renderer, shared by all atoms/bonds.
    // Never assign scene.background: transparent exports must stay transparent.
    scene.environment = target.texture;
    setMetalEnvironmentRotation(scene.environmentRotation, camera.quaternion, inverseCamera);
    invalidate();
    return () => {
      if (scene.environment === target.texture) {
        scene.environment = previous.environment;
        scene.environmentIntensity = previous.intensity;
        scene.environmentRotation.copy(previous.rotation);
      }
      target.dispose();
      invalidate();
    };
  }, [enabled, camera, gl, scene, invalidate, inverseCamera]);

  useLayoutEffect(() => {
    if (!enabled) return;
    scene.environmentIntensity = Math.max(0, intensityScale) * Math.max(0, ambientIntensity) / 0.6;
    invalidate();
  }, [enabled, scene, intensityScale, ambientIntensity, invalidate]);

  useFrame(() => {
    if (enabled) setMetalEnvironmentRotation(scene.environmentRotation, camera.quaternion, inverseCamera);
  });
  return null;
}

export function setMetalEnvironmentRotation(rotation: Euler, camera: Quaternion, inverse: Quaternion) {
  rotation.setFromQuaternion(inverse.copy(camera).invert(), "XYZ");
  // r171 negates Euler components when constructing the PMREM sampling matrix.
  // Supply the inverse camera transform in that convention, not a negated camera Euler.
  rotation.set(-rotation.x, -rotation.y, -rotation.z, "XYZ");
}

function createMetalStudio() {
  const scene = new Scene();
  scene.background = new Color().setScalar(0.7);
  const geometry = new PlaneGeometry();
  const lights = [
    { position: [4.5, 4.5, 3], size: [7, 9], radiance: 4 },
    { position: [0, -5, 4], size: [14, 5], radiance: 0.2 },
  ] as const;
  const materials = lights.map(({ position, size, radiance }) => {
    const material = new MeshBasicMaterial({ color: new Color().setScalar(radiance), toneMapped: false });
    const panel = new Mesh(geometry, material);
    panel.position.set(position[0], position[1], position[2]);
    panel.scale.set(size[0], size[1], 1);
    panel.lookAt(0, 0, 0);
    scene.add(panel);
    return material;
  });
  return { scene, dispose() { geometry.dispose(); materials.forEach(material => material.dispose()); } };
}
