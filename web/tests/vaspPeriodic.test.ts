import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { Vector3 } from "three";

import { parseVaspScene } from "../src/api/vasp";
import { useSceneEdits } from "../src/app/hooks/useSceneEdits";
import { createDefaultComponentVisibility, visibleSceneForComponents } from "../src/model/displayState";
import { applySceneDeletions } from "../src/model/sceneEdits";
import { EMPTY_SELECTION } from "../src/selection/SceneSelection";

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

describe("VASP periodic coordination", () => {
  test("adds only one-hop neighbors and complete Cu-centered tetrahedra, with unchanged defaults", () => {
    const scene = parseVaspScene(gamma);
    expect(scene.summary.atomCount).toBe(8);
    expect(scene.atoms).toHaveLength(46);
    expect(scene.bonds).toHaveLength(56);
    expect(scene.polyhedra).toHaveLength(14);
    expect(new Set(scene.atoms.map(atom => atom.id)).size).toBe(46);
    const defaults = createDefaultComponentVisibility(scene);
    expect(visibleSceneForComponents(scene, defaults)!.atoms).toHaveLength(18);
    expect(visibleSceneForComponents(scene, defaults)!.bonds).toHaveLength(16);
    expect(visibleSceneForComponents(scene, { ...defaults, polyhedra: true })!.polyhedra).toHaveLength(0);
    expect(visibleSceneForComponents(scene, { ...defaults, oneHopBondedAtoms: true, polyhedra: true })!.polyhedra).toHaveLength(14);
    expect(visibleSceneForComponents(scene, { ...defaults, boundaryAtoms: false, oneHopBondedAtoms: true, polyhedra: true })!.polyhedra).toHaveLength(4);
    for (const bond of scene.bonds) {
      expect(bond.startAtomIndex < 18 || bond.endAtomIndex < 18).toBe(true);
      expect(bond.length).toBeCloseTo(6.05 * Math.sqrt(3) / 4, 10);
      expect(scene.atoms[bond.startAtomIndex]!.siteId).toBe(bond.startSiteId);
      expect(scene.atoms[bond.endAtomIndex]!.siteId).toBe(bond.endSiteId);
    }
    for (const polyhedron of scene.polyhedra) {
      expect(scene.atoms[polyhedron.centerAtomIndex]!.element).toBe("Cu");
      expect(polyhedron.hullAtomIndices).toHaveLength(5);
      expect(polyhedron.faces).toHaveLength(4);
      const center = new Vector3(...scene.atoms[polyhedron.centerAtomIndex]!.position);
      for (const face of polyhedron.faces) {
        const [a, b, c] = face.map(index => new Vector3(...scene.atoms[polyhedron.hullAtomIndices[index]!]!.position)) as [Vector3, Vector3, Vector3];
        const normal = b.clone().sub(a).cross(c.clone().sub(a));
        expect(normal.dot(a.clone().sub(center))).toBeGreaterThan(0);
      }
    }
    const image = scene.atoms.find(atom => atom.imageReasons.includes("bonded") && !atom.imageReasons.includes("boundary"))!;
    expect(image.sourceAtomNumber).toBe(image.siteIndex + 1);
  });

  test("finds periodic neighbors in a skew cell against an independent exhaustive search", () => {
    const vectors = [[2, 0, 0], [3.8, .4, 0], [0, 0, 8]];
    const scene = parseVaspScene(`skew\n1\n${vectors.map(v => v.join(" ")).join("\n")}\nCu I\n1 1\nDirect\n.13 .27 .5\n.38 .73 .5`, {
      "Cu|Cu": { min: 0, max: 0 }, "I|I": { min: 0, max: 0 }, "Cu|I": { min: .4, max: 1.1 },
    });
    expect(scene.atoms.some(atom => atom.imageOffset.some(value => Math.abs(value) > 1))).toBe(true);
    for (let sourceIndex = 0; sourceIndex < 2; sourceIndex++) {
      const source = scene.atoms[sourceIndex]!;
      const target = scene.atoms[1 - sourceIndex]!;
      const expected = new Set<string>();
      for (let a = -8; a <= 8; a++) for (let b = -8; b <= 8; b++) for (let c = -1; c <= 1; c++) {
        const offset = [a, b, c];
        const position = new Vector3(...target.position);
        vectors.forEach((vector, axis) => position.addScaledVector(new Vector3(...vector), offset[axis]!));
        const distance = position.distanceTo(new Vector3(...source.position));
        if (distance > .4 && distance < 1.1) expected.add(offset.join(","));
      }
      const actual = new Set(scene.bonds.filter(bond => bond.startAtomIndex === sourceIndex || bond.endAtomIndex === sourceIndex)
        .map(bond => scene.atoms[bond.startAtomIndex === sourceIndex ? bond.endAtomIndex : bond.startAtomIndex]!.imageOffset.join(",")));
      expect(actual).toEqual(expected);
    }
  });

  test("includes same-site images beyond adjacent cells but does not recursively extend them", () => {
    const scene = parseVaspScene("small\n1\n1.5 0 0\n0 1.5 0\n0 0 1.5\nCu\n1\nDirect\n.5 .5 .5");
    expect(scene.atoms.some(atom => atom.imageOffset.join(",") === "2,0,0")).toBe(true);
    expect(scene.bonds.every(bond => bond.startAtomIndex === 0)).toBe(true);
    expect(scene.polyhedra).toHaveLength(0);
  });

  test("generates an octahedron, skips planar coordination, and recomputes after cutoff changes", () => {
    const planar = "planar\n1\n10 0 0\n0 10 0\n0 0 10\nNi O\n1 4\nDirect\n.5 .5 .5\n.3 .5 .5\n.7 .5 .5\n.5 .3 .5\n.5 .7 .5";
    expect(parseVaspScene(planar).polyhedra).toHaveLength(0);
    const octahedron = planar.replace("1 4", "1 6") + "\n.5 .5 .3\n.5 .5 .7";
    const scene = parseVaspScene(octahedron);
    expect(scene.polyhedra).toHaveLength(1);
    expect(scene.polyhedra[0]!.faces).toHaveLength(8);
    expect(parseVaspScene(octahedron, {}, .8).polyhedra).toHaveLength(0);
    expect(parseVaspScene(octahedron, { "Ni|O": { min: 0, max: 1.9 } }).polyhedra).toHaveLength(0);
    expect(parseVaspScene(gamma, {}, .8).atoms).toHaveLength(18);
  });

  test("deleting coordination atoms or bonds removes dependent polyhedra and undo restores them", () => {
    const source = parseVaspScene(gamma);
    const original = JSON.stringify(source);
    const center = source.polyhedra[0]!.centerAtomIndex;
    const bond = source.bonds.find(bond => bond.startAtomIndex === center || bond.endAtomIndex === center)!;
    const edited = applySceneDeletions(source, { atoms: new Set(), bonds: new Set([bond.id]) })!;
    expect(edited.polyhedra).toHaveLength(13);
    const { result } = renderHook(() => useSceneEdits(source, 1));
    act(() => result.current.deleteObjects({ atoms: new Set([source.atoms[center]!.id]), bonds: new Set() }));
    expect(result.current.scene!.summary.atomCount).toBe(7);
    expect(result.current.scene!.polyhedra).toHaveLength(13);
    const visible = visibleSceneForComponents(result.current.scene!, { ...createDefaultComponentVisibility(), oneHopBondedAtoms: true, hideUnbondedBoundary: true })!;
    visible.atoms.forEach((atom, index) => {
      if (!atom.isPeriodicImage || atom.imageReasons.includes("boundary")) return;
      expect(visible.bonds.some(bond => bond.startAtomIndex === index || bond.endAtomIndex === index)).toBe(true);
    });
    act(() => { expect(result.current.undoDeletion()).toBe(true); });
    expect(result.current.scene).toBe(source);
    expect(JSON.stringify(source)).toBe(original);
    expect(applySceneDeletions(source, EMPTY_SELECTION)).toBe(source);
  });

  test("rejects pathological periodic search sizes before allocating an enormous supercell", () => {
    expect(() => parseVaspScene("tiny\n1\n.001 0 0\n0 .001 0\n0 0 .001\nCu\n1\nDirect\n.5 .5 .5")).toThrow("周期邻居搜索范围过大");
    expect(() => parseVaspScene(gamma, { "Cu|I": { min: 0, max: Infinity } })).toThrow("成键距离范围无效");
  });
});
