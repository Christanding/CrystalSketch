import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, spyOn, test } from "bun:test";
import type { ReactElement, SetStateAction } from "react";
import { AgXToneMapping, BoxGeometry, Color, Euler, Group, Material, Mesh, MeshPhysicalMaterial, NoBlending, OrthographicCamera, Quaternion, Scene, ShaderLib, Texture, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { N8AOPass } from "n8ao";
import { createAmbientOcclusion } from "../src/scene/ambientOcclusion";
import { createNativeAmbientOcclusionRenderer, sceneHasTransparentMaterials } from "../src/scene/ambientOcclusionMaterials";
import { enableBatchedInstanceRgba } from "../src/scene/batchedInstanceRgba";
import * as RenderOverlay from "../src/scene/renderOverlay";
import { setMetalEnvironmentRotation } from "../src/scene/MetalEnvironment";
import { configureStudioScene, createStudioEnvironment, NEW_STUDIO_LIGHTING_RIGS, usesStudioLighting } from "../src/scene/studioEnvironment";
import { crystalAxisLabelFontSize, ORIENTATION_GIZMO_ZOOM_PER_CANVAS_PIXEL } from "../src/scene/OrientationGizmo";
import { waitForGpuCompletion } from "../src/scene/pathTracingRenderer";

import { LightingControls, lightDirectionFromPoint } from "../src/app/inspector/LightingControls";
import { MaterialPresetLights } from "../src/scene/MaterialPresetLights";
import cartoonPreset from "../src/data/material-presets/presets/cartoon.json";
import type { MaterialPresetLight } from "../src/model/materialPresets";
import { isMetalMaterialPreset } from "../src/model/materialPresets";
import { createDefaultStyle, crystalAxisMaterialForStyle, type StyleState } from "../src/model/appearance";
import { readRenderSettings, STUDIO_PRESET_LIGHT_DIRECTIONS } from "../src/model/renderSettings";
import { RenderingPanel } from "../src/app/inspector/RenderingPanel";
import type { InspectorSettingsActions, InspectorSettingsModel } from "../src/app/inspector/InspectorSettingsPanel";

describe("lighting controls", () => {
  test.each([false, true])("keeps lazy low-resolution tracing safe across activation and disposal (activate=%s)", async activate => {
    interface NativeRenderer {
      camera: Camera;
      material: Material & { backgroundAlpha: number; cameraWorldMatrix: Camera["matrixWorld"]; _listeners?: Record<string, unknown[]> };
      samples: number; alpha: boolean; tiles: Vector2;
      _primaryTarget: WebGLRenderTarget; _blendTargets: WebGLRenderTarget[]; _sobolTarget: WebGLRenderTarget;
      _compileFunction: () => void;
    }
    interface NativeTracer {
      scene: Scene; camera: Camera;
      _pathTracer: NativeRenderer; _lowResPathTracer: NativeRenderer | null;
      dynamicLowRes: boolean; renderToCanvas: boolean; synchronizeRenderSize: boolean;
      renderDelay: number; fadeDuration: number; minSamples: number; lowResScale: number;
      setScene(scene: Scene, camera: Camera): unknown;
      setCamera(camera: Camera): void; updateCamera(): void; reset(): void; renderSample(): void; dispose(): void;
    }
    const vendorPath = "three-gpu-pathtracer/src/core/WebGLPathTracer.js";
    const { WebGLPathTracer } = await import(vendorPath) as { WebGLPathTracer: {
      new (renderer: WebGLRenderer): NativeTracer; prototype: NativeTracer;
    } };
    let tracer: NativeTracer | undefined, bound: WebGLRenderTarget | null = null;
    let clearAlpha = 0, sobolDraws = 0, disposed = false;
    const drawingSize = new Vector2(800, 600), clearColor = new Color(), events: string[] = [];
    const targetOwner = () => bound === tracer?._pathTracer._primaryTarget ? "main"
      : bound === tracer?._lowResPathTracer?._primaryTarget ? "low" : "other";
    const renderer = {
      autoClear: true, extensions: { get: () => true },
      getContextAttributes: () => ({ premultipliedAlpha: false }),
      getDrawingBufferSize: (value: Vector2) => value.copy(drawingSize),
      getRenderTarget: () => bound,
      setRenderTarget: (target: WebGLRenderTarget | null) => { bound = target; },
      getScissorTest: () => false,
      getScissor: (value: Vector4) => value.set(0, 0, drawingSize.x, drawingSize.y),
      getViewport: (value: Vector4) => value.set(0, 0, drawingSize.x, drawingSize.y),
      setScissorTest() {}, setScissor() {}, setViewport() {},
      getClearColor: (value: Color) => value.copy(clearColor), getClearAlpha: () => clearAlpha,
      setClearColor: (value: Color | number, alpha: number) => { clearColor.set(value); clearAlpha = alpha; },
      clearColor: () => { events.push(`${targetOwner()}:clear`); },
      render: (object: Mesh) => {
        if (!Array.isArray(object.material) && object.material?.constructor.name === "SobolNumbersMaterial") sobolDraws++;
        if (object.material === tracer?._pathTracer.material) events.push(`${targetOwner()}:draw`);
      },
      compileAsync: () => Promise.resolve(),
    } as unknown as WebGLRenderer;
    // Scene packing is unrelated to this lifecycle. Keep the real constructors,
    // camera, reset, tile generator, alpha, scale and disposal paths; replace GPU calls only.
    const setScene = spyOn(WebGLPathTracer.prototype, "setScene").mockImplementation(function (this: NativeTracer, scene, camera) {
      this.scene = scene; this.camera = camera; this.updateCamera();
    });
    const step = async () => { await Promise.resolve(); tracer!.renderSample(); await Promise.resolve(); };
    const size = (value: NativeRenderer) => [value._primaryTarget.width, value._primaryTarget.height];
    try {
      tracer = new WebGLPathTracer(renderer);
      const main = tracer._pathTracer;
      expect(tracer._lowResPathTracer).toBeNull();
      expect(sobolDraws).toBe(1);
      tracer.renderDelay = tracer.fadeDuration = 0;
      tracer.minSamples = Infinity;
      tracer.renderToCanvas = false;
      main.tiles.set(1, 1); main.material.backgroundAlpha = 1;
      const camera = new OrthographicCamera(-2, 2, 1.5, -1.5, 0.1, 100);
      camera.position.set(2, 3, 5); camera.lookAt(0, 0, 0);
      tracer.setCamera(camera);
      tracer.reset(); await step(); await step();
      expect(size(main)).toEqual([800, 600]);
      expect(tracer._lowResPathTracer).toBeNull();
      drawingSize.set(1280, 960);
      tracer.dynamicLowRes = true; tracer.reset(); await step();
      expect(size(main)).toEqual([1280, 960]);
      expect(tracer._lowResPathTracer).toBeNull();
      tracer.dynamicLowRes = false; tracer.renderToCanvas = true; await step();
      expect(tracer._lowResPathTracer).toBeNull();
      expect(sobolDraws).toBe(1);
      if (activate) {
        tracer.dynamicLowRes = true;
        await step(); await step(); await step();
        const low = tracer._lowResPathTracer!;
        expect(low).not.toBeNull();
        expect(sobolDraws).toBe(2);
        expect(low.tiles.toArray()).toEqual([1, 1]);
        expect(size(low)).toEqual([320, 240]);
        expect(low.camera).toBe(camera);
        expect(low.material).toBe(main.material);
        expect(low.samples).toBe(1);
        events.length = 0; tracer.reset(); await step();
        const resetAndDraw = ["main:clear", "low:clear", "main:draw", "low:draw"].map(event => events.indexOf(event));
        expect(resetAndDraw.every(index => index >= 0)).toBe(true);
        expect(resetAndDraw).toEqual([...resetAndDraw].sort((a, b) => a - b));
        tracer.dynamicLowRes = false;
        camera.position.x += 1; tracer.updateCamera(); drawingSize.set(1536, 1024);
        events.length = 0; await step();
        expect(tracer._lowResPathTracer).toBe(low);
        expect(size(low)).toEqual([384, 256]);
        expect(low.material.cameraWorldMatrix.equals(camera.matrixWorld)).toBe(true);
        expect(events).not.toContain("low:draw");
        expect(low.samples).toBe(0);
        tracer.dynamicLowRes = true; await step();
        expect(tracer._lowResPathTracer).toBe(low);
        expect(low.samples).toBe(1);
        tracer.lowResScale = 0.5; await step();
        expect(size(main)).toEqual([1536, 1024]);
        expect(size(low)).toEqual([768, 512]);
        drawingSize.set(1, 1); await step();
        expect(size(low)).toEqual([1, 1]);
        tracer.synchronizeRenderSize = false; drawingSize.set(320, 200); await step();
        expect(size(main)).toEqual([1, 1]); expect(size(low)).toEqual([1, 1]);
        main.material.backgroundAlpha = 0; await step();
        expect(main.alpha).toBe(true); expect(low.alpha).toBe(true);
        main.material.backgroundAlpha = 1; await step();
        expect(main.alpha).toBe(false); expect(low.alpha).toBe(false);
        expect(sobolDraws).toBe(2);
      }
      const nativeRenderers = [main, tracer._lowResPathTracer].filter((value): value is NativeRenderer => value !== null);
      const resources = nativeRenderers.flatMap(value => [value._primaryTarget, ...value._blendTargets, value._sobolTarget]);
      const releases = resources.map(() => 0);
      resources.forEach((target, i) => target.addEventListener("dispose", () => { releases[i] = releases[i]! + 1; }));
      let sharedMaterialDisposals = 0;
      main.material.addEventListener("dispose", () => { sharedMaterialDisposals++; });
      for (const value of nativeRenderers) expect(value.material._listeners?.recompilation).toContain(value._compileFunction);
      tracer.dispose(); disposed = true;
      expect(releases).toEqual(resources.map(() => 1));
      expect(tracer._lowResPathTracer).toBeNull();
      expect(sharedMaterialDisposals).toBe(0);
      for (const value of nativeRenderers) expect(value.material._listeners?.recompilation ?? []).not.toContain(value._compileFunction);
    } finally {
      if (!disposed) tracer?.dispose();
      setScene.mockRestore();
    }
  });

  test.each([1, 2])("publishes the latest vendor accumulation with tile grid %i across reset, resize and opaque rendering", async tileGrid => {
    // Import the patched source used by Vite, not Bun's package-main UMD build.
    const vendorPath = "three-gpu-pathtracer/src/core/PathTracingRenderer.js";
    interface VendorRenderer {
      readonly target: WebGLRenderTarget;
      samples: number;
      alpha: boolean;
      update(): void;
      reset(): void;
      setSize(width: number, height: number): void;
    }
    const vendor = await import(vendorPath) as { PathTracingRenderer: { prototype: VendorRenderer } };
    const primary = new WebGLRenderTarget(4, 4);
    const blends = [new WebGLRenderTarget(4, 4), new WebGLRenderTarget(4, 4)];
    const targets = [primary, ...blends];
    const byTexture = new Map(targets.map(target => [target.texture, target]));
    const storage = new WeakMap<WebGLRenderTarget, Float64Array>();
    const pixels = (target: WebGLRenderTarget) => {
      let values = storage.get(target);
      if (!values || values.length !== target.width * target.height) {
        values = new Float64Array(target.width * target.height); storage.set(target, values);
      }
      return values;
    };
    let bound: WebGLRenderTarget | null = null, latestWritten: WebGLRenderTarget | null = null;
    let clearAlpha = 0, blendDraws = 0;
    const clearColor = new Color();
    const destination = () => {
      if (!bound) throw new Error("Expected an offscreen accumulation target");
      return bound;
    };
    const renderer = {
      autoClear: true,
      getRenderTarget: () => bound,
      setRenderTarget: (target: WebGLRenderTarget | null) => { bound = target; },
      getScissorTest: () => false,
      getScissor: (value: Vector4) => value.set(0, 0, 4, 4),
      getViewport: (value: Vector4) => value.set(0, 0, 4, 4),
      setScissorTest() {}, setScissor() {}, setViewport() {},
      getClearColor: (value: Color) => value.copy(clearColor),
      getClearAlpha: () => clearAlpha,
      setClearColor: (value: Color | number, alpha: number) => { clearColor.set(value); clearAlpha = alpha; },
      clearColor: () => { pixels(destination()).fill(0); },
    };
    const material = {
      resolution: new Vector2(), seed: 0, bounces: 3, transmissiveBounces: 0,
      opacity: 1, blending: NoBlending as number, onBeforeRender() {},
      stratifiedTexture: { stableNoise: true, init() {}, next() {}, reset() {} },
    };
    const blendMaterial = { opacity: 1, target1: primary.texture, target2: primary.texture };
    // Only GPU draws are replaced: the real vendor generator selects targets,
    // advances tiles/samples and performs all reset/resize/alpha transitions.
    const tracer = Object.assign(Object.create(vendor.PathTracingRenderer.prototype), {
      _renderer: renderer, _primaryTarget: primary, _blendTargets: blends,
      _sobolTarget: { texture: null }, _subframe: new Vector4(0, 0, 1, 1),
      _alpha: true, _opacityFactor: 1, tiles: new Vector2(tileGrid, tileGrid),
      stableNoise: true, stableTiles: true, samples: 0, _task: null, _compilePromise: null,
      _fsQuad: { material, render() {
        const target = destination(), data = pixels(target), { x, y, z: width, w: height } = target.scissor;
        for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
          const index = row * target.width + col;
          data[index] = material.blending === NoBlending ? material.seed
            : data[index]! * (1 - material.opacity) + material.seed * material.opacity;
        }
        latestWritten = target;
      } },
      _blendQuad: { material: blendMaterial, render() {
        const target = destination(), data = pixels(target);
        const before = pixels(byTexture.get(blendMaterial.target1)!);
        const sample = pixels(byTexture.get(blendMaterial.target2)!);
        // Unit-alpha texels reduce the vendor BlendMaterial equation to this mean.
        for (let i = 0; i < data.length; i++) data[i] = before[i]! * (1 - blendMaterial.opacity) + sample[i]! * blendMaterial.opacity;
        latestWritten = target; blendDraws++;
      } },
    }) as VendorRenderer;
    const renderSamples = (count: number) => {
      for (let sample = 1; sample <= count; sample++) {
        for (let tile = 0; tile < tileGrid * tileGrid; tile++) {
          tracer.update();
          expect(tracer.target === latestWritten).toBe(true);
        }
        expect(tracer.samples).toBe(sample);
        for (const value of pixels(tracer.target)) expect(value).toBeCloseTo((sample + 1) / 2, 12);
      }
    };
    const expectCleared = () => {
      expect(tracer.samples).toBe(0);
      for (const target of targets) expect(pixels(target).every(value => value === 0)).toBe(true);
    };
    try {
      tracer.reset(); expectCleared(); renderSamples(4);
      // Interrupt a new sample, then ensure reset discards its generator/parity.
      tracer.update(); tracer.reset(); expectCleared(); renderSamples(3);
      tracer.setSize(6, 4); expectCleared();
      for (const target of targets) expect([target.width, target.height]).toEqual([6, 4]);
      renderSamples(4);
      tracer.alpha = false; expectCleared();
      const previousBlendDraws = blendDraws;
      renderSamples(4);
      expect(tracer.target).toBe(primary);
      expect(blendDraws).toBe(previousBlendDraws);
      tracer.alpha = true; expectCleared(); renderSamples(2);
    } finally { targets.forEach(target => target.dispose()); }
  });

  test("waits for completed GPU work and rejects lost, failed or cancelled exports before accepting an image", async () => {
    let polls = 0, deleted = 0, lost = false;
    const sync = {} as WebGLSync;
    const gl = {
      SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3,
      TIMEOUT_EXPIRED: 4, WAIT_FAILED: 5,
      isContextLost: () => lost, fenceSync: () => sync, flush: () => {},
      clientWaitSync: () => ++polls === 1 ? 4 : 3,
      deleteSync: () => { deleted++; },
    } as unknown as WebGL2RenderingContext;
    await waitForGpuCompletion(gl);
    expect(polls).toBe(2);
    expect(deleted).toBe(1);
    gl.clientWaitSync = () => { lost = true; return gl.TIMEOUT_EXPIRED; };
    await expect(waitForGpuCompletion(gl)).rejects.toMatchObject({ code: "context-lost" });
    expect(deleted).toBe(1);
    lost = false;
    gl.clientWaitSync = () => gl.WAIT_FAILED;
    await expect(waitForGpuCompletion(gl)).rejects.toMatchObject({ code: "gpu-sync-failed" });
    expect(deleted).toBe(2);
    const controller = new AbortController();
    gl.clientWaitSync = () => { controller.abort(); return gl.TIMEOUT_EXPIRED; };
    await expect(waitForGpuCompletion(gl, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(deleted).toBe(3);
  });

  test("keeps photographic light panels aimed inward and returns to one legacy light", () => {
    const scene = new Scene(), camera = new OrthographicCamera();
    scene.userData.studioRadius = 3;
    camera.quaternion.setFromEuler(new Euler(0.31, -0.62, 0.27));
    camera.updateMatrixWorld();
    const direction: [number, number] = [24, 61];
    const style = { ...createDefaultStyle(), lightDirection: direction };
    for (const studio of ["uniform", "overhead", "dual-strip", "rembrandt"] as const) {
      const settings = readRenderSettings({ studio, environmentRotation: 47 });
      configureStudioScene(scene, camera, settings, style, 1, "raster");
      const group = scene.getObjectByName("crystalsketch-studio-lights")!;
      expect(group.children).toHaveLength(NEW_STUDIO_LIGHTING_RIGS[studio].panels.length);
      const [az, el] = direction.map(value => value * Math.PI / 180);
      const expected = new Vector3(Math.cos(el!) * Math.sin(az!), Math.sin(el!), Math.cos(el!) * Math.cos(az!))
        .applyAxisAngle(new Vector3(0, 1, 0), 47 * Math.PI / 180).applyQuaternion(camera.quaternion);
      expect(group.children[0]!.position.clone().normalize().distanceTo(expected)).toBeLessThan(1e-12);
      for (const light of group.children) {
        const emission = new Vector3(0, 0, -1).applyQuaternion(light.quaternion);
        expect(emission.dot(light.position.clone().normalize())).toBeCloseTo(-1, 12);
        expect(light.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      }
      const environment = createStudioEnvironment(studio);
      try {
        const data = environment.image.data;
        expect(data).toBeInstanceOf(Float32Array);
        expect(data.every(Number.isFinite)).toBe(true);
        for (const panel of NEW_STUDIO_LIGHTING_RIGS[studio].panels) {
          const [az, el] = panel.direction.map(value => value * Math.PI / 180);
          const ray = new Vector3(Math.cos(el!) * Math.sin(az!), Math.sin(el!), Math.cos(el!) * Math.cos(az!));
          const x = Math.min(511, Math.floor((Math.atan2(ray.z, ray.x) / (2 * Math.PI) + 0.5) * 512));
          const y = Math.min(255, Math.floor((Math.asin(ray.y) / Math.PI + 0.5) * 256));
          expect(data[(y * 512 + x) * 4]!).toBeGreaterThanOrEqual(panel.power * 0.999);
        }
      } finally { environment.dispose(); }
      configureStudioScene(scene, camera, settings, style, 0);
      expect(scene.environmentIntensity).toBe(0);
      expect(group.children.every(light => (light as unknown as { intensity: number }).intensity === 0)).toBe(true);
      for (const studio of ["original", "softbox", "side", "rim"] as const) {
        configureStudioScene(scene, camera, readRenderSettings({ studio }), style, 1);
        expect(group.children).toHaveLength(1);
        expect(group.children[0]!.position.length()).toBeCloseTo(6, 12);
      }
    }
    expect(STUDIO_PRESET_LIGHT_DIRECTIONS.overhead).toEqual([0, 90]);
  });

  test("keeps the opaque AO background outside tone mapping with one output conversion", () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const renderer = {
      domElement: canvas, getPixelRatio: () => 1, getSize: (size: Vector2) => size.set(32, 32),
      capabilities: { reverseDepthBuffer: false }, toneMapping: AgXToneMapping, toneMappingExposure: 1,
    } as unknown as WebGLRenderer;
    const scene = new Scene();
    const background = new Color("#ffffff");
    scene.background = background;
    const camera = new OrthographicCamera();
    camera.layers.enable(RenderOverlay.ANNOTATION_LAYER);
    const originalMask = camera.layers.mask;
    const passes: Parameters<EffectComposer["addPass"]>[0][] = [];
    const originalAddPass = EffectComposer.prototype.addPass;
    const addPassSpy = spyOn(EffectComposer.prototype, "addPass").mockImplementation(function (this: EffectComposer, pass) {
      passes.push(pass);
      originalAddPass.call(this, pass);
    });
    const composeSpy = spyOn(EffectComposer.prototype, "render").mockImplementation(() => {
      expect(camera.layers.isEnabled(RenderOverlay.ANNOTATION_LAYER)).toBe(false);
    });
    const overlaySpy = spyOn(RenderOverlay, "renderAnnotationOverlay").mockImplementation(() => {});
    let effect: ReturnType<typeof createAmbientOcclusion> | undefined;
    try {
      effect = createAmbientOcclusion(renderer, scene, camera);
      expect(passes).toHaveLength(3);
      expect(passes[1]).toBeInstanceOf(OutputPass);
      const ao = passes[0] as N8AOPass & {
        beautyRenderTarget: WebGLRenderTarget;
        transparencyRenderTargetDWFalse: WebGLRenderTarget;
      };
      const output = passes[1] as OutputPass;
      const uniforms = output.material.uniforms;
      const shader = output.material.fragmentShader;
      expect(shader.indexOf("if (n8HasSurface)")).toBeLessThan(shader.indexOf("#ifdef LINEAR_TONE_MAPPING"));
      expect(shader.match(/sRGBTransferOETF\(/g)).toHaveLength(1);
      expect(shader).not.toMatch(/gl_FragColor\.a\s*=/);
      expect(ao.configuration.gammaCorrection).toBe(false);
      const settings = readRenderSettings({ aoEnabled: true, aoIntensity: 0.55, aoRadius: 1, exposure: 1 });
      effect.render(settings, 0.65, false);
      expect(uniforms.n8SceneDepth?.value).toBe(ao.beautyRenderTarget.depthTexture);
      expect(uniforms.n8BackgroundDepth?.value).toBe(1);
      expect(ao.configuration.intensity).toBe(0.55);
      expect(renderer.toneMappingExposure).toBe(1);
      expect(renderer.toneMapping).toBe(AgXToneMapping);
      expect(scene.background).toBe(background);
      expect(camera.layers.mask).toBe(originalMask);
      scene.background = null;
      renderer.capabilities.reverseDepthBuffer = true;
      effect.render(settings, 0.65, false);
      expect(uniforms.n8BackgroundDepth?.value).toBe(0);
      expect(scene.background).toBeNull();
      expect(composeSpy).toHaveBeenCalledTimes(2);
      expect(overlaySpy).toHaveBeenCalledTimes(2);
      expect(camera.layers.mask).toBe(originalMask);
    } finally {
      effect?.dispose();
      overlaySpy.mockRestore(); composeSpy.mockRestore(); addPassSpy.mockRestore();
    }
  });

  test("preserves source shader hooks and live material updates in native transparent AO composition", () => {
    const scene = new Scene(), camera = new OrthographicCamera(), geometry = new BoxGeometry();
    const source = new MeshPhysicalMaterial({ color: "#aabbcc", roughness: 0.2 });
    const translucent = new MeshPhysicalMaterial({ transparent: true, opacity: 0.4, depthWrite: false });
    const glass = new MeshPhysicalMaterial({ transmission: 0.9 });
    const opaqueMesh = new Mesh(geometry, source), shell = new Mesh(geometry, translucent), glassMesh = new Mesh(geometry, glass);
    const mixedMaterials = [source, translucent];
    const mixed = new Mesh(geometry, mixedMaterials);
    scene.add(opaqueMesh, shell, glassMesh, mixed);
    const texture = new Texture(), currentViewport = new Vector4(0, 0, 640, 480);
    let clone: MeshPhysicalMaterial | undefined;
    let sourceRenderHooks = 0;
    source.onBeforeCompile = shader => {
      enableBatchedInstanceRgba(shader);
      shader.fragmentShader += "\n// original fog adapter";
    };
    source.customProgramCacheKey = () => "batched-rgba-and-fog";
    source.onBeforeRender = () => { sourceRenderHooks++; };
    const originalCompile = source.onBeforeCompile;
    const renderer = {
      getCurrentViewport: (value: Vector4) => value.copy(currentViewport),
      render() {
        const material = opaqueMesh.material;
        expect(material).not.toBe(source);
        if (clone) expect(material).toBe(clone);
        clone = material;
        expect(material.roughness).toBe(source.roughness);
        expect(material.color.getHex()).toBe(source.color.getHex());
        expect(material.customProgramCacheKey()).toContain("batched-rgba-and-fog");
        expect(shell.material).toBe(translucent);
        expect(glassMesh.material).toBe(glass);
        expect(mixed.material[0]).toBe(material);
        expect(mixed.material[1]).toBe(translucent);
        const shader = {
          uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader,
        } as Parameters<Material["onBeforeCompile"]>[0];
        material.onBeforeCompile(shader, renderer);
        material.onBeforeRender(renderer, scene, camera, geometry, opaqueMesh, new Group());
        expect(shader.vertexShader).toContain("#define USE_COLOR_ALPHA");
        expect(shader.fragmentShader).toContain("// original fog adapter");
        expect(shader.fragmentShader.indexOf("gl_FragColor.rgb *= clamp(texture2D(n8NativeAo"))
          .toBeLessThan(shader.fragmentShader.indexOf("#include <tonemapping_fragment>"));
        expect(shader.uniforms.n8NativeAo?.value).toBe(texture);
        expect((shader.uniforms.n8NativeViewport?.value as Vector4).toArray()).toEqual(currentViewport.toArray());
      },
    } as unknown as WebGLRenderer;
    const native = createNativeAmbientOcclusionRenderer(renderer);
    const factor = () => {
      expect(opaqueMesh.material).toBe(source);
      expect(shell.material.visible).toBe(false);
      expect(glassMesh.material.visible).toBe(false);
      expect(mixed.material[0]).toBe(source);
      expect(mixed.material[1]?.visible).toBe(false);
      return texture;
    };
    try {
      native.render(scene, camera, factor);
      expect(opaqueMesh.material).toBe(source);
      expect(mixed.material).toBe(mixedMaterials);
      source.roughness = 0.83;
      source.color.set("#4488bb");
      source.needsUpdate = true;
      currentViewport.set(0, 0, 320, 240);
      const copySpy = spyOn(clone!, "copy");
      try {
        native.render(scene, camera, factor);
        expect(copySpy).toHaveBeenCalledTimes(1);
      } finally { copySpy.mockRestore(); }
      expect(source.onBeforeCompile).toBe(originalCompile);
      expect(sourceRenderHooks).toBe(2);
      expect(shell.material).toBe(translucent);
      expect(glassMesh.material).toBe(glass);
      expect(mixed.material).toBe(mixedMaterials);
    } finally {
      native.dispose(); native.dispose();
      source.dispose(); translucent.dispose(); glass.dispose(); geometry.dispose(); texture.dispose();
    }
  });

  test("detects transmission and restores material identity after factor errors, draw errors and disposal", () => {
    const scene = new Scene(), camera = new OrthographicCamera(), geometry = new BoxGeometry();
    const opaque = new MeshPhysicalMaterial(), glass = new MeshPhysicalMaterial({ transmission: 0.9 });
    const opaqueMesh = new Mesh(geometry, opaque), glassMesh = new Mesh(geometry, glass);
    const originals = [opaque, glass], mixed = new Mesh(geometry, originals);
    scene.add(opaqueMesh, glassMesh, mixed);
    expect(glass.transparent).toBe(false);
    expect(sceneHasTransparentMaterials(scene, camera)).toBe(true);
    glassMesh.visible = mixed.visible = false;
    expect(sceneHasTransparentMaterials(scene, camera)).toBe(false);
    glassMesh.visible = mixed.visible = true;
    const texture = new Texture();
    let failDraw = false;
    const renderer = { render() { if (failDraw) throw new Error("draw failure"); } } as unknown as WebGLRenderer;
    const native = createNativeAmbientOcclusionRenderer(renderer);
    const restored = () => {
      expect(opaqueMesh.material).toBe(opaque);
      expect(glassMesh.material).toBe(glass);
      expect(mixed.material).toBe(originals);
      expect(opaqueMesh.visible && glassMesh.visible && mixed.visible).toBe(true);
    };
    try {
      expect(() => native.render(scene, camera, () => { throw new Error("factor failure"); })).toThrow("factor failure");
      restored();
      failDraw = true;
      expect(() => native.render(scene, camera, () => texture)).toThrow("draw failure");
      restored();
      failDraw = false;
      native.render(scene, camera, () => texture);
      restored();
      expect(() => native.render(scene, camera, () => { native.dispose(); return texture; })).toThrow("disposed");
      restored();
      expect(() => native.render(scene, camera, () => texture)).toThrow("disposed");
    } finally { native.dispose(); opaque.dispose(); glass.dispose(); geometry.dispose(); texture.dispose(); }
  });

  test("routes actual transmission through a scalar AO pass and restores renderer state on errors and route changes", () => {
    const scene = new Scene(), camera = new OrthographicCamera(), geometry = new BoxGeometry();
    const originalBackground = new Color("#ffffff");
    scene.background = originalBackground;
    camera.layers.enable(RenderOverlay.ANNOTATION_LAYER);
    const originalMask = camera.layers.mask;
    const opaque = new MeshPhysicalMaterial(), glass = new MeshPhysicalMaterial({ transmission: 0.9 });
    const solid = new Mesh(geometry, opaque), shell = new Mesh(geometry, glass);
    scene.add(solid, shell);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const clearColor = new Color("#ffffff");
    let clearAlpha = 0, target: WebGLRenderTarget | null = null;
    let failFactor = false, failDraw = false, nativeDraws = 0, opaqueDraws = 0;
    const renderer = {
      domElement: canvas, getPixelRatio: () => 1, getSize: (size: Vector2) => size.set(32, 32),
      capabilities: { reverseDepthBuffer: false }, toneMapping: AgXToneMapping, toneMappingExposure: 1,
      xr: { enabled: false }, autoClear: true, autoClearDepth: true,
      getRenderTarget: () => target, setRenderTarget: (value: WebGLRenderTarget | null) => { target = value; },
      getClearColor: (color: Color) => color.copy(clearColor), getClearAlpha: () => clearAlpha,
      setClearColor: (color: Color, alpha: number) => { clearColor.copy(color); clearAlpha = alpha; },
      render() {
        nativeDraws++;
        expect(solid.material).not.toBe(opaque);
        expect(shell.material).toBe(glass);
        expect(renderer.toneMapping).toBe(AgXToneMapping);
        expect(renderer.toneMappingExposure).toBe(1);
        expect(scene.background).toBe(originalBackground);
        if (failDraw) { renderer.toneMappingExposure = 9; throw new Error("native draw failure"); }
      },
    } as unknown as WebGLRenderer;
    const composeSpy = spyOn(EffectComposer.prototype, "render").mockImplementation(function (this: EffectComposer) {
      const ao = this.passes[0] as N8AOPass & { configuration: { renderMode: number } };
      expect(ao.configuration.transparencyAware).toBe(false);
      expect(ao.configuration.gammaCorrection).toBe(false);
      if (this.renderToScreen) {
        opaqueDraws++;
        expect(ao.configuration.renderMode).toBe(0);
        expect(this.passes[1]?.enabled && this.passes[2]?.enabled).toBe(true);
        return;
      }
      expect(ao.configuration.renderMode).toBe(1);
      expect(this.passes[1]?.enabled || this.passes[2]?.enabled).toBe(false);
      expect(solid.material).toBe(opaque);
      expect(shell.material.visible).toBe(false);
      renderer.autoClear = false;
      renderer.autoClearDepth = false;
      renderer.xr.enabled = true;
      renderer.toneMappingExposure = 7;
      scene.background = null;
      if (failFactor) throw new Error("AO factor failure");
    });
    const overlaySpy = spyOn(RenderOverlay, "renderAnnotationOverlay").mockImplementation(() => {});
    const effect = createAmbientOcclusion(renderer, scene, camera);
    const settings = readRenderSettings({ aoEnabled: true, aoIntensity: 0.6 });
    const restored = () => {
      expect(solid.material).toBe(opaque);
      expect(shell.material).toBe(glass);
      expect(scene.background).toBe(originalBackground);
      expect(camera.layers.mask).toBe(originalMask);
      expect(renderer.autoClear && renderer.autoClearDepth).toBe(true);
      expect(renderer.xr.enabled).toBe(false);
      expect(renderer.toneMappingExposure).toBe(1);
      expect(renderer.getRenderTarget()).toBeNull();
      expect(renderer.getClearAlpha()).toBe(0);
    };
    try {
      effect.render(settings, 1, false);
      restored();
      failFactor = true;
      expect(() => effect.render(settings, 1, false)).toThrow("AO factor failure");
      restored();
      failFactor = false; failDraw = true;
      expect(() => effect.render(settings, 1, false)).toThrow("native draw failure");
      restored();
      failDraw = false;
      glass.transmission = 0;
      effect.render(settings, 1, false);
      restored();
      expect(nativeDraws).toBe(2);
      expect(opaqueDraws).toBe(1);
    } finally {
      effect.dispose(); overlaySpy.mockRestore(); composeSpy.mockRestore();
      opaque.dispose(); glass.dispose(); geometry.dispose();
    }
  });

  test("scales PDF axis letters with the preview sprite instead of using a fixed 56-pixel label", () => {
    const sizeAt = (height: number) => {
      const camera = new OrthographicCamera(-height / 2, height / 2, height / 2, -height / 2);
      camera.zoom = height * ORIENTATION_GIZMO_ZOOM_PER_CANVAS_PIXEL;
      camera.updateProjectionMatrix();
      return crystalAxisLabelFontSize(camera, height);
    };
    expect(sizeAt(588)).toBeCloseTo(16.26305, 5);
    expect(sizeAt(256)).toBeLessThan(8);
    expect(sizeAt(512)).toBeCloseTo(sizeAt(256) * 2, 8);
    expect(sizeAt(1024) / 2).toBeCloseTo(sizeAt(512), 8);
  });
  test("keeps rendering progress and recovery controls connected without changing lighting", () => {
    let style: StyleState = { ...createDefaultStyle(), materialPreset: "pbr-ceramic", rendering: readRenderSettings({ mode: "path-traced" }) };
    const pauses: boolean[] = [];
    let restarts = 0;
    const model: InspectorSettingsModel = {
      distinguishSimilarColors: false, dragSensitivity: 1, fogAffectsUnitCell: false,
      isCustomColorScheme: false, interactionMode: "trackball", lightStrength: 1, mouseInertia: true,
      previewMeshQuality: "high", selectionActivation: "single", showFpsOverlay: false,
      showCrystalAxisLabels: true, structureLineWidth: { unitCell: 1, polyhedra: 1 }, unitCellLineStyle: "solid",
    };
    const noop = () => {};
    const actions: InspectorSettingsActions = {
      onDistinguishSimilarColorsChange: noop, onDragSensitivityChange: noop, onFogAffectsUnitCellChange: noop,
      onInteractionModeChange: noop, onLightStrengthChange: noop, onMouseInertiaChange: noop,
      onPreviewMeshQualityChange: noop, onSelectionActivationChange: noop, onShowFpsOverlayChange: noop,
      onShowCrystalAxisLabelsChange: noop, onStructureLineWidthChange: noop, onUnitCellLineStyleChange: noop,
    };
    const props = { style, settingsModel: model, settingsActions: actions,
      onStyleChange: (next: SetStateAction<StyleState>) => {
        style = typeof next === "function" ? next(style) : next;
      },
      onRenderingPausedChange: (value: boolean) => pauses.push(value), onRenderingRestart: () => { restarts++; },
    };
    const { rerender } = render(<RenderingPanel {...props}
      renderingProgress={{ phase: "rendering", samples: 16, targetSamples: 64, elapsedMs: 2300 }} />);
    expect(screen.getByRole("progressbar", { name: "Sampling progress" }).getAttribute("value")).toBe("16");
    expect(screen.getByText("16 / 64 samples")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(pauses).toEqual([true]);
    rerender(<RenderingPanel {...props} renderingPaused
      renderingProgress={{ phase: "paused", samples: 16, targetSamples: 64, elapsedMs: 2300 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(pauses).toEqual([true, false]);
    rerender(<RenderingPanel {...props}
      renderingProgress={{ phase: "unsupported", samples: 0, targetSamples: 64, elapsedMs: 0, message: "scene-too-large" }} />);
    expect(screen.getByRole("status").textContent).toContain("exceeds the path-tracing limit");
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(restarts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to realtime" }));
    expect(style.rendering?.mode).toBe("realtime");
    expect(style.materialPreset).toBe("pbr-ceramic");
    expect(style.mainLightIntensity).toBe(createDefaultStyle().mainLightIntensity);
    style = { ...style, rendering: readRenderSettings({ mode: "realtime", aoEnabled: true }) };
    rerender(<RenderingPanel {...props} style={style}
      renderingProgress={{ phase: "error", samples: 0, targetSamples: 0, elapsedMs: 0, message: "ao-failed" }} />);
    expect(screen.getByRole("status").textContent).toContain("Ambient occlusion could not start");
    fireEvent.click(screen.getByRole("button", { name: "Turn off AO" }));
    expect(style.rendering?.aoEnabled).toBe(false);
    rerender(<RenderingPanel {...props} style={style}
      renderingProgress={{ phase: "rendering", samples: 32, targetSamples: 64, elapsedMs: 3100 }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    style = { ...style, rendering: readRenderSettings({ mode: "path-traced", quality: "ultra" }) };
    rerender(<RenderingPanel {...props} style={style} />);
    expect(style.rendering?.quality).toBe("ultra");
    expect(screen.getByRole("combobox", { name: "Sampling quality" }).textContent).toContain("Ultra");
    expect(screen.getByText(/512 preview samples and 2048 export samples/)).toBeTruthy();
    style = { ...style, materialPreset: "cartoon", rendering: readRenderSettings({
      mode: "path-traced", studio: "softbox", aoEnabled: true,
    }) };
    const legacyStyle = structuredClone(style);
    rerender(<RenderingPanel {...props} style={style}
      renderingProgress={{ phase: "unsupported", samples: 0, targetSamples: 64, elapsedMs: 0, message: "unsupported-material" }} />);
    expect(usesStudioLighting(style)).toBe(false);
    expect(usesStudioLighting({ materialPreset: "pbr-ceramic" })).toBe(true);
    expect((screen.getByRole("combobox", { name: "Studio" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("textbox", { name: "Exposure" }).closest("fieldset")?.disabled).toBe(true);
    expect(screen.getByRole("radio", { name: "Realtime" }).getAttribute("aria-checked")).toBe("true");
    const pathTracing = screen.getByRole("radio", { name: "Path tracing" }) as HTMLButtonElement;
    expect(pathTracing.disabled).toBe(true);
    fireEvent.click(pathTracing);
    expect(style).toEqual(legacyStyle);
    const ao = screen.getByRole("switch", { name: "Contact shading" }) as HTMLButtonElement;
    expect(ao.disabled).toBe(true);
    expect(ao.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/All materials export at the selected size, mesh quality and supersampling/)).toBeTruthy();
  });

  test("passes the active material and explicit light controls to crystal axes without palette or radius coupling", () => {
    const style = { ...createDefaultStyle(), materialPreset: "colored-metal", mainLightIntensity: 0, ambientLightIntensity: 0.35, lightDirection: [125, -20] as [number, number] };
    const before = JSON.stringify(style);
    const axes = crystalAxisMaterialForStyle(style, 0);
    expect(axes).toEqual({ materialPreset: "colored-metal", mainLightIntensity: 0, ambientLightIntensity: 0.35, lightDirection: [125, -20], lightStrength: 0 });
    const otherAppearance = { ...style, atomRadius: 30, bondThickness: 80, colorScheme: "nord" };
    expect(crystalAxisMaterialForStyle(otherAppearance, 0)).toEqual(axes);
    expect(JSON.stringify(style)).toBe(before);
  });
  test("keeps studio reflections camera-relative under compound crystal rotations", () => {
    for (const camera of [new Quaternion(0.5, 0.5, 0.5, 0.5), new Quaternion().setFromEuler(new Euler(0.3, -0.8, 1.2))]) {
      const rotation = new Euler();
      setMetalEnvironmentRotation(rotation, camera, new Quaternion());
      const viewRay = new Vector3(0.2, 0.4, 0.7).normalize();
      const sampledRay = viewRay.clone().applyQuaternion(camera)
        .applyEuler(new Euler(-rotation.x, -rotation.y, -rotation.z));
      expect(sampledRay.distanceTo(viewRay)).toBeLessThan(1e-6);
    }
  });

  test("new finishes scale all light lobes consistently while preserving direction and zero strength", () => {
    for (const presetId of ["soft-ceramic", "satin-matte", "cel-shaded", "colored-metal", "soft-jade", "soft-velvet"]) {
      for (const strength of [0, 1.5]) {
        const lights = MaterialPresetLights({
          presetId, lighting: cartoonPreset.lighting as MaterialPresetLight[],
          intensityScale: strength, mainIntensity: 0.4, ambientIntensity: 0.8, direction: [20, 30],
        }).props.children;
        const unitScale = isMetalMaterialPreset(presetId) ? 1 : Math.PI;
        expect(lights.every((light: ReactElement<{intensityScale: number}>) => light.props.intensityScale === strength * unitScale)).toBe(true);
      }
    }
  });

  test("maps the sphere to camera-relative directions and clamps outside drags", () => {
    expect(lightDirectionFromPoint(0, 0)).toEqual([0, 0]);
    expect(lightDirectionFromPoint(1, 0)).toEqual([90, 0]);
    expect(lightDirectionFromPoint(0, 1)[1]).toBe(90);
    const [azimuth, elevation] = lightDirectionFromPoint(-5, -5);
    expect(azimuth).toBeCloseTo(-90, 5);
    expect(elevation).toBeCloseTo(-45, 5);
  });

  test("supports pointer capture, independent sliders, and keyboard aiming", () => {
    const directions: [number, number][] = [];
    const main: number[] = [];
    const ambient: number[] = [];
    render(<LightingControls direction={[0, 0]}
      onDirectionChange={value => directions.push(value)}
      onMainIntensityChange={value => main.push(value)}
      onAmbientIntensityChange={value => ambient.push(value)} />);
    const ball = screen.getByRole("button", { name: "Light direction" });
    ball.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} });
    let captured = false;
    ball.setPointerCapture = () => { captured = true; };
    ball.hasPointerCapture = () => captured;
    ball.releasePointerCapture = () => { captured = false; };
    fireEvent.pointerMove(ball, { pointerId: 1, clientX: 94, clientY: 50 });
    expect(directions).toHaveLength(0);
    fireEvent.pointerDown(ball, { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(ball, { pointerId: 1, clientX: 94, clientY: 50 });
    expect(directions.at(-1)).toEqual([90, 0]);
    fireEvent.pointerUp(ball, { pointerId: 1, clientX: 94, clientY: 50 });
    expect(captured).toBe(false);
    fireEvent.keyDown(ball, { key: "ArrowUp" });
    expect(directions.at(-1)).toEqual([0, 2]);
    fireEvent.keyDown(ball, { key: "ArrowLeft", shiftKey: true });
    expect(directions.at(-1)).toEqual([-10, 0]);
    fireEvent.change(screen.getByRole("slider", { name: "Main light" }), { target: { value: "0" } });
    expect(main).toEqual([0]);
    expect(ambient).toEqual([]);
    fireEvent.change(screen.getByRole("slider", { name: "Ambient light" }), { target: { value: "1.5" } });
    expect(ambient).toEqual([1.5]);
  });

  test("overrides main and ambient independently without changing the fixed fill light", () => {
    const direction: [number, number] = [-30, 20];
    const elements = MaterialPresetLights({
      lighting: cartoonPreset.lighting as MaterialPresetLight[],
      direction, mainIntensity: 0, ambientIntensity: 1.2, intensityScale: 1.5,
    }).props.children;
    type LightElement = ReactElement<Record<string, unknown>, (props: Record<string, unknown>) => ReactElement<Record<string, unknown>>>;
    const lights = (elements as LightElement[]).map(element => element.type(element.props));
    expect(lights).toHaveLength(3);
    expect(lights[0]?.props.intensity).toBeCloseTo(1.8);
    expect(lights[1]?.props.intensity).toBe(0);
    expect(lights[1]?.props.direction).toEqual(direction);
    expect(lights[1]?.props.intensityScale).toBe(1.5);
    expect(lights[2]?.props.intensity).toBe(0.2);
    expect(lights[2]?.props.direction).toBeUndefined();
  });
});
