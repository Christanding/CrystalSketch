import { describe, expect, test } from "bun:test";
import type { SceneSpec } from "../src/api/scene";
import { parseVaspScene } from "../src/api/vasp";
import { createDefaultComponentVisibility, visibleSceneForComponents } from "../src/model/displayState";
import { filterSceneToAtomIds } from "../src/model/measurements";
import { createDefaultObjectStyleState, visibleSceneForObjectStyles } from "../src/model/objectStyles";
import {
  classifyAutoPolyhedronAvailability,
  DEFAULT_POLYHEDRON_DISPLAY,
  isPolyhedronDisplayState,
  MAX_POLYHEDRON_CENTERS,
  preparePolyhedronDisplay,
} from "../src/model/polyhedronDisplay";
import { applySceneDeletions } from "../src/model/sceneEdits";

const gamma = `gamma-CuI
1
6.05 0 0
0 6.05 0
0 0 6.05
Cu I
4 4
Direct
0 0 0
0 .5 .5
.5 0 .5
.5 .5 0
.25 .25 .25
.25 .75 .75
.75 .25 .75
.75 .75 .25`;

const planar = "planar\n1\n10 0 0\n0 10 0\n0 0 10\nNi O\n1 4\nDirect\n.5 .5 .5\n.3 .5 .5\n.7 .5 .5\n.5 .3 .5\n.5 .7 .5";

function selected(scene: SceneSpec, ...centerAtomIds: string[]) {
  return preparePolyhedronDisplay(scene, { mode: "selected", centerAtomIds });
}

describe("polyhedron center selection", () => {
  test("keeps automatic scene identity and reuses an existing exact center without mutating the source", () => {
    const scene = parseVaspScene(gamma);
    const before = JSON.stringify(scene);
    expect(preparePolyhedronDisplay(scene, DEFAULT_POLYHEDRON_DISPLAY)).toEqual({
      scene, requested: 14, generated: 14, issues: [],
    });
    expect(preparePolyhedronDisplay(scene, DEFAULT_POLYHEDRON_DISPLAY).scene).toBe(scene);
    const center = scene.atoms[scene.polyhedra[0]!.centerAtomIndex]!;
    const result = selected(scene, center.id, center.id);
    expect(result).toMatchObject({ requested: 1, generated: 1, issues: [] });
    expect(result.scene.polyhedronAtoms).toBe(scene.atoms);
    expect(result.scene.atoms).toBe(scene.atoms);
    expect(result.scene.bonds).toBe(scene.bonds);
    expect(result.scene.polyhedra[0]).toBe(scene.polyhedra[0]);
    expect(JSON.stringify(scene)).toBe(before);
  });

  test("allows iodine and same-element centers using only their existing bonds", () => {
    const scene = parseVaspScene(gamma);
    const iodine = scene.atoms.find(atom => !atom.isPeriodicImage && atom.element === "I")!;
    const result = selected(scene, iodine.id);
    expect(result.generated).toBe(1);
    expect(result.scene.polyhedra[0]!.faces).toHaveLength(4);
    expect(scene.polyhedra.some(polyhedron => scene.atoms[polyhedron.centerAtomIndex]!.id === iodine.id)).toBe(false);

    const copper = parseVaspScene("Cu\n1\n1.5 0 0\n0 1.5 0\n0 0 1.5\nCu\n1\nDirect\n.5 .5 .5", {
      "Cu|Cu": { min: .4, max: 1.6 },
    });
    expect(copper.polyhedra).toHaveLength(0);
    const octahedron = selected(copper, copper.atoms[0]!.id);
    expect(octahedron.generated).toBe(1);
    expect(octahedron.scene.polyhedra[0]!.faces).toHaveLength(8);
    expect(octahedron.scene.bonds).toBe(copper.bonds);
  });

  test("pins an exact boundary image and rejects outer one-hop images with incomplete coordination", () => {
    const scene = parseVaspScene(gamma);
    const boundary = scene.atoms.find(atom => atom.imageReasons.includes("boundary"))!;
    const outer = scene.atoms.find(atom => atom.isPeriodicImage && !atom.imageReasons.includes("boundary"))!;
    const result = selected(scene, boundary.id, outer.id, "removed-id");
    expect(result.generated).toBe(1);
    expect(result.scene.polyhedronAtoms![result.scene.polyhedra[0]!.centerAtomIndex]).toBe(boundary);
    expect(result.issues).toEqual([
      { centerAtomId: outer.id, reason: "incomplete-coordination", neighborCount: expect.any(Number) },
      { centerAtomId: "removed-id", reason: "missing-center", neighborCount: 0 },
    ]);
  });

  test("reports planar geometry and distinct-neighbor shortages without inventing faces", () => {
    const scene = parseVaspScene(planar);
    expect(selected(scene, scene.atoms[0]!.id).issues).toEqual([
      { centerAtomId: scene.atoms[0]!.id, reason: "degenerate", neighborCount: 4 },
    ]);
    const three = { ...scene, bonds: [...scene.bonds.slice(0, 3), scene.bonds[0]!] };
    expect(selected(three, scene.atoms[0]!.id)).toMatchObject({ generated: 0, issues: [
      { centerAtomId: scene.atoms[0]!.id, reason: "too-few-neighbors", neighborCount: 3 },
    ] });
  });

  test("keeps selected geometry indexed to raw coordinates while atom, element and periodic visibility hide spheres and bonds", () => {
    const scene = parseVaspScene(gamma);
    const boundary = scene.atoms.find(atom => atom.imageReasons.includes("boundary"))!;
    const prepared = selected(scene, boundary.id).scene;
    const defaults = createDefaultComponentVisibility(scene);
    const visible = visibleSceneForComponents(prepared, { ...defaults,
      boundaryAtoms: false, oneHopBondedAtoms: false, atoms: false, polyhedra: true,
    })!;
    expect(visible.atoms.every(atom => !atom.isPeriodicImage)).toBe(true);
    expect(visible.atoms).toHaveLength(8);
    expect(visible.polyhedra).toBe(prepared.polyhedra);
    expect(visible.polyhedronAtoms).toBe(scene.atoms);
    expect(visible.polyhedronAtoms![visible.polyhedra[0]!.centerAtomIndex]).toBe(boundary);
    const hidden = visibleSceneForObjectStyles(visible, { ...createDefaultObjectStyleState(),
      elementOverrides: { I: { visible: false } }, atomOverrides: { [scene.atoms[0]!.siteId]: { visible: false } },
    });
    expect(hidden.atoms.every(atom => atom.element !== "I")).toBe(true);
    expect(hidden.bonds).toHaveLength(0);
    expect(hidden.polyhedra).toBe(prepared.polyhedra);
    expect(hidden.polyhedronAtoms).toBe(scene.atoms);
    expect(visibleSceneForComponents(prepared, { ...defaults, polyhedra: false })!.polyhedra).toEqual([]);
  });

  test("real bond or atom deletion removes coordination; undo and raw regeneration recover it", () => {
    const scene = parseVaspScene(gamma);
    const polyhedron = scene.polyhedra[0]!;
    const center = scene.atoms[polyhedron.centerAtomIndex]!;
    const coordinationBond = scene.bonds.find(bond => bond.startAtomIndex === polyhedron.centerAtomIndex
      || bond.endAtomIndex === polyhedron.centerAtomIndex)!;
    const edited = applySceneDeletions(scene, { atoms: new Set(), bonds: new Set([coordinationBond.id]) })!;
    expect(selected(edited, center.id)).toMatchObject({ generated: 0, issues: [
      { centerAtomId: center.id, reason: "too-few-neighbors", neighborCount: 3 },
    ] });
    const prepared = selected(scene, center.id).scene;
    expect(applySceneDeletions(prepared, { atoms: new Set(), bonds: new Set([coordinationBond.id]) })!.polyhedra).toEqual([]);
    expect(applySceneDeletions(prepared, { atoms: new Set([center.id]), bonds: new Set() })!.polyhedra).toEqual([]);
    const withoutCenter = applySceneDeletions(scene, { atoms: new Set([center.id]), bonds: new Set() })!;
    expect(selected(withoutCenter, center.id).issues[0]!.reason).toBe("missing-center");
    expect(selected(scene, center.id).generated).toBe(1);
  });

  test("preserves independent indices through unrelated deletion and filters measurement focus by raw atom IDs", () => {
    const scene = parseVaspScene(gamma);
    const boundary = scene.atoms.find(atom => atom.imageReasons.includes("boundary"))!;
    const prepared = selected(scene, boundary.id).scene;
    const polyhedron = prepared.polyhedra[0]!;
    const keepIds = new Set(polyhedron.hullAtomIndices.map(index => scene.atoms[index]!.id));
    const unrelated = scene.atoms.find(atom => !keepIds.has(atom.id))!;
    const edited = applySceneDeletions(prepared, { atoms: new Set([unrelated.id]), bonds: new Set() })!;
    expect(edited.polyhedra[0]).toBe(polyhedron);
    expect(edited.polyhedronAtoms).toBe(scene.atoms);
    const visible = visibleSceneForComponents(prepared, { ...createDefaultComponentVisibility(scene),
      boundaryAtoms: false, polyhedra: true,
    })!;
    const focused = filterSceneToAtomIds(visible, keepIds);
    expect(focused.polyhedra[0]).toBe(polyhedron);
    expect(focused.polyhedronAtoms).toBe(scene.atoms);
    expect(focused.summary).toBe(scene.summary);
    expect(filterSceneToAtomIds(visible, new Set(visible.atoms.map(atom => atom.id))).polyhedra).toEqual([]);
    expect(filterSceneToAtomIds(visible, new Set()).polyhedra).toEqual([]);
  });

  test("resolves real deletion by IDs when visible bond indices differ from independent hull indices", () => {
    const scene = parseVaspScene(gamma);
    const center = scene.atoms.filter(atom => !atom.isPeriodicImage && atom.element === "Cu")[1]!;
    const prepared = selected(scene, center.id).scene;
    const visible = visibleSceneForComponents(prepared, { ...createDefaultComponentVisibility(scene),
      boundaryAtoms: false, oneHopBondedAtoms: true, polyhedra: true,
    })!;
    const centerIndex = visible.atoms.findIndex(atom => atom.id === center.id);
    expect(centerIndex).not.toBe(visible.polyhedra[0]!.centerAtomIndex);
    const bond = visible.bonds.find(bond => bond.startAtomIndex === centerIndex || bond.endAtomIndex === centerIndex)!;
    expect(applySceneDeletions(visible, { atoms: new Set(), bonds: new Set([bond.id]) })!.polyhedra).toEqual([]);
    const hiddenImages = visibleSceneForComponents(prepared, { ...createDefaultComponentVisibility(scene),
      boundaryAtoms: false, oneHopBondedAtoms: false, polyhedra: true,
    })!;
    const hiddenNeighbor = prepared.polyhedra[0]!.hullAtomIndices.map(index => scene.atoms[index]!)
      .find(atom => !hiddenImages.atoms.some(visibleAtom => visibleAtom.id === atom.id))!;
    expect(hiddenNeighbor).toBeDefined();
    expect(applySceneDeletions(hiddenImages, { atoms: new Set([hiddenNeighbor.id]), bonds: new Set() })!.polyhedra).toEqual([]);
  });

  test("does not reuse stale faces when the supplied raw graph changes", () => {
    const scene = parseVaspScene(gamma);
    const polyhedron = scene.polyhedra[0]!;
    const center = scene.atoms[polyhedron.centerAtomIndex]!;
    const neighbor = scene.atoms.findIndex((_, index) => !polyhedron.hullAtomIndices.includes(index));
    const originalBond = scene.bonds.find(bond => bond.startAtomIndex === polyhedron.centerAtomIndex)!;
    const changed = { ...scene, bonds: [...scene.bonds, { ...originalBond,
      id: "added-coordination", endAtomIndex: neighbor,
    }] };
    const result = selected(changed, center.id);
    expect(result.scene.polyhedra[0]).not.toBe(polyhedron);
    expect(result.scene.polyhedra[0]!.hullAtomIndices).toContain(neighbor);
  });
});

describe("polyhedron availability and persisted state", () => {
  test("distinguishes deferred, no-bond, low coordination, species-filtered and unclassified geometry", () => {
    const scene = parseVaspScene(gamma);
    expect(classifyAutoPolyhedronAvailability(scene)).toBe("available");
    expect(classifyAutoPolyhedronAvailability({ ...scene, connectivity: "deferred" })).toBe("deferred");
    expect(classifyAutoPolyhedronAvailability({ ...scene, bonds: [], polyhedra: [] })).toBe("no-bonds");
    expect(classifyAutoPolyhedronAvailability({ ...scene, bonds: scene.bonds.slice(0, 1), polyhedra: [] })).toBe("insufficient-coordination");
    const copper = parseVaspScene("Cu\n1\n1.5 0 0\n0 1.5 0\n0 0 1.5\nCu\n1\nDirect\n.5 .5 .5");
    expect(classifyAutoPolyhedronAvailability(copper)).toBe("automatic-center-filter");
    expect(classifyAutoPolyhedronAvailability({ ...copper, sourceFormat: undefined })).toBe("degenerate-or-unavailable");
    expect(classifyAutoPolyhedronAvailability(parseVaspScene(planar))).toBe("degenerate-or-unavailable");
  });

  test("accepts exact stable IDs and rejects malformed, duplicate, empty or over-limit selections", () => {
    expect(isPolyhedronDisplayState({ mode: "auto" })).toBe(true);
    expect(isPolyhedronDisplayState({ mode: "selected", centerAtomIds: ["site-1", "site-1-image-1-0-0"] })).toBe(true);
    for (const invalid of [null, {}, { mode: "other" }, { mode: "selected" },
      { mode: "selected", centerAtomIds: [] }, { mode: "selected", centerAtomIds: [1] },
      { mode: "selected", centerAtomIds: [""] }, { mode: "selected", centerAtomIds: ["  "] },
      { mode: "selected", centerAtomIds: ["a", "a"] },
      { mode: "selected", centerAtomIds: Array.from({ length: MAX_POLYHEDRON_CENTERS + 1 }, (_, index) => String(index)) },
    ]) expect(isPolyhedronDisplayState(invalid)).toBe(false);
  });
});
