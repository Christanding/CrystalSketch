import { AlertTriangleIcon, FolderOpen, ImageDown, Redo2, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { captureSceneVisibility, restoreObjectStyleVisibility, restoreAtomColors, useSceneEdits } from "./hooks/useSceneEdits";
import { useMeasurementTools } from "./hooks/useMeasurementTools";
import { MeasurementToolsPanel } from "./controls/commonPanel/MeasurementToolsPanel";
import { type WorkspacePreferences } from "./workspaceStorage";
import { createPortal } from "react-dom";
import { loadDocuments, createEmptyManifest, type StoredDocuments } from "./documentStorage";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { transferableStyle, type DocumentEditorProps } from "./documentState";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SceneSelectionProvider } from "../selection/SceneSelection";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { MotionProvider, useMotion } from "@/motion/MotionProvider";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";
import { PREVIEW_THEME_COLORS } from "@/theme/previewTheme";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CrystalSketchLogo } from "./panels/CrystalSketchLogo";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { AtomInspectorCard } from "./AtomInspectorCard";
import { BondInspectorCard } from "./BondInspectorCard";
import type { BondCutoffRange, SceneSpec } from "../api/scene";
import { LatticeScene } from "../scene/LatticeScene";
import { OrientationGizmo } from "../scene/OrientationGizmo";
import { crystalAxisColorsForStyle, crystalAxisMaterialForStyle } from "../model/appearance";
import {
  CommonControlsPanel,
  type CommonPanelTab,
} from "./controls/CommonControlsPanel";
import { ViewControlRail } from "./controls/ViewControlRail";
import { createCameraInteractionStore } from "./cameraInteractionStore";
import {
  ColorPickerRegistryProvider,
  useColorPickerRegistry,
} from "./colorPickerRegistry";
import { createPreviewFpsStore } from "../model/previewFpsStore";
import { useFigureAppearanceController } from "./hooks/useFigureAppearanceController";
import { useFigureExportController } from "./hooks/useFigureExportController";
import { PoscarExportPanel } from "./controls/commonPanel/PoscarExportPanel";
import { usePoscarExportController } from "./hooks/usePoscarExportController";
import { FigurePreviewDialog } from "./controls/commonPanel/FigurePreviewDialog";
import { ModelingPanel } from "./inspector/ModelingPanel";
import { useModelingController } from "./hooks/useModelingController";
import { fractionalToCartesian, modelToScene, type Vec3 } from "../model/structureModel";
import { useLockedInteractionFeedback } from "./hooks/useLockedInteractionFeedback";
import { usePreviewCameraCommands } from "./hooks/usePreviewCameraCommands";
import { useSceneObjectInteractionController } from "./hooks/useSceneObjectInteractionController";
import { useStructurePreview } from "./hooks/useStructurePreview";
import type { StructurePreviewErrorKind } from "./hooks/useStructurePreview";
import { ElementLegend } from "./legend/ElementLegend";
import {
  orientationGizmoContainerStyle,
  orientationGizmoSizeForViewport,
  compactLegendStyle,
  compactInspectionStyle,
  useMeasuredPreviewLayout,
  useViewportSize,
} from "./layout/overlayLayout";
import { StructureSummaryCard } from "./panels/StructureSummaryCard";
import {
  InspectorSidebar,
  InspectorToggle,
} from "./inspector/InspectorSidebar";
import {
  hasPolyhedra,
  previewSafeAreaForInspector,
  sceneOffsetXForInspector,
  NARROW_PREVIEW_BREAKPOINT_PX,
  setAtomColorOverrides,
  visibleSceneForComponents,
} from "../model";
const EMPTY_BOND_CUTOFF_OVERRIDES: Record<string, BondCutoffRange> = {};

interface ResetLoadedPreviewOptions {
  preserveActiveCommonPanelTab?: boolean;
  preserveInspectorOpen?: boolean;
}

type ResetLoadedPreviewState = (
  nextScene: SceneSpec | null,
  options?: ResetLoadedPreviewOptions,
) => void;

export function App() {
  const { t } = useTranslation();
  const [startup, setStartup] = useState<{ workspace: StoredDocuments; failed: boolean } | null>(
    () => typeof indexedDB === "undefined" ? { workspace: { manifest: createEmptyManifest(), documents: [] }, failed: false } : null,
  );
  useEffect(() => {
    if (typeof indexedDB === "undefined") return;
    let active = true;
    void loadDocuments().then(workspace => { if (active) setStartup({ workspace, failed: false }); })
      .catch(() => { if (active) setStartup({ workspace: { manifest: createEmptyManifest(), documents: [] }, failed: true }); });
    return () => { active = false; };
  }, []);
  return (
    <MotionProvider>
      <ThemeProvider>
        <ColorPickerRegistryProvider>
          {startup
            ? <DocumentWorkspace initial={startup.workspace} restoreFailed={startup.failed} editor={AppContent} />
            : <div role="status" className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">{t("workspace.restoring")}</div>}
        </ColorPickerRegistryProvider>
      </ThemeProvider>
    </MotionProvider>
  );
}

function AppContent({ initialWorkspace, leftSidebarOpen, onLeftSidebarOpenChange, active, comparison, comparisonControls, canCompare, onToggleCompare, controlsHost, comparisonCameraStore, onActivate, onOpen, onCreateModel, onClose, register }: DocumentEditorProps) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { reducedMotion } = useMotion();
  const { closeActiveColorPicker } = useColorPickerRegistry();
  const [activeCommonPanelTab, setActiveCommonPanelTab] =
    useState<CommonPanelTab>("display");
  const [cameraInteractionStore] = useState(() => createCameraInteractionStore(initialWorkspace?.preferences.viewScale, initialWorkspace?.preferences.viewPan));
  const [workspaceError, setWorkspaceError] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const [previewFpsStore] = useState(createPreviewFpsStore);
  const [isStructureSummaryCollapsed, setIsStructureSummaryCollapsed] = useState(true);
  const [workspaceResetRequest, setWorkspaceResetRequest] = useState<{
    options: ResetLoadedPreviewOptions;
    scene: SceneSpec | null;
    token: number;
  }>({ options: {}, scene: null, token: 0 });
  const windowSize = useViewportSize();
  const editorRef = useRef<HTMLDivElement>(null);
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const restoreLeftSidebarRef = useRef<HTMLButtonElement>(null);
  const previousLeftSidebarOpen = useRef(leftSidebarOpen);
  const [viewportSize, setViewportSize] = useState(windowSize);
  useLayoutEffect(() => {
    const element = editorRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const resetLoadedPreviewState = useCallback<ResetLoadedPreviewState>(
    (nextScene, options = {}) => {
      closeActiveColorPicker();
      setWorkspaceResetRequest((currentRequest) => ({
        options,
        scene: nextScene,
        token: currentRequest.token + 1,
      }));
    },
    [closeActiveColorPicker],
  );
  const handlePreviewCleared = useCallback(() => {
    resetLoadedPreviewState(null);
  }, [resetLoadedPreviewState]);
  const handleBondAlgorithmSceneLoaded = useCallback(() => {
    closeActiveColorPicker();
  }, [closeActiveColorPicker]);
  const {
    replaceModel,
    readSession,
    updateModelSymmetry,
    bondAlgorithm,
    customBondingProfile,
    connectivityIntent,
    connectivityRetryable,
    connectivityStatus,
    errorKind,
    errorMessage,
    errorTitle,
    handleBondAlgorithmChange,
    handleBondCutoffOverridesChange,
    handleBondToleranceChange,
    handleResetAllSettings,
    requestConnectivity,
    previewStatus,
    scene: sourceScene,
    selectedFileName,
    setErrorMessage,
    session,
    clearPreview,
    symmetryPending,
  } = useStructurePreview({
    initialSession: initialWorkspace?.session,
    onBondAlgorithmSceneLoaded: handleBondAlgorithmSceneLoaded,
    onPreviewCleared: handlePreviewCleared,
    resetLoadedPreviewState,
  });
  const editing = useSceneEdits(sourceScene, workspaceResetRequest.token, initialWorkspace?.preferences.edits,
    { preserveHistoryOnReset: Boolean(session?.model) });
  const modelCommands = useRef<{ report: (error: unknown) => void; cancel: () => void; hasPreview: boolean }>({
    report: () => {}, cancel: () => {}, hasPreview: false,
  });
  const safeDelete = useCallback((selection: Parameters<typeof editing.deleteObjects>[0]) => {
    try { modelCommands.current.cancel(); editing.deleteObjects(selection); }
    catch (error) { modelCommands.current.report(error); }
  }, [editing.deleteObjects]);
  const safeUndo = useCallback(() => {
    if (modelCommands.current.hasPreview) { modelCommands.current.cancel(); return true; }
    try { return editing.undoDeletion(); } catch (error) { modelCommands.current.report(error); return false; }
  }, [editing.undoDeletion]);
  const safeRedo = useCallback(() => {
    try { modelCommands.current.cancel(); return editing.redoDeletion(); }
    catch (error) { modelCommands.current.report(error); return false; }
  }, [editing.redoDeletion]);
  const scene = editing.scene;
  const appearance = useFigureAppearanceController({
    recordVisibilityChange: editing.recordVisibilityChange,
    initialState: initialWorkspace?.preferences.appearance,
    closeActiveColorPicker,
    connectivityStatus,
    requestConnectivity,
    scene,
  });
  useLayoutEffect(() => editing.registerVisibilityRestore(appearance.restoreVisibilityState), [editing.registerVisibilityRestore, appearance.restoreVisibilityState]);
  const interaction = useSceneObjectInteractionController({
    active,
    initialInspectorTab: initialWorkspace?.session.model ? "modeling" : undefined,
    deleteObjects: safeDelete,
    undoDeletion: safeUndo,
    redoDeletion: safeRedo,
    closeActiveColorPicker,
    componentVisibility: appearance.componentVisibility,
    connectivityStatus,
    hideAtom: appearance.hideAtom,
    requestConnectivity,
    setBondVisible: appearance.setBondVisible,
    visibleScene: appearance.visibleScene,
  });
  const measurementTools = useMeasurementTools({
    scene, visibleScene: appearance.visibleScene, resetToken: session?.model ? 0 : workspaceResetRequest.token,
    selection: interaction.selection, select: interaction.replaceSelection,
    initial: initialWorkspace?.preferences.measurementTools,
  });
  const modeling = useModelingController({ session, selection: interaction.selection, editing, readSession,
    onCreateModel, active, updateModelSymmetry,
    onLocatePoint: point => {
      const current = readSession();
      if (!current) return;
      cameraInteractionStore.requestPanTarget(fractionalToCartesian(point.map(value => value - .5) as Vec3, current.scene.cell.vectors));
    },
  });
  modelCommands.current = { report: modeling.report, cancel: modeling.cancel, hasPreview: Boolean(modeling.previewScene) };
  useLayoutEffect(() => {
    if (!session?.model) return;
    return editing.registerModelEditing({
      read: () => readSession()!.model!.state,
      readReferences: measurementTools.getModelReferences,
      replace: (state, replay) => {
        const before = readSession()!;
        const nextScene = modeling.preparedSceneFor(state)
          ?? modelToScene(state, before.customBondingProfile?.cutoffOverrides, before.scene.bondTolerance);
        measurementTools.transitionModelReferences(before.model!.state, state, before.scene, nextScene, replay);
        replaceModel(state, nextScene);
        // The same image ID can refer to a different physical copy after changing the cell.
        const sameCell = before.model!.state.structure.cell.vectors.every((vector, axis) =>
          vector.every((value, component) => value === state.structure.cell.vectors[axis]![component]));
        if (sameCell) interaction.pruneSelection(nextScene);
        else interaction.clearSelection();
      },
    });
  }, [session?.id, Boolean(session?.model), editing.registerModelEditing, readSession, replaceModel,
    modeling.preparedSceneFor, measurementTools.getModelReferences, measurementTools.transitionModelReferences,
    interaction.pruneSelection, interaction.clearSelection]);
  useEffect(() => {
    if (interaction.activeInspectorTab !== "modeling" || !interaction.isInspectorOpen) modeling.cancel();
  }, [interaction.activeInspectorTab, interaction.isInspectorOpen, modeling.cancel]);
  const modelingPreviewScene = useMemo(() => modeling.previewScene ? visibleSceneForComponents(modeling.previewScene,
    appearance.componentVisibility, appearance.style.objectStyles, appearance.bondVisibilityOverrides) : null,
  [modeling.previewScene, appearance.componentVisibility, appearance.style.objectStyles, appearance.bondVisibilityOverrides]);
  const modelExportBlock = modeling.controller.preview || modeling.controller.busy ? t("modeling.pendingExport") : undefined;
  const poscarExport = usePoscarExportController(sourceScene ? { file: session?.file ?? null,
    fileName: selectedFileName, scene: sourceScene, deletedAtomIds: editing.snapshot.deleted.atoms,
    model: session?.model ? { structure: session.model.state.structure, revision: session.model.revision } : undefined } : null,
    { blockedReason: modelExportBlock, initialDraft: initialWorkspace?.preferences.poscarDraft });
  const measurementMode = leftSidebarOpen && activeCommonPanelTab === "tools"
    && (measurementTools.tool === "distance" || measurementTools.tool === "angle");
  useEffect(() => {
    const changed = previousLeftSidebarOpen.current !== leftSidebarOpen;
    previousLeftSidebarOpen.current = leftSidebarOpen;
    if (!leftSidebarOpen) {
      closeActiveColorPicker();
      measurementTools.setTool("inspect");
      if (changed) restoreLeftSidebarRef.current?.focus({ preventScroll: true });
    } else if (changed) leftSidebarRef.current?.focus({ preventScroll: true });
  }, [leftSidebarOpen, closeActiveColorPicker, measurementTools.setTool]);
  const visibleAtomIds = useMemo(() => new Set(appearance.componentVisibility.atoms && appearance.componentOpacity.atoms > 0
    ? appearance.visibleScene?.atoms.map(atom => atom.id) : []), [appearance.visibleScene?.atoms, appearance.componentVisibility.atoms, appearance.componentOpacity.atoms]);
  const handleToolAtomInspect = useCallback((id: string | null, additive = false) => {
    if (modelCommands.current.hasPreview) return;
    if (measurementMode) { if (id) measurementTools.pickAtom(id); }
    else interaction.handleAtomInspect(id, additive);
  }, [measurementMode, measurementTools.pickAtom, interaction.handleAtomInspect]);
  const handleToolBondInspect = useCallback((id: string | null, additive = false) => {
    if (modelCommands.current.hasPreview) return;
    if (!measurementMode) interaction.handleBondInspect(id, additive);
  }, [measurementMode, interaction.handleBondInspect]);
  const {
    bondVisibilityOverrides,
    componentOpacity,
    componentVisibility,
    elementColorOverrides,
    handleBondFamilyVisibilityChange,
    handleComponentOpacityChange,
    handleComponentOpacityReset,
    handleComponentVisibilityChange,
    handleDistinguishSimilarColorsChange,
    handleFogAffectsUnitCellChange,
    handleLegendElementColorChange,
    legendColorScheme,
    legendEntries,
    objectStyleAtoms,
    polyhedronElements,
    previewMeshQuality,
    resetAppearance,
    setPreviewMeshQuality,
    setComponentOpacity,
    setShowCrystalAxisLabels,
    setStructureLineWidth,
    setStyle,
    setUnitCellLineStyle,
    showCrystalAxisLabels,
    structureLineWidth,
    style,
    unitCellLineStyle,
    visibleScene,
  } = appearance;
  const {
    activeInspectorTab,
    activeObjectsTab,
    atomLocateRequest,
    bondLocateRequest,
    bondObjectsResetToken,
    clearSelection,
    handleActiveInspectorTabChange,
    handleActiveObjectsTabChange,
    handleAtomLocateRequestHandled,
    handleAtomPulse,
    handleBondInspect,
    handleBondLocateRequestHandled,
    handleBondPulse,
    handleBondVisibilityChange,
    handleHideAtom,
    handleHideBond,
    handleInspectorOpenChange,
    handleLocateAtomInObjects,
    handleLocateBondInObjects,
    handleSelectionActivationChange,
    inspectedAtomId,
    inspectedAtomInfo,
    inspectedBondId,
    inspectedBondInfo,
    isInspectorOpen,
    pulsedSceneObject,
    resetInteraction,
    selectionActivation,
  } = interaction;
  const selectedColorAtoms = useMemo(() => {
    const atoms = sourceScene?.atoms ?? [];
    const siteIds = new Set(atoms.filter(atom => interaction.selection.atoms.has(atom.id)).map(atom => atom.siteId));
    return atoms.filter(atom => siteIds.has(atom.siteId));
  }, [sourceScene, interaction.selection.atoms]);
  useLayoutEffect(() => editing.registerAtomColorRestore(snapshot => {
    setStyle(current => ({ ...current, objectStyles: restoreAtomColors(current.objectStyles, snapshot) }));
  }), [editing.registerAtomColorRestore, setStyle]);
  const handleSelectedAtomColor = useCallback((color: string | null, group?: object) => {
    setStyle(current => {
      const objectStyles = setAtomColorOverrides(current.objectStyles, selectedColorAtoms, color);
      editing.recordAtomColorChange(current.objectStyles, objectStyles, group);
      return objectStyles === current.objectStyles ? current : { ...current, objectStyles };
    });
  }, [editing.recordAtomColorChange, selectedColorAtoms, setStyle]);
  const hasVisibleScene = visibleScene !== null;
  const {
    cameraAnimatedCommandVersion,
    cameraCommandVersion,
    cameraControlsPanelState,
    cameraOrientationRef,
    cameraOrientationVersion,
    handleCameraCommandAnimationActiveChange,
    handleCameraControlsInteractionActiveChange,
    handleCameraOrientationChange,
    handleCameraPrimaryChange,
    handleCameraRollChange,
    handleCameraRollPreviewChange,
    handleCameraRollPreviewStart,
    handleDragSensitivityChange,
    handleGizmoAxisClick,
    handleInteractionLockedChange,
    handleInteractionModeChange,
    handleLightStrengthChange,
    handleMouseInertiaChange,
    handleResetView,
    handleShowFpsOverlayChange,
    isCameraCommandAnimationActive,
    isCameraControlsInteractionActive,
    isCameraRollInteractionActive,
    orientationGizmoFrameRequestRef,
    requestOrientationGizmoFrame,
    resetCameraForScene,
    viewState,
  } = usePreviewCameraCommands({
    initialViewState: initialWorkspace?.preferences.viewState,
    cameraInteractionStore,
    previewFpsStore,
    scene,
    visibleScene,
  });
  const {
    exportError,
    exportProjectedSize,
    exportSettings,
    handleExportFigure,
    handleExportSettingsChange,
    figurePreview,
    handlePreviewFigure,
    handleFigurePreviewOpenChange,
    handleFigurePreviewLayoutChange,
    isExporting,
    resetExportState,
    setExportError,
    syncProjectedSizeForExportTab,
  } = useFigureExportController({
    blockedReason: modelExportBlock,
    visibleSceneOverride: measurementTools.exportVisibleScene,
    initialSettings: initialWorkspace?.preferences.exportSettings,
    bondVisibilityOverrides,
    cameraOrientationRef,
    componentOpacity,
    componentVisibility,
    lightStrength: viewState.lightStrength,
    scene: measurementTools.exportScene,
    selectedFileName,
    showCrystalAxisLabels,
    style,
    structureLineWidth,
    unitCellLineStyle,
    visibleScene: measurementTools.previewScene,
  });
  const workspacePreferences = useMemo<WorkspacePreferences | null>(() => session ? {
    version: 1,
    modelDocument: Boolean(session.model),
    sessionId: session.id,
    appearance: { style, componentVisibility, componentOpacity, bondVisibilityOverrides,
      previewMeshQuality, unitCellLineStyle, structureLineWidth, showCrystalAxisLabels },
    edits: editing.snapshot,
    viewState,
    viewScale: cameraInteractionStore.getViewScaleSnapshot(),
    viewPan: cameraInteractionStore.getPanSnapshot(),
    exportSettings,
    measurementTools: measurementTools.snapshot,
    poscarDraft: poscarExport.snapshot,
  } : null, [session, style, componentVisibility, componentOpacity, bondVisibilityOverrides,
    previewMeshQuality, unitCellLineStyle, structureLineWidth, showCrystalAxisLabels,
    editing.snapshot, viewState, cameraInteractionStore, exportSettings, measurementTools.snapshot, poscarExport.snapshot]);
  const persistence = useWorkspacePersistence(session, workspacePreferences, cameraInteractionStore, cameraOrientationRef);
  const latestEditor = useRef({ isExporting, workspacePreferences });
  latestEditor.current = { isExporting: isExporting || modeling.controller.busy, workspacePreferences };
  useLayoutEffect(() => register(session?.id ?? "empty", {
    snapshot: persistence.getSnapshot,
    closeColorPicker: closeActiveColorPicker,
    isBusy: () => latestEditor.current.isExporting,
    applyAppearance: preferences => {
      const source = transferableStyle(preferences.appearance.style);
      const target = latestEditor.current.workspacePreferences;
      if (!target) return;
      setStyle(current => ({ ...source, objectStyles: restoreObjectStyleVisibility(source.objectStyles,
        captureSceneVisibility(current.objectStyles, target.appearance.componentVisibility, target.appearance.bondVisibilityOverrides)) }));
      setComponentOpacity(preferences.appearance.componentOpacity);
      handleLightStrengthChange(preferences.viewState.lightStrength);
      setStructureLineWidth(preferences.appearance.structureLineWidth);
      setUnitCellLineStyle(preferences.appearance.unitCellLineStyle);
    },
  }), [register, session?.id, persistence.getSnapshot, closeActiveColorPicker, setStyle, setComponentOpacity, handleLightStrengthChange, setStructureLineWidth, setUnitCellLineStyle]);
  useEffect(() => { if (!active) closeActiveColorPicker(); }, [active, closeActiveColorPicker]);
  const handleClearWorkspace = async () => {
    setIsClearing(true);
    try {
      await onClose();
      setWorkspaceError(false);
      persistence.dismissSaveError();
      setClearDialogOpen(false);
    } catch {
      setWorkspaceError(true);
      setClearDialogOpen(false);
    } finally { setIsClearing(false); }
  };
  const {
    handleSceneContextMenuCapture,
    handleScenePointerDownCapture,
    handleScenePointerEndCapture,
    handleScenePointerMoveCapture,
    handleSceneWheelCapture,
    lockedInteractionFeedbackCount,
    resetLockedInteractionFeedback,
    triggerLockedInteractionFeedback,
  } = useLockedInteractionFeedback({
    hasVisibleScene,
    interactionLocked: viewState.interactionLocked,
  });

  useLayoutEffect(() => {
    if (workspaceResetRequest.token === 0) {
      return;
    }
    resetAppearance(workspaceResetRequest.scene);
    resetInteraction(workspaceResetRequest.options.preserveInspectorOpen);
    if (!workspaceResetRequest.options.preserveActiveCommonPanelTab) {
      setActiveCommonPanelTab("display");
    }
    setIsStructureSummaryCollapsed(true);
    resetExportState();
    resetLockedInteractionFeedback();
    resetCameraForScene(workspaceResetRequest.scene);
  }, [
    resetCameraForScene,
    resetAppearance,
    resetExportState,
    resetInteraction,
    resetLockedInteractionFeedback,
    workspaceResetRequest,
  ]);

  const handleActiveCommonPanelTabChange = useCallback((tab: CommonPanelTab) => {
    closeActiveColorPicker();
    if (tab !== "tools") measurementTools.setTool("inspect");
    setActiveCommonPanelTab(tab);
  }, [closeActiveColorPicker, measurementTools.setTool]);
  const compactPreview = !comparison && windowSize.width <= NARROW_PREVIEW_BREAKPOINT_PX;
  const measuredPreviewLayout = useMeasuredPreviewLayout({
    enabled: compactPreview && active, viewport: viewportSize, editorRef, controlsHost,
    leftOpen: leftSidebarOpen, rightOpen: isInspectorOpen, hasScene: scene !== null,
    hasInspection: Boolean((inspectedAtomInfo || inspectedBondInfo) && !measurementMode),
  });
  const previewSafeArea = useMemo(() => comparison ? { left: 20, right: 20, top: 126, bottom: 116 }
    : compactPreview ? measuredPreviewLayout.safeArea : previewSafeAreaForInspector(),
  [comparison, compactPreview, measuredPreviewLayout.safeArea]);
  const sceneOffsetX = comparison ? 0 : sceneOffsetXForInspector(isInspectorOpen, viewportSize.width)
    + (!leftSidebarOpen && viewportSize.width > 760 ? -(previewSafeArea.left - 64) / 2 : 0);
  const overlayAvailableArea = compactPreview ? measuredPreviewLayout.availableArea : previewSafeArea;
  const orientationGizmoSize = useMemo(
    () => comparison ? 130 : orientationGizmoSizeForViewport(viewportSize, overlayAvailableArea, compactPreview),
    [comparison, compactPreview, overlayAvailableArea, viewportSize],
  );
  const renderPreviewContextMenuContent = () => (
    <ContextMenuContent className="w-80 max-w-[var(--radix-context-menu-content-available-width)]">
      <ContextMenuGroup>
        <ContextMenuItem
          disabled={previewStatus === "loading" || isExporting || (!editing.snapshot.history.length && !modeling.previewScene)}
          aria-keyshortcuts="Meta+Z Control+Z"
          className="max-[600px]:flex-wrap"
          onSelect={() => { safeUndo(); }}
        >
          <Undo2 aria-hidden="true" /><span className="shrink-0 whitespace-nowrap">{t("actions.undo")}</span>
          <ContextMenuShortcut className="max-[600px]:ml-6 max-[600px]:basis-full">⌘ / Ctrl + Z</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={previewStatus === "loading" || isExporting || !editing.snapshot.future?.length}
          aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
          className="max-[600px]:flex-wrap"
          onSelect={() => { safeRedo(); }}
        >
          <Redo2 aria-hidden="true" /><span className="shrink-0 whitespace-nowrap">{t("actions.redo")}</span>
          <ContextMenuShortcut className="max-[600px]:ml-6 max-[600px]:basis-full">⌘ / Ctrl + Shift + Z</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem
          disabled={!scene || previewStatus === "loading"}
          onSelect={handleResetView}
        >
          <RotateCcw aria-hidden="true" />
          {t("actions.resetView")}
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem onSelect={onOpen}>
          <FolderOpen aria-hidden="true" />
          {t("actions.openFile")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!scene || isExporting || previewStatus === "loading"}
          onSelect={() => {
            void handleExportFigure();
          }}
        >
          <ImageDown aria-hidden="true" />
          {t("actions.exportFigure")}
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem
          disabled={!scene || previewStatus === "loading"}
          onSelect={() => {
            void handleResetAllSettings();
          }}
        >
          <RefreshCw aria-hidden="true" />
          {t("actions.resetAll")}
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  );

  useEffect(() => {
    if (activeCommonPanelTab !== "export") {
      return;
    }

    syncProjectedSizeForExportTab();
  }, [activeCommonPanelTab, cameraOrientationVersion, syncProjectedSizeForExportTab]);

  return (
    <SceneSelectionProvider value={interaction.selection}>
    <div ref={editorRef} className="relative h-full w-full overflow-clip bg-background text-foreground"
      style={visibleScene ? { backgroundColor: PREVIEW_THEME_COLORS[resolvedTheme].background } : undefined}>
      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); cancelClearRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>{t("workspace.clearTitle")}</DialogTitle>
            <DialogDescription>{t("workspace.clearDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancelClearRef} variant="outline" onClick={() => setClearDialogOpen(false)}>{t("workspace.cancel")}</Button>
            <Button variant="destructive" disabled={isClearing} onClick={() => void handleClearWorkspace()}>{t("workspace.confirmClear")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <section
            className="scene-stage absolute inset-0 transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduced:transition-none"
            style={{ transform: `translateX(${sceneOffsetX}px)` }}
            aria-label={t("preview.crystalStructurePreview")}
            onPointerCancelCapture={handleScenePointerEndCapture}
            onContextMenuCapture={handleSceneContextMenuCapture}
            onPointerDownCapture={handleScenePointerDownCapture}
            onPointerMoveCapture={handleScenePointerMoveCapture}
            onPointerUpCapture={handleScenePointerEndCapture}
            onWheelCapture={handleSceneWheelCapture}
          >
            {visibleScene || modelingPreviewScene ? (
              <LatticeScene
                comparisonCameraStore={comparison ? comparisonCameraStore : undefined}
                comparisonViewId={session?.id}
                cameraAnimatedCommandVersion={cameraAnimatedCommandVersion}
                cameraCommandVersion={cameraCommandVersion}
                cameraState={viewState.camera}
                cameraOrientationRef={cameraOrientationRef}
                onCameraOrientationFrame={requestOrientationGizmoFrame}
                onCameraOrientationChange={handleCameraOrientationChange}
                onCameraCommandAnimationActiveChange={handleCameraCommandAnimationActiveChange}
                onCameraControlsInteractionActiveChange={
                  handleCameraControlsInteractionActiveChange
                }
                onAtomInspect={handleToolAtomInspect}
                onAtomPulse={handleAtomPulse}
                onBondInspect={handleToolBondInspect}
                onBondPulse={handleBondPulse}
                onLockedInteractionAttempt={triggerLockedInteractionFeedback}
                cameraInteractionStore={cameraInteractionStore}
                suspendCameraOrientationUpdates={
                  isCameraCommandAnimationActive ||
                  isCameraControlsInteractionActive ||
                  isCameraRollInteractionActive
                }
                interactionLocked={viewState.interactionLocked}
                interactionMode={viewState.interactionMode}
                selectionActivation={measurementMode ? "single" : selectionActivation}
                mouseInertia={viewState.mouseInertia}
                layoutScene={modeling.previewScene ?? appearance.geometryScene ?? visibleScene!}
                resetCounter={viewState.resetCounter}
                safeArea={previewSafeArea}
                scene={modelingPreviewScene ?? measurementTools.previewScene ?? visibleScene!}
                inspectedAtomId={inspectedAtomId}
                inspectedBondId={inspectedBondId}
                pulseAtomId={
                  pulsedSceneObject?.kind === "atom"
                    ? pulsedSceneObject.id
                    : null
                }
                pulseToken={
                  pulsedSceneObject?.kind === "atom"
                    ? pulsedSceneObject.token
                    : 0
                }
                pulseBondId={
                  pulsedSceneObject?.kind === "bond"
                    ? pulsedSceneObject.id
                    : null
                }
                pulseBondToken={
                  pulsedSceneObject?.kind === "bond"
                    ? pulsedSceneObject.token
                    : 0
                }
                previewMeshQuality={previewMeshQuality}
                reducedMotion={reducedMotion}
                componentOpacity={componentOpacity}
                dragSensitivity={viewState.dragSensitivity}
                lightStrength={viewState.lightStrength}
                previewFpsStore={previewFpsStore}
                style={style}
                structureLineWidth={structureLineWidth}
                theme={resolvedTheme}
                showAtoms={componentVisibility.atoms}
                showFpsOverlay={viewState.showFpsOverlay}
                showUnitCell={componentVisibility.unitCell}
                unitCellLineStyle={unitCellLineStyle}
              />
            ) : (
              <div
                className="grid h-full w-full place-items-center bg-background text-sm text-muted-foreground"
                data-state={previewStatus}
              >
                {previewStatus === "loading" ? (
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      data-testid="loading-structure-spinner"
                      className="inline-flex size-3 shrink-0 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground motion-enabled:animate-spin motion-enabled:[animation-duration:450ms]"
                    />
                    {t("preview.loadingStructure")}
                  </span>
                ) : (
                  t("preview.noStructureLoaded")
                )}
              </div>
            )}
          </section>
        </ContextMenuTrigger>
        {renderPreviewContextMenuContent()}
      </ContextMenu>

      {visibleScene ? (
        <OrientationGizmo
          eventScopeRef={editorRef}
          axisColors={crystalAxisColorsForStyle(style)}
          materialState={crystalAxisMaterialForStyle(style, viewState.lightStrength)}
          cameraOrientationRef={cameraOrientationRef}
          cellVectors={visibleScene.cell.vectors}
          className="absolute transition-[left] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduced:transition-none"
          frameRequestRef={orientationGizmoFrameRequestRef}
          onAxisClick={axis => { onActivate(); handleGizmoAxisClick(axis); }}
          orientationVersion={cameraOrientationVersion}
          showLabels={showCrystalAxisLabels}
          theme={resolvedTheme}
          style={{ ...orientationGizmoContainerStyle(overlayAvailableArea, orientationGizmoSize, compactPreview),
            ...(!compactPreview && !leftSidebarOpen ? { left: 16 } : {}) }}
        />
      ) : null}

      {legendEntries.length > 0 ? (
        <ElementLegend
          entries={legendEntries}
          offsetX={sceneOffsetX}
          onElementColorChange={handleLegendElementColorChange}
          safeArea={previewSafeArea}
          compact={compactPreview}
          style={compactPreview ? compactLegendStyle(viewportSize, overlayAvailableArea, orientationGizmoSize) : undefined}
        />
      ) : null}

      {active && controlsHost ? createPortal(<>
      {!leftSidebarOpen ? <TooltipProvider delayDuration={500}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button ref={restoreLeftSidebarRef} variant="ghost" size="icon"
              aria-label={t("actions.showLeftSidebar")} aria-expanded={false} aria-controls="left-controls-sidebar"
              className="absolute left-4 top-4 z-30 size-14 border-0 bg-transparent p-0 shadow-none hover:bg-transparent"
              onClick={() => { if (compactPreview && isInspectorOpen) handleInspectorOpenChange(false); onLeftSidebarOpenChange(true); }}><CrystalSketchLogo className="size-7" /></Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("actions.showLeftSidebar")}</TooltipContent>
        </Tooltip>
      </TooltipProvider> : null}
      <div className="document-inspection contents" style={compactPreview ? compactInspectionStyle(viewportSize, overlayAvailableArea) : undefined}>
      {inspectedAtomInfo && !measurementMode ? (
        <AtomInspectorCard
          colorScheme={legendColorScheme}
          colorOverrides={elementColorOverrides}
          info={inspectedAtomInfo}
          isInspectorOpen={isInspectorOpen}
          onClose={clearSelection}
          onDelete={interaction.handleDeleteSelection}
          onHide={handleHideAtom}
          onLocateInObjects={handleLocateAtomInObjects}
          selectedAtoms={selectedColorAtoms}
          onColorChange={handleSelectedAtomColor}
          style={style}
        />
      ) : null}

      {inspectedBondInfo && !measurementMode ? (
        <BondInspectorCard
          colorScheme={legendColorScheme}
          colorOverrides={elementColorOverrides}
          info={inspectedBondInfo}
          isInspectorOpen={isInspectorOpen}
          onClose={clearSelection}
          onDelete={interaction.handleDeleteSelection}
          onHide={handleHideBond}
          onLocateInObjects={handleLocateBondInObjects}
          style={style}
        />
      ) : null}
      </div>

      <div
        ref={leftSidebarRef}
        id="left-controls-sidebar"
        role="region"
        aria-label={t("nav.leftSidebar")}
        aria-hidden={!leftSidebarOpen}
        inert={!leftSidebarOpen}
        tabIndex={-1}
        data-slot="left-controls-scroll"
        className={cn(
          "left-controls-scroll absolute inset-y-0 left-0 w-[320px] max-w-full overflow-x-hidden overflow-y-auto overscroll-y-contain outline-none transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduced:transition-none",
          leftSidebarOpen ? "translate-x-0" : "-translate-x-full !pointer-events-none",
          isInspectorOpen ? "max-[760px]:hidden" : null,
        )}
      >
      <div className="flex w-[312px] max-w-full flex-col gap-4 py-4 pl-4">
        <StructureSummaryCard
          onCollapseSidebar={() => onLeftSidebarOpenChange(false)}
          isCollapsed={isStructureSummaryCollapsed}
          onCollapsedChange={setIsStructureSummaryCollapsed}
          onOpenStructure={onOpen}
          onClearWorkspace={() => { closeActiveColorPicker(); setClearDialogOpen(true); }}
          clearDisabled={isClearing || isExporting}
          canClearRecovery={workspaceError}
          symmetryPending={symmetryPending}
          previewStatus={previewStatus}
          scene={scene}
          selectedFileName={selectedFileName}
        />

        {scene ? <ViewControlRail
          comparison={comparison}
          comparisonControls={comparisonControls}
          canCompare={canCompare}
          onToggleCompare={onToggleCompare}
          interactionLocked={viewState.interactionLocked}
          lockedInteractionFeedbackCount={lockedInteractionFeedbackCount}
          onInteractionLockedChange={handleInteractionLockedChange}
          onResetView={handleResetView}
          cameraInteractionStore={cameraInteractionStore}
          previewFpsStore={previewFpsStore}
          showFps={viewState.showFpsOverlay}
        /> : null}

        {scene ? (
          <div>
            <CommonControlsPanel
              structureExportContent={sourceScene ? <PoscarExportPanel controller={poscarExport} fileName={selectedFileName}
                disabled={previewStatus === "loading"} /> : undefined}
              toolsContent={<MeasurementToolsPanel tools={measurementTools} visibleAtomIds={visibleAtomIds} />}
              activeTab={activeCommonPanelTab}
              cameraState={cameraControlsPanelState}
              cellVectors={scene.cell.vectors}
              componentOpacity={componentOpacity}
              style={style}
              exportProjectedSize={exportProjectedSize ?? undefined}
              componentVisibility={componentVisibility}
              connectivityIntent={connectivityIntent}
              connectivityStatus={connectivityStatus}
              exportError={exportError}
              exportSettings={exportSettings}
              hasPolyhedra={hasPolyhedra(scene)}
              polyhedronElements={polyhedronElements}
              colorSchemeElements={legendEntries.slice(0, 4).map(entry => entry.element)}
              isExporting={isExporting}
              onActiveTabChange={handleActiveCommonPanelTabChange}
              onCameraPrimaryChange={handleCameraPrimaryChange}
              onCameraRollPreviewChange={handleCameraRollPreviewChange}
              onCameraRollPreviewStart={handleCameraRollPreviewStart}
              onCameraRollChange={handleCameraRollChange}
              onComponentOpacityChange={handleComponentOpacityChange}
              onComponentOpacityReset={handleComponentOpacityReset}
              onExport={handleExportFigure}
              onPreview={handlePreviewFigure}
              onExportSettingsChange={handleExportSettingsChange}
              onStyleChange={setStyle}
              onComponentVisibilityChange={handleComponentVisibilityChange}
            />
          </div>
        ) : null}
      </div>
      </div>

      {workspaceError || persistence.saveError ? (
        <Alert className="absolute bottom-4 left-4 z-40 max-w-sm bg-background" onDismiss={() => { setWorkspaceError(false); persistence.dismissSaveError(); }}>
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription>{t("workspace.storageError")}</AlertDescription>
        </Alert>
      ) : null}
      {errorMessage ? (
        <Alert
          className={cn(
            "absolute top-4 z-20 w-[320px] rounded-xl shadow-sm shadow-foreground/5",
            scene ? "left-[386px]" : "left-[328px]",
            "max-[760px]:left-4 max-[760px]:right-4 max-[760px]:top-[10rem] max-[760px]:w-auto",
          )}
          onDismiss={() => setErrorMessage(null)}
        >
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle className="font-semibold">
            {localizedPreviewErrorTitle(errorKind, errorTitle, t)}
          </AlertTitle>
          <AlertDescription>
            {localizedPreviewErrorMessage(errorKind, errorMessage, t)}
            {errorKind === "bonding-error" && connectivityRetryable ? (
              <Button className="mt-2 h-7 px-2 text-xs" variant="outline" disabled={connectivityStatus === "loading"} onClick={() => void requestConnectivity(connectivityIntent ?? "preserve")}>Retry</Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {scene ? (
        <>
          <InspectorToggle
            isOpen={isInspectorOpen}
            onOpenChange={handleInspectorOpenChange}
          />

          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="contents">
                <InspectorSidebar
                  modelingContent={<ModelingPanel controller={modeling.controller} />}
                  sourceScene={sourceScene ?? undefined}
                  deletedSelection={editing.snapshot.deleted}
                  onRestoreObjects={editing.restoreObjects}
                  activeObjectsTab={activeObjectsTab}
                  activeTab={activeInspectorTab}
                  atomLocateRequest={atomLocateRequest}
                  atomOpacity={componentOpacity.atoms}
                  atomsVisible={componentVisibility.atoms}
                  bondAlgorithm={bondAlgorithm}
                  onBondToleranceChange={handleBondToleranceChange}
                  bondLocateRequest={bondLocateRequest}
                  bondObjectsResetToken={bondObjectsResetToken}
                  bondsVisible={componentVisibility.bonds}
                  bondVisibilityOverrides={bondVisibilityOverrides}
                  cutoffOverrides={
                    customBondingProfile?.cutoffOverrides ??
                    EMPTY_BOND_CUTOFF_OVERRIDES
                  }
                  hasCustomBondingProfile={customBondingProfile !== null}
                  isOpen={isInspectorOpen}
                  isSceneLoading={previewStatus === "loading" || connectivityStatus === "loading"}
                  scene={scene}
                  selectedAtomId={inspectedAtomId}
                  selectedBondId={inspectedBondId}
                  settingsModel={{
                    lightDirection: style.lightDirection,
                    mainLightIntensity: style.mainLightIntensity,
                    ambientLightIntensity: style.ambientLightIntensity,
                    distinguishSimilarColors: style.distinguishSimilarColors,
                    dragSensitivity: viewState.dragSensitivity,
                    fogAffectsUnitCell: style.fogAffectsUnitCell,
                    isCustomColorScheme: style.colorSchemeMode === "custom",
                    interactionMode: viewState.interactionMode,
                    lightStrength: viewState.lightStrength,
                    mouseInertia: viewState.mouseInertia,
                    previewMeshQuality,
                    selectionActivation,
                    showCrystalAxisLabels,
                    showFpsOverlay: viewState.showFpsOverlay,
                    structureLineWidth,
                    unitCellLineStyle,
                  }}
                  settingsActions={{
                    onLightDirectionChange: lightDirection => setStyle(current => ({ ...current, lightDirection })),
                    onMainLightIntensityChange: mainLightIntensity => setStyle(current => ({ ...current, mainLightIntensity })),
                    onAmbientLightIntensityChange: ambientLightIntensity => setStyle(current => ({ ...current, ambientLightIntensity })),
                    onDistinguishSimilarColorsChange:
                      handleDistinguishSimilarColorsChange,
                    onDragSensitivityChange: handleDragSensitivityChange,
                    onFogAffectsUnitCellChange: handleFogAffectsUnitCellChange,
                    onInteractionModeChange: handleInteractionModeChange,
                    onLightStrengthChange: handleLightStrengthChange,
                    onMouseInertiaChange: handleMouseInertiaChange,
                    onPreviewMeshQualityChange: setPreviewMeshQuality,
                    onSelectionActivationChange:
                      handleSelectionActivationChange,
                    onShowCrystalAxisLabelsChange: setShowCrystalAxisLabels,
                    onShowFpsOverlayChange: handleShowFpsOverlayChange,
                    onStructureLineWidthChange: setStructureLineWidth,
                    onUnitCellLineStyleChange: setUnitCellLineStyle,
                  }}
                  style={style}
                  onActiveObjectsTabChange={handleActiveObjectsTabChange}
                  onActiveTabChange={handleActiveInspectorTabChange}
                  onAtomLocateRequestHandled={handleAtomLocateRequestHandled}
                  onBondLocateRequestHandled={handleBondLocateRequestHandled}
                  onBondVisibilityChange={handleBondVisibilityChange}
                  onBondCutoffChange={handleBondCutoffOverridesChange}
                  onBondCutoffEditingStart={() => handleBondInspect(null)}
                  bondOpacity={componentOpacity.bonds}
                  onBondFamilyVisibilityChange={handleBondFamilyVisibilityChange}
                  onBondAlgorithmChange={(nextBondAlgorithm) => {
                    void handleBondAlgorithmChange(nextBondAlgorithm);
                  }}
                  onElementColorChange={handleLegendElementColorChange}
                  onStyleChange={setStyle}
                />
              </div>
            </ContextMenuTrigger>
            {renderPreviewContextMenuContent()}
          </ContextMenu>
        </>
      ) : null}
      </>, controlsHost) : null}
    </div>
      <FigurePreviewDialog {...figurePreview} layout={exportSettings.previewLayout}
        onLayoutChange={handleFigurePreviewLayoutChange} onOpenChange={handleFigurePreviewOpenChange} />
    </SceneSelectionProvider>
  );
}

function localizedPreviewErrorTitle(
  kind: StructurePreviewErrorKind | null,
  fallbackTitle: string,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (kind === "backend-unavailable") {
    return t("validation.pythonBackendUnavailable");
  }
  if (kind === "bonding-error") {
    return t("validation.bondingFailed");
  }
  if (kind) {
    return t("validation.unsupportedFile");
  }
  return fallbackTitle;
}

function localizedPreviewErrorMessage(
  kind: StructurePreviewErrorKind | null,
  fallbackMessage: string,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (kind === "backend-unavailable") {
    return t("validation.startLocalBackend");
  }
  if (kind === "file-too-large") {
    return t("validation.fileTooLarge");
  }
  if (kind === "parse-error") {
    return t("validation.parseError");
  }
  if (kind === "bonding-error") {
    return fallbackMessage;
  }
  if (kind === "static-example") {
    return t("validation.staticExampleFailed");
  }
  return fallbackMessage;
}
