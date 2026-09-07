import type { AtomSpec, SceneSpec } from "../api/scene";
import { applySceneDeletions } from "./sceneEdits";

type Point3 = [number, number, number];
export type MeasurementDisplayMode = "all" | "distance" | "angle";

export interface MeasurementStyle {
  color: string;
  fontScale: number;
  fontWeight: 300 | 400 | 500 | 600;
  showLabels: boolean;
  displayMode?: MeasurementDisplayMode;
}
export const DEFAULT_MEASUREMENT_STYLE: MeasurementStyle = {
  color: "#333333", fontScale: 100, fontWeight: 400, showLabels: true, displayMode: "all",
};

export type SceneMeasurement =
  | { id: string; kind: "distance"; atomIds: [string, string] }
  | { id: string; kind: "angle"; atomIds: [string, string, string] };

export function measurementIsDisplayed(measurement: SceneMeasurement, style?: MeasurementStyle): boolean {
  return !style?.displayMode || style.displayMode === "all" || style.displayMode === measurement.kind;
}

export interface ResolvedMeasurement {
  definition: SceneMeasurement;
  points: Point3[];
  value: number;
  label: string;
  labelPosition: Point3;
}

export function resolveMeasurement(
  scene: SceneSpec,
  measurement: SceneMeasurement,
): ResolvedMeasurement | null {
  const selectedIds = new Set(measurement.atomIds);
  if (selectedIds.size !== measurement.atomIds.length) return null;
  const atoms = new Map<string, AtomSpec>();
  for (const atom of scene.atoms) {
    if (!selectedIds.has(atom.id)) continue;
    if (atoms.has(atom.id)) return null;
    atoms.set(atom.id, atom);
  }
  const points: Point3[] = [];
  for (const id of measurement.atomIds) {
    const atom = atoms.get(id);
    if (!atom || !atom.position.every(Number.isFinite)) return null;
    points.push([...atom.position]);
  }

  // Measure the selected images in Cartesian space; never wrap to a closer image.
  const [first, second] = points as [Point3, Point3, ...Point3[]];
  const firstArm = subtract(first, second);
  const firstLength = length(firstArm);
  if (!Number.isFinite(firstLength) || firstLength === 0) return null;
  if (measurement.kind === "distance") {
    return {
      definition: measurement,
      points,
      value: firstLength,
      label: `${firstLength.toFixed(3)} Å`,
      labelPosition: add(second, scale(firstArm, 0.5)),
    };
  }

  const secondArm = subtract(points[2]!, second);
  const secondLength = length(secondArm);
  if (!Number.isFinite(secondLength) || secondLength === 0) return null;
  const firstDirection = scale(firstArm, 1 / firstLength);
  const secondDirection = scale(secondArm, 1 / secondLength);
  const value = Math.atan2(
    length(cross(firstDirection, secondDirection)),
    dot(firstDirection, secondDirection),
  ) * 180 / Math.PI;
  const bisector = add(firstDirection, secondDirection);
  const bisectorLength = length(bisector);
  // A straight angle has no unique bisector; use a stable perpendicular direction.
  const labelDirection = bisectorLength > 1e-10
    ? scale(bisector, 1 / bisectorLength)
    : perpendicular(firstDirection);
  return {
    definition: measurement,
    points,
    value,
    label: `${value.toFixed(2)}°`,
    labelPosition: add(second, scale(labelDirection, Math.min(firstLength, secondLength) * 0.3)),
  };
}

export function findAtomsBySourceNumber(scene: SceneSpec, number: number): AtomSpec[] {
  if (!Number.isInteger(number)) return [];
  const originals: AtomSpec[] = [];
  const images: AtomSpec[] = [];
  for (const atom of scene.atoms) {
    if ((atom.sourceAtomNumber ?? atom.siteIndex) !== number) continue;
    (atom.isPeriodicImage ? images : originals).push(atom);
  }
  return [...originals, ...images];
}

export function firstNeighborAtomIds(scene: SceneSpec, seedIds: ReadonlySet<string>): Set<string> {
  const result = new Set(seedIds);
  for (const bond of scene.bonds) {
    const start = scene.atoms[bond.startAtomIndex];
    const end = scene.atoms[bond.endAtomIndex];
    if (!start || !end) continue;
    if (seedIds.has(start.id)) result.add(end.id);
    if (seedIds.has(end.id)) result.add(start.id);
  }
  return result;
}

export function filterSceneToAtomIds(scene: SceneSpec, keepIds: ReadonlySet<string>): SceneSpec {
  const deletedIds = new Set(scene.atoms.filter(atom => !keepIds.has(atom.id)).map(atom => atom.id));
  if (deletedIds.size === 0) return scene;
  const filtered = applySceneDeletions(scene, { atoms: deletedIds, bonds: new Set() })!;
  return { ...filtered, summary: scene.summary };
}

function subtract(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Point3, b: Point3): Point3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(point: Point3, factor: number): Point3 {
  return [point[0] * factor, point[1] * factor, point[2] * factor];
}

function length(point: Point3): number {
  return Math.hypot(...point);
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Point3, b: Point3): Point3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function perpendicular(direction: Point3): Point3 {
  const [x, y, z] = direction.map(Math.abs) as Point3;
  const axis: Point3 = x <= y && x <= z ? [1, 0, 0] : y <= z ? [0, 1, 0] : [0, 0, 1];
  const normal = cross(direction, axis);
  return scale(normal, 1 / length(normal));
}
