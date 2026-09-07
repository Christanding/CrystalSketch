import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BatchedMesh,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Group,
  type InterleavedBufferAttribute,
  Matrix4,
  Vector3,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type {
  AtomSpec,
  PolyhedronSpec,
} from "../api/scene";
import type { StyleState } from "../model";
import { polyhedronColorForElement } from "../model";
import { StructureMaterial } from "./StructureMaterial";
import type { ResolvedStructureMaterialFamily } from "./materialPresetResolver";
import { STRUCTURE_RENDER_ORDER } from "./renderOrder";
import { polyhedronGeometryFromAtoms } from "./structureGeometry";
import { createPolyhedronEdges, polyhedronEdgeLayer, type PolyhedronEdge } from "./polyhedronEdges";

export const POLYHEDRON_SURFACE_OPACITY = 0.4;
export const POLYHEDRON_EDGE_COLOR = "#000000";
export const POLYHEDRON_EDGE_LINE_WIDTH_PIXELS = 1;
export const POLYHEDRON_EDGE_OPACITY = 0.95;

export interface PolyhedronSurfaceBatchBuild {
  edges: PolyhedronEdge[];
  itemCount: number;
  items: PolyhedronSurfaceRenderItem[];
  key: string;
  maxIndexCount: number;
  maxVertexCount: number;
}

export interface PolyhedronSurfaceRenderItem {
  color: Color;
  geometry: BufferGeometry;
  polyhedron: PolyhedronSpec;
  polyhedronIndex: number;
}

export function BatchedPolyhedra({
  atoms,
  lineWidthScale,
  materialFamily,
  opacity,
  polyhedra,
  style,
}: {
  atoms: AtomSpec[];
  lineWidthScale: number;
  materialFamily: ResolvedStructureMaterialFamily;
  opacity: number;
  polyhedra: PolyhedronSpec[];
  style: StyleState;
}) {
  const meshRef = useRef<BatchedMesh | null>(null);
  const populatedBatchMeshRef = useRef<BatchedMesh | null>(null);
  const populatedBatchKeyRef = useRef<string | null>(null);
  const batchIdsRef = useRef<number[]>([]);
  const invalidate = useThree((state) => state.invalidate);
  const batch = useMemo(
    () =>
      createPolyhedronSurfaceBatchBuild({
        atoms,
        polyhedra,
        style: {},
      }),
    [atoms, polyhedra],
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !batch) {
      populatedBatchMeshRef.current = null;
      populatedBatchKeyRef.current = null;
      return;
    }

    if (
      populatedBatchMeshRef.current === mesh &&
      populatedBatchKeyRef.current === batch.key
    ) {
      return;
    }

    batchIdsRef.current = populateBatchedPolyhedraSurfaces(mesh, batch);
    populatedBatchMeshRef.current = mesh;
    populatedBatchKeyRef.current = batch.key;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    invalidate();
  }, [batch, invalidate]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !batch) return;
    const color = new Color();
    batch.items.forEach((item, index) => {
      const center = atoms[item.polyhedron.centerAtomIndex]!;
      mesh.setColorAt(batchIdsRef.current[index]!, color.set(polyhedronColorForElement(style, center.element)));
    });
    invalidate();
  }, [atoms, batch, invalidate, style.polyhedronColors]);

  useEffect(() => {
    return () => {
      disposePolyhedronSurfaceBatchBuild(batch);
    };
  }, [batch]);

  if (!batch) {
    return null;
  }

  return (
    <group>
      {batch.itemCount > 0 ? (
        <batchedMesh
          key={batch.key}
          ref={meshRef}
          args={[batch.itemCount, batch.maxVertexCount, batch.maxIndexCount]}
          renderOrder={STRUCTURE_RENDER_ORDER.polyhedronSurface}
        >
          <StructureMaterial
            color="#ffffff"
            depthWrite={opacity >= 1}
            materialFamily={materialFamily}
            opacity={opacity}
            outlineVisible={false}
            polygonOffset
            polygonOffsetFactor={3}
            side={FrontSide}
            transparent={opacity < 1}
          />
        </batchedMesh>
      ) : null}
      {batch.edges.length > 0 ? (
        <PolyhedronEdges
          edges={batch.edges}
          lineWidthScale={lineWidthScale}
          opacity={opacity}
        />
      ) : null}
    </group>
  );
}

export const MemoizedBatchedPolyhedra = memo(BatchedPolyhedra);

export function createPolyhedronSurfaceBatchBuild({
  atoms,
  polyhedra,
  style,
}: {
  atoms: AtomSpec[];
  polyhedra: PolyhedronSpec[];
  style: Pick<StyleState, "polyhedronColors">;
}): PolyhedronSurfaceBatchBuild | null {
  const validPolyhedra: PolyhedronSpec[] = [];
  const items: PolyhedronSurfaceRenderItem[] = [];
  const seenSurfaceFaceKeys = new Set<string>();
  let maxIndexCount = 0;
  let maxVertexCount = 0;

  polyhedra.forEach((polyhedron, polyhedronIndex) => {
    const centerAtom = atoms[polyhedron.centerAtomIndex];
    if (!centerAtom) {
      return;
    }

    if (!isValidPolyhedronForAtoms(polyhedron, atoms)) {
      return;
    }

    validPolyhedra.push(polyhedron);

    const surfacePolyhedron = uniqueSurfacePolyhedron(
      polyhedron,
      atoms,
      seenSurfaceFaceKeys,
    );
    if (!surfacePolyhedron) {
      return;
    }

    const geometry = prepareBatchGeometry(
      polyhedronGeometryFromAtoms(surfacePolyhedron, atoms),
    );
    if (!geometry) {
      return;
    }

    const position = geometry.getAttribute("position");
    const vertexCount = position?.count ?? 0;
    const indexCount = geometry.getIndex()?.count ?? vertexCount;
    if (vertexCount <= 0 || indexCount <= 0) {
      geometry.dispose();
      return;
    }

    items.push({
      color: new Color(polyhedronColorForElement(style, centerAtom.element)),
      geometry,
      polyhedron,
      polyhedronIndex,
    });
    maxIndexCount += indexCount;
    maxVertexCount += vertexCount;
  });

  const edges = createPolyhedronEdges(validPolyhedra, atoms);
  if (items.length === 0 && edges.length === 0) {
    return null;
  }

  return {
    edges,
    itemCount: items.length,
    items,
    key: polyhedronSurfaceBatchKey(items),
    maxIndexCount,
    maxVertexCount,
  };
}

function isValidPolyhedronForAtoms(
  polyhedron: PolyhedronSpec,
  atoms: AtomSpec[],
): boolean {
  if (polyhedron.faces.length === 0) {
    return false;
  }

  if (polyhedron.hullAtomIndices.some((atomIndex) => !atoms[atomIndex])) {
    return false;
  }

  return polyhedron.faces.every(
    (face) => polyhedronSurfaceFaceKey(polyhedron, atoms, face) !== null,
  );
}

function uniqueSurfacePolyhedron(
  polyhedron: PolyhedronSpec,
  atoms: AtomSpec[],
  seenSurfaceFaceKeys: Set<string>,
): PolyhedronSpec | null {
  const pendingFaceKeys = new Set<string>();
  const uniqueFaces: PolyhedronSpec["faces"] = [];

  for (const atomIndex of polyhedron.hullAtomIndices) {
    if (!atoms[atomIndex]) {
      return null;
    }
  }

  for (const face of polyhedron.faces) {
    const faceKey = polyhedronSurfaceFaceKey(polyhedron, atoms, face);
    if (!faceKey) {
      return null;
    }

    if (seenSurfaceFaceKeys.has(faceKey) || pendingFaceKeys.has(faceKey)) {
      continue;
    }

    pendingFaceKeys.add(faceKey);
    uniqueFaces.push(face);
  }

  for (const faceKey of pendingFaceKeys) {
    seenSurfaceFaceKeys.add(faceKey);
  }

  if (uniqueFaces.length === polyhedron.faces.length) {
    return polyhedron;
  }

  return {
    ...polyhedron,
    faces: uniqueFaces,
  };
}

function polyhedronSurfaceFaceKey(
  polyhedron: PolyhedronSpec,
  atoms: AtomSpec[],
  face: number[],
): string | null {
  if (
    face.length !== 3 ||
    new Set(face).size !== 3 ||
    face.some(
      (vertexIndex) =>
        !Number.isInteger(vertexIndex) ||
        vertexIndex < 0 ||
        vertexIndex >= polyhedron.hullAtomIndices.length,
    )
  ) {
    return null;
  }

  const vertexKeys: string[] = [];
  for (const vertexIndex of face) {
    const atomIndex = polyhedron.hullAtomIndices[vertexIndex];
    if (atomIndex === undefined) {
      return null;
    }

    const atom = atoms[atomIndex];
    if (
      !atom ||
      atom.position.some((coordinate: number) => !Number.isFinite(coordinate))
    ) {
      return null;
    }

    vertexKeys.push(
      atom.position.map((coordinate: number) => String(coordinate)).join(","),
    );
  }

  return vertexKeys.sort().join("|");
}

export function disposePolyhedronSurfaceBatchBuild(
  batch: PolyhedronSurfaceBatchBuild | null,
) {
  for (const item of batch?.items ?? []) {
    item.geometry.dispose();
  }
}

function populateBatchedPolyhedraSurfaces(
  mesh: BatchedMesh,
  batch: PolyhedronSurfaceBatchBuild,
) {
  const identity = new Matrix4();
  mesh.perObjectFrustumCulled = true;
  mesh.sortObjects = true;
  const batchIds: number[] = [];

  for (const item of batch.items) {
    const geometryId = mesh.addGeometry(item.geometry);
    const batchId = mesh.addInstance(geometryId);
    batchIds.push(batchId);
    mesh.setMatrixAt(batchId, identity);
    mesh.setColorAt(batchId, item.color);
  }

  return batchIds;
}

function PolyhedronEdges({
  lineWidthScale,
  opacity,
  edges,
}: {
  lineWidthScale: number;
  opacity: number;
  edges: PolyhedronEdge[];
}) {
  const groupRef = useRef<Group>(null);
  const direction = useRef(new Vector3());
  const inverse = useRef(new Matrix4());
  const lastDirection = useRef(new Vector3(Infinity, Infinity, Infinity));
  const counts = useRef([0, 0, 0]);
  const invalidate = useThree(state => state.invalidate);
  const layers = useMemo(() => [0, 1, 2].map(layer => {
    const positions = new Float32Array(edges.length * 6);
    edges.forEach((edge, index) => { positions.set(edge.start, index * 6); positions.set(edge.end, index * 6 + 3); });
    const lineGeometry = new LineSegmentsGeometry();
    lineGeometry.setPositions(positions);
    lineGeometry.instanceCount = 0;
    const buffer = (lineGeometry.getAttribute("instanceStart") as InterleavedBufferAttribute).data;
    buffer.setUsage(DynamicDrawUsage);
    const material = new LineMaterial({
      alphaToCoverage: true,
      color: POLYHEDRON_EDGE_COLOR,
      depthWrite: false,
      fog: false,
      linewidth: 1,
      opacity: 0,
      side: DoubleSide,
      transparent: true,
      worldUnits: false,
    });

    const line = new LineSegments2(lineGeometry, material);
    line.renderOrder = STRUCTURE_RENDER_ORDER.polyhedronEdge + layer;
    return { line, positions, buffer };
  }), [edges]);

  useLayoutEffect(() => {
    const scale = Math.sqrt(opacity / POLYHEDRON_SURFACE_OPACITY) * POLYHEDRON_EDGE_OPACITY;
    layers.forEach(({ line }, layer) => {
      line.material.linewidth = POLYHEDRON_EDGE_LINE_WIDTH_PIXELS * lineWidthScale * [0.7, 0.9, 1][layer]!;
      line.material.opacity = Math.min(1, scale * [0.22 * (1 - opacity), 0.85, 1][layer]!);
    });
    lastDirection.current.setScalar(Infinity);
    invalidate();
  }, [invalidate, layers, lineWidthScale, opacity]);

  useFrame(({ camera }) => {
    const group = groupRef.current;
    if (!group) return;
    group.updateWorldMatrix(true, false);
    camera.getWorldDirection(direction.current).negate();
    inverse.current.copy(group.matrixWorld).invert();
    direction.current.transformDirection(inverse.current);
    if (direction.current.distanceToSquared(lastDirection.current) < 1e-10) return;
    lastDirection.current.copy(direction.current);
    counts.current.fill(0);
    for (const edge of edges) {
      const layer = polyhedronEdgeLayer(edge, direction.current);
      const offset = counts.current[layer]! * 6;
      layers[layer]!.positions.set(edge.start, offset);
      layers[layer]!.positions.set(edge.end, offset + 3);
      counts.current[layer]!++;
    }
    layers.forEach(({ line, buffer }, layer) => {
      line.geometry.instanceCount = counts.current[layer]!;
      line.visible = counts.current[layer]! > 0;
      buffer.needsUpdate = true;
    });
  });

  useEffect(() => {
    return () => {
      layers.forEach(({ line }) => { line.geometry.dispose(); line.material.dispose(); });
    };
  }, [layers]);

  return <group ref={groupRef}>{layers.map(({ line }, index) => <primitive key={index} object={line} />)}</group>;
}

function prepareBatchGeometry(
  geometry: BufferGeometry | null,
): BufferGeometry | null {
  if (!geometry) {
    return null;
  }

  // Facet normals keep each coordination plane flat, rather than shading it like a sphere.
  const flatGeometry = geometry.toNonIndexed();
  geometry.dispose();
  flatGeometry.computeVertexNormals();
  flatGeometry.computeBoundingBox();
  flatGeometry.computeBoundingSphere();
  return flatGeometry;
}

function polyhedronSurfaceBatchKey(items: PolyhedronSurfaceRenderItem[]): string {
  let hash = hashString("polyhedra");
  for (const item of items) {
    hash = hashNumber(hash, item.polyhedronIndex);
    hash = hashString(item.color.getHexString(), hash);
    hash = hashGeometryAttribute(item.geometry, "position", hash);
    hash = hashIndexAttribute(item.geometry, hash);
  }
  return `polyhedra:${items.length}:${hash.toString(36)}`;
}

function hashGeometryAttribute(
  geometry: BufferGeometry,
  name: string,
  initialHash: number,
): number {
  const attribute = geometry.getAttribute(name);
  let hash = hashNumber(initialHash, attribute.itemSize);
  hash = hashNumber(hash, attribute.count);
  for (let index = 0; index < attribute.array.length; index += 1) {
    hash = hashNumber(hash, attribute.array[index] ?? 0);
  }
  return hash;
}

function hashIndexAttribute(
  geometry: BufferGeometry,
  initialHash: number,
): number {
  const index = geometry.getIndex();
  if (!index) {
    return hashNumber(initialHash, 0);
  }

  let hash = hashNumber(initialHash, index.count);
  for (let arrayIndex = 0; arrayIndex < index.array.length; arrayIndex += 1) {
    hash = hashNumber(hash, index.array[arrayIndex] ?? 0);
  }
  return hash;
}

function hashString(value: string, initialHash = 2166136261): number {
  let hash = initialHash;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashNumber(initialHash: number, value: number): number {
  const safeValue = Number.isFinite(value) ? value : 0;
  return hashString(String(safeValue), initialHash);
}
