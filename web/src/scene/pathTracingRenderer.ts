import {
  AgXToneMapping, Box3, BufferGeometry, Camera, Scene, SRGBColorSpace, WebGLRenderer, type Texture,
} from "three";
import { MeshBVH, type MeshBVHOptions } from "three-mesh-bvh";
import { DenoiseMaterial, WebGLPathTracer, type BVHWorker, type PathTracingSceneGeneratorResult } from "three-gpu-pathtracer";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { RENDER_QUALITY, type RenderSettings } from "../model/renderSettings";
import type { PathTracingBVHRequest, PathTracingBVHResponse } from "./pathTracingBVH.worker";
import { collectTracePrimitives, createPrimitiveSceneUpdater, hasTriangleMeshes, installPrimitiveGeometry, packTracePrimitives } from "./pathTracingPrimitives";

export interface PathTracingSession {
  readonly samples: number;
  /** Accumulate one tile without filtering or presenting an intermediate image. */
  renderSample(): number;
  /** Present the latest complete sample; partial tiles never replace it. */
  present(): boolean;
  waitForGpu(): Promise<void>;
  updateCamera(camera: Camera): void;
  updateLighting(): void;
  /** False leaves the session unchanged; the owner must replace incompatible geometry. */
  updateScene(scene: Scene): boolean;
  resize(width: number, height: number): void;
  setExposure(value: number): void;
  dispose(): void;
}

export interface PathTracingSessionOptions {
  canvas: HTMLCanvasElement;
  scene: Scene;
  camera: Camera;
  /** Actual output pixels. The preview caller applies previewScale; exports pass their final size. */
  width: number;
  height: number;
  settings: RenderSettings;
  /** Triangle-only remains available for compatibility and fixed-quality reference renders. */
  geometryMode?: "analytic-primitives" | "analytic-spheres" | "triangles";
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export class PathTracingRendererError extends Error {
  constructor(readonly code: "unsupported" | "context-lost" | "gpu-sync-failed" | "invalid-size" | "disposed" | "worker-failed" | "shader-compile-failed",
    message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathTracingRendererError";
  }
}

/** Owns a separate WebGL context; never accepts or disposes the viewport's R3F renderer. */
export async function createPathTracingSession(options: PathTracingSessionOptions): Promise<PathTracingSession> {
  const { canvas, settings, signal } = options;
  let scene = options.scene;
  signal?.throwIfAborted();
  let renderer: WebGLRenderer | null = null;
  let tracer: WebGLPathTracer | null = null;
  let output: FullScreenQuad | null = null;
  let worker: SessionBVHWorker | null = null;
  let primitiveGeometry: ReturnType<typeof installPrimitiveGeometry> | null = null;
  let updatePrimitiveScene: ((next: Scene) => boolean) | null = null;
  let disposed = false;
  let failure: PathTracingRendererError | null = null;
  const pendingCompiles = new Set<Promise<unknown>>();
  let ownedCamera = copyWorldCamera(options.camera);
  let displayedSamples = 0;
  let completedSamples = 0;
  let completedTexture: Texture | null = null;
  const resetPresentation = () => {
    displayedSamples = completedSamples = 0;
    completedTexture = null;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    canvas.removeEventListener("webglcontextlost", contextLost);
    worker?.dispose();
    worker = null;
    const retiredTracer = tracer;
    const retiredRenderer = renderer;
    const retiredOutput = output;
    const retiredPrimitiveGeometry = primitiveGeometry;
    tracer = null;
    renderer = null;
    output = null;
    primitiveGeometry = null;
    resetPresentation();
    const release = () => {
      try {
        retiredPrimitiveGeometry?.dispose();
        retiredOutput?.material.dispose();
        retiredOutput?.dispose();
        retiredTracer?.dispose();
      } finally {
        try { retiredRenderer?.dispose(); } finally {
          // The vendor leaves internal GPU resources alive; only lose our dedicated context.
          retiredRenderer?.forceContextLoss();
        }
      }
    };
    // r171 compileAsync still polls its program table. Let it finish before clearing that table.
    if (pendingCompiles.size) void Promise.allSettled([...pendingCompiles]).then(release);
    else release();
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    failure = new PathTracingRendererError("context-lost", "路径追踪的图形上下文已丢失，请重新开启预览。");
    dispose();
  };
  const active = () => {
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (disposed || !renderer || !tracer) throw new PathTracingRendererError("disposed", "路径追踪会话已结束。");
    return { renderer, tracer };
  };
  const resize = (width: number, height: number) => {
    const { renderer: currentRenderer, tracer: currentTracer } = active();
    if (canvas.width === width && canvas.height === height) return;
    const gl = currentRenderer.getContext();
    const maxSize = Math.min(currentRenderer.capabilities.maxTextureSize, Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > maxSize || height > maxSize) {
      throw new PathTracingRendererError("invalid-size", `路径追踪图像尺寸无效，当前设备单边上限为 ${maxSize} 像素。`);
    }
    currentRenderer.setSize(width, height, false);
    const pixels = width * height;
    const tileGrid = pixels <= 375_000 ? 1 : pixels <= 1_500_000 ? 2 : 3;
    currentTracer.tiles.set(tileGrid, tileGrid);
    currentTracer.reset();
    resetPresentation();
  };
  const compose = (force = false) => {
    const { renderer: currentRenderer, tracer: currentTracer } = active();
    if (!output || !completedTexture || (!force && completedSamples === displayedSamples)) return false;
    // Opaque accumulation can reuse its sole target in place. Wait for a complete
    // sample there; an explicit exposure adjustment retains its immediate behavior.
    if (!force && currentTracer.samples !== completedSamples && currentTracer.target.texture === completedTexture) return false;
    // The next partial sample writes the other ping-pong target, so this completed
    // texture stays valid without a copy until renderSample publishes the next one.
    (output.material as DenoiseMaterial).map = completedTexture;
    currentRenderer.setRenderTarget(null);
    output.render(currentRenderer);
    displayedSamples = completedSamples;
    if (failure) throw failure;
    return true;
  };

  const prepareScene = async (nextScene: Scene) => {
    const { renderer: currentRenderer, tracer: currentTracer } = active();
    const currentWorker = worker!;
    primitiveGeometry?.restore();
    primitiveGeometry = null;
    updatePrimitiveScene = null;
    scene = nextScene;
    // Serialize builds in the caller; the vendor's concurrent-build queue is not reliable.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    active();
    options.onProgress?.(0);
    const primitives = options.geometryMode === "triangles" ? []
      : collectTracePrimitives(scene, options.geometryMode !== "analytic-spheres");
    const hasTriangles = hasTriangleMeshes(scene, primitives);
    const visibility = primitives.map(({ mesh }) => mesh.visible);
    let triangleGeometry: BufferGeometry;
    try {
      for (const { mesh } of primitives) mesh.visible = false;
      const result = await currentTracer.setSceneAsync(scene, ownedCamera, { onProgress: progress => {
        if (!disposed) options.onProgress?.(Math.max(0, Math.min(1, progress)) * (primitives.length ? 0.9 : 1));
      } }) as unknown as PathTracingSceneGeneratorResult;
      triangleGeometry = result.geometry;
    } finally {
      primitives.forEach(({ mesh }, index) => { mesh.visible = visibility[index]!; });
    }
    active();
    if (primitives.length) {
      const width = canvas.width, height = canvas.height;
      try {
        const data = packTracePrimitives(currentTracer, primitives);
        const bvh = await currentWorker.generatePrimitives(data.primitives, data.bounds);
        active();
        primitiveGeometry = installPrimitiveGeometry(currentTracer, bvh.nodes, bvh.nodeCount,
          data.extraData, currentRenderer.capabilities.maxTextureSize, hasTriangles);
        // Exercise the real shader before publishing any samples. Keep complete
        // triangle geometry available if this optional acceleration is unsupported.
        currentRenderer.setSize(1, 1, false);
        currentTracer.tiles.set(1, 1);
        currentTracer.reset();
        while (currentTracer.samples < 1) {
          active();
          currentTracer.renderSample();
          active();
          if (currentTracer.samples < 1) await new Promise<void>(resolve => setTimeout(resolve, 8));
        }
        await waitForGpuCompletion(currentRenderer.getContext(), signal);
        updatePrimitiveScene = createPrimitiveSceneUpdater(currentTracer, scene, primitives, triangleGeometry,
          bvh.nodes, primitiveGeometry, options.geometryMode !== "analytic-spheres");
      } catch (error) {
        signal?.throwIfAborted();
        if (currentRenderer.getContext().isContextLost() || disposed
          || error instanceof PathTracingRendererError && error.code === "gpu-sync-failed"
          || failure && (failure as PathTracingRendererError).code !== "shader-compile-failed") throw error;
        failure = null;
        active();
        primitiveGeometry?.restore();
        primitiveGeometry = null;
        updatePrimitiveScene = null;
        console.warn("CrystalSketch: analytic primitives unavailable; retaining triangle geometry.", error);
        await currentTracer.setSceneAsync(scene, ownedCamera);
      } finally {
        if (!disposed && !failure && !currentRenderer.getContext().isContextLost()) {
          resize(width, height);
          currentTracer.reset();
          resetPresentation();
        }
      }
    }
    active();
    options.onProgress?.(1);
  };

  try {
    if (typeof Worker !== "function") throw new PathTracingRendererError("unsupported", "当前浏览器不支持路径追踪所需的 Web Worker。");
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    } catch (error) {
      throw new PathTracingRendererError("unsupported", "当前浏览器无法创建路径追踪所需的 WebGL2 上下文。", { cause: error });
    }
    if (!renderer.extensions.has("EXT_color_buffer_float")) {
      throw new PathTracingRendererError("unsupported", "当前设备不支持路径追踪所需的浮点渲染缓冲区。");
    }
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = AgXToneMapping;
    renderer.toneMappingExposure = settings.exposure;
    renderer.setClearColor(0x000000, 0);
    const compileAsync = renderer.compileAsync.bind(renderer);
    renderer.compileAsync = (...args) => {
      const pending = compileAsync(...args);
      pendingCompiles.add(pending);
      void pending.then(() => pendingCompiles.delete(pending), () => pendingCompiles.delete(pending));
      return pending;
    };
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      const detail = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)]
        .filter(Boolean).join("\n").slice(0, 600);
      failure = new PathTracingRendererError("shader-compile-failed", `当前设备无法编译路径追踪着色器。${detail ? `\n${detail}` : ""}`);
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    signal?.addEventListener("abort", dispose, { once: true });
    worker = new SessionBVHWorker();
    tracer = new WebGLPathTracer(renderer);
    const denoise = new DenoiseMaterial({ sigma: 2, kSigma: 1.5, threshold: 0.25 });
    // The upstream filter accumulates premultiplied colors. This canvas stores straight
    // alpha, and scientific silhouettes must retain the original pixel coverage.
    denoise.fragmentShader = denoise.fragmentShader.replace("#include <tonemapping_fragment>", `
      gl_FragColor.rgb = gl_FragColor.a > 1e-6 ? gl_FragColor.rgb / gl_FragColor.a : vec3(0.0);
      gl_FragColor.a = texture2D(map, vUv).a;
      #include <tonemapping_fragment>
    `);
    output = new FullScreenQuad(denoise);
    tracer.setBVHWorker(worker);
    tracer.bounces = RENDER_QUALITY[settings.quality].bounces;
    tracer.renderDelay = 0;
    tracer.fadeDuration = 0;
    tracer.minSamples = 1;
    tracer.dynamicLowRes = false;
    tracer.rasterizeScene = false;
    tracer.renderToCanvas = false;
    tracer.renderScale = 1;
    resize(options.width, options.height);
    await prepareScene(scene);
    active();

    return {
      get samples() { return tracer?.samples ?? 0; },
      renderSample() {
        const { tracer: currentTracer } = active();
        currentTracer.renderSample();
        if (failure) throw failure;
        const samples = currentTracer.samples;
        const complete = Math.round(samples);
        if (complete >= 1 && Math.abs(samples - complete) < 1e-6) {
          completedSamples = complete;
          completedTexture = currentTracer.target.texture;
        }
        return currentTracer.samples;
      },
      present() { return compose(); },
      waitForGpu() { return waitForGpuCompletion(active().renderer.getContext(), signal); },
      updateCamera(camera) {
        const { tracer: currentTracer } = active();
        camera.updateWorldMatrix(true, false);
        if (camera.type === ownedCamera.type && camera.matrixWorld.equals(ownedCamera.matrixWorld)
          && camera.projectionMatrix.equals(ownedCamera.projectionMatrix)) return;
        ownedCamera = copyWorldCamera(camera);
        currentTracer.setCamera(ownedCamera);
        resetPresentation();
      },
      updateLighting() {
        const { tracer: currentTracer } = active();
        scene.updateMatrixWorld(true);
        currentTracer.updateLights();
        currentTracer.updateEnvironment();
        resetPresentation();
      },
      updateScene(nextScene) {
        const { tracer: currentTracer } = active();
        if (!updatePrimitiveScene?.(nextScene)) return false;
        scene = nextScene;
        currentTracer.updateLights();
        currentTracer.updateEnvironment();
        resetPresentation();
        return true;
      },
      resize,
      setExposure(value) {
        const { renderer: currentRenderer } = active();
        if (!Number.isFinite(value) || value <= 0) throw new RangeError("Exposure must be a positive finite number.");
        currentRenderer.toneMappingExposure = value;
        // Recompose the accumulated image even when the caller has paused its RAF loop.
        compose(true);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    signal?.throwIfAborted();
    if (failure) throw failure;
    throw error;
  }
}

/** Await submitted GPU work without blocking cancellation or trusting a delayed context-lost event. */
export async function waitForGpuCompletion(gl: WebGLRenderingContext | WebGL2RenderingContext, signal?: AbortSignal): Promise<void> {
  const check = () => {
    signal?.throwIfAborted();
    if (gl.isContextLost()) throw new PathTracingRendererError("context-lost", "显卡在出图过程中丢失上下文，未生成图片。请重试或手动调整采样质量。");
  };
  check();
  if (!("fenceSync" in gl)) throw new PathTracingRendererError("unsupported", "当前设备不支持出图所需的 WebGL2 同步功能。");
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) throw new PathTracingRendererError("gpu-sync-failed", "无法确认显卡已完成出图，未生成图片。请重试。");
  try {
    gl.flush();
    for (;;) {
      check();
      const state = gl.clientWaitSync(sync, 0, 0);
      if (state === gl.ALREADY_SIGNALED || state === gl.CONDITION_SATISFIED) return;
      if (state === gl.WAIT_FAILED) throw new PathTracingRendererError("gpu-sync-failed", "显卡出图同步失败，未生成图片。请重试。");
      await new Promise<void>(resolve => setTimeout(resolve, 8));
    }
  } finally {
    if (!gl.isContextLost()) gl.deleteSync(sync);
  }
}

function copyWorldCamera(source: Camera): Camera {
  source.updateWorldMatrix(true, false);
  const camera = source.clone(false);
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
  camera.matrix.copy(source.matrixWorld);
  camera.matrixWorld.copy(source.matrixWorld);
  camera.matrixWorldInverse.copy(source.matrixWorldInverse);
  camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
  return camera;
}

class SessionBVHWorker implements BVHWorker {
  private worker: Worker | null = new Worker(new URL("./pathTracingBVH.worker.ts", import.meta.url), { type: "module" });
  private rejectPending: ((error: unknown) => void) | null = null;

  generate(geometry: BufferGeometry, options: MeshBVHOptions = {}): Promise<MeshBVH> {
    const { onProgress, ...workerOptions } = options;
    const index = geometry.getIndex()?.array;
    const request: PathTracingBVHRequest = {
      type: "mesh", position: new Float32Array(geometry.getAttribute("position").array),
      index: index ? new Uint32Array(index) : null,
      groups: geometry.groups.map(group => ({ ...group })), options: workerOptions,
    };
    const transfers = [request.position.buffer, request.index?.buffer]
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    return this.run(request, transfers, onProgress).then(data => {
      if (data.type !== "mesh") throw new Error("Unexpected path tracing BVH response.");
      const bvh = MeshBVH.deserialize(data.serialized, geometry);
      geometry.boundingBox = bvh.getBoundingBox(new Box3());
      return bvh;
    });
  }

  generatePrimitives(primitives: Float32Array, bounds: Float64Array): Promise<{ nodes: Float32Array; nodeCount: number }> {
    return this.run({ type: "primitives", primitives, bounds },
      [primitives.buffer as ArrayBuffer, bounds.buffer as ArrayBuffer]).then(data => {
      if (data.type !== "primitives") throw new Error("Unexpected primitive BVH response.");
      return data;
    });
  }

  private run(request: PathTracingBVHRequest, transfers: Transferable[], onProgress?: (value: number) => void):
    Promise<Extract<PathTracingBVHResponse, { type: "mesh" | "primitives" }>> {
    const worker = this.worker;
    if (!worker || this.rejectPending) return Promise.reject(new Error("The path tracing BVH worker is unavailable or busy."));
    return new Promise((resolve, reject) => {
      const finish = () => { this.rejectPending = null; worker.onmessage = null; worker.onerror = null; };
      this.rejectPending = error => { finish(); reject(error); };
      worker.onerror = event => {
        finish();
        reject(new PathTracingRendererError("worker-failed", event.message || "路径追踪几何构建失败。"));
      };
      worker.onmessage = ({ data }: MessageEvent<PathTracingBVHResponse>) => {
        try {
          if (data.type === "progress") onProgress?.(data.progress);
          else if (data.type === "error") {
            finish();
            reject(new PathTracingRendererError("worker-failed", data.message));
          } else {
            finish();
            resolve(data);
          }
        } catch (error) { finish(); reject(error); }
      };
      try {
        // Mesh requests own copies: cancellation cannot detach the generator's live geometry.
        worker.postMessage(request, transfers);
      } catch (error) { finish(); reject(error); }
    });
  }

  dispose() {
    this.rejectPending?.(new DOMException("Path tracing preparation cancelled.", "AbortError"));
    this.worker?.terminate();
    this.worker = null;
  }
}
