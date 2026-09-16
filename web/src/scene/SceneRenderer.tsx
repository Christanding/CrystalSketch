import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AgXToneMapping, NeutralToneMapping, NoToneMapping } from "three";
import { createCartoonRenderer } from "./CartoonOutline";
import { isMetalMaterialPreset, isPhysicalMaterialPreset } from "../model/materialPresets";
import type { RenderSettings } from "../model/renderSettings";
import { ANNOTATION_LAYER, renderAnnotationOverlay } from "./renderOverlay";
import type { createAmbientOcclusion } from "./ambientOcclusion";

export default function SceneRenderer({ presetId, settings, aoRadius, transparent, traceVisible = false,
  restart = 0, onError }: { presetId: string; settings: RenderSettings; aoRadius: number; transparent: boolean; traceVisible?: boolean;
  restart?: number;
  onError?: (message: string) => void;
}) {
  const { gl, scene, camera, invalidate } = useThree();
  const physical = isPhysicalMaterialPreset(presetId);
  const toneMapping = physical ? AgXToneMapping : isMetalMaterialPreset(presetId) ? NeutralToneMapping : NoToneMapping;
  const legacy = useMemo(() => createCartoonRenderer(gl, toneMapping), [gl, toneMapping]);
  const ao = useRef<ReturnType<typeof createAmbientOcclusion> | null>(null);
  const wantsAo = physical && settings.mode === "realtime" && settings.aoEnabled;
  useEffect(() => () => legacy.dispose(), [legacy]);
  useEffect(() => {
    if (!wantsAo) return;
    let active = true;
    import("./ambientOcclusion").then(module => {
      if (!active) return;
      ao.current = module.createAmbientOcclusion(gl, scene, camera);
      invalidate();
    }).catch(error => { if (active) onError?.(error instanceof Error ? error.message : "AO unavailable"); });
    return () => { active = false; ao.current?.dispose(); ao.current = null; };
  }, [wantsAo, gl, scene, camera, invalidate, onError, restart]);
  useFrame(() => {
    gl.toneMapping = toneMapping;
    gl.toneMappingExposure = physical ? settings.exposure : 1;
    camera.layers.enable(ANNOTATION_LAYER);
    if (traceVisible) { renderAnnotationOverlay(gl, scene, camera, true); return; }
    if (wantsAo && ao.current) {
      try { ao.current.render(settings, aoRadius, transparent); }
      catch (error) {
        ao.current.dispose(); ao.current = null;
        onError?.(error instanceof Error ? error.message : "AO unavailable");
        legacy.render(scene, camera);
      }
    } else if (physical) gl.render(scene, camera);
    else legacy.render(scene, camera);
  }, 1);
  return null;
}
