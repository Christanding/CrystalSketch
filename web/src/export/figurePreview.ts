import { createCameraPoseSnapshot } from "../scene/cameraPose";
import { ensureFigureFonts, FIGURE_FONT_FAMILY } from "../theme/fonts";
import { exportDpi, validateExportSettings, visibleSceneForComponents, type ExportSettingsState } from "../model";
import { prepareCombinedExportLayers, type PreparedCombinedExport } from "./combinedExportRaster";
import type { CreateFigureExportOptions, FigureExportFile } from "./types";
import { canvasToPngBlob, exportTextColor } from "./rasterCanvas";
import { createFigureExportFiles } from "../app/exportFigure";

export type FigurePreviewContent =
  | { kind: "combined"; prepared: PreparedCombinedExport; settings: ExportSettingsState }
  | { kind: "separate"; files: FigureExportFile[] };

export interface FigurePreviewState {
  open: boolean;
  loading: boolean;
  error: string | null;
  content: FigurePreviewContent | null;
}

export async function prepareFigurePreview(options: CreateFigureExportOptions): Promise<FigurePreviewContent> {
  await ensureFigureFonts();
  if (!validateExportSettings(options.settings).valid) throw new Error("Export settings are invalid.");
  if (!options.settings.combineComponents) {
    return { kind: "separate", files: await createFigureExportFiles(options) };
  }
  const visibleScene = options.visibleSceneOverride === undefined
    ? visibleSceneForComponents(options.scene, options.componentVisibility, options.style.objectStyles, options.bondVisibilityOverrides)
    : options.visibleSceneOverride;
  const prepared = await prepareCombinedExportLayers({
      ...options,
      cameraPose: createCameraPoseSnapshot(options.cameraOrientationRef.current),
      visibleScene,
    });
  // PDF keeps accessory lettering as vectors; rasterize only the on-screen copy.
  for (const layer of prepared.layers) {
    if (!layer.textItems.length) continue;
    const canvas = document.createElement("canvas");
    canvas.width = layer.image.width;
    canvas.height = layer.image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the figure preview canvas.");
    const bitmap = await createImageBitmap(layer.image.blob);
    try { context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
    context.fillStyle = exportTextColor(options.settings.background);
    context.textBaseline = "middle";
    for (const item of layer.textItems) {
      context.font = `${item.fontStyle ?? "normal"} ${item.fontWeight ?? 400} ${item.size}px ${FIGURE_FONT_FAMILY}`;
      context.textAlign = item.fontStyle === "italic" ? "center" : "left";
      context.fillText(item.label, item.x, item.y);
    }
    layer.previewBlob = await canvasToPngBlob(canvas, exportDpi(options.settings));
    canvas.width = canvas.height = 1;
  }
  return { kind: "combined", settings: options.settings, prepared };
}
