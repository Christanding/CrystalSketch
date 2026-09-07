import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { NeutralToneMapping, NoToneMapping, type ToneMapping, type Camera, type Mesh, type Scene, type ShaderMaterial, type WebGLRenderer } from "three";
import { isMetalMaterialPreset } from "../model/materialPresets";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";

// OutlineEffect r171 omits BatchedMesh transforms. Keep the upstream pass and
// supply those transforms so each atom's outline stays attached to its sphere.
export function createCartoonRenderer(renderer: WebGLRenderer, selectedToneMapping: ToneMapping = NoToneMapping) {
  const effect = new OutlineEffect(renderer, { defaultThickness: .0015, defaultColor: [0, 0, 0] });
  const materials = new Set<ShaderMaterial>();
  return {
    render(scene: Scene, camera: Camera) {
      const beforeRender = scene.onBeforeRender;
      const toneMapping = renderer.toneMapping;
      renderer.toneMapping = selectedToneMapping;
      scene.onBeforeRender = (...args) => {
        beforeRender.apply(scene, args);
        scene.traverse(object => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of meshMaterials) {
            if (material.type !== "OutlineEffect" || materials.has(material as ShaderMaterial)) continue;
            const outline = material as ShaderMaterial;
            outline.vertexShader = outline.vertexShader
              .replace("#include <common>", "#include <common>\n#include <batching_pars_vertex>")
              .replace("#include <begin_vertex>", "#include <begin_vertex>\n#include <batching_vertex>")
              .replace("vec3 outlineNormal = - objectNormal;", `vec3 outlineNormal = - objectNormal;
                vec4 outlinePosition = vec4(transformed, 1.0);
                #ifdef USE_BATCHING
                  outlinePosition = batchingMatrix * outlinePosition;
                  outlineNormal = normalize(mat3(batchingMatrix) * outlineNormal);
                #endif`)
              .replace("outlineNormal, vec4( transformed, 1.0 )", "outlineNormal, outlinePosition");
            outline.needsUpdate = true;
            materials.add(outline);
          }
        });
      };
      try {
        effect.render(scene, camera);
      } finally {
        scene.onBeforeRender = beforeRender;
        renderer.toneMapping = toneMapping;
      }
    },
    dispose() { materials.forEach(material => material.dispose()); materials.clear(); },
  };
}

export function CartoonOutline({ presetId = "cartoon" }: { presetId?: string }) {
  const { gl } = useThree();
  const toneMapping = isMetalMaterialPreset(presetId) ? NeutralToneMapping : NoToneMapping;
  const renderer = useMemo(() => createCartoonRenderer(gl, toneMapping), [gl, toneMapping]);
  useEffect(() => () => renderer.dispose(), [renderer]);
  useFrame(({ scene, camera }) => renderer.render(scene, camera), 1);
  return null;
}
