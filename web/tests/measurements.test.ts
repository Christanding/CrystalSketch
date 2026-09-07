import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { Quaternion } from "three";
import type { AtomSpec, BondSpec, SceneSpec } from "../src/api/scene";
import { useMeasurementTools, type MeasurementToolsSnapshot } from "../src/app/hooks/useMeasurementTools";
import { useSceneEdits } from "../src/app/hooks/useSceneEdits";
import { createStructureExportFile } from "../src/export/structureExportFile";
import { createCombinedExportFile } from "../src/export/combinedExportFile";
import type { CreateFigureExportOptions } from "../src/export/types";
import { parseWorkspacePreferences, serializeWorkspacePreferences, type WorkspacePreferences } from "../src/app/workspaceStorage";
import { createPreviewViewState } from "../src/app/viewState";
import {
  createDefaultBondVisibilityOverrides, createDefaultComponentOpacity, createDefaultComponentVisibility,
  createDefaultExportSettings, createDefaultStyle, DEFAULT_STRUCTURE_LINE_WIDTH, visibleSceneForComponents,
} from "../src/model";
import { EMPTY_SELECTION } from "../src/selection/SceneSelection";
import {
  filterSceneToAtomIds,
  findAtomsBySourceNumber,
  firstNeighborAtomIds,
  measurementIsDisplayed,
  resolveMeasurement,
  type SceneMeasurement,
} from "../src/model/measurements";

describe("scene measurements", () => {
  test("model reference replay reads live refs and does not undo later appearance or deleted annotations", () => {
    const scene = sceneWithAtoms([atom("a", [0, 0, 0]), atom("b", [1, 0, 0]), atom("c", [2, 0, 0])]);
    const initial: MeasurementToolsSnapshot = { measurements: [{ id: "pin", kind: "distance", atomIds: ["a", "b"] },
      { id: "removed", kind: "distance", atomIds: ["a", "b"] }], focus: { atomIds: ["b"], neighbors: false } };
    const { result, unmount } = renderHook(() => useMeasurementTools({ scene, visibleScene: scene, resetToken: 0,
      selection: EMPTY_SELECTION, select: () => {}, initial }));
    const before = result.current.getModelReferences();
    const mapped: MeasurementToolsSnapshot = { measurements: [{ id: "pin", kind: "distance", atomIds: ["a", "c"] },
      { id: "removed", kind: "distance", atomIds: ["a", "c"] }], focus: { atomIds: ["c"], neighbors: false } };
    act(() => {
      result.current.restoreModelReferences(mapped, before);
      expect(result.current.getModelReferences().measurements[0]!.atomIds).toEqual(["a", "c"]);
      result.current.removeMeasurement("removed");
      expect(result.current.getModelReferences().measurements).toHaveLength(1);
      result.current.setLabelStyle(style => ({ ...style, fontScale: 175, color: "#123456" }));
      result.current.exitFocus();
    });
    act(() => result.current.restoreModelReferences(before, mapped));
    expect(result.current.snapshot.measurements).toEqual([before.measurements[0]!]);
    expect(result.current.snapshot.focus).toBeNull();
    expect(result.current.labelStyle).toMatchObject({ fontScale: 175, color: "#123456" });
    unmount();
  });
  test("filters measurement types without deleting or altering saved definitions", () => {
    const measurements: SceneMeasurement[] = [
      { id: "d", kind: "distance", atomIds: ["a", "b"] },
      { id: "a", kind: "angle", atomIds: ["a", "b", "c"] },
    ];
    const before = JSON.stringify(measurements);
    const appearance = { color: "#333333", fontScale: 100, fontWeight: 300 as const, showLabels: true };
    expect(measurements.filter(item => measurementIsDisplayed(item))).toHaveLength(2);
    expect(measurements.filter(item => measurementIsDisplayed(item, { ...appearance, displayMode: "distance" })).map(item => item.id)).toEqual(["d"]);
    expect(measurements.filter(item => measurementIsDisplayed(item, { ...appearance, displayMode: "angle" })).map(item => item.id)).toEqual(["a"]);
    expect(measurements.filter(item => measurementIsDisplayed(item, { ...appearance, showLabels: false, displayMode: "all" }))).toHaveLength(2);
    expect(JSON.stringify(measurements)).toBe(before);
  });
  test("measures actual Cartesian positions in a skew cell without minimum-image wrapping", () => {
    const scene = sceneWithAtoms([
      atom("origin", [0, 0, 0], { siteId: "Cu-1" }),
      atom("image", [6, 2, 0], {
        siteId: "Cu-1", isPeriodicImage: true, imageOffset: [1, 1, 0],
        fractionalPosition: [1, 1, 0],
      }),
    ]);
    scene.cell.vectors = [[4, 0, 0], [2, 2, 0], [0, 0, 3]];
    const definition: SceneMeasurement = { id: "distance-1", kind: "distance", atomIds: ["origin", "image"] };
    const result = resolveMeasurement(scene, definition)!;
    expect(result.definition).toBe(definition);
    expect(result.points).toEqual([[0, 0, 0], [6, 2, 0]]);
    expect(result.value).toBeCloseTo(Math.sqrt(40), 12);
    expect(result.label).toBe("6.325 Å");
    expect(result.labelPosition).toEqual([3, 1, 0]);
  });

  test("uses the selected image as angle vertex even when all three atoms share a site", () => {
    const scene = sceneWithAtoms([
      atom("left", [0, 0, 0], { siteId: "Cu-1" }),
      atom("vertex", [4, 0, 0], { siteId: "Cu-1", isPeriodicImage: true, imageOffset: [1, 0, 0] }),
      atom("right", [6, 2, 0], { siteId: "Cu-1", isPeriodicImage: true, imageOffset: [1, 1, 0] }),
    ]);
    scene.cell.vectors = [[4, 0, 0], [2, 2, 0], [0, 0, 3]];
    const result = resolveMeasurement(scene, angle("left", "vertex", "right"))!;
    expect(result.value).toBeCloseTo(135, 12);
    expect(result.label).toBe("135.00°");
    expect(result.points[1]).toEqual([4, 0, 0]);
    expect(result.labelPosition[0]).toBeLessThan(4);
    expect(result.labelPosition[1]).toBeGreaterThan(0);
  });

  test("resolves a right angle with a label in its interior", () => {
    const scene = sceneWithAtoms([atom("a", [2, 0, 0]), atom("b", [0, 0, 0]), atom("c", [0, 3, 0])]);
    const result = resolveMeasurement(scene, angle("a", "b", "c"))!;
    expect(result.value).toBe(90);
    expect(result.label).toBe("90.00°");
    expect(result.labelPosition[0]).toBeCloseTo(0.6 / Math.sqrt(2), 12);
    expect(result.labelPosition[1]).toBeCloseTo(0.6 / Math.sqrt(2), 12);
    expect(result.labelPosition[2]).toBe(0);
  });

  test.each([
    [[1, 0, 0], [-2, 0, 0]],
    [[0, 1, 0], [0, -2, 0]],
    [[0, 0, 1], [0, 0, -2]],
    [[1, 2, 3], [-2, -4, -6]],
  ] as [AtomSpec["position"], AtomSpec["position"]][])("keeps straight angles and their labels finite for %p / %p", (a, c) => {
    const scene = sceneWithAtoms([atom("a", a), atom("b", [0, 0, 0]), atom("c", c)]);
    const result = resolveMeasurement(scene, angle("a", "b", "c"))!;
    expect(result.value).toBe(180);
    expect(result.label).toBe("180.00°");
    expect(result.labelPosition.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...result.labelPosition)).toBeGreaterThan(0);
    expect(result.labelPosition.reduce((sum, coordinate, index) => sum + coordinate * a[index]!, 0)).toBeCloseTo(0, 12);
  });

  test("formats a tetrahedral angle and permits distinct atoms on the same ray", () => {
    const scene = sceneWithAtoms([
      atom("a", [1, 1, 1]), atom("b", [0, 0, 0]), atom("c", [1, -1, -1]), atom("d", [2, 2, 2]),
    ]);
    expect(resolveMeasurement(scene, angle("a", "b", "c"))?.label).toBe("109.47°");
    expect(resolveMeasurement(scene, angle("a", "b", "d"))?.label).toBe("0.00°");
  });

  test("rejects missing or duplicate IDs, coincident endpoints, and non-finite positions", () => {
    const scene = sceneWithAtoms([
      atom("a", [1, 0, 0]), atom("b", [0, 0, 0]), atom("c", [0, 0, 0]), atom("bad", [NaN, 0, 0]),
    ]);
    const definitions: SceneMeasurement[] = [
      { id: "missing", kind: "distance", atomIds: ["a", "missing"] },
      { id: "duplicate", kind: "distance", atomIds: ["a", "a"] },
      { id: "zero", kind: "distance", atomIds: ["b", "c"] },
      { id: "non-finite", kind: "distance", atomIds: ["a", "bad"] },
      angle("a", "b", "a"), angle("c", "b", "a"), angle("a", "b", "c"),
    ];
    for (const definition of definitions) expect(resolveMeasurement(scene, definition)).toBeNull();
    scene.atoms.push(atom("a", [2, 0, 0]));
    expect(resolveMeasurement(scene, { id: "ambiguous", kind: "distance", atomIds: ["a", "b"] })).toBeNull();
  });
});

describe("atom source lookup and graph filtering", () => {
  test("finds native source numbers with originals first, preserving order and site-index fallback", () => {
    const scene = sceneWithAtoms([
      atom("image-first", [1, 0, 0], { sourceAtomNumber: 7, siteIndex: 6, isPeriodicImage: true }),
      atom("unrelated", [2, 0, 0], { sourceAtomNumber: 2, siteIndex: 7 }),
      atom("original", [0, 0, 0], { sourceAtomNumber: 7, siteIndex: 6 }),
      atom("image-second", [-1, 0, 0], { sourceAtomNumber: 7, siteIndex: 6, isPeriodicImage: true }),
      atom("legacy", [0, 1, 0], { siteIndex: 12 }),
    ]);
    expect(findAtomsBySourceNumber(scene, 7).map(value => value.id)).toEqual(["original", "image-first", "image-second"]);
    expect(findAtomsBySourceNumber(scene, 12).map(value => value.id)).toEqual(["legacy"]);
    expect(findAtomsBySourceNumber(scene, 6)).toEqual([]);
    expect(findAtomsBySourceNumber(scene, 1)).toEqual([]);
    expect(findAtomsBySourceNumber(scene, NaN)).toEqual([]);
    expect(scene.atoms[0]!.id).toBe("image-first");
  });

  test("expands exactly one graph hop from the original seeds in either bond direction", () => {
    const scene = sceneWithAtoms([atom("a", [0, 0, 0]), atom("b", [1, 0, 0]), atom("c", [2, 0, 0]), atom("nearby", [0.01, 0, 0])]);
    scene.bonds = [bond("ab", 0, 1), bond("bc", 1, 2)];
    const seeds = new Set(["a"]);
    expect(firstNeighborAtomIds(scene, seeds)).toEqual(new Set(["a", "b"]));
    expect(firstNeighborAtomIds(scene, new Set(["c"]))).toEqual(new Set(["c", "b"]));
    expect(firstNeighborAtomIds(scene, new Set(["b"]))).toEqual(new Set(["a", "b", "c"]));
    expect(firstNeighborAtomIds(scene, new Set())).toEqual(new Set());
    expect(seeds).toEqual(new Set(["a"]));
  });

  test("reindexes bonds and polyhedra while preserving source metadata, face-local indices, and extra fields", () => {
    const source = { filename: "POSCAR", atomCount: 5 };
    const retainedBond = { ...bond("retained", 2, 4), customBond: "retained" };
    const retainedPolyhedron = {
      centerAtomIndex: 2, hullAtomIndices: [2, 3, 4], faces: [[0, 1, 2] as [number, number, number]],
      visibilityDependencies: [], visibilityDependencyGroups: [], customPolyhedron: "retained",
    };
    const scene = {
      ...sceneWithAtoms(Array.from({ length: 5 }, (_, index) => atom(`a${index}`, [index, 0, 0], { sourceAtomNumber: 10 + index }))),
      source,
      bonds: [bond("removed", 0, 1), retainedBond],
      polyhedra: [
        { centerAtomIndex: 0, hullAtomIndices: [0, 1, 2], faces: [[0, 1, 2] as [number, number, number]], visibilityDependencies: [], visibilityDependencyGroups: [] },
        retainedPolyhedron,
      ],
    } satisfies SceneSpec & { source: typeof source };
    const summary = scene.summary;
    const originalFaces = scene.polyhedra[1]!.faces;
    const filtered = filterSceneToAtomIds(scene, new Set(["a2", "a3", "a4"])) as typeof scene;
    expect(filtered.atoms.map(value => value.sourceAtomNumber)).toEqual([12, 13, 14]);
    expect(filtered.atoms[0]).toBe(scene.atoms[2]!);
    expect(filtered.bonds).toEqual([{ ...scene.bonds[1]!, startAtomIndex: 0, endAtomIndex: 2 }]);
    expect(filtered.polyhedra).toEqual([{ ...scene.polyhedra[1]!, centerAtomIndex: 0, hullAtomIndices: [0, 1, 2] }]);
    expect(filtered.polyhedra[0]!.faces).toBe(originalFaces);
    expect(filtered.summary).toBe(summary);
    expect(filtered.summary.atomCount).toBe(5);
    expect(filtered.source).toBe(source);
    expect(scene.atoms).toHaveLength(5);
    expect(scene.bonds[1]!.startAtomIndex).toBe(2);
    expect(scene.polyhedra[1]!.hullAtomIndices).toEqual([2, 3, 4]);
    expect(filterSceneToAtomIds(scene, new Set(scene.atoms.map(value => value.id)))).toBe(scene);
  });

  test("drops incomplete polyhedra and allows filtering to an empty display", () => {
    const scene = sceneWithAtoms([atom("a", [0, 0, 0]), atom("b", [1, 0, 0]), atom("c", [0, 1, 0])]);
    scene.bonds = [bond("ab", 0, 1)];
    scene.polyhedra = [{ centerAtomIndex: 0, hullAtomIndices: [0, 1, 2], faces: [[0, 1, 2]], visibilityDependencies: [], visibilityDependencyGroups: [] }];
    expect(filterSceneToAtomIds(scene, new Set(["a", "b"])).polyhedra).toEqual([]);
    const filtered = filterSceneToAtomIds(scene, new Set());
    expect(filtered.atoms).toEqual([]);
    expect(filtered.bonds).toEqual([]);
    expect(filtered.polyhedra).toEqual([]);
    expect(filtered.summary).toBe(scene.summary);
  });
});

describe("measurement state and export integration", () => {
  test("round-trips exact periodic image IDs and focus through workspace storage, accepting older workspaces", () => {
    const state: WorkspacePreferences = {
      version: 1, sessionId: "measurement-workspace",
      appearance: {
        style: createDefaultStyle(), componentVisibility: createDefaultComponentVisibility(),
        componentOpacity: createDefaultComponentOpacity(), bondVisibilityOverrides: createDefaultBondVisibilityOverrides(),
        previewMeshQuality: "high", unitCellLineStyle: "solid", structureLineWidth: DEFAULT_STRUCTURE_LINE_WIDTH,
        showCrystalAxisLabels: true,
      },
      edits: { deleted: { atoms: [], bonds: [] }, history: [] },
      viewState: createPreviewViewState(), viewScale: 1, exportSettings: createDefaultExportSettings(),
      measurementTools: {
        appearance: { color: "#2e5d8a", fontScale: 150, fontWeight: 300, showLabels: false, displayMode: "angle" },
        measurements: [{ id: "image-measurement", kind: "distance", atomIds: ["Cu-0", "Cu-0-image-1-0--1"] }],
        focus: { atomIds: ["Cu-0-image-1-0--1"], neighbors: true },
      },
    };
    expect(parseWorkspacePreferences(serializeWorkspacePreferences(state))!.measurementTools).toEqual(state.measurementTools);
    expect(parseWorkspacePreferences(serializeWorkspacePreferences({ ...state, measurementTools: undefined }))!.measurementTools).toBeUndefined();
  });

  test("retains a saved image measurement through hiding, deletion, undo, and metadata changes", () => {
    const scene = periodicScene("boundary");
    const definition: SceneMeasurement = { id: "saved-image", kind: "distance", atomIds: ["original", "image"] };
    const initial: MeasurementToolsSnapshot = { measurements: [definition], focus: null };
    const { result, rerender } = renderHook(({ data, boundaryAtoms, token }) => {
      const editing = useSceneEdits(data, token);
      const tools = useMeasurementTools({
        scene: editing.scene,
        visibleScene: visibleSceneForComponents(editing.scene, { ...createDefaultComponentVisibility(), boundaryAtoms }),
        resetToken: token, selection: EMPTY_SELECTION, select() {}, initial,
      });
      return { editing, tools };
    }, { initialProps: { data: scene, boundaryAtoms: true, token: 0 } });
    expect(result.current.tools.resolvedMeasurements[0]!.resolved?.value).toBe(1);
    rerender({ data: scene, boundaryAtoms: false, token: 0 });
    expect(result.current.tools.snapshot.measurements).toEqual([definition]);
    expect(resolveMeasurement(result.current.tools.previewScene!, definition)).toBeNull();
    rerender({ data: scene, boundaryAtoms: true, token: 0 });
    expect(resolveMeasurement(result.current.tools.previewScene!, definition)?.value).toBe(1);
    act(() => result.current.editing.deleteObjects({ atoms: new Set(["image"]), bonds: new Set() }));
    expect(result.current.tools.snapshot.measurements).toEqual([definition]);
    expect(result.current.tools.resolvedMeasurements[0]!.resolved).toBeNull();
    act(() => { expect(result.current.editing.undoDeletion()).toBe(true); });
    expect(result.current.tools.resolvedMeasurements[0]!.resolved?.points[1]).toEqual([1, 0, 0]);
    rerender({ data: { ...scene, summary: { ...scene.summary, formula: "Cu2" } }, boundaryAtoms: true, token: 0 });
    expect(result.current.tools.snapshot.measurements).toEqual([definition]);
    rerender({ data: scene, boundaryAtoms: true, token: 1 });
    expect(result.current.tools.snapshot).toEqual({ measurements: [], focus: null,
      appearance: { color: "#333333", fontScale: 100, fontWeight: 400, showLabels: true, displayMode: "all" } });
  });

  test("restores focus, pins only completed drafts, and does not repeatedly reset a new session", () => {
    const scene = periodicScene("boundary");
    const initial: MeasurementToolsSnapshot = { measurements: [], focus: { atomIds: ["image"], neighbors: false } };
    const { result, rerender } = renderHook(({ token }) => useMeasurementTools({
      scene, visibleScene: scene, resetToken: token, selection: EMPTY_SELECTION, select() {}, initial,
    }), { initialProps: { token: 0 } });
    expect(result.current.previewScene?.atoms.map(atom => atom.id)).toEqual(["image"]);
    rerender({ token: 1 });
    expect(result.current.focus).toBeNull();
    act(() => result.current.setTool("distance"));
    act(() => result.current.pickAtom("original"));
    expect(result.current.canPin).toBe(false);
    act(() => result.current.pickAtom("image"));
    expect(result.current.currentMeasurement?.value).toBe(1);
    expect(result.current.previewScene?.measurements).toHaveLength(1);
    expect(result.current.exportScene?.measurements).toEqual([]);
    expect(result.current.exportVisibleScene?.measurements).toEqual([]);
    act(() => result.current.pinMeasurement());
    expect(result.current.snapshot.measurements[0]!.atomIds).toEqual(["original", "image"]);
    expect(result.current.exportScene?.measurements).toHaveLength(1);
    expect(result.current.exportVisibleScene?.measurements).toEqual(result.current.snapshot.measurements);
    expect(result.current.draft).toBeNull();
    act(() => result.current.pickAtom("original"));
    expect(result.current.draftAtoms).toHaveLength(1);
    act(() => result.current.setTool("inspect"));
    expect(result.current.tool).toBe("inspect");
    expect(result.current.draftAtoms).toHaveLength(0);
    expect(result.current.previewScene?.measurements).toEqual(result.current.snapshot.measurements);
    expect(result.current.exportScene?.measurements).toHaveLength(1);
    rerender({ token: 1 });
    expect(result.current.snapshot.measurements).toHaveLength(1);
  });

  test.each(["boundary", "bonded"] as const)("keeps an isolated %s image identical in preview and export scenes", reason => {
    const scene = periodicScene(reason);
    const visibility = { ...createDefaultComponentVisibility(), oneHopBondedAtoms: true, hideUnbondedBoundary: true };
    const visibleScene = visibleSceneForComponents(scene, visibility);
    const { result } = renderHook(() => useMeasurementTools({
      scene, visibleScene, resetToken: 0, selection: EMPTY_SELECTION, select() {},
      initial: { measurements: [], focus: { atomIds: ["image"], neighbors: false } },
    }));
    expect(result.current.previewScene?.atoms.map(atom => atom.id)).toEqual(["image"]);
    expect(result.current.exportVisibleScene?.atoms).toBe(result.current.previewScene!.atoms);
    expect(result.current.exportVisibleScene?.bonds).toBe(result.current.previewScene!.bonds);
    expect(result.current.exportScene?.atoms).toBe(scene.atoms);
    expect(result.current.exportScene?.bonds).toBe(scene.bonds);
    // Reapplying visibility after focus loses the original atom that justified this image.
    expect(visibleSceneForComponents(result.current.exportVisibleScene, visibility)!.atoms).toEqual([]);
  });

  test("rejects an explicitly unavailable export scene before rendering instead of falling back to the source", async () => {
    const scene = periodicScene("boundary");
    const options = { ...exportOptions(scene), visibleSceneOverride: null };
    await expect(createStructureExportFile(options)).rejects.toThrow("No structure is available to export.");
    await expect(createCombinedExportFile(options)).rejects.toThrow("No structure is available to export.");
  });
});

function periodicScene(reason: "boundary" | "bonded"): SceneSpec {
  const dependency = reason === "boundary" ? "boundaryAtoms" : "oneHopBondedAtoms";
  return {
    ...sceneWithAtoms([
      atom("original", [0, 0, 0], { siteId: "Cu-1", sourceAtomNumber: 1 }),
      atom("image", [1, 0, 0], {
        siteId: "Cu-1", sourceAtomNumber: 1, isPeriodicImage: true, imageOffset: [1, 0, 0],
        imageReasons: [reason], visibilityDependencies: [dependency], visibilityDependencyGroups: [[dependency]],
      }),
    ]),
    sourceFormat: "vasp",
    bonds: [bond("original-image", 0, 1)],
  };
}

function exportOptions(scene: SceneSpec): CreateFigureExportOptions {
  return {
    scene, cameraOrientationRef: { current: new Quaternion() }, fileName: "POSCAR", lightStrength: 100,
    bondVisibilityOverrides: createDefaultBondVisibilityOverrides(),
    componentVisibility: createDefaultComponentVisibility(), componentOpacity: createDefaultComponentOpacity(),
    settings: createDefaultExportSettings(), style: createDefaultStyle(), showCrystalAxisLabels: true,
    structureLineWidth: DEFAULT_STRUCTURE_LINE_WIDTH, unitCellLineStyle: "solid",
  };
}

function angle(a: string, vertex: string, c: string): SceneMeasurement {
  return { id: "angle", kind: "angle", atomIds: [a, vertex, c] };
}

function atom(id: string, position: AtomSpec["position"], overrides: Partial<AtomSpec> = {}): AtomSpec {
  return {
    id, siteId: id, siteIndex: 0, element: "Cu", position, fractionalPosition: [0, 0, 0],
    imageOffset: [0, 0, 0], isPeriodicImage: false, imageReasons: [],
    visibilityDependencies: [], visibilityDependencyGroups: [], ...overrides,
  };
}

function bond(id: string, startAtomIndex: number, endAtomIndex: number): BondSpec {
  return {
    id, relationId: id, familyKey: "Cu-Cu", startSiteId: `a${startAtomIndex}`, endSiteId: `a${endAtomIndex}`,
    startImageOffset: [0, 0, 0], endImageOffset: [0, 0, 0], relativeImageOffset: [0, 0, 0], length: 1,
    startAtomIndex, endAtomIndex, visibilityDependencies: [], visibilityDependencyGroups: [],
  };
}

function sceneWithAtoms(atoms: AtomSpec[]): SceneSpec {
  return {
    atoms, bonds: [], bondFamilies: [], polyhedra: [],
    cell: { vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    summary: {
      formula: "Cu", atomCount: atoms.length,
      cell: { a: "1", b: "1", c: "1", alpha: "90", beta: "90", gamma: "90" },
      symmetry: { available: false, spaceGroup: null, spaceGroupNumber: null, pointGroup: null,
        pointGroupSchoenflies: null, crystalSystem: null, latticeSystem: null },
    },
  };
}
