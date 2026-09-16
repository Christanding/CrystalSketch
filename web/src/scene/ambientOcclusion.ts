import { Camera, Color, Scene, WebGLRenderer, type Material, type Texture, type WebGLRenderTarget } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { N8AOPass } from "n8ao";
import type { RenderSettings } from "../model/renderSettings";
import { ANNOTATION_LAYER, renderAnnotationOverlay } from "./renderOverlay";
import { createNativeAmbientOcclusionRenderer, sceneHasTransparentMaterials } from "./ambientOcclusionMaterials";

// N8AO 2.0.1 owns these resources but inherits Pass.dispose(), which is a no-op.
type DisposableN8AO = N8AOPass & Record<string, unknown> & {
  beautyRenderTarget: WebGLRenderTarget;
  autoDetectTransparency: boolean;
  setDisplayMode(mode: "AO" | "Combined"): void;
};
function disposeAmbientOcclusion(pass: DisposableN8AO) {
  const targets = ["beautyRenderTarget", "writeTargetInternal", "readTargetInternal", "accumulationRenderTarget",
    "depthDownsampleTarget", "transparencyRenderTargetDWFalse", "transparencyRenderTargetDWTrue"];
  for (const key of targets) (pass[key] as WebGLRenderTarget | undefined)?.dispose();
  const materials = new Set<Material>();
  for (const key of ["accumulationQuad", "depthDownsampleQuad", "depthCopyPass", "effectShaderQuad", "poissonBlurQuad", "effectCompositerQuad"]) {
    const quad = pass[key] as { material: Material; dispose(): void } | undefined;
    if (quad) { materials.add(quad.material); quad.dispose(); }
  }
  for (const key of ["standardDenoiseMaterial", "neuralDenoiseMaterial"]) {
    const material = pass[key] as Material | undefined;
    if (material && !materials.has(material)) material.dispose();
  }
  (pass.bluenoise as Texture | undefined)?.dispose();
}

export function createAmbientOcclusion(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
  const composer = new EffectComposer(renderer);
  const ao = new N8AOPass(scene, camera, 1, 1) as DisposableN8AO;
  const native = createNativeAmbientOcclusionRenderer(renderer);
  ao.autoDetectTransparency = false;
  ao.configuration.gammaCorrection = false;
  ao.configuration.neuralDenoise = false;
  ao.configuration.accumulate = false;
  ao.setQualityMode("Medium");
  const output = new OutputPass();
  const outputUniforms = Object.assign(output.uniforms, {
    n8SceneDepth: { value: null as Texture | null },
    n8BackgroundDepth: { value: 1 },
  });
  // Clear/background colors bypass tone mapping in the direct renderer. Keep that
  // behavior for opaque scenes. Transparent scenes use native composition below.
  // OutputPass still performs the single output color conversion and preserves alpha.
  output.material.fragmentShader = output.material.fragmentShader
    .replace("uniform sampler2D tDiffuse;", `uniform sampler2D tDiffuse;
      uniform highp sampler2D n8SceneDepth;
      uniform float n8BackgroundDepth;`)
    .replace("// tone mapping", `float n8Depth = texture2D(n8SceneDepth, vUv).r;
      bool n8HasSurface = n8Depth != n8BackgroundDepth;
      if (n8HasSurface) {
      // tone mapping`)
    .replace("// color space", `}
      // color space`);
  const aa = new SMAAPass(1, 1);
  composer.addPass(ao);
  composer.addPass(output);
  composer.addPass(aa);
  let width = 0, height = 0;
  let disposed = false;
  return {
    render(settings: RenderSettings, radius: number, transparent: boolean) {
      if (disposed) throw new Error("The AO renderer has been disposed.");
      const canvas = renderer.domElement;
      if (width !== canvas.width || height !== canvas.height) {
        width = canvas.width; height = canvas.height;
        composer.setPixelRatio(1);
        composer.setSize(width, height);
      }
      ao.configuration.aoRadius = Math.max(0.05, radius * settings.aoRadius);
      ao.configuration.intensity = settings.aoIntensity;
      const mask = camera.layers.mask;
      camera.layers.disable(ANNOTATION_LAYER);
      try {
        if (transparent || sceneHasTransparentMaterials(scene, camera)) {
          const target = renderer.getRenderTarget();
          const background = scene.background;
          const clearColor = renderer.getClearColor(new Color());
          const clearAlpha = renderer.getClearAlpha();
          const autoClear = renderer.autoClear, autoClearDepth = renderer.autoClearDepth;
          const xrEnabled = renderer.xr.enabled;
          const toneMapping = renderer.toneMapping, exposure = renderer.toneMappingExposure;
          const restoreRenderer = () => {
            renderer.setRenderTarget(target);
            renderer.setClearColor(clearColor, clearAlpha);
            renderer.autoClear = autoClear;
            renderer.autoClearDepth = autoClearDepth;
            renderer.xr.enabled = xrEnabled;
            renderer.toneMapping = toneMapping;
            renderer.toneMappingExposure = exposure;
            scene.background = background;
          };
          composer.renderToScreen = false;
          output.enabled = aa.enabled = false;
          ao.configuration.transparencyAware = false;
          ao.setDisplayMode("AO");
          try {
            native.render(scene, camera, () => {
              try { composer.render(); }
              finally { restoreRenderer(); }
              return composer.readBuffer.texture;
            });
          } finally {
            composer.renderToScreen = true;
            output.enabled = aa.enabled = true;
            ao.setDisplayMode("Combined");
            restoreRenderer();
          }
        } else {
          ao.configuration.transparencyAware = false;
          outputUniforms.n8SceneDepth.value = ao.beautyRenderTarget.depthTexture;
          outputUniforms.n8BackgroundDepth.value = renderer.capabilities.reverseDepthBuffer ? 0 : 1;
          composer.render();
        }
      }
      finally { camera.layers.mask = mask; }
      renderAnnotationOverlay(renderer, scene, camera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      native.dispose();
      disposeAmbientOcclusion(ao);
      output.dispose(); aa.dispose(); composer.dispose();
    },
  };
}
