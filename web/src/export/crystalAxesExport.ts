import type { SceneSpec } from "../api/scene";
import type { CameraPoseSnapshot } from "../scene/cameraPose";
import type { RasterExportImage } from "../scene/exportRenderer";
import type {
  CrystalAxisColors,
  CrystalAxisMaterialState,
  ExportBackground,
  ExportFormat,
  ExportSettingsState,
  ExportSupersampling,
} from "../model";
import {
  exportBackgroundColor,
  exportTextColor,
  rasterFormatForExportFormat,
  withRasterDpi,
} from "./rasterCanvas";
import { encodeRasterTextPdf } from "./pdfTextExport";
import type { FigureExportFile } from "./types";
import { DEFAULT_EXPORT_DPI } from "../model/exportSettings";

const CRYSTAL_AXIS_EXPORT_SIZE_RATIO = 1;
export const CRYSTAL_AXIS_LABEL_HALO_COLOR = "#ffffff";

export async function createCrystalAxesExportFile({
  axisColors,
  materialState,
  background,
  cameraPose,
  fileName,
  format,
  scene,
  showCrystalAxisLabels,
  size,
  supersampling,
  dpi = DEFAULT_EXPORT_DPI,
}: {
  axisColors: CrystalAxisColors;
  materialState?: CrystalAxisMaterialState;
  background: ExportBackground;
  cameraPose: CameraPoseSnapshot;
  fileName: string;
  format: ExportFormat;
  scene: SceneSpec;
  showCrystalAxisLabels: boolean;
  size: number;
  supersampling: ExportSupersampling;
  dpi?: number;
}): Promise<FigureExportFile> {
  const rasterImage = await renderCrystalAxesForExport({
    axisColors,
    materialState,
    background,
    cameraPose,
    format,
    scene,
    showCrystalAxisLabels,
    size,
    supersampling,
    dpi,
  });

  if (format === "pdf") {
    return {
      blob: await encodeRasterTextPdf(rasterImage, { background, halo: false, dpi }),
      fileName,
      format,
    };
  }

  return {
    blob: rasterImage.blob,
    fileName,
    format,
  };
}

export async function renderCrystalAxesForExport({
  axisColors,
  materialState,
  background,
  cameraPose,
  format,
  scene,
  showCrystalAxisLabels,
  size,
  supersampling,
  dpi = DEFAULT_EXPORT_DPI,
}: {
  axisColors: CrystalAxisColors;
  materialState?: CrystalAxisMaterialState;
  background: ExportBackground;
  cameraPose: CameraPoseSnapshot;
  format: ExportFormat;
  scene: SceneSpec;
  showCrystalAxisLabels: boolean;
  size: number;
  supersampling: ExportSupersampling;
  dpi?: number;
}): Promise<RasterExportImage> {
  const { renderCrystalAxesRasterImage } = await import("../scene/exportRenderer");
  const image = await renderCrystalAxesRasterImage({
    axisColors,
    materialState,
    backgroundColor: exportBackgroundColor(background),
    cameraPose,
    cellVectors: scene.cell.vectors,
    imageFormat: rasterFormatForExportFormat(format),
    includeLabelTextItems: format === "pdf" && showCrystalAxisLabels,
    labelColor: exportTextColor(background),
    labelHaloColor: CRYSTAL_AXIS_LABEL_HALO_COLOR,
    showLabelHalo: format !== "pdf" && background !== "black" && showCrystalAxisLabels,
    showLabels: format !== "pdf" && showCrystalAxisLabels,
    size,
    supersampling,
  });
  return { ...image, blob: await withRasterDpi(image.blob, rasterFormatForExportFormat(format), dpi) };
}

export function crystalAxisExportSize(
  settings: ExportSettingsState,
  referenceSize: number,
): number {
  return Math.round(referenceSize * CRYSTAL_AXIS_EXPORT_SIZE_RATIO);
}
