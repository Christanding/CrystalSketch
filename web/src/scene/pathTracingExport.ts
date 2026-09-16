import { OrthographicCamera, type Camera, type Scene, type WebGLRenderer } from "three";
import type { SceneSpec } from "../api/scene";
import type { ComponentOpacityState, StyleState, UnitCellLineStyle } from "../model";
import { EXPORT_RENDER_PIXEL_MAX } from "../model/exportSettings";
import { RENDER_QUALITY, type RenderSettings } from "../model/renderSettings";
import type { FigureRenderControl } from "../export/types";
import type { SceneLayout } from "./sceneLayout";
import type { SceneMeshDetail } from "./StructureSceneObjects";
import { configureStudioScene, createStudioEnvironment } from "./studioEnvironment";
import { renderAnnotationOverlay } from "./renderOverlay";

export async function renderPathTracedExport(options: {
  source: SceneSpec; style: StyleState; componentOpacity: ComponentOpacityState;
  showAtoms: boolean; showUnitCell: boolean; unitCellColor: string; background: string | null;
  unitCellLineStyle: UnitCellLineStyle;
  width: number; height: number; layout: SceneLayout; camera: Camera; meshDetail: SceneMeshDetail;
  unitCellLineWidth: number; polyhedronLineWidth: number; lightStrength: number;
  renderer: WebGLRenderer; rasterScene: Scene; settings: RenderSettings; control?: FigureRenderControl;
}): Promise<HTMLCanvasElement> {
  const { control, width, height, camera, settings } = options;
  control?.signal?.throwIfAborted();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width * height > EXPORT_RENDER_PIXEL_MAX) {
    throw new Error(`路径追踪导出最多支持 ${EXPORT_RENDER_PIXEL_MAX / 10_000} 万内部像素（包括超采样），且须符合设备尺寸限制；不会自动降低分辨率。`);
  }
  const [{ createCrystalPathTraceScene }, { createPathTracingSession }] = await Promise.all([
    import("./pathTracingScene"), import("./pathTracingRenderer"),
  ]);
  const started = performance.now();
  const target = RENDER_QUALITY[settings.quality].exportSamples;
  const report = (phase: "preparing" | "rendering" | "complete", samples = 0) => control?.onProgress?.({
    phase, samples: Math.floor(samples), targetSamples: target, elapsedMs: performance.now() - started,
  });
  report("preparing");
  const worldPerPixel = camera instanceof OrthographicCamera
    ? (camera.right - camera.left) / camera.zoom / width : options.layout.span / height;
  const snapshot = await createCrystalPathTraceScene({
    scene: options.source, style: options.style, componentOpacity: options.componentOpacity,
    groupPosition: options.layout.groupPosition, showAtoms: options.showAtoms, showUnitCell: options.showUnitCell,
    unitCellColor: options.unitCellColor, unitCellRadius: worldPerPixel * options.unitCellLineWidth / 2,
    unitCellLineStyle: options.unitCellLineStyle,
    polyhedronEdgeRadius: worldPerPixel * options.polyhedronLineWidth / 2,
    quality: settings.quality, meshDetail: options.meshDetail, signal: control?.signal,
  });
  const environment = createStudioEnvironment(settings.studio);
  const tracedCanvas = document.createElement("canvas");
  let session: Awaited<ReturnType<typeof createPathTracingSession>> | undefined;
  try {
    snapshot.scene.environment = environment;
    snapshot.scene.background = null;
    snapshot.scene.userData.studioRadius = options.layout.span;
    configureStudioScene(snapshot.scene, camera, settings, options.style, options.lightStrength);
    session = await createPathTracingSession({ canvas: tracedCanvas, scene: snapshot.scene, camera,
      width, height, settings, signal: control?.signal });
    let lastReport = 0, queuedUpdates = 0;
    while (session.samples < target) {
      control?.signal?.throwIfAborted();
      session.renderSample();
      // RAF limits CPU submission, not GPU completion. Keep expensive glass paths
      // from queuing hundreds of draws and reporting success before a device reset.
      if (++queuedUpdates >= 16) { await session.waitForGpu(); queuedUpdates = 0; }
      if (performance.now() - lastReport > 180) { report("rendering", session.samples); lastReport = performance.now(); }
      await nextRenderFrame(control?.signal);
    }
    session.present();
    await session.waitForGpu();
    control?.signal?.throwIfAborted();
    const result = document.createElement("canvas");
    result.width = width; result.height = height;
    const context = result.getContext("2d");
    if (!context) throw new Error("无法创建路径追踪出图画布。");
    if (options.background) { context.fillStyle = options.background; context.fillRect(0, 0, width, height); }
    context.drawImage(tracedCanvas, 0, 0);
    renderAnnotationOverlay(options.renderer, options.rasterScene, camera, true);
    context.drawImage(options.renderer.domElement, 0, 0);
    report("complete", target);
    return result;
  } finally {
    session?.dispose();
    snapshot.dispose();
    environment.dispose();
    tracedCanvas.width = tracedCanvas.height = 1;
  }
}

function nextRenderFrame(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cancelAnimationFrame(frame); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const frame = requestAnimationFrame(() => { signal?.removeEventListener("abort", abort); resolve(); });
    signal?.addEventListener("abort", abort, { once: true });
  });
}
