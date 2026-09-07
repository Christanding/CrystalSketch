import { type Ref, useEffect, useMemo } from "react";
import type { ThreeElements } from "@react-three/fiber";
import {
  BackSide,
  DoubleSide,
  DataTexture,
  FrontSide,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  ShaderChunk,
  type Material,
  type Side,
} from "three";

import type { ResolvedStructureMaterialFamily } from "./materialPresetResolver";
import { isMetalMaterialPreset } from "../model/materialPresets";

export type StructureMeshMaterial =
  | MeshToonMaterial
  | MeshPhongMaterial
  | MeshBasicMaterial
  | MeshLambertMaterial
  | MeshPhysicalMaterial
  | MeshStandardMaterial;

export function StructureMaterial({
  color,
  depthWrite,
  materialFamily,
  materialRef,
  onBeforeCompile,
  opacity,
  outlineVisible,
  polygonOffset,
  polygonOffsetFactor,
  polygonOffsetUnits,
  side,
  transparent,
  vertexColors,
  customProgramCacheKey,
}: {
  color?: string;
  depthWrite: boolean;
  materialFamily: ResolvedStructureMaterialFamily;
  materialRef?: Ref<StructureMeshMaterial>;
  onBeforeCompile?: Material["onBeforeCompile"];
  opacity: number;
  outlineVisible?: boolean;
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  side?: Side;
  transparent: boolean;
  vertexColors?: boolean;
  customProgramCacheKey?: Material["customProgramCacheKey"];
}) {
  const calibrateDiffuse = (materialFamily.id === "cartoon"
    && (materialFamily.material.type === "MeshPhongMaterial" || materialFamily.material.type === "MeshToonMaterial"))
    || (isMetalMaterialPreset(materialFamily.id) && materialFamily.material.type === "MeshToonMaterial");
  const shadeCel = materialFamily.id === "cel-shaded" && materialFamily.material.type === "MeshPhongMaterial";
  const shadeJade = materialFamily.id === "soft-jade" && materialFamily.material.type === "MeshPhongMaterial";
  const shaderAdapter = shadeJade ? shadeJadeFragmentShader : shadeCel ? shadeCelFragmentShader : calibrateDiffuse ? calibrateCartoonDiffuseShader : null;
  const shaderVersion = shadeJade ? "jade-scattering-r171-v1" : shadeCel ? "cel-key-r171-v1" : "cartoon-diffuse-r171-v1";
  const compileMaterial = useMemo(() => {
    if (!shaderAdapter) return onBeforeCompile;
    const compile: Material["onBeforeCompile"] = function (this: Material, shader, renderer) {
      onBeforeCompile?.call(this, shader, renderer);
      shader.fragmentShader = shaderAdapter(shader.fragmentShader);
    };
    return compile;
  }, [shaderAdapter, onBeforeCompile]);
  const programCacheKey = useMemo(() => shaderAdapter
    ? () => `${shaderVersion}:${customProgramCacheKey?.() ?? onBeforeCompile?.toString() ?? ""}`
    : customProgramCacheKey, [shaderAdapter, shaderVersion, customProgramCacheKey, onBeforeCompile]);
  const materialKey = [
    materialFamily.id,
    transparent ? "transparent" : "opaque",
    vertexColors ? "vertex-colors" : "solid",
    side ?? "front",
  ].join(":");
  const commonProps = {
    color,
    depthWrite,
    opacity,
    toneMapped: !(isMetalMaterialPreset(materialFamily.id) && materialFamily.material.type === "MeshToonMaterial"),
    userData: { outlineParameters: {
      visible: outlineVisible ?? (!["satin-matte", "soft-jade", "soft-velvet"].includes(materialFamily.id) && !isMetalMaterialPreset(materialFamily.id)),
      thickness: materialFamily.id === "soft-ceramic" ? 0.0008 : 0.0015,
    } },
    onBeforeCompile: compileMaterial,
    polygonOffset,
    polygonOffsetFactor,
    polygonOffsetUnits,
    side,
    transparent,
    vertexColors,
    customProgramCacheKey: programCacheKey,
  };
  const presetProps = resolveThreeProps(materialFamily.material.props);
  const resolvedCommonProps = omitUndefined(commonProps);

  if (materialFamily.material.type === "MeshToonMaterial") {
    return <ToonMaterial ref={materialRef as Ref<MeshToonMaterial>}
      key={materialKey} {...presetProps} {...resolvedCommonProps} />;
  }

  if (materialFamily.material.type === "MeshPhongMaterial") {
    return <meshPhongMaterial ref={materialRef as Ref<MeshPhongMaterial>}
      key={materialKey} {...presetProps} {...resolvedCommonProps} />;
  }

  if (materialFamily.material.type === "MeshBasicMaterial") {
    return (
      <meshBasicMaterial
        ref={materialRef as Ref<MeshBasicMaterial>}
        key={materialKey}
        {...presetProps}
        {...resolvedCommonProps}
      />
    );
  }

  if (materialFamily.material.type === "MeshLambertMaterial") {
    return (
      <meshLambertMaterial
        ref={materialRef as Ref<MeshLambertMaterial>}
        key={materialKey}
        {...presetProps}
        {...resolvedCommonProps}
      />
    );
  }

  if (materialFamily.material.type === "MeshPhysicalMaterial") {
    return (
      <meshPhysicalMaterial
        ref={materialRef as Ref<MeshPhysicalMaterial>}
        key={materialKey}
        {...presetProps}
        {...resolvedCommonProps}
      />
    );
  }

  return (
    <meshStandardMaterial
      ref={materialRef as Ref<MeshStandardMaterial>}
      key={materialKey}
      {...presetProps}
      {...resolvedCommonProps}
    />
  );
}

export function calibrateCartoonDiffuseShader(fragmentShader: string): string {
  const marker = "#include <lights_fragment_end>";
  if ((!fragmentShader.includes("#define PHONG") && !fragmentShader.includes("#define TOON")) || !fragmentShader.includes(marker)) {
    throw new Error("Three.js lit shader no longer matches the cartoon diffuse adapter.");
  }
  // Cancel Lambert's 1/pi for palette-oriented illustration lighting only.
  // Specular highlights, opacity, occlusion and linear-to-sRGB output stay untouched.
  return fragmentShader.replace(marker, `${marker}
  reflectedLight.directDiffuse *= PI;
  reflectedLight.indirectDiffuse *= PI;`);
}

export function shadeCelFragmentShader(fragmentShader: string): string {
  const marker = "#include <lights_phong_pars_fragment>";
  const diffuse = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );";
  if (!fragmentShader.includes("#define PHONG") || !fragmentShader.includes(marker)
    || !ShaderChunk.lights_phong_pars_fragment.includes(diffuse)) {
    throw new Error("Three.js lit shader no longer matches the cel adapter.");
  }
  // The first directional light is the controllable key. Quantizing fill lights
  // independently creates overlapping bands; keep their diffuse and all specular intact.
  const lighting = ShaderChunk.lights_phong_pars_fragment.replace(diffuse, `
    vec3 celIrradiance = irradiance;
    #if NUM_DIR_LIGHTS > 0
      if (dot(directLight.direction, directionalLights[0].direction) > 0.9999) {
        float celEdge = max(fwidth(dotNL), 0.015);
        float celBand = smoothstep(0.22 - celEdge, 0.22 + celEdge, dotNL);
        celIrradiance = directLight.color * mix(0.03, 0.6, celBand) * (0.88 + 0.12 * dotNL);
      }
    #endif
    reflectedLight.directDiffuse += celIrradiance * BRDF_Lambert(material.diffuseColor);`);
  return fragmentShader.replace(marker, lighting);
}

export function shadeJadeFragmentShader(fragmentShader: string): string {
  const marker = "#include <lights_phong_pars_fragment>";
  const diffuse = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );";
  if (!fragmentShader.includes("#define PHONG") || !fragmentShader.includes(marker)
    || !ShaderChunk.lights_phong_pars_fragment.includes(diffuse)) {
    throw new Error("Three.js lit shader no longer matches the jade scattering adapter.");
  }
  // Fast translucency approach used by Three.js's SubsurfaceScatteringShader.
  // Rounded surfaces use normalized view-path thickness instead of a UV map.
  // This is an artistic SSS approximation, not full volumetric light transport.
  const lighting = ShaderChunk.lights_phong_pars_fragment.replace(diffuse, `
    float jadeCosine = dot(geometryNormal, directLight.direction);
    float jadeWrapped = saturate((jadeCosine + 0.2) / 1.2);
    reflectedLight.directDiffuse += directLight.color * mix(dotNL, jadeWrapped, 0.65) * BRDF_Lambert(material.diffuseColor);
    vec3 jadeScatteringHalf = normalize(directLight.direction + geometryNormal * 0.18);
    float jadePhase = pow(saturate(dot(geometryViewDir, -jadeScatteringHalf)), 2.0);
    float jadeThickness = max(0.08, abs(dot(geometryNormal, geometryViewDir)));
    float jadeTransmittance = exp(-2.3 * jadeThickness);
    reflectedLight.directDiffuse += directLight.color * material.diffuseColor * jadePhase * jadeTransmittance * 0.4;`);
  return fragmentShader.replace(marker, lighting);
}

function ToonMaterial(props: ThreeElements["meshToonMaterial"]) {
  const gradientMap = useMemo(() => {
    const texture = new DataTexture(new Uint8Array([70, 150, 255]), 3, 1, RedFormat);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }, []);
  useEffect(() => () => gradientMap.dispose(), [gradientMap]);
  return <meshToonMaterial {...props} gradientMap={gradientMap} />;
}

function omitUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

function resolveThreeProps(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, resolveThreePropValue(value)]),
  );
}

function resolveThreePropValue(value: unknown): unknown {
  if (typeof value === "string") {
    return THREE_PROP_CONSTANTS[value] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(resolveThreePropValue);
  }
  if (typeof value === "object" && value !== null) {
    return resolveThreeProps(value as Record<string, unknown>);
  }

  return value;
}

const THREE_PROP_CONSTANTS: Record<string, unknown> = {
  BackSide,
  DoubleSide,
  FrontSide,
};
