import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { ChangeEvent } from "react";
import { useStructurePreview } from "../src/app/hooks/useStructurePreview";
import { captureSceneVisibility, restoreObjectStyleVisibility, restoreAtomColors, useSceneEdits, type SceneVisibilitySnapshot } from "../src/app/hooks/useSceneEdits";
import { useSceneObjectInteractionController } from "../src/app/hooks/useSceneObjectInteractionController";
import { useFigureAppearanceController } from "../src/app/hooks/useFigureAppearanceController";
import { parseWorkspacePreferences, serializeWorkspacePreferences, type WorkspacePreferences } from "../src/app/workspaceStorage";
import { createDefaultStyle, createDefaultComponentVisibility, createDefaultComponentOpacity, createDefaultExportSettings, createDefaultBondVisibilityOverrides, DEFAULT_STRUCTURE_LINE_WIDTH, setAtomOverrideProperty, setAtomColorOverrides, visibleSceneForComponents, type BondVisibilityOverrides } from "../src/model";
import { createPreviewViewState } from "../src/app/viewState";
import { parseVaspScene, parseVaspStructure } from "../src/api/vasp";
import { applyModelOperation, createModelState, modelToScene, type ModelOperation } from "../src/model/structureModel";

const structure = "CuI\n1\n6 0 0\n0 6 0\n0 0 6\nCu I\n1 1\nDirect\n.25 .25 .25\n.5 .5 .5";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const inputEvent = (file: File) => ({ target: { files: [file], value: "POSCAR" } }) as unknown as ChangeEvent<HTMLInputElement>;
const symmetryResponse = (spaceGroup: string) => new Response(JSON.stringify({ ...parseVaspScene(structure).summary.symmetry, available: true, spaceGroup }));

test("batch color undo shares the edit timeline and preserves later non-color appearance changes", () => {
  const scene = parseVaspScene(structure);
  const [first, second] = scene.atoms;
  let styles = createDefaultStyle().objectStyles;
  styles = setAtomOverrideProperty(styles, first!.siteId, "color", "#123456");
  const components = createDefaultComponentVisibility(), bonds = createDefaultBondVisibilityOverrides();
  const { result } = renderHook(() => useSceneEdits(scene, 0));
  result.current.registerAtomColorRestore(snapshot => { styles = restoreAtomColors(styles, snapshot); });
  result.current.registerVisibilityRestore(snapshot => { styles = restoreObjectStyleVisibility(styles, snapshot); });
  act(() => result.current.deleteObjects({ atoms: new Set(), bonds: new Set([scene.bonds[0]!.id]) }));
  const gesture = {};
  act(() => {
    for (const color of ["#b79eeb", "#97cff2", "#f1abbc"]) {
      const next = setAtomColorOverrides(styles, [first!, second!], color);
      result.current.recordAtomColorChange(styles, next, gesture);
      styles = next;
    }
  });
  expect(result.current.snapshot.history.map(action => "kind" in action ? action.kind : "legacy")).toEqual(["delete", "atom-color"]);
  styles = setAtomOverrideProperty(styles, first!.siteId, "radius", 0.9);
  styles = setAtomOverrideProperty(styles, second!.siteId, "opacity", 55);
  styles = setAtomOverrideProperty(styles, "unrelated-site", "color", "#abcdef");
  const beforeHidden = captureSceneVisibility(styles, components, bonds);
  styles = setAtomOverrideProperty(styles, first!.siteId, "visible", false);
  act(() => result.current.recordVisibilityChange(beforeHidden, captureSceneVisibility(styles, components, bonds)));
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(styles.atomOverrides[first!.siteId]!.color).toBe("#f1abbc");
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(styles.atomOverrides[first!.siteId]).toEqual({ color: "#123456", radius: 0.9 });
  expect(styles.atomOverrides[second!.siteId]).toEqual({ opacity: 55 });
  expect(styles.atomOverrides["unrelated-site"]!.color).toBe("#abcdef");
  expect(result.current.snapshot.deleted.bonds).toEqual([scene.bonds[0]!.id]);
  const saved = JSON.parse(JSON.stringify(result.current.snapshot));
  const restored = renderHook(() => useSceneEdits(scene, 0, saved));
  restored.result.current.registerAtomColorRestore(snapshot => { styles = restoreAtomColors(styles, snapshot); });
  restored.result.current.registerVisibilityRestore(snapshot => { styles = restoreObjectStyleVisibility(styles, snapshot); });
  act(() => { expect(restored.result.current.redoDeletion()).toBe(true); });
  expect(styles.atomOverrides[first!.siteId]).toEqual({ color: "#f1abbc", radius: 0.9 });
  expect(styles.atomOverrides[second!.siteId]).toEqual({ color: "#f1abbc", opacity: 55 });
  act(() => { expect(restored.result.current.redoDeletion()).toBe(true); });
  expect(styles.atomOverrides[first!.siteId]!.visible).toBe(false);
});

test("restoring element colors is undoable and a new color branches after undo", () => {
  const scene = parseVaspScene(structure), first = scene.atoms[0]!;
  let styles = createDefaultStyle().objectStyles;
  const { result } = renderHook(() => useSceneEdits(scene, 0));
  result.current.registerAtomColorRestore(snapshot => { styles = restoreAtomColors(styles, snapshot); });
  const color = (value: string | null) => act(() => {
    const next = setAtomColorOverrides(styles, [first], value);
    result.current.recordAtomColorChange(styles, next);
    styles = next;
  });
  color("#b79eeb"); color(null);
  expect(result.current.snapshot.history).toHaveLength(2);
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(styles.atomOverrides[first.siteId]!.color).toBe("#b79eeb");
  act(() => { expect(result.current.redoDeletion()).toBe(true); });
  expect(styles.atomOverrides[first.siteId]).toBeUndefined();
  act(() => { result.current.undoDeletion(); });
  color("#97cff2");
  expect(result.current.redoDeletion()).toBe(false);
  expect(result.current.snapshot.future).toHaveLength(0);
});

test("a color gesture that returns to its initial state adds no undo step and retains the redo branch", () => {
  const scene = parseVaspScene(structure), first = scene.atoms[0]!;
  let styles = setAtomColorOverrides(createDefaultStyle().objectStyles, [first], "#123456");
  const { result } = renderHook(() => useSceneEdits(scene, 0));
  result.current.registerAtomColorRestore(snapshot => { styles = restoreAtomColors(styles, snapshot); });
  act(() => { result.current.deleteObjects({ atoms: new Set(), bonds: new Set([scene.bonds[0]!.id]) }); result.current.undoDeletion(); });
  const future = result.current.snapshot.future;
  const gesture = {};
  act(() => {
    for (const color of ["#abcdef", "#123456"]) {
      const next = setAtomColorOverrides(styles, [first], color);
      result.current.recordAtomColorChange(styles, next, gesture);
      styles = next;
    }
  });
  expect(result.current.snapshot.history).toHaveLength(0);
  expect(result.current.snapshot.future).toEqual(future);
  act(() => { expect(result.current.redoDeletion()).toBe(true); });
});

test("model edits retain existing selected sites and update the focused atom's element and coordinates", () => {
  let model = createModelState(parseVaspStructure(structure));
  const firstId = model.structure.sites[0]!.siteId;
  const secondId = model.structure.sites[1]!.siteId;
  const { result, rerender } = renderHook(({ scene }) => useSceneObjectInteractionController({
    visibleScene: scene, componentVisibility: createDefaultComponentVisibility(), connectivityStatus: "ready",
    deleteObjects() {}, undoDeletion: () => false, closeActiveColorPicker() {}, hideAtom() {},
    requestConnectivity: async () => true, setBondVisible() {},
  }), { initialProps: { scene: modelToScene(model) } });
  act(() => result.current.replaceSelection({ atoms: new Set([firstId, secondId]), bonds: new Set() }));
  const selection = result.current.selection;
  for (const operation of [
    { type: "substitute", siteIds: [firstId], element: "Zn" },
    { type: "move", siteId: firstId, position: [0.2, 0.25, 0.25], coordinates: "direct" },
    { type: "constraints", siteIds: [firstId], flags: [false, true, false] },
  ] satisfies ModelOperation[]) {
    model = applyModelOperation(model, operation).state;
    const scene = modelToScene(model);
    act(() => { result.current.pruneSelection(scene); rerender({ scene }); });
    expect(result.current.selection).toBe(selection);
    expect(result.current.inspectedAtomId).toBe(firstId);
  }
  expect(result.current.inspectedAtomInfo!.canonicalAtom.element).toBe("Zn");
  result.current.inspectedAtomInfo!.canonicalAtom.fractionalPosition.forEach((value, index) =>
    expect(value).toBeCloseTo([0.2, 0.25, 0.25][index]!, 12));
});

test("vacancy prunes only absent atoms and incident bonds, keeping the remaining mixed selection", () => {
  const model = applyModelOperation(createModelState(parseVaspStructure(structure)), { type: "supercell", repeat: [2, 1, 1] }).state;
  const scene = modelToScene(model);
  const removedId = model.structure.sites[0]!.siteId;
  const keptId = model.structure.sites[3]!.siteId;
  const removedBond = scene.bonds.find(bond => bond.startSiteId === removedId || bond.endSiteId === removedId)!;
  const keptBond = scene.bonds.find(bond => bond.startSiteId !== removedId && bond.endSiteId !== removedId)!;
  expect(removedBond).toBeDefined();
  expect(keptBond).toBeDefined();
  const { result, rerender } = renderHook(({ visibleScene }) => useSceneObjectInteractionController({
    visibleScene, componentVisibility: createDefaultComponentVisibility(), connectivityStatus: "ready",
    deleteObjects() {}, undoDeletion: () => false, closeActiveColorPicker() {}, hideAtom() {},
    requestConnectivity: async () => true, setBondVisible() {},
  }), { initialProps: { visibleScene: scene } });
  act(() => result.current.replaceSelection({ atoms: new Set([removedId, keptId]), bonds: new Set([removedBond.id, keptBond.id]) }));
  const nextScene = modelToScene(applyModelOperation(model, { type: "vacancy", siteIds: [removedId] }).state);
  act(() => { result.current.pruneSelection(nextScene); rerender({ visibleScene: nextScene }); });
  expect(result.current.selection.atoms).toEqual(new Set([keptId]));
  expect(result.current.selection.bonds).toEqual(new Set([keptBond.id]));
  expect(result.current.inspectedAtomId).toBe(keptId);
});

test("moving a boundary site removes an undrawn selected image without dropping another selected atom", () => {
  const model = createModelState(parseVaspStructure(structure.replace(".25 .25 .25", "0 0 0")));
  const scene = modelToScene(model);
  const siteId = model.structure.sites[0]!.siteId;
  const otherId = model.structure.sites[1]!.siteId;
  const image = scene.atoms.find(atom => atom.siteId === siteId && atom.isPeriodicImage)!;
  expect(image).toBeDefined();
  const { result, rerender } = renderHook(({ visibleScene }) => useSceneObjectInteractionController({
    visibleScene, componentVisibility: createDefaultComponentVisibility(), connectivityStatus: "ready",
    deleteObjects() {}, undoDeletion: () => false, closeActiveColorPicker() {}, hideAtom() {},
    requestConnectivity: async () => true, setBondVisible() {},
  }), { initialProps: { visibleScene: scene } });
  act(() => result.current.replaceSelection({ atoms: new Set([image.id, otherId]), bonds: new Set() }));
  const nextScene = modelToScene(applyModelOperation(model, { type: "move", siteId, coordinates: "direct", position: [0.1, 0.1, 0.1] }).state);
  act(() => { result.current.pruneSelection(nextScene); rerender({ visibleScene: nextScene }); });
  expect(result.current.selection.atoms).toEqual(new Set([otherId]));
  expect(result.current.inspectedAtomId).toBe(otherId);
});

test("model rebonding reads the latest edited structure even immediately after replacing its revision", async () => {
  const original = createModelState(parseVaspStructure(structure));
  const substituted = applyModelOperation(original, { type: "substitute", siteIds: [original.structure.sites[0]!.siteId], element: "Zn" }).state;
  const inserted = applyModelOperation(substituted, { type: "interstitial", element: "H", coordinates: "direct", position: [0.75, 0.75, 0.75] }).state;
  const file = new File([structure], "POSCAR");
  const { result, unmount } = renderHook(() => useStructurePreview({ initialSession: { id: "edited-rebond",
    file, fileName: "POSCAR", bondingMode: "minimum-distance", customBondingProfile: null,
    model: { state: substituted, revision: 1 }, scene: modelToScene(substituted) },
    onBondAlgorithmSceneLoaded() {}, onPreviewCleared() {}, resetLoadedPreviewState() {} }));
  try {
    await act(async () => {
      result.current.replaceModel(inserted);
      await result.current.handleBondToleranceChange(1.3);
    });
    expect(result.current.session!.model!.revision).toBe(2);
    expect(result.current.scene!.summary.atomCount).toBe(3);
    expect(result.current.scene!.bondTolerance).toBe(1.3);
    expect(new Set(result.current.scene!.atoms.map(atom => atom.element))).toEqual(new Set(["Zn", "I", "H"]));
    await act(async () => { await result.current.handleBondCutoffOverridesChange({ "I|Zn": { min: 0.4, max: 3.5 } }); });
    expect(result.current.scene!.atoms.map(atom => atom.siteId)).toEqual(modelToScene(inserted, { "I|Zn": { min: 0.4, max: 3.5 } }, 1.3).atoms.map(atom => atom.siteId));
    expect(await file.text()).toBe(structure);
  } finally { unmount(); }
});

test("shows VASP before symmetry responds and ignores analysis after clearing", async () => {
  let complete!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { complete = resolve; })) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useStructurePreview({
    onBondAlgorithmSceneLoaded() {}, onPreviewCleared() {}, resetLoadedPreviewState() {},
  }));
  await act(async () => { await result.current.handleFileChange(inputEvent(new File([structure], "POSCAR"))); });
  expect(result.current.previewStatus).toBe("ready");
  expect(result.current.scene?.summary.atomCount).toBe(2);
  expect(result.current.symmetryPending).toBe(true);
  act(() => result.current.clearPreview());
  await act(async () => { complete(symmetryResponse("late")); });
  expect(result.current.scene).toBeNull();
  expect(result.current.selectedFileName).toBeNull();
  unmount();
});

test("late symmetry from the old file cannot replace the new file's result", async () => {
  const completions: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => completions.push(resolve))) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useStructurePreview({
    onBondAlgorithmSceneLoaded() {}, onPreviewCleared() {}, resetLoadedPreviewState() {},
  }));
  await act(async () => { await result.current.handleFileChange(inputEvent(new File([structure], "POSCAR"))); });
  await act(async () => { await result.current.handleFileChange(inputEvent(new File([structure], "CONTCAR"))); });
  await act(async () => { completions[0]!(symmetryResponse("old")); });
  expect(result.current.selectedFileName).toBe("CONTCAR");
  expect(result.current.scene?.summary.symmetry.spaceGroup).not.toBe("old");
  await act(async () => { completions[1]!(symmetryResponse("new")); });
  await waitFor(() => expect(result.current.scene?.summary.symmetry.spaceGroup).toBe("new"));
  expect(result.current.symmetryPending).toBe(false);
  unmount();
});

test("restores deleted atoms and undo history, and clears both for a new structure", () => {
  const scene = parseVaspScene(structure);
  const id = scene.atoms[0]!.id;
  const initial = { deleted: { atoms: [id], bonds: [] }, history: [{ atoms: [], bonds: [] }] };
  const { result, rerender, unmount } = renderHook(({ token }) => useSceneEdits(scene, token, initial), { initialProps: { token: 0 } });
  expect(result.current.scene?.atoms.some(atom => atom.id === id)).toBe(false);
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(result.current.scene?.atoms.some(atom => atom.id === id)).toBe(true);
  act(() => result.current.deleteObjects({ atoms: new Set([id]), bonds: new Set() }));
  rerender({ token: 1 });
  expect(result.current.snapshot.deleted.atoms).toEqual([]);
  expect(result.current.undoDeletion()).toBe(false);
  unmount();
});

test("migrates legacy redo states and clears future when a new restore changes the branch", () => {
  const scene = parseVaspScene(structure);
  const [a, b] = scene.atoms.map(atom => atom.id);
  const initial = { deleted: { atoms: [], bonds: [] }, history: [],
    future: [{ atoms: [a!, b!], bonds: [] }, { atoms: [a!], bonds: [] }] };
  const { result, rerender } = renderHook(({ token }) => useSceneEdits(scene, token, initial), { initialProps: { token: 0 } });
  act(() => { expect(result.current.redoDeletion()).toBe(true); });
  expect(result.current.snapshot.deleted.atoms).toEqual([a!]);
  act(() => { expect(result.current.redoDeletion()).toBe(true); });
  expect(result.current.snapshot.deleted.atoms).toEqual([a!, b!]);
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  act(() => result.current.restoreObjects({ atoms: new Set([a!]), bonds: new Set() }));
  expect(result.current.scene?.atoms).toEqual(scene.atoms);
  expect(result.current.redoDeletion()).toBe(false);
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(result.current.snapshot.deleted.atoms).toEqual([a!]);
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(result.current.snapshot.deleted.atoms).toEqual([]);
  expect(result.current.snapshot.future.length).toBeGreaterThan(0);
  rerender({ token: 1 });
  expect(result.current.snapshot).toEqual({ deleted: { atoms: [], bonds: [] }, history: [], future: [] });
  expect(result.current.redoDeletion()).toBe(false);
});

test("keeps deletion, hiding, and restoration in one chronological undo/redo history", () => {
  const scene = parseVaspScene(structure);
  const [a, b] = scene.atoms;
  let objectStyles = createDefaultStyle().objectStyles;
  let components = createDefaultComponentVisibility();
  let bonds: BondVisibilityOverrides = createDefaultBondVisibilityOverrides();
  const { result } = renderHook(() => useSceneEdits(scene, 0));
  const applyVisibility = (snapshot: SceneVisibilitySnapshot) => {
    objectStyles = restoreObjectStyleVisibility(objectStyles, snapshot);
    components = snapshot.componentVisibility;
    bonds = { hiddenFamilies: new Set(snapshot.hiddenBondFamilies), hiddenBondRelations: new Set(snapshot.hiddenBondRelations) };
  };
  const unregister = result.current.registerVisibilityRestore(applyVisibility);
  const visible = () => visibleSceneForComponents(result.current.scene, components, objectStyles, bonds)!;
  act(() => result.current.deleteObjects({ atoms: new Set([a!.id]), bonds: new Set() }));
  const before = captureSceneVisibility(objectStyles, components, bonds);
  objectStyles = setAtomOverrideProperty(objectStyles, b!.siteId, "visible", false);
  const after = captureSceneVisibility(objectStyles, components, bonds);
  act(() => result.current.recordVisibilityChange(before, after));
  objectStyles = setAtomOverrideProperty(objectStyles, b!.siteId, "color", "#123456");
  expect(visible().atoms.some(atom => atom.id === b!.id)).toBe(false);
  expect(result.current.snapshot.history.map(action => action.kind)).toEqual(["delete", "visibility"]);
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(visible().atoms.some(atom => atom.id === b!.id)).toBe(true);
  expect(visible().atoms.some(atom => atom.id === a!.id)).toBe(false);
  expect(objectStyles.atomOverrides[b!.siteId]?.color).toBe("#123456");
  act(() => { expect(result.current.undoDeletion()).toBe(true); });
  expect(visible().atoms.some(atom => atom.id === a!.id)).toBe(true);
  const saved = JSON.parse(JSON.stringify(result.current.snapshot));
  const restored = renderHook(() => useSceneEdits(scene, 0, saved));
  restored.result.current.registerVisibilityRestore(applyVisibility);
  act(() => { expect(restored.result.current.redoDeletion()).toBe(true); });
  expect(restored.result.current.scene?.atoms.some(atom => atom.id === a!.id)).toBe(false);
  act(() => { expect(restored.result.current.redoDeletion()).toBe(true); });
  expect(objectStyles.atomOverrides[b!.siteId]?.visible).toBe(false);
  expect(objectStyles.atomOverrides[b!.siteId]?.color).toBe("#123456");
  unregister();
  expect(result.current.snapshot.future.map(action => action.kind)).toEqual(["visibility", "delete"]);
});

test("caps the edit timeline at 50 steps and keeps no-op changes out of history", () => {
  const source = parseVaspScene(structure);
  const scene = { ...source, atoms: Array.from({ length: 60 }, (_, index) => ({ ...source.atoms[0]!, id: `atom-${index}`, siteId: `atom-${index}` })), bonds: [], polyhedra: [] };
  const { result } = renderHook(() => useSceneEdits(scene, 0));
  act(() => { for (const atom of scene.atoms) result.current.deleteObjects({ atoms: new Set([atom.id]), bonds: new Set() }); });
  expect(result.current.scene?.atoms).toHaveLength(0);
  expect(result.current.snapshot.history).toHaveLength(50);
  act(() => result.current.deleteObjects({ atoms: new Set([scene.atoms[0]!.id]), bonds: new Set() }));
  expect(result.current.snapshot.history).toHaveLength(50);
  act(() => { for (let index = 0; index < 50; index++) expect(result.current.undoDeletion()).toBe(true); });
  expect(result.current.undoDeletion()).toBe(false);
  expect(result.current.scene?.atoms).toHaveLength(50);
  expect(result.current.snapshot.future).toHaveLength(50);
  act(() => result.current.deleteObjects({ atoms: new Set(), bonds: new Set() }));
  expect(result.current.snapshot.future).toHaveLength(50);
  act(() => { for (let index = 0; index < 50; index++) expect(result.current.redoDeletion()).toBe(true); });
  expect(result.current.redoDeletion()).toBe(false);
  expect(result.current.scene?.atoms).toHaveLength(0);
  expect(scene.atoms).toHaveLength(60);
});

test("routes delete, undo, redo, and hide shortcuts only to the active view", () => {
  const scene = parseVaspScene(structure);
  const hidden = { left: [] as string[], right: [] as string[] };
  const { result, rerender } = renderHook(({ active }: { active: "left" | "right" | null }) => {
    const leftEdits = useSceneEdits(scene, 0), rightEdits = useSceneEdits(scene, 0);
    const base = { closeActiveColorPicker() {}, componentVisibility: createDefaultComponentVisibility(),
      connectivityStatus: "ready" as const, requestConnectivity: async () => true, setBondVisible() {} };
    const left = useSceneObjectInteractionController({ ...base, active: active === "left", ...leftEdits,
      visibleScene: leftEdits.scene, hideAtom: id => hidden.left.push(id) });
    const right = useSceneObjectInteractionController({ ...base, active: active === "right", ...rightEdits,
      visibleScene: rightEdits.scene, hideAtom: id => hidden.right.push(id) });
    return { leftEdits, rightEdits, left, right };
  }, { initialProps: { active: "left" as "left" | "right" | null } });
  const [a, b] = scene.atoms;
  act(() => { result.current.left.handleAtomInspect(a!.id); result.current.right.handleAtomInspect(a!.id); });
  fireEvent.keyDown(window, { key: "Delete" });
  expect(result.current.leftEdits.snapshot.deleted.atoms).toEqual([a!.id]);
  expect(result.current.rightEdits.snapshot.deleted.atoms).toEqual([]);
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  expect(result.current.leftEdits.snapshot.deleted.atoms).toEqual([]);
  fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });
  expect(result.current.leftEdits.snapshot.deleted.atoms).toEqual([a!.id]);
  rerender({ active: "right" });
  fireEvent.keyDown(window, { key: "Backspace" });
  expect(result.current.rightEdits.snapshot.deleted.atoms).toEqual([a!.id]);
  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(result.current.rightEdits.snapshot.deleted.atoms).toEqual([]);
  fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
  expect(result.current.rightEdits.snapshot.deleted.atoms).toEqual([a!.id]);
  act(() => { result.current.left.handleAtomInspect(b!.id); result.current.right.handleAtomInspect(b!.id); });
  fireEvent.keyDown(window, { key: "h" });
  expect(hidden).toEqual({ left: [], right: [b!.siteId] });
  rerender({ active: "left" });
  fireEvent.keyDown(window, { key: "h" });
  expect(hidden).toEqual({ left: [b!.siteId], right: [b!.siteId] });
  act(() => { result.current.left.handleAtomInspect(b!.id); result.current.right.handleAtomInspect(b!.id); });
  const leftSnapshot = result.current.leftEdits.snapshot, rightSnapshot = result.current.rightEdits.snapshot;
  const editor = document.createElement("div"), child = document.createElement("span");
  editor.setAttribute("contenteditable", "true"); editor.append(child); document.body.append(editor);
  try {
    fireEvent.keyDown(child, { key: "Delete" });
    fireEvent.keyDown(child, { key: "z", metaKey: true });
    fireEvent.keyDown(child, { key: "Z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(child, { key: "h" });
    expect(result.current.leftEdits.snapshot).toBe(leftSnapshot);
  } finally { editor.remove(); }
  rerender({ active: null });
  fireEvent.keyDown(window, { key: "Delete" });
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "h" });
  expect(result.current.leftEdits.snapshot).toBe(leftSnapshot);
  expect(result.current.rightEdits.snapshot).toBe(rightSnapshot);
  expect(hidden).toEqual({ left: [b!.siteId], right: [b!.siteId] });
});

test("the card delete action uses the latest mixed selection and exact periodic image identities", () => {
  const source = parseVaspScene(structure);
  const first = source.atoms[0]!, second = source.atoms[1]!, bond = source.bonds[0]!;
  const image = { ...first, id: `${first.id}-image-1-0-0`, isPeriodicImage: true,
    imageOffset: [1, 0, 0] as [number, number, number],
    fractionalPosition: [first.fractionalPosition[0] + 1, first.fractionalPosition[1], first.fractionalPosition[2]] as [number, number, number],
    position: [first.position[0] + 6, first.position[1], first.position[2]] as [number, number, number] };
  const scene = { ...source, atoms: [...source.atoms, image] };
  const { result, rerender } = renderHook(({ active }) => {
    const editing = useSceneEdits(scene, 0);
    const interaction = useSceneObjectInteractionController({ active, ...editing, visibleScene: editing.scene,
      componentVisibility: createDefaultComponentVisibility(), connectivityStatus: "ready",
      closeActiveColorPicker() {}, hideAtom() {}, setBondVisible() {}, requestConnectivity: async () => true });
    return { editing, interaction };
  }, { initialProps: { active: true } });
  const deleteFromCard = result.current.interaction.handleDeleteSelection;
  act(() => result.current.interaction.replaceSelection({ atoms: new Set([image.id, second.id]), bonds: new Set([bond.id]) }));
  act(() => { expect(deleteFromCard()).toBe(true); });
  expect(result.current.editing.snapshot.deleted).toEqual({ atoms: [image.id, second.id], bonds: [bond.id] });
  expect(result.current.editing.scene?.atoms.some(atom => atom.id === first.id)).toBe(true);
  expect(result.current.interaction.selection.atoms.size + result.current.interaction.selection.bonds.size).toBe(0);
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  expect(result.current.editing.scene?.atoms).toEqual(scene.atoms);
  expect(result.current.editing.scene?.bonds).toEqual(scene.bonds);
  fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
  expect(result.current.editing.snapshot.deleted).toEqual({ atoms: [image.id, second.id], bonds: [bond.id] });
  act(() => result.current.interaction.replaceSelection({ atoms: new Set([first.id]), bonds: new Set() }));
  rerender({ active: false });
  expect(result.current.interaction.handleDeleteSelection()).toBe(false);
  expect(result.current.editing.scene?.atoms.some(atom => atom.id === first.id)).toBe(true);
});

test("does not silently accept corrupt or incompatible recovery settings", () => {
  expect(parseWorkspacePreferences(null)).toBeNull();
  expect(() => parseWorkspacePreferences("not json")).toThrow();
  expect(() => parseWorkspacePreferences('{"version":2}')).toThrow();
  expect(() => parseWorkspacePreferences('{"version":1,"sessionId":"incomplete"}')).toThrow();
});

test("background metadata does not rebuild visible GPU geometry", () => {
  const scene = parseVaspScene(structure);
  const { result, rerender, unmount } = renderHook(({ data }) => useFigureAppearanceController({
    scene: data, connectivityStatus: "ready", closeActiveColorPicker() {}, requestConnectivity: async () => true,
  }), { initialProps: { data: scene } });
  const visible = result.current.visibleScene;
  const geometry = result.current.geometryScene;
  rerender({ data: { ...scene, summary: { ...scene.summary, symmetry: { ...scene.summary.symmetry, available: true, spaceGroup: "P1" } } } });
  expect(result.current.geometryScene).toBe(geometry);
  expect(result.current.visibleScene).toBe(visible);
  rerender({ data: { ...scene, atoms: [...scene.atoms] } });
  expect(result.current.geometryScene).not.toBe(geometry);
  unmount();
});

test("round-trips bond visibility sets instead of restoring plain JSON objects", () => {
  const state: WorkspacePreferences = {
    version: 1, sessionId: "saved-work",
    appearance: {
      style: createDefaultStyle(), componentVisibility: createDefaultComponentVisibility(),
      componentOpacity: createDefaultComponentOpacity(),
      bondVisibilityOverrides: { hiddenFamilies: new Set(["Cu|I"]), hiddenBondRelations: new Set(["bond-1"]) },
      previewMeshQuality: "high", unitCellLineStyle: "solid", structureLineWidth: DEFAULT_STRUCTURE_LINE_WIDTH,
      showCrystalAxisLabels: true,
    },
    edits: { deleted: { atoms: [], bonds: [] }, history: [] },
    viewState: createPreviewViewState(), viewScale: 1.25, exportSettings: { ...createDefaultExportSettings(), dpi: 300,
      previewLayout: { legend: { x: 0.15, y: -0.2 }, crystalAxes: { x: -0.3, y: 0.1 },
        margins: { top: 0.1, right: 0.05, bottom: 0.08, left: 0.05 } } },
  };
  const restored = parseWorkspacePreferences(serializeWorkspacePreferences(state))!;
  expect(restored.appearance.bondVisibilityOverrides.hiddenFamilies.has("Cu|I")).toBe(true);
  expect(restored.appearance.bondVisibilityOverrides.hiddenBondRelations.has("bond-1")).toBe(true);
  expect(restored.viewScale).toBe(1.25);
  expect(restored.appearance.style).toEqual(state.appearance.style);
  expect(restored.exportSettings.previewLayout).toEqual(state.exportSettings.previewLayout);
  expect(restored.exportSettings.dpi).toBe(300);
  const legacyDpiState = { ...state, exportSettings: { ...state.exportSettings, dpi: undefined } };
  expect(parseWorkspacePreferences(serializeWorkspacePreferences(legacyDpiState))?.exportSettings.dpi).toBe(600);
  for (const dpi of [null, "300", 150, 500, 0]) {
    const invalid = JSON.parse(serializeWorkspacePreferences(state));
    invalid.exportSettings.dpi = dpi;
    expect(() => parseWorkspacePreferences(JSON.stringify(invalid))).toThrow();
  }
  for (const previewLayout of [null, {}, { legend: { x: "1", y: 0 }, crystalAxes: { x: 0, y: 0 } }]) {
    const invalid = JSON.parse(serializeWorkspacePreferences(state));
    invalid.exportSettings.previewLayout = previewLayout;
    expect(() => parseWorkspacePreferences(JSON.stringify(invalid))).toThrow();
  }
  expect(parseWorkspacePreferences(serializeWorkspacePreferences({ ...state, exportSettings: createDefaultExportSettings() }))?.exportSettings.previewLayout).toBeUndefined();
  const visibility = captureSceneVisibility(state.appearance.style.objectStyles, state.appearance.componentVisibility, state.appearance.bondVisibilityOverrides);
  const historyState: WorkspacePreferences = { ...state, edits: { deleted: { atoms: [], bonds: [] },
    history: [{ kind: "visibility", before: visibility, after: { ...visibility, atomVisibility: { "Cu-1": false } } }],
    future: [{ kind: "delete", before: { atoms: [], bonds: [] }, after: { atoms: ["I-2"], bonds: [] } }] } };
  expect(parseWorkspacePreferences(serializeWorkspacePreferences(historyState))?.edits).toEqual(historyState.edits);
  const colorHistory: WorkspacePreferences = { ...state, edits: { deleted: { atoms: [], bonds: [] },
    history: [{ kind: "atom-color", before: { "Cu-1": null, "I-2": "#123456" }, after: { "Cu-1": "#b79eeb", "I-2": "#b79eeb" } }],
    future: [{ kind: "atom-color", before: { "Cu-1": "#b79eeb" }, after: { "Cu-1": null } }] } };
  expect(parseWorkspacePreferences(serializeWorkspacePreferences(colorHistory))?.edits).toEqual(colorHistory.edits);
  for (const after of [{ "Cu-1": 4 }, { wrong: "#abcdef" }, []]) {
    const invalid = JSON.parse(serializeWorkspacePreferences(colorHistory));
    invalid.edits.future[0].after = after;
    expect(() => parseWorkspacePreferences(JSON.stringify(invalid))).toThrow();
  }
  for (const future of ["invalid", [{ kind: "visibility", before: {}, after: {} }], [{ atoms: [1], bonds: [] }]]) {
    const invalid = JSON.parse(serializeWorkspacePreferences(historyState));
    invalid.edits.future = future;
    expect(() => parseWorkspacePreferences(JSON.stringify(invalid))).toThrow();
  }
  for (const materialPreset of ["soft-metal", "brushed-metal"]) {
    const legacy = { ...state, appearance: { ...state.appearance, style: { ...state.appearance.style, materialPreset } } };
    const migrated = parseWorkspacePreferences(serializeWorkspacePreferences(legacy))!;
    expect(migrated.appearance.style.materialPreset).toBe("colored-metal");
    expect(migrated.appearance.style.customColormap).toEqual(state.appearance.style.customColormap);
    expect(migrated.viewState).toEqual(state.viewState);
  }
});
