import type { AtomSpec, SceneSpec } from "../api/scene";
import { buildCoordinationPolyhedron, isAutomaticPolyhedronCenter } from "../api/vaspPolyhedra";

export type PolyhedronDisplayState =
  | { mode: "auto" }
  | { mode: "selected"; centerAtomIds: string[] };

export const DEFAULT_POLYHEDRON_DISPLAY: PolyhedronDisplayState = { mode: "auto" };
export const MAX_POLYHEDRON_CENTERS = 25_600;

export function isPolyhedronDisplayState(value: unknown): value is PolyhedronDisplayState {
  if (!value || typeof value !== "object" || !("mode" in value)) return false;
  if (value.mode === "auto") return true;
  if (value.mode !== "selected" || !("centerAtomIds" in value) || !Array.isArray(value.centerAtomIds)) return false;
  const ids: unknown[] = value.centerAtomIds;
  return ids.length > 0 && ids.length <= MAX_POLYHEDRON_CENTERS
    && ids.every(id => typeof id === "string" && id.trim().length > 0)
    && new Set(ids).size === ids.length;
}

export interface PolyhedronDisplayIssue {
  centerAtomId: string;
  reason: "missing-center" | "incomplete-coordination" | "too-few-neighbors" | "degenerate";
  neighborCount: number;
}

export interface PolyhedronDisplayResult {
  scene: SceneSpec;
  requested: number;
  generated: number;
  issues: PolyhedronDisplayIssue[];
}

/** Prepare geometry from the raw scene after deletions, before visibility filters. */
export function preparePolyhedronDisplay(scene: SceneSpec, state: PolyhedronDisplayState): PolyhedronDisplayResult {
  if (state.mode === "auto") {
    scene = repairLegacyPolyhedronShells(scene);
    return { scene, requested: scene.polyhedra.length, generated: scene.polyhedra.length, issues: [] };
  }
  const centerAtomIds = [...new Set(state.centerAtomIds)];
  if (centerAtomIds.length > MAX_POLYHEDRON_CENTERS) throw new Error("配位多面体超过 25,600 个的预览上限");
  const indicesById = new Map(scene.atoms.map((atom, index) => [atom.id, index]));
  const neighbors = coordinationNeighbors(scene);
  const existingAtoms = scene.polyhedronAtoms ?? scene.atoms;
  const existingByCenter = new Map(scene.polyhedra.map(polyhedron => [
    existingAtoms[polyhedron.centerAtomIndex]?.id, polyhedron,
  ]));
  const polyhedra: SceneSpec["polyhedra"] = [];
  const issues: PolyhedronDisplayIssue[] = [];
  for (const centerAtomId of centerAtomIds) {
    const centerAtomIndex = indicesById.get(centerAtomId);
    const center = centerAtomIndex === undefined ? undefined : scene.atoms[centerAtomIndex];
    const neighborIndices = centerAtomIndex === undefined ? new Set<number>() : neighbors[centerAtomIndex]!;
    const neighborCount = neighborIndices.size;
    let reason: PolyhedronDisplayIssue["reason"] | undefined;
    if (!center || centerAtomIndex === undefined) reason = "missing-center";
    else if (!hasCompleteCoordination(center)) reason = "incomplete-coordination";
    else if (neighborCount < 4) reason = "too-few-neighbors";
    else {
      const existing = existingAtoms === scene.atoms ? existingByCenter.get(centerAtomId) : undefined;
      const existingNeighbors = new Set(existing?.hullAtomIndices.filter(index => index !== centerAtomIndex));
      const reusable = existing && existingNeighbors.size === neighborCount
        && [...neighborIndices].every(index => existingNeighbors.has(index))
        && existing.faces.every(face => face.every(index => existing.hullAtomIndices[index] !== centerAtomIndex));
      const polyhedron = reusable ? existing : buildCoordinationPolyhedron(scene.atoms, centerAtomIndex, neighborIndices);
      if (polyhedron) polyhedra.push(polyhedron);
      else reason = "degenerate";
    }
    if (reason) issues.push({ centerAtomId, reason, neighborCount });
  }
  return { scene: { ...scene, polyhedronAtoms: scene.atoms, polyhedra },
    requested: centerAtomIds.length, generated: polyhedra.length, issues };
}

/** Old saved scenes may contain faces that incorrectly use the center as a vertex. */
function repairLegacyPolyhedronShells(scene: SceneSpec): SceneSpec {
  const atoms = scene.polyhedronAtoms ?? scene.atoms;
  let changed = false;
  const polyhedra = scene.polyhedra.flatMap(polyhedron => {
    if (!polyhedron.faces.some(face => face.some(index => polyhedron.hullAtomIndices[index] === polyhedron.centerAtomIndex))) {
      return [polyhedron];
    }
    changed = true;
    const repaired = buildCoordinationPolyhedron(atoms, polyhedron.centerAtomIndex, polyhedron.hullAtomIndices);
    return repaired ? [{ ...polyhedron, hullAtomIndices: repaired.hullAtomIndices, faces: repaired.faces }] : [];
  });
  return changed ? { ...scene, polyhedra } : scene;
}

export type AutoPolyhedronAvailability = "available" | "deferred" | "no-bonds"
  | "insufficient-coordination" | "automatic-center-filter" | "degenerate-or-unavailable";

/** Describe only causes supported by the current graph and its known generator. */
export function classifyAutoPolyhedronAvailability(scene: SceneSpec): AutoPolyhedronAvailability {
  if (scene.connectivity === "deferred") return "deferred";
  scene = repairLegacyPolyhedronShells(scene);
  if (scene.polyhedra.length > 0) return "available";
  if (scene.bonds.length === 0) return "no-bonds";
  const neighbors = coordinationNeighbors(scene);
  const candidates = scene.atoms.flatMap((atom, index) =>
    hasCompleteCoordination(atom) && neighbors[index]!.size >= 4 ? [index] : []);
  if (candidates.length === 0) return "insufficient-coordination";
  if (scene.sourceFormat === "vasp" && !candidates.some(index =>
    isAutomaticPolyhedronCenter(scene.atoms, index, neighbors[index]!))) return "automatic-center-filter";
  return "degenerate-or-unavailable";
}

function hasCompleteCoordination(atom: AtomSpec): boolean {
  return !atom.isPeriodicImage || atom.imageReasons.includes("boundary");
}

function coordinationNeighbors(scene: SceneSpec): Set<number>[] {
  const neighbors = scene.atoms.map(() => new Set<number>());
  for (const bond of scene.bonds) {
    const { startAtomIndex: start, endAtomIndex: end } = bond;
    if (start === end || !scene.atoms[start] || !scene.atoms[end]) continue;
    neighbors[start]!.add(end);
    neighbors[end]!.add(start);
  }
  return neighbors;
}
