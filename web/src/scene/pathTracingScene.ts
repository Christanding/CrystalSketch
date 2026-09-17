import {
  Box3, BufferAttribute, BufferGeometry, Color, CylinderGeometry, FrontSide, Group, Mesh,
  MeshPhysicalMaterial, Scene, SphereGeometry, Vector3,
} from "three";
import type { MeshPhysicalMaterialParameters } from "three";
import type { SceneSpec } from "../api/scene";
import {
  baseColorSchemeForStyle, elementColorOverridesForStyle, polyhedronColorForElement,
  type StyleState,
} from "../model/appearance";
import type { ComponentOpacityState } from "../model/displayState";
import type { UnitCellLineStyle } from "../model/rendering";
import type { RenderQuality } from "../model/renderSettings";
import { resolveAtomVisibleForStyle } from "../model/objectStyles";
import { isIridescenceThicknessRange } from "../model/materialPresets";
import type { SceneMeshDetail } from "./StructureSceneObjects";
import { createAtomRenderItems } from "./AtomRenderItems";
import { createBondRenderItems } from "./BondRenderItems";
import {
  resolveStructureMaterialFamiliesForStyle, type ResolvedStructureMaterialFamily,
} from "./materialPresetResolver";
import { createPolyhedronEdges } from "./polyhedronEdges";
import { BOND_RADIUS, CELL_FRAME_DASH_SIZE, CELL_FRAME_GAP_SIZE, cellFrameLinePositions } from "./sceneGeometry";
import { polyhedronGeometryFromAtoms, twoToneBondCylinderGeometry } from "./structureGeometry";

export const PATH_TRACING_GEOMETRY_LIMITS = {
  triangles: 1_500_000,
  meshes: 12_000,
  facesPerPolyhedron: 8_192,
} as const;

const DETAIL: Record<RenderQuality, { sphere: [number, number]; cylinder: number }> = {
  draft: { sphere: [24, 16], cylinder: 12 },
  standard: { sphere: [32, 24], cylinder: 16 },
  high: { sphere: [48, 32], cylinder: 24 },
  ultra: { sphere: [48, 32], cylinder: 24 },
};
const UP = new Vector3(0, 1, 0);
const BATCH_SIZE = 128;

export class PathTracingSceneError extends Error {
  constructor(readonly code: "geometry-limit" | "invalid-geometry", message: string) {
    super(message);
    this.name = "PathTracingSceneError";
  }
}

export interface CrystalPathTraceSceneOptions {
  scene: SceneSpec;
  style: StyleState;
  componentOpacity: ComponentOpacityState;
  groupPosition: [number, number, number];
  showAtoms: boolean;
  showUnitCell: boolean;
  unitCellColor: string;
  unitCellRadius: number;
  unitCellLineStyle?: UnitCellLineStyle;
  polyhedronEdgeRadius: number;
  quality: RenderQuality;
  /** Exports reuse their selected mesh quality; previews keep the sampling preset's existing detail. */
  meshDetail?: SceneMeshDetail;
  signal?: AbortSignal;
}

export interface CrystalPathTraceScene {
  scene: Scene;
  triangleCount: number;
  /** False leaves the snapshot unchanged; geometry changes use the existing rebuild path. */
  updateAppearance(options: CrystalPathTraceSceneOptions): boolean;
  updateLineRadii(unitCellRadius: number, polyhedronEdgeRadius: number): void;
  /** Releases snapshot geometry/materials. The caller owns any added environment texture. */
  dispose(): void;
}

/** Keep the same render items as the viewport; the path tracer cannot expand BatchedMesh. */
export async function createCrystalPathTraceScene(
  options: CrystalPathTraceSceneOptions,
): Promise<CrystalPathTraceScene> {
  const { scene: source, style, componentOpacity, signal } = options;
  signal?.throwIfAborted();
  assertFinitePoint(options.groupPosition);
  const scene = new Scene();
  const structure = new Group();
  structure.name = "crystalsketch-path-traced-structure";
  structure.position.fromArray(options.groupPosition);
  scene.add(structure);
  const geometries = new Set<BufferGeometry>();
  let materials = new Map<string, MeshPhysicalMaterial>();
  const geometryCache = new Map<string, BufferGeometry>();
  const detail = options.meshDetail ? {
    sphere: [options.meshDetail.sphereWidthSegments, options.meshDetail.sphereHeightSegments] as [number, number],
    cylinder: options.meshDetail.bondRadialSegments,
  } : DETAIL[options.quality];
  let triangleCount = 0;
  let meshCount = 0;
  let disposed = false;
  const geometryIdentity = snapshotGeometryIdentity(options);
  let currentUnitCellRadius = options.unitCellRadius, currentEdgeRadius = options.polyhedronEdgeRadius;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials.values()) material.dispose();
    geometries.clear();
    materials.clear();
    geometryCache.clear();
    structure.clear();
    scene.clear();
  };
  const geometryFor = (key: string, create: () => BufferGeometry) => {
    let geometry = geometryCache.get(key);
    if (!geometry) {
      geometry = create();
      geometryCache.set(key, geometry);
      geometries.add(geometry);
    }
    return geometry;
  };
  const materialFor = (
    target: string, family: ResolvedStructureMaterialFamily | null,
    color: string, opacity: number, vertexColors = false, cache = materials,
  ) => {
    const key = `${target}:${color}:${opacity}:${vertexColors}`;
    let material = cache.get(key);
    if (!material) {
      material = physicalMaterialFor(family, color, opacity, vertexColors);
      cache.set(key, material);
    }
    return material;
  };
  const addMesh = (geometry: BufferGeometry, material: MeshPhysicalMaterial, name: string) => {
    // The upstream generator fills missing colors as RGBA. Mixing our RGB bond
    // attribute with those RGBA spheres corrupts its merged buffer (or overruns it).
    const color = geometry.getAttribute("color");
    if (color?.itemSize === 3) {
      const rgba = new Float32Array(color.count * 4);
      for (let i = 0; i < color.count; i++) rgba.set([color.getX(i), color.getY(i), color.getZ(i), 1], i * 4);
      geometry.setAttribute("color", new BufferAttribute(rgba, 4));
    }
    const triangles = (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
    if (triangleCount + triangles > PATH_TRACING_GEOMETRY_LIMITS.triangles
      || meshCount + 1 > PATH_TRACING_GEOMETRY_LIMITS.meshes) {
      throw geometryLimitError();
    }
    triangleCount += triangles;
    meshCount++;
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    structure.add(mesh);
    return mesh;
  };
  const addLine = (
    start: readonly number[], end: readonly number[], radius: number,
    material: MeshPhysicalMaterial, name: string,
  ) => {
    if (!Number.isFinite(radius) || radius <= 0) return;
    assertFinitePoint(start);
    assertFinitePoint(end);
    const a = new Vector3().fromArray(start);
    const b = new Vector3().fromArray(end);
    const direction = b.clone().sub(a);
    const length = direction.length();
    if (length <= 1e-12) return;
    const geometry = geometryFor("line", () => new CylinderGeometry(1, 1, 1, Math.max(6, detail.cylinder / 2)));
    const mesh = addMesh(geometry, material, name);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(UP, direction.divideScalar(length));
    mesh.scale.set(radius, length, radius);
    mesh.userData.kind = name.startsWith("unit-cell") ? "unit-cell" : "polyhedron-edge";
  };

  try {
    await yieldPreparation(signal);
    const colorScheme = baseColorSchemeForStyle(style);
    const colorOverrides = elementColorOverridesForStyle(source.atoms, style);
    const families = resolveStructureMaterialFamiliesForStyle(style);

    if (options.showAtoms) {
      for (let offset = 0; offset < source.atoms.length; offset += BATCH_SIZE) {
        const items = createAtomRenderItems({
          atoms: source.atoms.slice(offset, offset + BATCH_SIZE),
          atomOpacity: componentOpacity.atoms, colorScheme, colorOverrides, style,
        });
        for (const item of items) {
          assertFinitePoint(item.position);
          if (!Number.isFinite(item.radius)) throw invalidGeometryError();
          if (item.radius <= 0) continue;
          const geometry = geometryFor("atom", () => new SphereGeometry(1, ...detail.sphere));
          const mesh = addMesh(geometry, materialFor("atom", families.atom, item.color, item.opacity), item.id);
          mesh.position.fromArray(item.position);
          mesh.scale.setScalar(item.radius);
          mesh.userData = {
            kind: "atom", atomId: item.id, sourceAtomNumber: item.atom.sourceAtomNumber,
            siteId: item.atom.siteId, siteIndex: item.atom.siteIndex,
            imageOffset: [...item.atom.imageOffset], isPeriodicImage: item.atom.isPeriodicImage,
          };
        }
        await yieldPreparation(signal);
      }
    }

    for (let offset = 0; offset < source.bonds.length; offset += BATCH_SIZE) {
      const items = createBondRenderItems({
        atoms: source.atoms, bonds: source.bonds.slice(offset, offset + BATCH_SIZE),
        bondColor: style.bondColor, bondOpacity: componentOpacity.bonds,
        bondRadius: BOND_RADIUS * style.bondThickness / 100,
        colorMode: style.bondColorMode, colorScheme, colorOverrides, style,
      });
      for (const item of items) {
        assertFinitePoint(item.center.toArray());
        if (!Number.isFinite(item.length) || !Number.isFinite(item.radius)) throw invalidGeometryError();
        if (item.radius <= 0) continue;
        const bicolor = style.bondColorMode === "bicolor";
        const geometry = geometryFor(bicolor ? `bond:${item.startColor}:${item.endColor}` : "bond", () => bicolor
          ? twoToneBondCylinderGeometry({ startColor: item.startColor, endColor: item.endColor,
            length: 1, radius: 1, radialSegments: detail.cylinder })
          : new CylinderGeometry(1, 1, 1, detail.cylinder));
        // This snapshot's canonical two-strip geometry is unit-radius, unit-height and open-ended.
        if (bicolor) geometry.userData.pathTracingCylinder = true;
        const mesh = addMesh(geometry, materialFor("bond", families.bond,
          bicolor ? "#ffffff" : item.startColor, item.opacity, bicolor), item.id);
        mesh.position.copy(item.center);
        mesh.quaternion.copy(item.quaternion);
        mesh.scale.set(item.radius, item.length, item.radius);
        mesh.userData = { kind: "bond", bondId: item.id,
          startAtomIndex: item.startAtomIndex, endAtomIndex: item.endAtomIndex };
      }
      await yieldPreparation(signal);
    }

    const polyhedronOpacity = componentOpacity.polyhedra / 100;
    if (polyhedronOpacity > 0) {
      const polyhedronAtoms = source.polyhedronAtoms ?? source.atoms;
      const seenFaces = new Set<string>();
      const seenEdges = new Set<string>();
      const edgeOpacity = Math.min(1, Math.sqrt(polyhedronOpacity / 0.4) * 0.95);
      const edgeMaterial = materialFor("polyhedron-edge", null, "#000000", edgeOpacity);
      for (let polyhedronIndex = 0; polyhedronIndex < source.polyhedra.length; polyhedronIndex++) {
        if (polyhedronIndex % 16 === 0) await yieldPreparation(signal);
        const polyhedron = source.polyhedra[polyhedronIndex]!;
        const centerAtom = polyhedronAtoms[polyhedron.centerAtomIndex];
        if (!centerAtom) continue;
        if (polyhedron.faces.length > PATH_TRACING_GEOMETRY_LIMITS.facesPerPolyhedron
          || polyhedron.hullAtomIndices.length > PATH_TRACING_GEOMETRY_LIMITS.facesPerPolyhedron) {
          throw geometryLimitError();
        }
        if (polyhedron.hullAtomIndices.some(index => !polyhedronAtoms[index])) continue;
        for (const index of polyhedron.hullAtomIndices) assertFinitePoint(polyhedronAtoms[index]!.position);
        const geometry = polyhedronGeometryFromAtoms(polyhedron, polyhedronAtoms);
        if (!geometry) continue;
        geometries.add(geometry);
        // The viewport draws coincident shared faces once; keep the same optical thickness here.
        const uniqueIndices: number[] = [];
        for (const face of polyhedron.faces) {
          const key = face.map(index => polyhedronAtoms[polyhedron.hullAtomIndices[index]!]!.position.join(",")).sort().join("|");
          if (seenFaces.has(key)) continue;
          seenFaces.add(key);
          uniqueIndices.push(...face);
        }
        if (uniqueIndices.length) {
          geometry.setIndex(uniqueIndices);
          const flatGeometry = geometry.toNonIndexed();
          flatGeometry.computeVertexNormals();
          geometry.dispose();
          geometries.delete(geometry);
          geometries.add(flatGeometry);
          const color = polyhedronColorForElement(style, centerAtom.element);
          const mesh = addMesh(flatGeometry, materialFor("polyhedron", families.polyhedron, color, polyhedronOpacity),
            `polyhedron:${polyhedronIndex}`);
          mesh.userData = { kind: "polyhedron", centerAtomIndex: polyhedron.centerAtomIndex };
        } else {
          geometry.dispose();
          geometries.delete(geometry);
        }
        const edges = createPolyhedronEdges([polyhedron], polyhedronAtoms);
        for (let index = 0; index < edges.length; index++) {
          const edge = edges[index]!;
          const key = `${edge.start.join(",")}|${edge.end.join(",")}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            addLine(edge.start, edge.end, options.polyhedronEdgeRadius, edgeMaterial, `polyhedron-edge:${seenEdges.size}`);
          }
          if ((index + 1) % BATCH_SIZE === 0) await yieldPreparation(signal);
        }
      }
    }

    if (options.showUnitCell && componentOpacity.unitCell > 0) {
      const positions = cellFrameLinePositions(source.cell.vectors);
      const material = materialFor("unit-cell", null, options.unitCellColor, componentOpacity.unitCell / 100);
      let distance = 0;
      for (let index = 0; index < positions.length; index += 6) {
        const a = new Vector3().fromArray(positions, index);
        const b = new Vector3().fromArray(positions, index + 3);
        const length = a.distanceTo(b);
        if (options.unitCellLineStyle !== "dashed") {
          addLine(a.toArray(), b.toArray(), options.unitCellRadius, material, `unit-cell:${index / 6}`);
        } else if (length > 1e-12) {
          // LineSegments2 uses cumulative world-space distances across its twelve edges.
          const period = CELL_FRAME_DASH_SIZE + CELL_FRAME_GAP_SIZE;
          const lineEnd = distance + length;
          for (let dash = Math.floor(distance / period) * period; dash < lineEnd; dash += period) {
            const start = Math.max(distance, dash), end = Math.min(lineEnd, dash + CELL_FRAME_DASH_SIZE);
            if (end <= start) continue;
            addLine(a.clone().lerp(b, (start - distance) / length).toArray(),
              a.clone().lerp(b, (end - distance) / length).toArray(), options.unitCellRadius, material,
              `unit-cell:${index / 6}:${dash}`);
            if (meshCount % BATCH_SIZE === 0) await yieldPreparation(signal);
          }
        }
        distance += length;
      }
    }
    signal?.throwIfAborted();
    scene.updateMatrixWorld(true);
    const size = new Box3().setFromObject(structure).getSize(new Vector3());
    scene.userData.studioRadius = Math.max(1, size.x, size.y, size.z);
    const meshes = structure.children as Mesh<BufferGeometry, MeshPhysicalMaterial>[];
    const atomMeshes = meshes.filter(mesh => mesh.userData.kind === "atom");
    const bondMeshes = meshes.filter(mesh => mesh.userData.kind === "bond");
    return { scene, triangleCount, dispose,
      updateAppearance(next) {
        next.signal?.throwIfAborted();
        if (disposed || snapshotGeometryIdentity(next) !== geometryIdentity
          || next.unitCellRadius !== currentUnitCellRadius || next.polyhedronEdgeRadius !== currentEdgeRadius) return false;
        const colorScheme = baseColorSchemeForStyle(next.style);
        const colorOverrides = elementColorOverridesForStyle(next.scene.atoms, next.style);
        const atomItems = next.showAtoms ? createAtomRenderItems({ atoms: next.scene.atoms,
          atomOpacity: next.componentOpacity.atoms, colorScheme, colorOverrides, style: next.style }).filter(item => item.radius > 0) : [];
        const bondItems = createBondRenderItems({ atoms: next.scene.atoms, bonds: next.scene.bonds,
          bondColor: next.style.bondColor, bondOpacity: next.componentOpacity.bonds,
          bondRadius: BOND_RADIUS * next.style.bondThickness / 100, colorMode: next.style.bondColorMode,
          colorScheme, colorOverrides, style: next.style }).filter(item => item.radius > 0);
        if (atomItems.length !== atomMeshes.length || bondItems.length !== bondMeshes.length) return false;
        for (let i = 0; i < atomItems.length; i++) {
          const item = atomItems[i]!, mesh = atomMeshes[i]!;
          if (mesh.name !== item.id || mesh.scale.x !== item.radius
            || !mesh.position.toArray().every((value, axis) => value === item.position[axis])) return false;
        }
        for (let i = 0; i < bondItems.length; i++) {
          const item = bondItems[i]!, mesh = bondMeshes[i]!;
          if (mesh.name !== item.id || mesh.scale.x !== item.radius || mesh.scale.y !== item.length
            || !mesh.position.equals(item.center) || !mesh.quaternion.equals(item.quaternion)) return false;
        }
        const families = resolveStructureMaterialFamiliesForStyle(next.style);
        const nextMaterials = new Map<string, MeshPhysicalMaterial>();
        const createdGeometries = new Set<BufferGeometry>();
        const assignments: { mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>; material: MeshPhysicalMaterial; geometry?: BufferGeometry }[] = [];
        const nextBondGeometries = new Map<string, BufferGeometry>();
        const material = (target: string, family: ResolvedStructureMaterialFamily | null, color: string, opacity: number, vertexColors = false) =>
          materialFor(target, family, color, opacity, vertexColors, nextMaterials);
        try {
          atomItems.forEach((item, i) => assignments.push({ mesh: atomMeshes[i]!, material: material("atom", families.atom, item.color, item.opacity) }));
          if (next.style.bondColorMode === "bicolor") for (let i = 0; i < bondItems.length; i++) {
            const item = bondItems[i]!, geometry = bondMeshes[i]!.geometry;
            const start = new Color(item.startColor), end = new Color(item.endColor), colors = geometry.getAttribute("color");
            const matches = (index: number, color: Color) => colors.getX(index) === Math.fround(color.r)
              && colors.getY(index) === Math.fround(color.g) && colors.getZ(index) === Math.fround(color.b);
            if (matches(0, start) && matches(colors.count - 1, end)) nextBondGeometries.set(`${item.startColor}:${item.endColor}`, geometry);
          }
          bondItems.forEach((item, i) => {
            const mesh = bondMeshes[i]!, bicolor = next.style.bondColorMode === "bicolor";
            let geometry = mesh.geometry;
            if (bicolor) {
              const key = `${item.startColor}:${item.endColor}`;
              const cached = nextBondGeometries.get(key);
              if (cached) geometry = cached;
              else {
                const start = new Color(item.startColor), end = new Color(item.endColor);
                // Shared color geometry must split when an object override changes only one bond.
                geometry = geometry.clone(); createdGeometries.add(geometry);
                const updated = geometry.getAttribute("color");
                for (let vertex = 0; vertex < updated.count; vertex++) {
                  const color = vertex < updated.count / 2 ? start : end;
                  updated.setXYZ(vertex, color.r, color.g, color.b);
                }
                updated.needsUpdate = true;
                nextBondGeometries.set(key, geometry);
              }
            }
            assignments.push({ mesh, geometry, material: material("bond", families.bond,
              bicolor ? "#ffffff" : item.startColor, item.opacity, bicolor) });
          });
          const polyhedronOpacity = next.componentOpacity.polyhedra / 100;
          const polyhedronAtoms = next.scene.polyhedronAtoms ?? next.scene.atoms;
          for (const mesh of meshes) {
            if (mesh.userData.kind === "polyhedron") {
              const atom = polyhedronAtoms[mesh.userData.centerAtomIndex as number]!;
              assignments.push({ mesh, material: material("polyhedron", families.polyhedron,
                polyhedronColorForElement(next.style, atom.element), polyhedronOpacity) });
            } else if (mesh.userData.kind === "polyhedron-edge") {
              assignments.push({ mesh, material: material("polyhedron-edge", null, "#000000",
                Math.min(1, Math.sqrt(polyhedronOpacity / 0.4) * 0.95)) });
            } else if (mesh.userData.kind === "unit-cell") {
              assignments.push({ mesh, material: material("unit-cell", null, next.unitCellColor, next.componentOpacity.unitCell / 100) });
            }
          }
          next.signal?.throwIfAborted();
        } catch (error) {
          nextMaterials.forEach(value => value.dispose());
          createdGeometries.forEach(value => value.dispose());
          throw error;
        }
        // All rejection/validation happens above: commit without yielding or rebuilding meshes.
        for (const assignment of assignments) {
          assignment.mesh.material = assignment.material;
          if (assignment.geometry) assignment.mesh.geometry = assignment.geometry;
        }
        materials.forEach(value => value.dispose()); materials = nextMaterials;
        createdGeometries.forEach(value => geometries.add(value));
        const usedGeometries = new Set(meshes.map(mesh => mesh.geometry));
        for (const geometry of geometries) if (!usedGeometries.has(geometry)) { geometry.dispose(); geometries.delete(geometry); }
        geometryCache.clear();
        return true;
      },
      updateLineRadii(unitCellRadius, polyhedronEdgeRadius) {
        if (![unitCellRadius, polyhedronEdgeRadius].every(value => Number.isFinite(value) && value > 0)) {
          throw invalidGeometryError();
        }
        for (const object of structure.children) {
          if (object.userData.kind === "unit-cell" || object.userData.kind === "polyhedron-edge") {
            const radius = object.userData.kind === "unit-cell" ? unitCellRadius : polyhedronEdgeRadius;
            object.scale.x = object.scale.z = radius;
          }
        }
        currentUnitCellRadius = unitCellRadius; currentEdgeRadius = polyhedronEdgeRadius;
        scene.updateMatrixWorld(true);
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Compare owned geometry inputs by value; React visibility selectors can return new arrays. */
function snapshotGeometryIdentity(options: CrystalPathTraceSceneOptions): string {
  const { scene, style } = options;
  return JSON.stringify([scene.atoms, scene.bonds, scene.polyhedra, scene.polyhedronAtoms, scene.cell.vectors,
    options.groupPosition, options.showAtoms, options.showUnitCell, options.quality, options.meshDetail,
    options.unitCellLineStyle ?? "solid", style.bondColorMode,
    options.componentOpacity.polyhedra > 0, options.componentOpacity.unitCell > 0,
    scene.atoms.map(atom => resolveAtomVisibleForStyle(atom, style.objectStyles))]);
}

function physicalMaterialFor(
  family: ResolvedStructureMaterialFamily | null, color: string, opacity: number, vertexColors: boolean,
): MeshPhysicalMaterial {
  const props = family?.material.props ?? {};
  const physical = family?.material.type === "MeshPhysicalMaterial" || family?.material.type === "MeshStandardMaterial";
  const roughness = !physical && typeof props.shininess === "number"
    ? Math.max(0.08, Math.min(1, Math.sqrt(2 / (props.shininess + 2)))) : 0.5;
  const material = new MeshPhysicalMaterial({ roughness, metalness: 0 });
  // Only native physical properties survive; illustration onBeforeCompile shaders are not traced.
  const supportedProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!(key in material)) continue;
    if (key === "iridescenceThicknessRange") {
      if (!isIridescenceThicknessRange(value)) throw new Error("Invalid physical iridescence thickness range.");
      supportedProps[key] = [value[0], value[1]];
    } else if (["number", "string", "boolean"].includes(typeof value)) {
      supportedProps[key] = value;
    }
  }
  material.setValues(supportedProps as MeshPhysicalMaterialParameters);
  material.color = new Color(color);
  material.opacity = opacity;
  material.transparent = opacity < 1;
  material.depthWrite = opacity >= 1;
  material.vertexColors = vertexColors;
  material.side = FrontSide;
  return material;
}

function assertFinitePoint(point: readonly number[]) {
  if (point.length !== 3 || point.some(value => !Number.isFinite(value))) throw invalidGeometryError();
}

function invalidGeometryError() {
  return new PathTracingSceneError("invalid-geometry", "结构包含无效坐标或半径，无法进行路径追踪。");
}

function geometryLimitError() {
  return new PathTracingSceneError("geometry-limit", "结构超出路径追踪几何上限，请降低画质或减少显示的原子、键及多面体。");
}

async function yieldPreparation(signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}
