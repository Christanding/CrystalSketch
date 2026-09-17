import { Vector3 } from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import electronegativity from "../data/electronegativity.json";
import type { AtomSpec, BondSpec, PolyhedronSpec } from "./scene";

const PAULING: Record<string, number> = electronegativity.elements;

export function buildVaspPolyhedra(atoms: AtomSpec[], bonds: BondSpec[], sourceCount: number): PolyhedronSpec[] {
  const neighbors = Array.from({ length: sourceCount }, () => new Set<number>());
  for (const bond of bonds) {
    neighbors[bond.startAtomIndex]?.add(bond.endAtomIndex);
    neighbors[bond.endAtomIndex]?.add(bond.startAtomIndex);
  }
  const polyhedra: PolyhedronSpec[] = [];
  neighbors.forEach((neighborIndices, centerAtomIndex) => {
    if (neighborIndices.size < 4) return;
    if (!isAutomaticPolyhedronCenter(atoms, centerAtomIndex, neighborIndices)) return;
    const polyhedron = buildCoordinationPolyhedron(atoms, centerAtomIndex, neighborIndices);
    if (!polyhedron) return;
    if (polyhedra.length >= 25_600) throw new Error("配位多面体超过 25,600 个的预览上限");
    polyhedra.push(polyhedron);
  });
  return polyhedra;
}

export function isAutomaticPolyhedronCenter(
  atoms: readonly AtomSpec[],
  centerAtomIndex: number,
  neighborIndices: Iterable<number>,
): boolean {
  const center = atoms[centerAtomIndex];
  if (!center) return false;
  const centerX = PAULING[center.element];
  // Retain upstream's center selection: lower electronegativity, then symbol order.
  return centerX !== undefined && ![...neighborIndices].some(index => {
    const element = atoms[index]?.element;
    if (element === undefined) return true;
    const neighborX = PAULING[element];
    return neighborX === undefined || neighborX < centerX
      || (neighborX === centerX && element <= center.element);
  });
}

/** Build one hull from an existing bond graph, without the automatic species filter. */
export function buildCoordinationPolyhedron(
  atoms: readonly AtomSpec[],
  centerAtomIndex: number,
  neighborIndices: Iterable<number>,
): PolyhedronSpec | null {
  const neighbors = new Set(neighborIndices);
  neighbors.delete(centerAtomIndex);
  if (neighbors.size < 4) return null;
  const hullAtomIndices = [centerAtomIndex, ...neighbors];
  if (hullAtomIndices.some(index => !atoms[index]?.position.every(Number.isFinite))) return null;
  const origin = new Vector3(...atoms[centerAtomIndex]!.position);
  const points = hullAtomIndices.map(index => new Vector3(...atoms[index]!.position).sub(origin));
  if (!hasVolume(points)) return null;
  const hull = new ConvexHull().setFromPoints(points);
  const indices = new Map(points.map((point, index) => [point, index]));
  const faces: PolyhedronSpec["faces"] = hull.faces.map(face => {
    const edge = face.edge;
    return [indices.get(edge.head().point)!, indices.get(edge.next.head().point)!, indices.get(edge.next.next.head().point)!];
  });
  return { centerAtomIndex, hullAtomIndices, faces,
    visibilityDependencies: [], visibilityDependencyGroups: [] };
}

function hasVolume(points: Vector3[]): boolean {
  const first = points[0]!;
  let edge = new Vector3();
  for (const point of points) {
    const candidate = point.clone().sub(first);
    if (candidate.lengthSq() > edge.lengthSq()) edge = candidate;
  }
  let normal = new Vector3();
  for (const point of points) {
    const candidate = new Vector3().crossVectors(edge, point.clone().sub(first));
    if (candidate.lengthSq() > normal.lengthSq()) normal = candidate;
  }
  if (normal.lengthSq() < 1e-20) return false;
  normal.normalize();
  return points.some(point => Math.abs(normal.dot(point.clone().sub(first))) > 1e-8);
}
