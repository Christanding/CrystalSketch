import { createCameraPoseSnapshot } from "../scene/cameraPose";
import {
  validateExportSettings,
  visibleSceneForComponents,
  exportDpi,
} from "../model";
import { encodeRasterPdf } from "./pdfTextExport";
import { renderExportRaster } from "./structureRasterExport";
import type {
  CreateFigureExportOptions,
  FigureExportFile,
} from "./types";
import { exportFileStem } from "./fileNames";
import { composeCombinedExportRaster, structureExportLayers, structureOnlyFigureExportLayout } from "./combinedExportRaster";

export async function createStructureExportFile({
  renderControl,
  bondVisibilityOverrides,
  cameraOrientationRef,
  componentOpacity,
  componentVisibility,
  fileName,
  lightStrength,
  scene,
  visibleSceneOverride,
  settings,
  style,
  structureLineWidth,
  unitCellLineStyle,
}: CreateFigureExportOptions): Promise<FigureExportFile> {
  const validation = validateExportSettings(settings);
  if (!validation.valid) {
    throw new Error("Export settings are invalid.");
  }

  const visibleScene = visibleSceneOverride === undefined
    ? visibleSceneForComponents(scene, componentVisibility, style.objectStyles, bondVisibilityOverrides)
    : visibleSceneOverride;
  if (!visibleScene) {
    throw new Error("No structure is available to export.");
  }

  const cameraPose = createCameraPoseSnapshot(cameraOrientationRef.current);
  let rasterImage = await renderExportRaster({
    renderControl,
    cameraPose,
    componentOpacity,
    componentVisibility,
    lightStrength,
    settings,
    style,
    structureLineWidth,
    unitCellLineStyle,
    visibleScene,
    separateMeasurementLabels: true,
  });
  if (rasterImage.measurementLabels?.length) {
    rasterImage = await composeCombinedExportRaster({
      layers: structureExportLayers(rasterImage, settings.format === "pdf"), width: rasterImage.width, height: rasterImage.height,
    }, { ...settings, previewLayout: structureOnlyFigureExportLayout(settings.previewLayout) });
  }

  if (settings.format === "pdf") {
    return {
      blob: await encodeRasterPdf(rasterImage, exportDpi(settings)),
      fileName: `${exportFileStem(fileName)}.pdf`,
      format: "pdf",
    };
  }

  return {
    blob: rasterImage.blob,
    fileName: `${exportFileStem(fileName)}.${settings.format}`,
    format: settings.format,
  };
}
