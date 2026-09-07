import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SceneSpec } from "../../api/scene";
import type { BondVisibilityOverrides } from "../../model/bondObjects";
import type { ComponentVisibilityState } from "../../model/displayState";
import type { ObjectStyleState } from "../../model/objectStyles";
import { applySceneDeletions } from "../../model/sceneEdits";
import { EMPTY_SELECTION, type SceneSelection } from "../../selection/SceneSelection";
import { applyModelOperation, type ModelState } from "../../model/structureModel";
import { applyModelPatch, createModelPatch, type ModelPatch } from "../../model/modelHistory";
import type { ModelReferenceSnapshot } from "../../model/measurementModelMapping";

type SavedSelection = { atoms: string[]; bonds: string[] };
export interface SceneVisibilitySnapshot {
  atomVisibility: Record<string, boolean>;
  elementVisibility: Record<string, boolean>;
  componentVisibility: ComponentVisibilityState;
  hiddenBondFamilies: string[];
  hiddenBondRelations: string[];
}
export type AtomColorSnapshot = Record<string, string | null>;
type AtomColorAction = { kind: "atom-color"; before: AtomColorSnapshot; after: AtomColorSnapshot };
export type SceneEditAction =
  | { kind: "delete"; before: SavedSelection; after: SavedSelection }
  | { kind: "model"; patch: ModelPatch; before: SavedSelection; after: SavedSelection;
      references?: { before: ModelReferenceSnapshot; after: ModelReferenceSnapshot } }
  | { kind: "visibility"; before: SceneVisibilitySnapshot; after: SceneVisibilitySnapshot }
  | AtomColorAction;
export interface SceneEditSnapshot {
  deleted: SavedSelection;
  history: (SceneEditAction | SavedSelection)[];
  future?: (SceneEditAction | SavedSelection)[];
}
type EditHistory = { deleted: SceneSelection; history: SceneEditAction[]; future: SceneEditAction[] };
const HISTORY_LIMIT = 50;
const restoreSelection = (selection: SavedSelection): SceneSelection => ({ atoms: new Set(selection.atoms), bonds: new Set(selection.bonds) });
const saveSelection = (selection: SceneSelection): SavedSelection => ({ atoms: [...selection.atoms], bonds: [...selection.bonds] });

export function useSceneEdits(source: SceneSpec | null, resetToken: number, initial?: SceneEditSnapshot,
  options: { preserveHistoryOnReset?: boolean } = {}) {
  const [edits, setEdits] = useState<EditHistory>(() => ({
    deleted: initial ? restoreSelection(initial.deleted) : EMPTY_SELECTION,
    history: initial ? restoreActions(initial.history, initial.deleted, "history") : [],
    future: initial ? restoreActions(initial.future ?? [], initial.deleted, "future") : [],
  }));
  const current = useRef(edits);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const modelAdapter = useRef<{ read: () => ModelState; readReferences?: () => ModelReferenceSnapshot;
    replace: (model: ModelState, replay?: { target: ModelReferenceSnapshot; expected: ModelReferenceSnapshot }) => void } | null>(null);
  const registerModelEditing = useCallback((adapter: NonNullable<typeof modelAdapter.current>) => {
    modelAdapter.current = adapter;
    return () => { if (modelAdapter.current === adapter) modelAdapter.current = null; };
  }, []);
  const visibilityRestore = useRef<((snapshot: SceneVisibilitySnapshot) => void) | null>(null);
  const atomColorRestore = useRef<((snapshot: AtomColorSnapshot) => void) | null>(null);
  const colorGroup = useRef<{ token: object; action: AtomColorAction; previousFuture: SceneEditAction[] } | null>(null);
  const registerAtomColorRestore = useCallback((apply: (snapshot: AtomColorSnapshot) => void) => {
    atomColorRestore.current = apply;
    return () => { if (atomColorRestore.current === apply) atomColorRestore.current = null; };
  }, []);
  const registerVisibilityRestore = useCallback((apply: (snapshot: SceneVisibilitySnapshot) => void) => {
    visibilityRestore.current = apply;
    return () => { if (visibilityRestore.current === apply) visibilityRestore.current = null; };
  }, []);
  const update = useCallback((next: EditHistory) => {
    current.current = next;
    setEdits(next);
  }, []);
  const previousResetToken = useRef(resetToken);
  useLayoutEffect(() => {
    if (previousResetToken.current === resetToken) return;
    previousResetToken.current = resetToken;
    // Display defaults must not destroy the editable model's operation history.
    colorGroup.current = null;
    if (options.preserveHistoryOnReset) return;
    update({ deleted: EMPTY_SELECTION, history: [], future: [] });
  }, [resetToken, options.preserveHistoryOnReset, update]);
  const commitModel = useCallback((model: ModelState, removedBonds: ReadonlySet<string> = new Set()) => {
    const adapter = modelAdapter.current;
    if (!adapter) return false;
    const state = current.current;
    const patch = createModelPatch(adapter.read(), model);
    const deleted = { ...state.deleted, bonds: new Set([...state.deleted.bonds, ...removedBonds]) };
    if (!patch.ids.length && JSON.stringify(patch.before) === JSON.stringify(patch.after)
      && deleted.bonds.size === state.deleted.bonds.size) return false;
    const beforeReferences = adapter.readReferences?.();
    adapter.replace(model);
    const afterReferences = adapter.readReferences?.();
    const action: SceneEditAction = { kind: "model", patch,
      before: saveSelection(state.deleted), after: saveSelection(deleted),
      references: beforeReferences && afterReferences ? { before: beforeReferences, after: afterReferences } : undefined };
    update({ deleted, history: [...state.history, action].slice(-HISTORY_LIMIT), future: [] });
    return true;
  }, [update]);
  const deleteObjects = useCallback((selection: SceneSelection) => {
    if (selection.atoms.size + selection.bonds.size === 0) return;
    if (modelAdapter.current && selection.atoms.size) {
      const ids = new Set(sourceRef.current?.atoms.filter(atom => selection.atoms.has(atom.id)).map(atom => atom.siteId));
      const next = applyModelOperation(modelAdapter.current.read(), { type: "vacancy", siteIds: [...ids] });
      commitModel(next.state, selection.bonds);
      return;
    }
    const state = current.current;
    const deleted = { atoms: new Set([...state.deleted.atoms, ...selection.atoms]),
      bonds: new Set([...state.deleted.bonds, ...selection.bonds]) };
    if (deleted.atoms.size === state.deleted.atoms.size && deleted.bonds.size === state.deleted.bonds.size) return;
    const action: SceneEditAction = { kind: "delete", before: saveSelection(state.deleted), after: saveSelection(deleted) };
    update({ deleted, history: [...state.history, action].slice(-HISTORY_LIMIT), future: [] });
  }, [commitModel, update]);
  const restoreObjects = useCallback((selection: SceneSelection) => {
    const state = current.current;
    const deleted = { atoms: new Set([...state.deleted.atoms].filter(id => !selection.atoms.has(id))),
      bonds: new Set([...state.deleted.bonds].filter(id => !selection.bonds.has(id))) };
    if (deleted.atoms.size === state.deleted.atoms.size && deleted.bonds.size === state.deleted.bonds.size) return;
    const action: SceneEditAction = { kind: "delete", before: saveSelection(state.deleted), after: saveSelection(deleted) };
    update({ deleted, history: [...state.history, action].slice(-HISTORY_LIMIT), future: [] });
  }, [update]);
  const recordVisibilityChange = useCallback((before: SceneVisibilitySnapshot, after: SceneVisibilitySnapshot) => {
    const previous = copyVisibility(before), next = copyVisibility(after);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    const state = current.current;
    const action: SceneEditAction = { kind: "visibility", before: previous, after: next };
    update({ ...state, history: [...state.history, action].slice(-HISTORY_LIMIT), future: [] });
  }, [update]);
  const recordAtomColorChange = useCallback((before: ObjectStyleState, after: ObjectStyleState, token?: object) => {
    const keys = [...new Set([...Object.keys(before.atomOverrides), ...Object.keys(after.atomOverrides)])]
      .filter(id => before.atomOverrides[id]?.color !== after.atomOverrides[id]?.color);
    if (!keys.length) return;
    const state = current.current;
    const group = token && colorGroup.current?.token === token && state.history.at(-1) === colorGroup.current.action
      ? colorGroup.current : null;
    const previous = { ...Object.fromEntries(keys.map(id => [id, before.atomOverrides[id]?.color ?? null])), ...group?.action.before };
    const next = { ...group?.action.after, ...Object.fromEntries(keys.map(id => [id, after.atomOverrides[id]?.color ?? null])) };
    const changed = Object.keys(previous).filter(id => previous[id] !== next[id]);
    const history = group ? state.history.slice(0, -1) : state.history;
    if (!changed.length) {
      update({ ...state, history, future: group?.previousFuture ?? state.future });
      colorGroup.current = null;
      return;
    }
    const action: AtomColorAction = { kind: "atom-color",
      before: Object.fromEntries(changed.map(id => [id, previous[id]!])),
      after: Object.fromEntries(changed.map(id => [id, next[id]!])) };
    colorGroup.current = token ? { token, action, previousFuture: group?.previousFuture ?? state.future } : null;
    update({ ...state, history: [...history, action].slice(-HISTORY_LIMIT), future: [] });
  }, [update]);
  const undoDeletion = useCallback(() => {
    const state = current.current;
    const action = state.history.at(-1);
    if (!action) return false;
    if (action.kind === "visibility") {
      if (!visibilityRestore.current) return false;
      visibilityRestore.current(copyVisibility(action.before));
    }
    if (action.kind === "atom-color") {
      if (!atomColorRestore.current) return false;
      atomColorRestore.current({ ...action.before });
    }
    if (action.kind === "model") {
      if (!modelAdapter.current) return false;
      modelAdapter.current.replace(applyModelPatch(modelAdapter.current.read(), action.patch, "before"),
        action.references ? { target: action.references.before, expected: action.references.after } : undefined);
    }
    colorGroup.current = null;
    update({ deleted: action.kind === "delete" || action.kind === "model" ? restoreSelection(action.before) : state.deleted,
      history: state.history.slice(0, -1), future: [...state.future, action].slice(-HISTORY_LIMIT) });
    return true;
  }, [update]);
  const redoDeletion = useCallback(() => {
    const state = current.current;
    const action = state.future.at(-1);
    if (!action) return false;
    if (action.kind === "visibility") {
      if (!visibilityRestore.current) return false;
      visibilityRestore.current(copyVisibility(action.after));
    }
    if (action.kind === "atom-color") {
      if (!atomColorRestore.current) return false;
      atomColorRestore.current({ ...action.after });
    }
    if (action.kind === "model") {
      if (!modelAdapter.current) return false;
      modelAdapter.current.replace(applyModelPatch(modelAdapter.current.read(), action.patch, "after"),
        action.references ? { target: action.references.after, expected: action.references.before } : undefined);
    }
    colorGroup.current = null;
    update({ deleted: action.kind === "delete" || action.kind === "model" ? restoreSelection(action.after) : state.deleted,
      history: [...state.history, action].slice(-HISTORY_LIMIT), future: state.future.slice(0, -1) });
    return true;
  }, [update]);
  const scene = useMemo(() => applySceneDeletions(source, edits.deleted), [source, edits.deleted]);
  const snapshot = useMemo(() => ({ deleted: saveSelection(edits.deleted), history: edits.history.map(copyAction),
    future: edits.future.map(copyAction) }), [edits]);
  return { scene, deleteObjects, restoreObjects, undoDeletion, redoDeletion, recordVisibilityChange, registerVisibilityRestore,
    recordAtomColorChange, registerAtomColorRestore, registerModelEditing, commitModel, snapshot };
}

export function restoreAtomColors(current: ObjectStyleState, snapshot: AtomColorSnapshot): ObjectStyleState {
  const atomOverrides = { ...current.atomOverrides };
  for (const [id, color] of Object.entries(snapshot)) {
    const value = { ...atomOverrides[id] };
    if (color === null) delete value.color;
    else value.color = color;
    if (Object.keys(value).length) atomOverrides[id] = value;
    else delete atomOverrides[id];
  }
  return { ...current, atomOverrides };
}

export function captureSceneVisibility(
  objectStyles: ObjectStyleState, componentVisibility: ComponentVisibilityState, bondVisibility: BondVisibilityOverrides,
): SceneVisibilitySnapshot {
  return copyVisibility({
    atomVisibility: visibilityProperties(objectStyles.atomOverrides),
    elementVisibility: visibilityProperties(objectStyles.elementOverrides),
    componentVisibility,
    hiddenBondFamilies: [...bondVisibility.hiddenFamilies], hiddenBondRelations: [...bondVisibility.hiddenBondRelations],
  });
}

export function restoreObjectStyleVisibility(current: ObjectStyleState, snapshot: SceneVisibilitySnapshot): ObjectStyleState {
  return {
    ...current,
    atomOverrides: restoreVisibilityProperties(current.atomOverrides, snapshot.atomVisibility),
    elementOverrides: restoreVisibilityProperties(current.elementOverrides, snapshot.elementVisibility),
  };
}

function visibilityProperties(overrides: Record<string, { visible?: boolean }>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => typeof value.visible === "boolean")
    .map(([id, value]) => [id, value.visible!]));
}

function restoreVisibilityProperties<T extends { visible?: boolean }>(overrides: Record<string, T>, saved: Record<string, boolean>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const id of new Set([...Object.keys(overrides), ...Object.keys(saved)])) {
    const value = { ...overrides[id] } as T;
    if (Object.hasOwn(saved, id)) value.visible = saved[id]!;
    else delete value.visible;
    if (Object.keys(value).length) result[id] = value;
  }
  return result;
}

function copyVisibility(snapshot: SceneVisibilitySnapshot): SceneVisibilitySnapshot {
  return {
    atomVisibility: Object.fromEntries(Object.entries(snapshot.atomVisibility).sort(([a], [b]) => a.localeCompare(b))),
    elementVisibility: Object.fromEntries(Object.entries(snapshot.elementVisibility).sort(([a], [b]) => a.localeCompare(b))),
    componentVisibility: { ...snapshot.componentVisibility },
    hiddenBondFamilies: [...new Set(snapshot.hiddenBondFamilies)].sort(),
    hiddenBondRelations: [...new Set(snapshot.hiddenBondRelations)].sort(),
  };
}

function copyAction(action: SceneEditAction): SceneEditAction {
  if (action.kind === "model") return action;
  if (action.kind === "atom-color") return { kind: "atom-color", before: { ...action.before }, after: { ...action.after } };
  return action.kind === "visibility"
    ? { kind: "visibility", before: copyVisibility(action.before), after: copyVisibility(action.after) }
    : { kind: "delete", before: { atoms: [...action.before.atoms], bonds: [...action.before.bonds] },
      after: { atoms: [...action.after.atoms], bonds: [...action.after.bonds] } };
}

function restoreActions(entries: (SceneEditAction | SavedSelection)[], deleted: SavedSelection, direction: "history" | "future"): SceneEditAction[] {
  const result: SceneEditAction[] = [];
  let cursor = deleted;
  // Earlier workspaces saved deletion states, with the next undo/redo state last.
  for (const entry of entries.slice(-HISTORY_LIMIT).reverse()) {
    if ("kind" in entry) {
      const action = copyAction(entry);
      result.push(action);
      if (action.kind === "delete" || action.kind === "model") cursor = direction === "history" ? action.before : action.after;
    } else {
      const action: SceneEditAction = direction === "history"
        ? { kind: "delete", before: entry, after: cursor }
        : { kind: "delete", before: cursor, after: entry };
      result.push(copyAction(action));
      cursor = entry;
    }
  }
  return result.reverse();
}
