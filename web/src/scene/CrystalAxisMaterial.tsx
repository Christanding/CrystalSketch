import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import { NeutralToneMapping, NoToneMapping } from "three";
import { DEFAULT_CRYSTAL_AXIS_MATERIAL, type CrystalAxisMaterialState } from "../model/appearance";
import { isMetalMaterialPreset } from "../model/materialPresets";
import { MaterialPresetLights } from "./MaterialPresetLights";
import { MetalEnvironment } from "./MetalEnvironment";
import { StructureMaterial } from "./StructureMaterial";
import { resolveStructureMaterialFamilyForStyle, resolveStructureMaterialFamilyForTarget } from "./materialPresetResolver";

export function CrystalAxisLighting({ materialState = DEFAULT_CRYSTAL_AXIS_MATERIAL }: { materialState?: CrystalAxisMaterialState }) {
  const { gl, invalidate } = useThree();
  const family = useMemo(() => resolveStructureMaterialFamilyForStyle(materialState), [materialState.materialPreset]);
  const toneMapping = isMetalMaterialPreset(materialState.materialPreset) ? NeutralToneMapping : NoToneMapping;
  useLayoutEffect(() => {
    const previous = gl.toneMapping;
    gl.toneMapping = toneMapping;
    invalidate();
    return () => {
      if (gl.toneMapping === toneMapping) gl.toneMapping = previous;
    };
  }, [gl, invalidate, toneMapping]);
  return <>
    <MaterialPresetLights presetId={family.id} lighting={family.lighting}
      ambientIntensity={materialState.ambientLightIntensity} mainIntensity={materialState.mainLightIntensity}
      direction={materialState.lightDirection} intensityScale={materialState.lightStrength} />
    <MetalEnvironment presetId={family.id} ambientIntensity={materialState.ambientLightIntensity}
      intensityScale={materialState.lightStrength} />
  </>;
}

export function CrystalAxisMaterial({ materialState = DEFAULT_CRYSTAL_AXIS_MATERIAL, color, target = "bond" }: {
  materialState?: CrystalAxisMaterialState;
  color: string;
  target?: "atom" | "bond";
}) {
  const family = useMemo(() => resolveStructureMaterialFamilyForTarget(materialState, target), [materialState.materialPreset, target]);
  // Keep the original small arrow silhouettes; only the surface finish follows the structure.
  return <StructureMaterial materialFamily={family} color={color} opacity={1} depthWrite transparent={false} outlineVisible={false} />;
}
