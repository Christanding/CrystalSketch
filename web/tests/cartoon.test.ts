import { describe, expect, test } from "bun:test";
import { parseVaspScene } from "../src/api/vasp";
import { applySceneDeletions } from "../src/model/sceneEdits";
import { createDefaultComponentVisibility, visibleSceneForComponents } from "../src/model/displayState";
import { EMPTY_SELECTION, selectSceneObject } from "../src/selection/SceneSelection";
import { withPngDpi } from "../src/export/pngDpi";

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

describe("CuI integration contracts", () => {
  test("preserves the 8 source atoms, 10 boundary copies and 16 original bonds", () => {
    const scene = parseVaspScene(gamma);
    expect(scene.summary.atomCount).toBe(8);
    const defaultScene = visibleSceneForComponents(scene, createDefaultComponentVisibility(scene))!;
    expect(defaultScene.atoms).toHaveLength(18);
    expect(defaultScene.bonds).toHaveLength(16);
    expect(scene.atoms.filter(atom => !atom.isPeriodicImage).map(atom => atom.sourceAtomNumber)).toEqual([1,2,3,4,5,6,7,8]);
    expect(scene.atoms.filter(atom => atom.sourceAtomNumber === 1)).toHaveLength(8);
    expect(scene.bonds[0]!.length).toBeCloseTo(6.05 * Math.sqrt(3) / 4, 10);
    const visibility = createDefaultComponentVisibility(scene);
    expect(visibleSceneForComponents(scene, { ...visibility, boundaryAtoms: false })!.atoms).toHaveLength(8);
    expect(visibleSceneForComponents(scene, { ...visibility, hideUnbondedBoundary: true })!.atoms).toHaveLength(14);
    expect(visibleSceneForComponents(scene, visibility)!.atoms).toHaveLength(18);
    expect(parseVaspScene(gamma, {}, .8).bonds).toHaveLength(0);
  });

  test("Cartesian scaling and selective dynamics preserve file order", () => {
    const scene = parseVaspScene(`scaled\n2\n3 0 0\n0 3 0\n0 0 3\nCu I\n1 1\nSelective dynamics\nCartesian\n.75 .75 .75 T F T\n1.5 1.5 1.5 F F F`);
    expect(scene.atoms.map(atom => atom.position)).toEqual([[1.5,1.5,1.5], [3,3,3]]);
    expect(scene.atoms.map(atom => atom.sourceAtomNumber)).toEqual([1,2]);
    const negativeScale = parseVaspScene(gamma.replace("\n1\n", "\n-216\n"));
    expect(negativeScale.cell.vectors[0]![0]).toBeCloseTo(6, 10);
    expect(() => parseVaspScene(gamma.split("\n").slice(0,-1).join("\n"))).toThrow("坐标行不足");
  });

  test("mixed multi-selection toggles independently and deletion preserves stable identities", () => {
    const scene = parseVaspScene(gamma);
    const atom = scene.atoms.find(atom => atom.sourceAtomNumber === 5)!;
    const bond = scene.bonds.find(bond => scene.atoms[bond.startAtomIndex]!.id !== atom.id
      && scene.atoms[bond.endAtomIndex]!.id !== atom.id)!;
    let selection = selectSceneObject(EMPTY_SELECTION, "atom", atom.id, false);
    selection = selectSceneObject(selection, "bond", bond.id, true);
    expect(selection.atoms.size).toBe(1);
    expect(selection.bonds.size).toBe(1);
    const edited = applySceneDeletions(scene, selection)!;
    expect(edited.summary.atomCount).toBe(7);
    expect(edited.atoms.some(candidate => candidate.id === atom.id)).toBe(false);
    expect(edited.bonds.some(candidate => candidate.id === bond.id)).toBe(false);
    expect(edited.atoms.find(atom => atom.sourceAtomNumber === 8)!.siteId).toBe("I-7");
    expect(edited.bonds.every(bond => edited.atoms[bond.startAtomIndex]!.siteId === bond.startSiteId
      && edited.atoms[bond.endAtomIndex]!.siteId === bond.endSiteId)).toBe(true);
    expect(applySceneDeletions(scene, EMPTY_SELECTION)).toBe(scene);
    selection = selectSceneObject(selection, "atom", atom.id, true);
    expect(selection.atoms.size).toBe(0);
    expect(selection.bonds.size).toBe(1);
  });

  test("PNG exports carry exactly one 600 DPI chunk", async () => {
    const pixel = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGd8AAAAASUVORK5CYII=", "base64")], {type:"image/png"});
    const first = await withPngDpi(pixel);
    const second = await withPngDpi(first);
    expect(second.size).toBe(first.size);
    const data = new Uint8Array(await second.arrayBuffer());
    expect(new TextDecoder().decode(data.subarray(37,41))).toBe("pHYs");
    expect(new DataView(data.buffer).getUint32(41) * .0254).toBeCloseTo(600, 2);
  });
});
