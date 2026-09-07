import { Vector3 } from "three";
import type { ComponentType, ReactNode } from "react";
import { createDefaultStyle, createDefaultObjectStyleState, createDefaultComponentVisibility, createDefaultComponentOpacity, createDefaultBondVisibilityOverrides, createDefaultExportSettings, defaultPreviewMeshQualityForScene, DEFAULT_STRUCTURE_LINE_WIDTH, DEFAULT_UNIT_CELL_LINE_STYLE, DEFAULT_SHOW_CRYSTAL_AXIS_LABELS, type StyleState } from "../model";
import type { ComparisonCameraStore } from "../model/comparisonCameraStore";
import { stateFromViewVectors } from "../scene/crystalCamera";
import { createPreviewViewState } from "./viewState";
import type { LoadedPreviewSession } from "./hooks/useStructurePreview";
import type { SavedWorkspace, WorkspacePreferences } from "./workspaceStorage";
import type { ModelState } from "../model/structureModel";
import type { SceneSpec } from "../api/scene";

export interface DocumentEditorHandle {
  snapshot: () => SavedWorkspace | null;
  closeColorPicker: () => void;
  applyAppearance: (preferences: WorkspacePreferences) => void;
  isBusy: () => boolean;
}
export interface DocumentEditorProps {
  initialWorkspace: SavedWorkspace | null;
  leftSidebarOpen: boolean;
  onLeftSidebarOpenChange: (open: boolean) => void;
  active: boolean;
  comparison: boolean;
  comparisonControls?: ReactNode;
  canCompare: boolean;
  onToggleCompare: () => void;
  controlsHost: HTMLDivElement | null;
  comparisonCameraStore: ComparisonCameraStore;
  onActivate: () => void;
  onOpen: () => void;
  onCreateModel?: (model: ModelState, scene: SceneSpec) => Promise<void>;
  onClose: () => Promise<void>;
  register: (id: string, handle: DocumentEditorHandle) => () => void;
}
export type DocumentEditorComponent = ComponentType<DocumentEditorProps>;

// IDs identify sites within one source file; only element-wide appearance is transferable.
export function transferableStyle(style: StyleState): StyleState {
  return { ...style,
    atomRadiusModel: style.atomRadiusModel === "custom" ? style.objectStyles.customRadiusBaseModel ?? "uniform" : style.atomRadiusModel,
    objectStyles: { ...createDefaultObjectStyleState(),
      elementOverrides: Object.fromEntries(Object.entries(style.objectStyles.elementOverrides)
        .map(([element, value]) => [element, { radius: value.radius, opacity: value.opacity }])),
    },
  };
}

export function createDocumentWorkspace(session: LoadedPreviewSession, inherited?: WorkspacePreferences): SavedWorkspace {
  const scene = session.scene;
  const viewState = createPreviewViewState(scene.cell.vectors);
  if (scene.sourceFormat === "vasp") viewState.camera = stateFromViewVectors(scene.cell.vectors,
    "outward", "upward", new Vector3(0, 0, 1), new Vector3(1, 0, 0));
  if (inherited) viewState.lightStrength = inherited.viewState.lightStrength;
  return { session, preferences: {
    version: 1, sessionId: session.id,
    appearance: {
      style: inherited ? transferableStyle(inherited.appearance.style) : createDefaultStyle(),
      componentVisibility: createDefaultComponentVisibility(scene),
      componentOpacity: inherited?.appearance.componentOpacity ?? createDefaultComponentOpacity(),
      bondVisibilityOverrides: createDefaultBondVisibilityOverrides(),
      previewMeshQuality: inherited?.appearance.previewMeshQuality ?? defaultPreviewMeshQualityForScene(scene),
      unitCellLineStyle: inherited?.appearance.unitCellLineStyle ?? DEFAULT_UNIT_CELL_LINE_STYLE,
      structureLineWidth: inherited?.appearance.structureLineWidth ?? DEFAULT_STRUCTURE_LINE_WIDTH,
      showCrystalAxisLabels: inherited?.appearance.showCrystalAxisLabels ?? DEFAULT_SHOW_CRYSTAL_AXIS_LABELS,
    },
    edits: { deleted: { atoms: [], bonds: [] }, history: [] },
    viewState, viewScale: 1,
    exportSettings: inherited?.exportSettings ?? createDefaultExportSettings(),
  } };
}
