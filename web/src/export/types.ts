import type { SceneSpec } from "../api/scene";
import type { RenderProgress } from "../model/renderSettings";
import type { CameraOrientationRef } from "../scene/LatticeScene";
import type {
  ComponentOpacityState,
  ComponentVisibilityState,
  BondVisibilityOverrides,
  ExportFormat,
  ExportSettingsState,
  StyleState,
  StructureLineWidthState,
  UnitCellLineStyle,
} from "../model";

export interface FigureRenderControl {
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

export interface CreateFigureExportOptions {
  renderControl?: FigureRenderControl;
  bondVisibilityOverrides: BondVisibilityOverrides;
  cameraOrientationRef: CameraOrientationRef;
  componentOpacity: ComponentOpacityState;
  componentVisibility: ComponentVisibilityState;
  fileName: string | null;
  lightStrength: number;
  scene: SceneSpec;
  visibleSceneOverride?: SceneSpec | null;
  settings: ExportSettingsState;
  showCrystalAxisLabels: boolean;
  style: StyleState;
  structureLineWidth: StructureLineWidthState;
  unitCellLineStyle: UnitCellLineStyle;
}

export interface FigureExportFile {
  blob: Blob;
  fileName: string;
  format: ExportFormat;
}

export type RasterExportFileFormat = Exclude<ExportFormat, "pdf">;
