import { act, renderHook } from "@testing-library/react";
import { expect, spyOn, test } from "bun:test";
import { StrictMode, useLayoutEffect } from "react";
import { Quaternion, Vector3 } from "three";
import { parseVaspScene, parseVaspStructure } from "../src/api/vasp";
import { createDocumentWorkspace } from "../src/app/documentState";
import { createEmptyManifest, DOCUMENT_MANIFEST_KEY, durableWorkspaceManifest, loadDocuments, parseWorkspaceManifest, saveModelWorkspace, saveWorkspaceManifest } from "../src/app/documentStorage";
import * as documentStorage from "../src/app/documentStorage";
import { useWorkspacePersistence } from "../src/app/hooks/useWorkspacePersistence";
import type { LoadedPreviewSession } from "../src/app/hooks/useStructurePreview";
import { useSceneEdits } from "../src/app/hooks/useSceneEdits";
import { useFigureAppearanceController } from "../src/app/hooks/useFigureAppearanceController";
import { setAtomOverrideProperty } from "../src/model";
import { applyModelOperation, createModelState, modelToScene } from "../src/model/structureModel";
import { applyModelPatch, createModelPatch } from "../src/model/modelHistory";
import { createCameraInteractionStore } from "../src/model/cameraInteractionStore";
import { stateFromViewVectors, vectorsFromCameraQuaternion } from "../src/scene/crystalCamera";
import { parseWorkspacePreferences, serializeWorkspacePreferences, type SavedWorkspace } from "../src/app/workspaceStorage";

const scene = parseVaspScene("CuI\n1\n6 0 0\n0 6 0\n0 0 6\nCu I\n1 1\nDirect\n.25 .25 .25\n.5 .5 .5");
const session = (id: string) => ({ id, scene, file: null, fileName: "POSCAR", bondingMode: "minimum-distance" as const, customBondingProfile: null });

test("multi-document manifest rejects duplicate identities and invalid compare targets", () => {
  const state = { ...createEmptyManifest(), documents: [{ id: "a", title: "POSCAR" }, { id: "b", title: "POSCAR" }], activeId: "a", compareIds: ["a", "b"] as [string, string] };
  expect(parseWorkspaceManifest(JSON.stringify(state))).toEqual(state);
  expect(parseWorkspaceManifest(JSON.stringify({ ...state, leftSidebarOpen: false })).leftSidebarOpen).toBe(false);
  expect(() => parseWorkspaceManifest(JSON.stringify({ ...state, leftSidebarOpen: "false" }))).toThrow();
  for (const patch of [{ activeId: "missing" }, { compareIds: ["a", "a"] }, { compareIds: ["a", "missing"] }, { documents: [state.documents[0], state.documents[0]] }]) {
    expect(() => parseWorkspaceManifest(JSON.stringify({ ...state, ...patch }))).toThrow();
  }
  expect(parseWorkspaceManifest(JSON.stringify(createEmptyManifest())).documents).toEqual([]);
});

test("new documents inherit visual style without copying site IDs, visibility, measurements or edits", () => {
  const original = createDocumentWorkspace(session("original"));
  original.preferences.appearance.style.materialPreset = "colored-metal";
  original.preferences.appearance.style.objectStyles.atomOverrides.a = { visible: false, color: "#ff0000" };
  original.preferences.appearance.componentVisibility.atoms = false;
  original.preferences.edits.deleted.atoms.push("a");
  original.preferences.measurementTools = { measurements: [{ id: "x", kind: "distance", atomIds: ["a", "b"] }], focus: null };
  const next = createDocumentWorkspace(session("next"), original.preferences);
  expect(next.preferences.appearance.style.materialPreset).toBe("colored-metal");
  expect(next.preferences.appearance.style.objectStyles.atomOverrides).toEqual({});
  expect(next.preferences.appearance.componentVisibility.atoms).toBe(true);
  expect(next.preferences.edits.deleted.atoms).toEqual([]);
  expect(next.preferences.measurementTools).toBeUndefined();
  expect(next.preferences.sessionId).toBe("next");
});

test("a failed new document save cannot keep closed documents in the durable manifest", () => {
  const state = { ...createEmptyManifest(), documents: [{ id: "kept", title: "CONTCAR" }, { id: "unsaved", title: "POSCAR" }], activeId: "unsaved", compareIds: ["kept", "unsaved"] as [string, string] };
  const durable = durableWorkspaceManifest(state, new Set(["closed", "kept"]));
  expect(durable.documents.map(doc => doc.id)).toEqual(["kept"]);
  expect(durable.activeId).toBe("kept");
  expect(durable.compareIds).toBeNull();
  expect(parseWorkspaceManifest(JSON.stringify(durable))).toEqual(durable);
});

test("actual visibility controls share deletion undo order without reverting later colors", () => {
  const close = () => {};
  const request = async () => true;
  const { result, unmount } = renderHook(() => {
    const edits = useSceneEdits(scene, 0);
    const appearance = useFigureAppearanceController({ scene: edits.scene, connectivityStatus: "ready", closeActiveColorPicker: close,
      requestConnectivity: request, recordVisibilityChange: edits.recordVisibilityChange });
    useLayoutEffect(() => edits.registerVisibilityRestore(appearance.restoreVisibilityState), [edits.registerVisibilityRestore, appearance.restoreVisibilityState]);
    return { edits, appearance };
  });
  const first = scene.atoms[0]!;
  const second = scene.atoms[1]!;
  act(() => result.current.edits.deleteObjects({ atoms: new Set([first.id]), bonds: new Set() }));
  act(() => result.current.appearance.hideAtom(second.siteId));
  act(() => result.current.appearance.setStyle(current => ({ ...current, materialPreset: "colored-metal",
    objectStyles: setAtomOverrideProperty(current.objectStyles, second.siteId, "color", "#ff0000") })));
  act(() => { expect(result.current.edits.undoDeletion()).toBe(true); });
  expect(result.current.appearance.style.objectStyles.atomOverrides[second.siteId]?.visible).not.toBe(false);
  expect(result.current.appearance.style.objectStyles.atomOverrides[second.siteId]?.color).toBe("#ff0000");
  expect(result.current.edits.snapshot.deleted.atoms).toEqual([first.id]);
  act(() => result.current.edits.undoDeletion());
  expect(result.current.edits.snapshot.deleted.atoms).toEqual([]);
  act(() => { result.current.edits.redoDeletion(); result.current.edits.redoDeletion(); });
  expect(result.current.edits.snapshot.deleted.atoms).toEqual([first.id]);
  expect(result.current.appearance.style.objectStyles.atomOverrides[second.siteId]?.visible).toBe(false);
  expect(result.current.appearance.style.materialPreset).toBe("colored-metal");
  unmount();
});

test("model revision, edit history and preferences use one durable record and never load stale local preferences", async () => {
  const storage = mockDocumentDatabase();
  const savedManifest = localStorage.getItem(DOCUMENT_MANIFEST_KEY);
  const id = "model-storage-contract", preferenceKey = `crystalsketch.document.${id}`;
  const previousPreferences = localStorage.getItem(preferenceKey);
  try {
    const before = createModelState(parseVaspStructure("CuI\n1\n6 0 0\n0 6 0\n0 0 6\nCu I\n1 1\nDirect\n.25 .25 .25\n.5 .5 .5"));
    const after = applyModelOperation(before, { type: "vacancy", siteIds: [before.structure.sites[0]!.siteId] }).state;
    const workspace = createDocumentWorkspace({ ...session(id), scene: modelToScene(after), model: { state: after, revision: 1 } });
    workspace.preferences.modelDocument = true;
    workspace.preferences.viewScale = 1.75;
    workspace.preferences.edits.history = [{ kind: "model", patch: createModelPatch(before, after),
      before: { atoms: [], bonds: [] }, after: { atoms: [], bonds: [] },
      references: { before: { measurements: [], focus: null }, after: { measurements: [], focus: null } } }];
    workspace.preferences.poscarDraft = { text: "retained user draft", baseModelRevision: 0, modified: true };
    localStorage.setItem(preferenceKey, serializeWorkspacePreferences({ ...workspace.preferences, viewScale: 99,
      edits: { deleted: { atoms: [], bonds: [] }, history: [] } }));
    await saveModelWorkspace(workspace);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]!.key).toBe(`document:${id}`);
    expect(storage.writes[0]!.record).toHaveProperty("savedPreferences");
    saveWorkspaceManifest({ ...createEmptyManifest(), documents: [{ id, title: "POSCAR" }], activeId: id });
    const restored = (await loadDocuments()).documents[0]!;
    expect(restored.session.model).toEqual(workspace.session.model);
    expect(restored.preferences).toEqual(workspace.preferences);
    const action = restored.preferences.edits.history[0]!;
    if (!("kind" in action)) throw new Error("Expected a typed history action");
    expect(action.kind).toBe("model");
    if (action.kind !== "model") throw new Error("Expected restored model action");
    expect(applyModelPatch(restored.session.model!.state, action.patch, "before")).toEqual(before);
    storage.abortNextWrite = true;
    await expect(saveModelWorkspace({ session: { ...workspace.session, model: { state: before, revision: 2 } },
      preferences: { ...workspace.preferences, viewScale: 2.5 } })).rejects.toThrow("Test write aborted");
    const retained = (await loadDocuments()).documents[0]!;
    expect(retained.session.model!.revision).toBe(1);
    expect(retained.preferences.viewScale).toBe(1.75);
    expect(retained.preferences.edits).toEqual(workspace.preferences.edits);
  } finally {
    storage.restore();
    if (savedManifest === null) localStorage.removeItem(DOCUMENT_MANIFEST_KEY); else localStorage.setItem(DOCUMENT_MANIFEST_KEY, savedManifest);
    if (previousPreferences === null) localStorage.removeItem(preferenceKey); else localStorage.setItem(preferenceKey, previousPreferences);
  }
});

test("autosave debounces complete latest model snapshots without flushing effect updates or StrictMode cleanup", async () => {
  const timers = mockAutosaveTimers();
  const save = spyOn(documentStorage, "saveModelWorkspace").mockResolvedValue(undefined);
  const store = createCameraInteractionStore();
  const orientation = { current: new Quaternion() };
  const first = modelWorkspace("debounced-model", 0);
  const hook = renderHook(({ workspace }) => useWorkspacePersistence(workspace.session, workspace.preferences, store, orientation),
    { initialProps: { workspace: first }, wrapper: StrictMode });
  try {
    await act(async () => { await Promise.resolve(); });
    expect(save).not.toHaveBeenCalled();
    expect(timers.pendingCount()).toBe(1);
    for (let revision = 1; revision <= 3; revision++) hook.rerender({ workspace: modelWorkspace(first.session.id, revision) });
    expect(save).not.toHaveBeenCalled();
    expect(timers.pendingCount()).toBe(1);
    orientation.current.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 3);
    act(() => { store.setViewScaleSnapshot(1.8); store.setPanSnapshot([2, 3, 4]); });
    const latest = hook.result.current.getSnapshot()!;
    act(() => timers.fire());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toEqual(latest);
    expect(latest.session.model!.revision).toBe(3);
    expect(latest.preferences.poscarDraft!.text).toBe("draft-3");
    expect(latest.preferences.edits.history).toHaveLength(3);
    expect(latest.preferences.viewScale).toBe(1.8);
    expect(latest.preferences.viewPan).toEqual([2, 3, 4]);
    const axes = vectorsFromCameraQuaternion(orientation.current);
    expect(latest.preferences.viewState.camera).toEqual(stateFromViewVectors(latest.session.scene.cell.vectors,
      first.preferences.viewState.camera.primary, first.preferences.viewState.camera.secondary, axes.up, axes.outward));
  } finally {
    hook.unmount();
    await act(async () => { await Promise.resolve(); });
    save.mockRestore(); timers.restore();
  }
});

test("page exits and real unmount flush live camera state before the debounce timer for model and source documents", async () => {
  const timers = mockAutosaveTimers();
  const saveModel = spyOn(documentStorage, "saveModelWorkspace").mockResolvedValue(undefined);
  const savePreferences = spyOn(documentStorage, "saveDocumentPreferences").mockImplementation(() => {});
  const saveSource = spyOn(documentStorage, "saveDocumentSession").mockResolvedValue(undefined);
  try {
    for (const workspace of [modelWorkspace("exit-model", 0), createDocumentWorkspace(session("exit-source"))]) {
      const store = createCameraInteractionStore();
      const orientation = { current: new Quaternion() };
      const hook = renderHook(() => useWorkspacePersistence(workspace.session, workspace.preferences, store, orientation));
      const saves = workspace.session.model ? saveModel : savePreferences;
      const startingCount = saves.mock.calls.length;
      act(() => { store.setViewScaleSnapshot(2); store.setPanSnapshot([1, 2, 3]); });
      orientation.current.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
      const beforeUnload = hook.result.current.getSnapshot()!;
      act(() => window.dispatchEvent(new Event("beforeunload")));
      expect(saves).toHaveBeenCalledTimes(startingCount + 1);
      expect(timers.pendingCount()).toBe(0);
      const lastSaved = () => workspace.session.model ? saveModel.mock.calls.at(-1)![0].preferences : savePreferences.mock.calls.at(-1)![0];
      expect(lastSaved()).toEqual(beforeUnload.preferences);
      act(() => { store.setViewScaleSnapshot(2.5); window.dispatchEvent(new Event("pagehide")); });
      expect(lastSaved().viewScale).toBe(2.5);
      act(() => store.setViewScaleSnapshot(3));
      const beforeUnmount = hook.result.current.getSnapshot()!;
      hook.unmount();
      orientation.current.identity();
      await act(async () => { await Promise.resolve(); });
      expect(lastSaved()).toEqual(beforeUnmount.preferences);
      expect(timers.pendingCount()).toBe(0);
      const countAfterUnmount = saves.mock.calls.length;
      act(() => { store.setViewScaleSnapshot(4); window.dispatchEvent(new Event("pagehide")); });
      expect(saves).toHaveBeenCalledTimes(countAfterUnmount);
    }
    expect(saveSource).toHaveBeenCalledTimes(1);
  } finally { saveModel.mockRestore(); savePreferences.mockRestore(); saveSource.mockRestore(); timers.restore(); }
});

test("in-flight model saves serialize and coalesce pending revisions, including after an aborted write", async () => {
  const storage = mockDocumentDatabase(false);
  const id = "serialized-model";
  try {
    const first = saveModelWorkspace(modelWorkspace(id, 1));
    await settleMicrotasks();
    const middle = saveModelWorkspace(modelWorkspace(id, 2));
    const latest = saveModelWorkspace(modelWorkspace(id, 3));
    expect(storage.writes).toHaveLength(1);
    storage.completeNext();
    await settleMicrotasks();
    expect(storage.writes.map(write => write.record.model!.revision)).toEqual([1, 3]);
    storage.completeNext();
    await Promise.all([first, middle, latest]);
    const record = storage.records.get(`document:${id}`)!;
    expect(record.model!.revision).toBe(3);
    expect(parseWorkspacePreferences(record.savedPreferences!)!.edits.history).toHaveLength(3);
    expect(parseWorkspacePreferences(record.savedPreferences!)!.poscarDraft!.text).toBe("draft-3");

    const failed = saveModelWorkspace(modelWorkspace(id, 4)).catch(error => error);
    await settleMicrotasks();
    const recovery = saveModelWorkspace(modelWorkspace(id, 5)).catch(error => error);
    storage.abortNextWrite = true;
    storage.completeNext();
    await settleMicrotasks();
    expect(storage.writes.at(-1)!.record.model!.revision).toBe(5);
    storage.completeNext();
    expect(await failed).toBeInstanceOf(Error);
    await recovery;
    expect(storage.records.get(`document:${id}`)!.model!.revision).toBe(5);
  } finally { storage.restore(); }
});

test("document removal blocks queued and later model saves from resurrecting its record", async () => {
  const storage = mockDocumentDatabase(false);
  const id = "removed-pending-model";
  const previousManifest = localStorage.getItem(DOCUMENT_MANIFEST_KEY);
  try {
    const active = saveModelWorkspace(modelWorkspace(id, 1));
    await settleMicrotasks();
    const pending = saveModelWorkspace(modelWorkspace(id, 2));
    saveWorkspaceManifest(createEmptyManifest());
    const removal = documentStorage.removeDocument(id);
    await settleMicrotasks();
    storage.completeNext();
    await settleMicrotasks();
    storage.completeNext();
    await Promise.all([active, pending, removal]);
    await saveModelWorkspace(modelWorkspace(id, 3));
    expect(storage.writes).toHaveLength(1);
    expect(storage.records.has(`document:${id}`)).toBe(false);
    expect((await loadDocuments()).documents).toEqual([]);
  } finally {
    storage.restore();
    if (previousManifest === null) localStorage.removeItem(DOCUMENT_MANIFEST_KEY);
    else localStorage.setItem(DOCUMENT_MANIFEST_KEY, previousManifest);
  }
});

function modelWorkspace(id: string, revision: number): SavedWorkspace {
  const model = createModelState({ cell: scene.cell, species: ["Cu"], sites: [
    { siteId: "Cu-0", speciesIndex: 0, fractionalPosition: [0.25 + revision * 0.01, 0.25, 0.25] },
  ] });
  const workspace = createDocumentWorkspace({ ...session(id), scene: modelToScene(model), model: { state: model, revision } });
  workspace.preferences.modelDocument = true;
  workspace.preferences.poscarDraft = { text: `draft-${revision}`, baseModelRevision: revision, modified: true };
  workspace.preferences.edits.history = Array.from({ length: revision }, (_, index) => ({ kind: "delete" as const,
    before: { atoms: [], bonds: [] }, after: { atoms: [], bonds: [`bond-${index}`] } }));
  return workspace;
}

async function settleMicrotasks() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function mockAutosaveTimers() {
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  let nextId = -1;
  const pending = new Map<number, () => void>();
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 150) return nativeSetTimeout(callback, delay, ...args);
    const id = nextId--;
    pending.set(id, () => callback(...args));
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    if (!pending.delete(handle as number)) nativeClearTimeout(handle as number | undefined);
  });
  return { pendingCount: () => pending.size,
    fire: () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()); },
    restore: () => { set.mockRestore(); clear.mockRestore(); } };
}

function mockDocumentDatabase(autoComplete = true) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  type Record = LoadedPreviewSession & { savedPreferences?: string };
  const records = new Map<string, Record>();
  const writes: { key: string; record: Record }[] = [];
  const completions: (() => void)[] = [];
  const control = { abortNextWrite: false };
  // The DOM runtime has no IndexedDB; control transaction completion to expose write races.
  const db = {
    onversionchange: null as (() => void) | null, close() {},
    transaction(_store: string, mode?: string) {
      const mutations: (() => void)[] = [];
      const enqueue = (mutation: () => void) => {
        mutations.push(mutation);
        if (mutations.length !== 1) return;
        const complete = () => {
          if (control.abortNextWrite) {
            control.abortNextWrite = false; transaction.error = new Error("Test write aborted"); transaction.onabort?.();
          } else { mutations.forEach(apply => apply()); transaction.oncomplete?.(); }
        };
        if (autoComplete) queueMicrotask(complete); else completions.push(complete);
      };
      const transaction = { error: null as Error | null, oncomplete: null as (() => void) | null, onabort: null as (() => void) | null,
        objectStore: () => ({
          put(record: Record, key: string) {
            expect(mode).toBe("readwrite");
            const copied = structuredClone(record); writes.push({ key, record: copied });
            enqueue(() => records.set(key, copied));
          },
          delete(key: string) { enqueue(() => { records.delete(key); }); },
          get(key: string) {
            const request = { result: undefined as unknown, onsuccess: null as (() => void) | null };
            queueMicrotask(() => { request.result = structuredClone(records.get(key)); request.onsuccess?.(); });
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() {
    const request = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } });
  return Object.assign(control, { records, writes,
    completeNext: () => { const next = completions.shift(); if (!next) throw new Error("No pending document transaction"); next(); },
    restore: () => {
      db.onversionchange?.();
      if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor); else Reflect.deleteProperty(globalThis, "indexedDB");
    } });
}
