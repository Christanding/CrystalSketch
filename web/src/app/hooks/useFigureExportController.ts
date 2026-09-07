import {
  type RefObject,
  useCallback,
  useState,
  useRef,
  useEffect,
} from "react";
import type { Quaternion } from "three";

import type { SceneSpec } from "../../api/scene";
import { createCameraPoseSnapshot } from "../../scene/cameraPose";
import { computeStructureExportProjectedSize } from "../../scene/exportFrame";
import {
  createFigureExportFiles,
  downloadFigureExportFiles,
} from "../exportFigure";
import {
  createDefaultExportSettings,
  syncExportSettingsProjectedSize,
  type ComponentOpacityState,
  type BondVisibilityOverrides,
  type ComponentVisibilityState,
  type ExportProjectedSize,
  type ExportSettingsState,
  type FigureExportLayout,
  type StyleState,
  type StructureLineWidthState,
  type UnitCellLineStyle,
} from "../../model";
import { prepareFigurePreview, type FigurePreviewState } from "../../export/figurePreview";

interface UseFigureExportControllerOptions {
  blockedReason?: string;
  visibleSceneOverride?: SceneSpec | null;
  initialSettings?: ExportSettingsState;
  bondVisibilityOverrides: BondVisibilityOverrides;
  cameraOrientationRef: RefObject<Quaternion>;
  componentOpacity: ComponentOpacityState;
  componentVisibility: ComponentVisibilityState;
  lightStrength: number;
  scene: SceneSpec | null;
  selectedFileName: string | null;
  showCrystalAxisLabels: boolean;
  style: StyleState;
  structureLineWidth: StructureLineWidthState;
  unitCellLineStyle: UnitCellLineStyle;
  visibleScene: SceneSpec | null;
}

export function useFigureExportController({
  blockedReason,
  visibleSceneOverride,
  initialSettings,
  bondVisibilityOverrides,
  cameraOrientationRef,
  componentOpacity,
  componentVisibility,
  lightStrength,
  scene,
  selectedFileName,
  showCrystalAxisLabels,
  style,
  structureLineWidth,
  unitCellLineStyle,
  visibleScene,
}: UseFigureExportControllerOptions) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportProjectedSize, setExportProjectedSize] =
    useState<ExportProjectedSize | null>(null);
  const [exportSettings, setExportSettings] = useState(() => initialSettings ?? createDefaultExportSettings());
  const [figurePreview, setFigurePreview] = useState<FigurePreviewState>({ open: false, loading: false, error: null, content: null });
  const previewRequestRef = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => () => { previewRequestRef.current += 1; }, []);

  const resetExportState = useCallback(() => {
    previewRequestRef.current += 1;
    setFigurePreview({ open: false, loading: false, error: null, content: null });
    setExportError(null);
    setExportProjectedSize(null);
    setExportSettings(createDefaultExportSettings());
  }, []);

  const computeCurrentExportProjectedSize = useCallback(() => {
    if (!visibleScene) {
      return null;
    }

    return computeStructureExportProjectedSize({
      cameraPose: createCameraPoseSnapshot(cameraOrientationRef.current),
      componentOpacity,
      scene: visibleScene,
      showAtoms: componentVisibility.atoms,
      showUnitCell: componentVisibility.unitCell,
      style,
    });
  }, [
    cameraOrientationRef,
    componentOpacity,
    componentVisibility.atoms,
    componentVisibility.unitCell,
    style,
    visibleScene,
  ]);

  const refreshExportProjectedSize = useCallback(() => {
    const projectedSize = computeCurrentExportProjectedSize();
    setExportProjectedSize(projectedSize);
    return projectedSize;
  }, [computeCurrentExportProjectedSize]);

  const prepareExportSettings = useCallback(() => {
    const projectedSize = refreshExportProjectedSize();
    if (projectedSize === null) {
      return exportSettings;
    }

    const nextExportSettings = syncExportSettingsProjectedSize(
      exportSettings,
      projectedSize,
    );
    if (nextExportSettings !== exportSettings) {
      setExportSettings(nextExportSettings);
    }
    return nextExportSettings;
  }, [exportSettings, refreshExportProjectedSize]);

  const visibleExportProjectedSize = visibleScene ? exportProjectedSize : null;

  const syncProjectedSizeForExportTab = useCallback(() => {
    const projectedSize = refreshExportProjectedSize();
    if (projectedSize === null) {
      return;
    }

    setExportSettings((currentSettings) =>
      syncExportSettingsProjectedSize(currentSettings, projectedSize),
    );
  }, [refreshExportProjectedSize]);

  const handleExportSettingsChange = useCallback(
    (nextExportSettings: ExportSettingsState) => {
      setExportSettings(nextExportSettings);
      setExportError(null);
    },
    [],
  );

  const handleExportFigure = useCallback(async () => {
    if (blockedReason) { setExportError(blockedReason); return; }
    if (!scene || busyRef.current) {
      return;
    }

    busyRef.current = true;
    setIsExporting(true);
    setExportError(null);

    try {
      const settingsForExport = prepareExportSettings();
      const exportFiles = await createFigureExportFiles({
        visibleSceneOverride,
        bondVisibilityOverrides,
        cameraOrientationRef,
        componentOpacity,
        componentVisibility,
        fileName: selectedFileName,
        lightStrength,
        scene,
        settings: settingsForExport,
        showCrystalAxisLabels,
        style,
        structureLineWidth,
        unitCellLineStyle,
      });
      await downloadFigureExportFiles(exportFiles, selectedFileName);
    } catch (error) {
      setExportError(
        error instanceof Error
          ? error.message
          : "Could not export this structure figure.",
      );
    } finally {
      busyRef.current = false;
      setIsExporting(false);
    }
  }, [
    blockedReason,
    cameraOrientationRef,
    visibleSceneOverride,
    bondVisibilityOverrides,
    componentOpacity,
    componentVisibility,
    isExporting,
    lightStrength,
    prepareExportSettings,
    scene,
    selectedFileName,
    showCrystalAxisLabels,
    style,
    structureLineWidth,
    unitCellLineStyle,
  ]);

  const handlePreviewFigure = useCallback(async () => {
    if (blockedReason) { setExportError(blockedReason); return; }
    if (!scene || busyRef.current) return;
    busyRef.current = true;
    setIsExporting(true);
    const requestId = ++previewRequestRef.current;
    setExportError(null);
    setFigurePreview({ open: true, loading: true, error: null, content: null });
    try {
      const content = await prepareFigurePreview({
        visibleSceneOverride,
        bondVisibilityOverrides,
        cameraOrientationRef,
        componentOpacity,
        componentVisibility,
        fileName: selectedFileName,
        lightStrength,
        scene,
        settings: prepareExportSettings(),
        showCrystalAxisLabels,
        style,
        structureLineWidth,
        unitCellLineStyle,
      });
      if (previewRequestRef.current === requestId) {
        setFigurePreview({ open: true, loading: false, error: null, content });
      }
    } catch (error) {
      if (previewRequestRef.current === requestId) {
        setFigurePreview({ open: true, loading: false, content: null,
          error: error instanceof Error ? error.message : "Could not prepare this figure preview." });
      }
    } finally {
      busyRef.current = false;
      setIsExporting(false);
    }
  }, [blockedReason, scene, visibleSceneOverride, bondVisibilityOverrides, cameraOrientationRef,
    componentOpacity, componentVisibility, selectedFileName, lightStrength,
    prepareExportSettings, showCrystalAxisLabels, style, structureLineWidth, unitCellLineStyle]);

  const handleFigurePreviewOpenChange = useCallback((open: boolean) => {
    if (!open) {
      previewRequestRef.current += 1;
      setFigurePreview({ open: false, loading: false, error: null, content: null });
    }
  }, []);

  const handleFigurePreviewLayoutChange = useCallback((layout: FigureExportLayout | undefined) => {
    setExportSettings(current => ({ ...current, previewLayout: layout }));
    setExportError(null);
  }, []);

  return {
    exportError,
    exportProjectedSize: visibleExportProjectedSize,
    exportSettings,
    figurePreview,
    handlePreviewFigure,
    handleFigurePreviewOpenChange,
    handleFigurePreviewLayoutChange,
    handleExportFigure,
    handleExportSettingsChange,
    isExporting,
    resetExportState,
    setExportError,
    setExportSettings,
    syncProjectedSizeForExportTab,
  };
}
