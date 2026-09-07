import { describe, expect, test } from "bun:test";
import { Matrix3, Vector3 } from "three";
import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { useSceneEdits } from "../src/app/hooks/useSceneEdits";
import { parseVaspScene, parseVaspStructure } from "../src/api/vasp";
import { createPoscar, validatePoscarText } from "../src/export/poscarExport";
import { mapModelReferences, mergeModelReferences, transitionModelReferences, type ModelReferenceSnapshot } from "../src/model/measurementModelMapping";
import { resolveMeasurement } from "../src/model/measurements";
import { applyModelOperation, createModelState, inspectModelDistances, modelToScene, ModelEditError, type ModelState } from "../src/model/structureModel";

const source = `CuI
1
8 0 0
0 8 0
0 0 8
Cu I
1 1
Selective dynamics
Direct
0 0 0 F T F
0.25 0.25 0.25 T T T
`;
const initial = () => createModelState(parseVaspStructure(source));
const apply = (state: ModelState, operation: Parameters<typeof applyModelOperation>[1]) => applyModelOperation(state, operation).state;

describe("editable periodic structure", () => {
  test("display reset retains model history and Command-Z restores each applied operation", () => {
    let model = initial();
    const original = model;
    const { result, rerender } = renderHook(({ reset }) => {
      const edits = useSceneEdits(modelToScene(model), reset, undefined, { preserveHistoryOnReset: true });
      useLayoutEffect(() => edits.registerModelEditing({ read: () => model, replace: next => { model = next; } }), [edits.registerModelEditing]);
      return edits;
    }, { initialProps: { reset: 0 } });
    act(() => { result.current.commitModel(apply(model, { type: "supercell", repeat: [2, 1, 1] })); });
    const supercell = model;
    act(() => { result.current.commitModel(apply(model, { type: "vacancy", siteIds: [model.structure.sites[1]!.siteId] })); });
    const vacancy = model;
    act(() => { result.current.commitModel(apply(model, { type: "substitute", siteIds: [model.structure.sites[0]!.siteId], element: "Zn" })); });
    const substituted = model;
    expect(result.current.snapshot.history).toHaveLength(3);
    rerender({ reset: 1 });
    expect(result.current.snapshot.history).toHaveLength(3);
    act(() => { expect(result.current.undoDeletion()).toBe(true); });
    expect(model).toEqual(vacancy);
    act(() => { expect(result.current.undoDeletion()).toBe(true); });
    expect(model).toEqual(supercell);
    act(() => { expect(result.current.undoDeletion()).toBe(true); });
    expect(model).toEqual(original);
    act(() => { result.current.redoDeletion(); result.current.redoDeletion(); result.current.redoDeletion(); });
    expect(model).toEqual(substituted);
  });
  test("uses exactly the original renderer before edits", () => {
    expect(modelToScene(initial())).toEqual(parseVaspScene(source));
  });
  test("64 → vacancy 63 → restored 64 preserves the source and durable vacancy anchor", () => {
    const base = apply(initial(), { type: "supercell", repeat: [4, 4, 2] });
    const site = base.structure.sites[12]!;
    const removed = apply(base, { type: "vacancy", siteIds: [site.siteId] });
    expect(base.structure.sites).toHaveLength(64);
    expect(removed.structure.sites).toHaveLength(63);
    expect(removed.defects[0]!.fractionalPosition).toEqual(site.fractionalPosition);
    expect(apply(removed, { type: "restore", defectId: removed.defects[0]!.id }).structure).toEqual(base.structure);
  });
  test("substitutions preserve identity and flags, remember the first element, and cancel on return", () => {
    const base = initial();
    const id = base.structure.sites[0]!.siteId;
    const zinc = apply(base, { type: "substitute", siteIds: [id], element: "Zn" });
    const sulfur = apply(zinc, { type: "substitute", siteIds: [id], element: "S" });
    expect(sulfur.structure.sites[0]).toMatchObject({ siteId: id, sourceAtomNumber: 1, selectiveDynamics: [false, true, false] });
    expect(sulfur.defects).toHaveLength(1);
    expect(sulfur.defects[0]!.originalElement).toBe("Cu");
    expect(apply(sulfur, { type: "substitute", siteIds: [id], element: "Cu" }).defects).toHaveLength(0);
    expect(base.structure.species).toEqual(["Cu", "I"]);
  });
  test("interstitials use Cartesian input; deletion does not create a fictitious vacancy", () => {
    const added = apply(initial(), { type: "interstitial", element: "H", coordinates: "cartesian", position: [4, 4, 4] });
    const site = added.structure.sites.at(-1)!;
    expect(site.fractionalPosition).toEqual([0.5, 0.5, 0.5]);
    expect(apply(added, { type: "vacancy", siteIds: [site.siteId] }).defects).toHaveLength(0);
    expect(() => apply(initial(), { type: "interstitial", element: "H", coordinates: "direct", position: [1, 0, 0] })).toThrow(/重叠/);
    expect(applyModelOperation(initial(), { type: "interstitial", element: "H", coordinates: "direct", position: [0.01, 0, 0] }).warnings).toHaveLength(1);
  });
  test("supercell is source-major, retains the zero-copy ID and source provenance", () => {
    const base = initial();
    const expanded = apply(base, { type: "supercell", repeat: [2, 1, 1] });
    expect(expanded.structure.sites.map(s => s.fractionalPosition)).toEqual([[0, 0, 0], [0.5, 0, 0], [0.125, 0.25, 0.25], [0.625, 0.25, 0.25]]);
    expect(expanded.structure.sites[0]!.siteId).toBe(base.structure.sites[0]!.siteId);
    expect(expanded.structure.sites[1]).toMatchObject({ sourceAtomNumber: 1, originSiteId: base.structure.sites[0]!.siteId, copyOffset: [1, 0, 0] });
    expect(new Set(expanded.structure.sites.map(s => s.siteId)).size).toBe(4);
    expect(() => apply(base, { type: "supercell", repeat: [30, 30, 30] })).toThrow(ModelEditError);
  });
  test("expanded and inserted atoms have unique display numbers without changing source provenance", () => {
    const fcc = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
    const sites = [...fcc, ...fcc.map(p => p.map(v => v + 0.25))].map((p, i) => ({ siteId: `source-${i}`,
      sourceAtomNumber: i + 1, speciesIndex: i < 4 ? 0 : 1, fractionalPosition: p as [number, number, number] }));
    const base = createModelState({ cell: { vectors: [[6, 0, 0], [0, 6, 0], [0, 0, 6]] }, species: ["Cu", "I"], sites });
    const expanded = apply(base, { type: "supercell", repeat: [2, 2, 2] });
    const canonical = modelToScene(expanded).atoms.filter(atom => !atom.isPeriodicImage);
    expect(canonical).toHaveLength(64);
    expect(new Set(canonical.map(atom => atom.sourceAtomNumber)).size).toBe(64);
    expect(new Set(expanded.structure.sites.map(site => site.sourceAtomNumber))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    base.structure.sites.forEach(site => expect(expanded.structure.sites.find(s => s.siteId === site.siteId)!.displayAtomNumber).toBe(site.sourceAtomNumber));
    const highest = expanded.structure.sites.find(site => site.displayAtomNumber === 64)!;
    const removed = apply(expanded, { type: "vacancy", siteIds: [highest.siteId] });
    const inserted = apply(removed, { type: "interstitial", element: "H", coordinates: "direct", position: [0.1, 0.1, 0.1] });
    const interstitial = inserted.structure.sites.at(-1)!;
    expect(interstitial.displayAtomNumber).toBe(65);
    expect(interstitial.sourceAtomNumber).toBeUndefined();
    const restored = apply(inserted, { type: "restore", defectId: inserted.defects.find(d => d.kind === "vacancy")!.id });
    expect(restored.structure.sites.find(site => site.siteId === highest.siteId)!.displayAtomNumber).toBe(64);
    expect(new Set(restored.structure.sites.map(site => site.displayAtomNumber)).size).toBe(65);
    const withoutInterstitial = apply(restored, { type: "restore", defectId: restored.defects.find(d => d.kind === "interstitial")!.id });
    expect(withoutInterstitial.structure.sites.map(site => site.displayAtomNumber)).toEqual(expanded.structure.sites.map(site => site.displayAtomNumber));
  });
  test("enabling constraints and inserting sites always produces complete selective dynamics", () => {
    const base = initial();
    base.structure.sites.forEach(site => delete site.selectiveDynamics);
    const constrained = apply(base, { type: "constraints", siteIds: [base.structure.sites[0]!.siteId], flags: [false, true, false] });
    expect(constrained.structure.sites.map(site => site.selectiveDynamics)).toEqual([[false, true, false], [true, true, true]]);
    const inserted = apply(constrained, { type: "interstitial", element: "H", coordinates: "direct", position: [0.5, 0.5, 0.5] });
    expect(inserted.structure.sites.map(site => site.selectiveDynamics)).toEqual([[false, true, false], [true, true, true], [true, true, true]]);
    const exported = createPoscar(inserted.structure, modelToScene(inserted), []);
    expect(validatePoscarText(exported.text).atomCount).toBe(3);
  });
  test("vacancy suspends a substitution and restores its current element plus substitution history", () => {
    const base = initial();
    const id = base.structure.sites[0]!.siteId;
    const substituted = apply(base, { type: "substitute", siteIds: [id], element: "Zn" });
    const vacancy = apply(substituted, { type: "vacancy", siteIds: [id] });
    expect(vacancy.defects).toHaveLength(1);
    expect(vacancy.defects[0]!.kind).toBe("vacancy");
    const restored = apply(vacancy, { type: "restore", defectId: vacancy.defects[0]!.id });
    expect(restored.structure).toEqual(substituted.structure);
    expect(restored.defects).toEqual(substituted.defects);
    const original = apply(restored, { type: "restore", defectId: restored.defects[0]!.id });
    expect(original.structure.species[original.structure.sites[0]!.speciesIndex]).toBe("Cu");
    expect(original.defects).toHaveLength(0);
    const expanded = apply(vacancy, { type: "supercell", repeat: [2, 1, 1] });
    const first = apply(expanded, { type: "restore", defectId: expanded.defects[0]!.id });
    const both = apply(first, { type: "restore", defectId: expanded.defects[1]!.id });
    expect(both.defects.every(d => d.kind === "substitution" && both.structure.sites.some(s => s.siteId === d.siteId))).toBe(true);
    expect(new Set(both.defects.map(d => d.id)).size).toBe(2);
  });
  test("centering translates vacancy snapshots and preserves periodic geometry", () => {
    const expanded = apply(initial(), { type: "supercell", repeat: [2, 2, 1] });
    const vacancy = apply(expanded, { type: "vacancy", siteIds: [expanded.structure.sites[0]!.siteId] });
    const centered = apply(vacancy, { type: "center", defectId: vacancy.defects[0]!.id });
    expect(centered.defects[0]!.fractionalPosition).toEqual([0.5, 0.5, 0.5]);
    expect(centered.defects[0]!.originalSite!.fractionalPosition).toEqual([0.5, 0.5, 0.5]);
    const delta = (s: ModelState) => s.structure.sites[0]!.fractionalPosition.map((v, i) => v - s.structure.sites[1]!.fractionalPosition[i]!);
    delta(centered).forEach((v, i) => expect(v - delta(vacancy)[i]! - Math.round(v - delta(vacancy)[i]!)).toBeCloseTo(0, 12));
  });
  test("finds skew-cell short images beyond rounded fractional coordinates", () => {
    const structure = { cell: { vectors: [[10, 0, 0], [29.9, 0.4, 0], [0, 0, 10]] as [number, number, number][] },
      species: ["Cu"], sites: [{ siteId: "a", speciesIndex: 0, fractionalPosition: [0, 0, 0] as [number, number, number] }] };
    const matrix = new Matrix3().set(10, 29.9, 0, 0, 0.4, 0, 0, 0, 10);
    expect(new Vector3(-3, 1, 0).applyMatrix3(matrix).length()).toBeLessThan(0.5);
    expect(inspectModelDistances(structure)).toHaveLength(1);
  });
  test("invalid geometry never mutates its input", () => {
    const base = initial();
    const snapshot = JSON.stringify(base);
    expect(() => apply(base, { type: "move", siteId: base.structure.sites[0]!.siteId, coordinates: "direct", position: [NaN, 0, 0] })).toThrow(ModelEditError);
    expect(() => apply(base, { type: "substitute", siteIds: [base.structure.sites[0]!.siteId], element: "XX" })).toThrow(ModelEditError);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
  test("supercell references follow the original Cartesian image, not its old offset in the larger cell", () => {
    const before = initial(), after = apply(before, { type: "supercell", repeat: [2, 1, 1] });
    const beforeScene = modelToScene(before), afterScene = modelToScene(after);
    const id = before.structure.sites[0]!.siteId;
    const snapshot: ModelReferenceSnapshot = { measurements: [{ id: "distance", kind: "distance", atomIds: [id, `${id}-image-1-0-0`] }],
      focus: { atomIds: [`${id}-image-1-0-0`], neighbors: true } };
    const mapped = mapModelReferences(snapshot, before, after, beforeScene, afterScene);
    expect(resolveMeasurement(beforeScene, snapshot.measurements[0]!)!.value).toBe(8);
    expect(resolveMeasurement(afterScene, mapped.measurements[0]!)!.value).toBe(8);
    expect(mapped.measurements[0]!.atomIds[1]).not.toBe(`${id}-image-1-0-0`);
    expect(mapped.focus!.atomIds[0]).toBe(mapped.measurements[0]!.atomIds[1]);
    expect(mergeModelReferences(mapped, snapshot, mapped)).toEqual(snapshot);
  });
  test("centering maps one rigid translation; undrawn images become unavailable instead of jumping", () => {
    const before = initial(), after = apply(before, { type: "center", siteId: before.structure.sites[1]!.siteId });
    const beforeScene = modelToScene(before), afterScene = modelToScene(after);
    const [a, b] = before.structure.sites.map(s => s.siteId) as [string, string];
    const snapshot: ModelReferenceSnapshot = { measurements: [{ id: "distance", kind: "distance", atomIds: [a, b] }], focus: null };
    const mapped = mapModelReferences(snapshot, before, after, beforeScene, afterScene);
    expect(resolveMeasurement(afterScene, mapped.measurements[0]!)!.value).toBeCloseTo(resolveMeasurement(beforeScene, snapshot.measurements[0]!)!.value, 10);
    const boundary: ModelReferenceSnapshot = { measurements: [{ id: "boundary", kind: "distance", atomIds: [a, `${a}-image-1-0-0`] }], focus: null };
    const cropped = { ...afterScene, atoms: afterScene.atoms.filter(atom => atom.position[0] < 8) };
    const unavailable = mapModelReferences(boundary, before, after, beforeScene, cropped);
    expect(resolveMeasurement(cropped, unavailable.measurements[0]!)).toBeNull();
    expect(cropped.atoms.some(atom => atom.id === unavailable.measurements[0]!.atomIds[1])).toBe(false);
  });
  test("unknown cell changes invalidate references, while ordinary vacancy preserves exact identity", () => {
    const before = initial(), scene = modelToScene(before);
    const ids = before.structure.sites.map(s => s.siteId) as [string, string];
    const snapshot: ModelReferenceSnapshot = { measurements: [{ id: "distance", kind: "distance", atomIds: ids }], focus: null };
    const removed = apply(before, { type: "vacancy", siteIds: [ids[0]] });
    expect(mapModelReferences(snapshot, before, removed, scene, modelToScene(removed))).toEqual(snapshot);
    const changed = structuredClone(before); changed.structure.cell.vectors[0]![1] = 1;
    const changedScene = modelToScene(changed);
    expect(resolveMeasurement(changedScene, mapModelReferences(snapshot, before, changed, scene, changedScene).measurements[0]!)).toBeNull();
  });
  test("reference replay keeps later additions, deletions, edits, and focus changes", () => {
    const target: ModelReferenceSnapshot = { measurements: [{ id: "owned", kind: "distance", atomIds: ["a", "b"] },
      { id: "deleted", kind: "distance", atomIds: ["a", "b"] }, { id: "edited", kind: "distance", atomIds: ["a", "b"] }], focus: null };
    const expected: ModelReferenceSnapshot = { measurements: target.measurements.map(m => ({ id: m.id, kind: "distance", atomIds: ["a", "mapped"] })), focus: null };
    const current: ModelReferenceSnapshot = { measurements: [expected.measurements[0]!, { id: "edited", kind: "distance", atomIds: ["a", "user-edit"] },
      { id: "new", kind: "distance", atomIds: ["b", "c"] }], focus: { atomIds: ["new-focus"], neighbors: false } };
    const replayed = mergeModelReferences(current, target, expected);
    expect(replayed.measurements.map(m => m.id)).toEqual(["owned", "edited", "new"]);
    expect(replayed.measurements[0]!.atomIds).toEqual(["a", "b"]);
    expect(replayed.measurements[1]!.atomIds).toEqual(["a", "user-edit"]);
    expect(replayed.focus).toEqual(current.focus);
  });
  test("undo restores historical image references without reconnecting later supercell annotations", () => {
    const before = initial(), after = apply(before, { type: "supercell", repeat: [2, 1, 1] });
    const beforeScene = modelToScene(before), afterScene = modelToScene(after);
    const id = before.structure.sites[0]!.siteId;
    const original: ModelReferenceSnapshot = { measurements: [{ id: "old", kind: "distance", atomIds: [id, `${id}-image-1-0-0`] }], focus: null };
    const expected = mapModelReferences(original, before, after, beforeScene, afterScene);
    const current: ModelReferenceSnapshot = { measurements: [...expected.measurements,
      { id: "new", kind: "distance", atomIds: [id, `${id}-image-1-0-0`] }], focus: { atomIds: [`${id}-image-1-0-0`], neighbors: false } };
    expect(resolveMeasurement(afterScene, current.measurements[1]!)!.value).toBe(16);
    const restored = transitionModelReferences(current, after, before, afterScene, beforeScene, { target: original, expected });
    expect(restored.measurements[0]!).toEqual(original.measurements[0]!);
    expect(resolveMeasurement(beforeScene, restored.measurements[0]!)!.value).toBe(8);
    expect(restored.measurements[1]!.id).toBe("new");
    expect(resolveMeasurement(beforeScene, restored.measurements[1]!)).toBeNull();
    expect(beforeScene.atoms.some(atom => atom.id === restored.focus!.atomIds[0])).toBe(false);
  });
});
