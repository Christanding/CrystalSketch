import type { BondVisibilityOverrides, ComponentOpacityState, ComponentVisibilityState, ExportSettingsState, MeshQuality, StyleState, StructureLineWidthState, UnitCellLineStyle } from "../model";
import type { LoadedPreviewSession } from "./hooks/useStructurePreview";
import type { SceneEditSnapshot } from "./hooks/useSceneEdits";
import type { PreviewViewState } from "./viewState";
import type { MeasurementToolsSnapshot } from "./hooks/useMeasurementTools";
import { exportDpi, isFigureExportLayout } from "../model/exportSettings";
import { isModelPatch } from "../model/modelHistory";
import type { SavedPoscarDraft } from "./hooks/usePoscarExportController";

export interface WorkspaceAppearance {
  style: StyleState;
  componentVisibility: ComponentVisibilityState;
  componentOpacity: ComponentOpacityState;
  bondVisibilityOverrides: BondVisibilityOverrides;
  previewMeshQuality: MeshQuality;
  unitCellLineStyle: UnitCellLineStyle;
  structureLineWidth: StructureLineWidthState;
  showCrystalAxisLabels: boolean;
}

export interface WorkspacePreferences {
  version: 1;
  modelDocument?: boolean;
  sessionId: string;
  appearance: WorkspaceAppearance;
  edits: SceneEditSnapshot;
  viewState: PreviewViewState;
  viewScale: number;
  viewPan?: [number, number, number];
  exportSettings: ExportSettingsState;
  measurementTools?: MeasurementToolsSnapshot;
  poscarDraft?: SavedPoscarDraft;
}

export interface SavedWorkspace {
  session: LoadedPreviewSession;
  preferences: WorkspacePreferences;
}

export const WORKSPACE_PREFERENCES_KEY = "crystalsketch.workspace.v1";
const DATABASE_NAME = "crystalsketch-workspace";
let databasePromise: Promise<IDBDatabase> | null = null;
let blockedSessionId: string | null = null;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Workspace storage is blocked by another tab."));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = null; };
      resolve(request.result);
    };
  }).catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}

export function parseWorkspacePreferences(value: string | null): WorkspacePreferences | null {
  if (!value) return null;
  const state = JSON.parse(value) as WorkspacePreferences;
  if (state?.version !== 1 || typeof state.sessionId !== "string"
    || !state.appearance?.style || !state.appearance.componentOpacity
    || !state.appearance.componentVisibility || !state.appearance.structureLineWidth || !state.appearance.bondVisibilityOverrides
    || !isSavedSelection(state.edits?.deleted)
    || !Array.isArray(state.edits.history) || !state.edits.history.every(isSavedEditAction)
    || (state.edits.future !== undefined && (!Array.isArray(state.edits.future) || !state.edits.future.every(isSavedEditAction)))
    || !state.viewState?.camera
    || !Number.isFinite(state.viewScale) || !state.exportSettings
    || state.viewPan !== undefined && (!Array.isArray(state.viewPan) || state.viewPan.length !== 3 || !state.viewPan.every(Number.isFinite))) {
    throw new Error("Saved workspace is invalid or incompatible.");
  }
  const overrides = state.appearance.bondVisibilityOverrides;
  state.exportSettings = { ...state.exportSettings, dpi: exportDpi(state.exportSettings) };
  if (state.exportSettings.previewLayout !== undefined && !isFigureExportLayout(state.exportSettings.previewLayout)) {
    throw new Error("Saved figure export layout is invalid.");
  }
  const tools = state.measurementTools;
  const labelStyle = tools?.appearance;
  if (labelStyle !== undefined && (!labelStyle || !/^#[0-9a-f]{6}$/i.test(labelStyle.color)
    || !Number.isFinite(labelStyle.fontScale) || labelStyle.fontScale < 50 || labelStyle.fontScale > 250
    || ![300, 400, 500, 600].includes(labelStyle.fontWeight) || typeof labelStyle.showLabels !== "boolean"
    || (labelStyle.displayMode !== undefined && !["all", "distance", "angle"].includes(labelStyle.displayMode)))) {
    throw new Error("Saved measurement text settings are invalid.");
  }
  if (tools !== undefined && (!tools || !Array.isArray(tools.measurements) || tools.measurements.length > 50
    || tools.measurements.some(item => !item || typeof item.id !== "string" || !["distance", "angle"].includes(item.kind)
      || !Array.isArray(item.atomIds) || item.atomIds.length !== (item.kind === "distance" ? 2 : 3)
      || !item.atomIds.every(id => typeof id === "string"))
    || (tools.focus !== null && (!tools.focus || !Array.isArray(tools.focus.atomIds)
      || !tools.focus.atomIds.every(id => typeof id === "string") || typeof tools.focus.neighbors !== "boolean")))) {
    throw new Error("Saved measurements are invalid.");
  }
  if (["soft-metal", "brushed-metal"].includes(state.appearance.style.materialPreset)) {
    state.appearance.style.materialPreset = "colored-metal";
  }
  state.appearance.bondVisibilityOverrides = {
    hiddenFamilies: restoreIdSet(overrides.hiddenFamilies),
    hiddenBondRelations: restoreIdSet(overrides.hiddenBondRelations),
  };
  return state;
}

function restoreIdSet(value: unknown): Set<string> {
  if (Array.isArray(value) && value.every(id => typeof id === "string")) return new Set(value);
  // Recover empty sets written by the early local development build.
  if (value && typeof value === "object" && Object.keys(value).length === 0) return new Set();
  throw new Error("Saved bond visibility is invalid.");
}

function isSavedSelection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const selection = value as { atoms?: unknown; bonds?: unknown };
  return isStringArray(selection.atoms) && isStringArray(selection.bonds);
}

function isSavedEditAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const action = value as { kind?: unknown; before?: unknown; after?: unknown; patch?: unknown };
  if (action.kind === undefined) return isSavedSelection(value);
  if (action.kind === "delete") return isSavedSelection(action.before) && isSavedSelection(action.after);
  if (action.kind === "model") return isModelPatch(action.patch) && isSavedSelection(action.before) && isSavedSelection(action.after);
  if (action.kind === "atom-color") return isAtomColorSnapshot(action.before) && isAtomColorSnapshot(action.after)
    && Object.keys(action.before).length === Object.keys(action.after).length
    && Object.keys(action.before).every(id => Object.hasOwn(action.after as object, id));
  return action.kind === "visibility" && isVisibilitySnapshot(action.before) && isVisibilitySnapshot(action.after);
}

function isAtomColorSnapshot(value: unknown): value is Record<string, string | null> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as object).every(color => color === null || typeof color === "string");
}

function isVisibilitySnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (!isBooleanRecord(snapshot.atomVisibility) || !isBooleanRecord(snapshot.elementVisibility)
    || !isBooleanRecord(snapshot.componentVisibility) || !isStringArray(snapshot.hiddenBondFamilies)
    || !isStringArray(snapshot.hiddenBondRelations)) return false;
  const components = snapshot.componentVisibility as Record<string, boolean>;
  return ["atoms", "bonds", "polyhedra", "unitCell", "boundaryAtoms", "oneHopBondedAtoms"]
    .every(key => typeof components[key] === "boolean");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string");
}

function isBooleanRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as object).every(item => typeof item === "boolean");
}

export function serializeWorkspacePreferences(preferences: WorkspacePreferences): string {
  const { hiddenFamilies, hiddenBondRelations } = preferences.appearance.bondVisibilityOverrides;
  return JSON.stringify({ ...preferences, appearance: { ...preferences.appearance,
    bondVisibilityOverrides: { hiddenFamilies: [...hiddenFamilies], hiddenBondRelations: [...hiddenBondRelations] },
  } });
}

export async function loadWorkspace(): Promise<SavedWorkspace | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDatabase();
  const preferences = parseWorkspacePreferences(localStorage.getItem(WORKSPACE_PREFERENCES_KEY));
  if (!preferences) return null;
  const session = await new Promise<LoadedPreviewSession | undefined>((resolve, reject) => {
    const request = db.transaction("workspace").objectStore("workspace").get("active");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!session || session.id !== preferences.sessionId) throw new Error("Saved workspace structure is unavailable.");
  if (!Array.isArray(session.scene?.atoms) || !Array.isArray(session.scene?.bonds)
    || !Array.isArray(session.scene?.cell?.vectors) || !session.scene.summary) {
    throw new Error("Saved structure is invalid.");
  }
  return { session, preferences };
}

export async function saveWorkspaceSession(session: LoadedPreviewSession): Promise<void> {
  if (typeof indexedDB === "undefined" || session.id === blockedSessionId) return;
  const db = await openDatabase();
  if (session.id === blockedSessionId) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("workspace", "readwrite");
    transaction.objectStore("workspace").put(session, "active");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Workspace save aborted."));
  });
}

export function saveWorkspacePreferences(preferences: WorkspacePreferences): void {
  if (typeof indexedDB === "undefined" || preferences.sessionId === blockedSessionId) return;
  // Only small editor settings use synchronous storage. Structure/File data stays in IDB.
  localStorage.setItem(WORKSPACE_PREFERENCES_KEY, serializeWorkspacePreferences(preferences));
}

export async function clearWorkspace(sessionId: string | null): Promise<void> {
  blockedSessionId = sessionId;
  // Remove the recovery pointer first: a late older IDB write cannot resurrect it.
  localStorage.removeItem(WORKSPACE_PREFERENCES_KEY);
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("workspace", "readwrite");
    transaction.objectStore("workspace").delete("active");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Workspace clear aborted."));
  });
}
