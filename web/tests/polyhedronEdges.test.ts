import { describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import type { AtomSpec, PolyhedronSpec } from "../src/api/scene";
import { createPolyhedronEdges, polyhedronEdgeLayer } from "../src/scene/polyhedronEdges";

const atoms: AtomSpec[] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
].map((position, index) => ({
  element: "Cu", id: `Cu-${index}`, siteId: `Cu-${index}`, siteIndex: index,
  position: position as [number, number, number],
  fractionalPosition: position as [number, number, number],
  imageOffset: [0, 0, 0], isPeriodicImage: false,
  imageReasons: [], visibilityDependencies: [], visibilityDependencyGroups: [],
}));
const cube: PolyhedronSpec = {
  centerAtomIndex: 0,
  visibilityDependencies: [], visibilityDependencyGroups: [],
  hullAtomIndices: atoms.map((_, index) => index),
  faces: [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ],
};

describe("polyhedron edge hierarchy", () => {
  test("removes coplanar triangulation diagonals and deduplicates shared edges", () => {
    const edges = createPolyhedronEdges([cube, cube], atoms);
    expect(edges).toHaveLength(12);
    expect(edges.every(edge => edge.normalGroups.length === 2)).toBe(true);
    expect(edges.every(edge => new Vector3(...edge.start).distanceTo(new Vector3(...edge.end)) === 1)).toBe(true);
  });

  test("separates silhouette, front and rear edges, and reclassifies on rotation", () => {
    const edges = createPolyhedronEdges([cube], atoms);
    const outward = new Vector3(1, 1, 1).normalize();
    const layers = edges.map(edge => polyhedronEdgeLayer(edge, outward));
    expect([0, 1, 2].map(layer => layers.filter(value => value === layer).length)).toEqual([3, 3, 6]);
    const reverse = outward.clone().negate();
    expect(edges.map(edge => polyhedronEdgeLayer(edge, reverse))).toEqual(
      layers.map(layer => layer === 2 ? 2 : layer === 1 ? 0 : 1),
    );
    expect(createPolyhedronEdges([cube], atoms)).toEqual(edges);
  });
});
