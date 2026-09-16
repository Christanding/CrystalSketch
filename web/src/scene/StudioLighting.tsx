import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import type { StyleState } from "../model/appearance";
import { STUDIO_PRESET_LIGHT_DIRECTIONS, type RenderSettings } from "../model/renderSettings";
import { configureStudioScene, createStudioEnvironment } from "./studioEnvironment";

RectAreaLightUniformsLib.init();

export default function StudioLighting({ settings, style, lightStrength, span }: {
  settings: RenderSettings; style: StyleState; lightStrength: number; span: number;
}) {
  const { gl, scene, camera, invalidate } = useThree();
  const environment = useMemo(() => createStudioEnvironment(settings.studio), [settings.studio]);
  useLayoutEffect(() => {
    const previous = { environment: scene.environment, intensity: scene.environmentIntensity,
      rotation: scene.environmentRotation.clone(), radius: scene.userData.studioRadius };
    scene.environment = environment;
    scene.userData.studioRadius = span;
    configureStudioScene(scene, camera, settings, style, lightStrength, "raster");
    // Generate/compile the LTC lookup only after this feature is actually activated.
    invalidate();
    return () => {
      scene.environment = previous.environment;
      scene.environmentIntensity = previous.intensity;
      scene.environmentRotation.copy(previous.rotation);
      scene.userData.studioRadius = previous.radius;
      scene.getObjectByName("crystalsketch-studio-lights")?.removeFromParent();
      environment.dispose();
      gl.renderLists.dispose();
      invalidate();
    };
  }, [environment, scene, camera, gl, invalidate]);
  useLayoutEffect(() => { scene.userData.studioRadius = span; invalidate(); }, [scene, span, settings, style, lightStrength, invalidate]);
  // New view-relative rigs follow camera-controller updates (0) before scene rendering (1).
  // Preserve the original four presets' previous frame priority.
  useFrame(() => configureStudioScene(scene, camera, settings, style, lightStrength, "raster"),
    STUDIO_PRESET_LIGHT_DIRECTIONS[settings.studio] ? 0.5 : 0);
  return null;
}
