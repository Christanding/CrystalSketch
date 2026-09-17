import type { SceneSpec } from "../api/scene";
import type { CameraPoseSnapshot } from "../scene/cameraPose";
import type { RasterExportImage } from "../scene/exportRenderer";
import { displayedMeasurements } from "../scene/MeasurementAnnotations";
import type {
  ComponentOpacityState,
  ComponentVisibilityState,
  ExportSettingsState,
  StyleState,
  StructureLineWidthState,
  UnitCellLineStyle,
} from "../model";
import {
  exportBackgroundColor,
  rasterFormatForExportFormat,
  withRasterDpi,
} from "./rasterCanvas";
import { exportDpi } from "../model/exportSettings";
import type { FigureRenderControl } from "./types";

const DARK_BACKGROUND_UNIT_CELL_LINE_COLOR = "#bbbbbb";

export async function renderExportRaster({
  renderControl,
  separateMeasurementLabels,
  cameraPose,
  componentOpacity,
  componentVisibility,
  lightStrength,
  settings,
  style,
  structureLineWidth,
  unitCellLineStyle,
  visibleScene,
}: {
  renderControl?: FigureRenderControl;
  separateMeasurementLabels?: boolean;
  cameraPose: CameraPoseSnapshot;
  componentOpacity: ComponentOpacityState;
  componentVisibility: ComponentVisibilityState;
  lightStrength: number;
  settings: ExportSettingsState;
  style: StyleState;
  structureLineWidth: StructureLineWidthState;
  unitCellLineStyle: UnitCellLineStyle;
  visibleScene: SceneSpec;
}): Promise<RasterExportImage> {
  const { renderStructureRasterImage } = await import("../scene/exportRenderer");
  const hasSeparateLabels = separateMeasurementLabels && visibleScene.measurementStyle?.showLabels !== false
    && displayedMeasurements(visibleScene).length > 0;
  // The final compositor owns JPEG encoding; keep a split structure lossless until then.
  const imageFormat = hasSeparateLabels ? "png" : rasterFormatForExportFormat(settings.format);

  const image = await renderStructureRasterImage({
    renderControl,
    separateMeasurementLabels,
    backgroundColor: exportBackgroundColor(settings.background),
    cameraPose,
    componentOpacity,
    height: settings.height,
    imageFormat,
    lightStrength,
    meshQuality: settings.meshQuality,
    scene: visibleScene,
    showAtoms: componentVisibility.atoms,
    showUnitCell: componentVisibility.unitCell,
    style,
    structureLineWidth,
    supersampling: settings.supersampling,
    unitCellLineColor:
      settings.background === "black" ? DARK_BACKGROUND_UNIT_CELL_LINE_COLOR : undefined,
    unitCellLineStyle,
    width: settings.width,
  });
  return { ...image, blob: await withRasterDpi(image.blob, imageFormat, exportDpi(settings)) };
}
