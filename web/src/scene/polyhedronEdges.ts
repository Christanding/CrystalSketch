import { Vector3 } from "three";
import type { AtomSpec, PolyhedronSpec } from "../api/scene";
import type { VectorTuple } from "../model/vector";

export interface PolyhedronEdge {
  start: VectorTuple;
  end: VectorTuple;
  normalGroups: Vector3[][];
}

export function createPolyhedronEdges(polyhedra: PolyhedronSpec[], atoms: AtomSpec[]): PolyhedronEdge[] {
  const uniqueEdges = new Map<string, PolyhedronEdge>();
  const coplanarThreshold = Math.cos(Math.PI / 180);
  for (const polyhedron of polyhedra) {
    const localEdges = new Map<string, { start: VectorTuple; end: VectorTuple; normals: Vector3[] }>();
    for (const face of polyhedron.faces) {
      const points = face.map(index => atoms[polyhedron.hullAtomIndices[index]!]?.position);
      if (points.length !== 3 || points.some(point => !point || point.some(value => !Number.isFinite(value)))) continue;
      const [a, b, c] = points as [VectorTuple, VectorTuple, VectorTuple];
      const normal = new Vector3(...b).sub(new Vector3(...a)).cross(new Vector3(...c).sub(new Vector3(...a)));
      if (normal.lengthSq() < 1e-20) continue;
      normal.normalize();
      for (let index = 0; index < 3; index++) {
        const first = points[index]!;
        const second = points[(index + 1) % 3]!;
        const firstKey = first.join(",");
        const secondKey = second.join(",");
        const [start, end, key] = firstKey < secondKey
          ? [first, second, `${firstKey}|${secondKey}`] as const
          : [second, first, `${secondKey}|${firstKey}`] as const;
        const edge = localEdges.get(key) ?? { start, end, normals: [] };
        edge.normals.push(normal);
        localEdges.set(key, edge);
      }
    }
    for (const [key, edge] of localEdges) {
      // Suppress triangulation diagonals, not the physical creases of a polyhedron.
      if (edge.normals.length > 1 && edge.normals.every(normal => normal.dot(edge.normals[0]!) > coplanarThreshold)) continue;
      const shared = uniqueEdges.get(key) ?? { start: edge.start, end: edge.end, normalGroups: [] };
      shared.normalGroups.push(edge.normals);
      uniqueEdges.set(key, shared);
    }
  }
  return [...uniqueEdges.values()];
}

/** 0: rear hint, 1: front crease, 2: silhouette. A shared edge is drawn only once. */
export function polyhedronEdgeLayer(edge: PolyhedronEdge, outward: Vector3): 0 | 1 | 2 {
  let layer: 0 | 1 | 2 = 0;
  for (const normals of edge.normalGroups) {
    let front = false;
    let rear = normals.length === 1;
    for (const normal of normals) {
      if (normal.dot(outward) > 1e-6) front = true;
      else rear = true;
    }
    if (front && rear) return 2;
    if (front) layer = 1;
  }
  return layer;
}
