import type { AtomSpec, SceneSpec } from "../api/scene";
import type { SceneMeasurement } from "./measurements";
import { fractionalToCartesian, type ModelState, type Vec3 } from "./structureModel";

export interface ModelReferenceSnapshot {
  measurements: SceneMeasurement[];
  focus: { atomIds: string[]; neighbors: boolean } | null;
}
export interface ModelReferenceReplay { target: ModelReferenceSnapshot; expected: ModelReferenceSnapshot }

const EPSILON = 1e-7;
const INVALID_REFERENCE = "\0model-reference-unavailable:";
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const sameMeasurement = (a: SceneMeasurement, b: SceneMeasurement) => a.kind === b.kind && sameIds(a.atomIds, b.atomIds);
const sameFocus = (a: ModelReferenceSnapshot["focus"], b: ModelReferenceSnapshot["focus"]) => a === b
  || Boolean(a && b && a.neighbors === b.neighbors && sameIds(a.atomIds, b.atomIds));
const mapMeasurement = (measurement: SceneMeasurement, map: (id: string) => string): SceneMeasurement => measurement.kind === "distance"
  ? { ...measurement, atomIds: [map(measurement.atomIds[0]), map(measurement.atomIds[1])] }
  : { ...measurement, atomIds: [map(measurement.atomIds[0]), map(measurement.atomIds[1]), map(measurement.atomIds[2])] };

export function cloneModelReferences(snapshot: ModelReferenceSnapshot): ModelReferenceSnapshot {
  return { measurements: snapshot.measurements.map(m => mapMeasurement(m, id => id)),
    focus: snapshot.focus ? { ...snapshot.focus, atomIds: [...snapshot.focus.atomIds] } : null };
}

/** Replay only the references still owned by this transaction, never later user edits. */
export function mergeModelReferences(current: ModelReferenceSnapshot, target: ModelReferenceSnapshot,
  expected?: ModelReferenceSnapshot, fallback = current): ModelReferenceSnapshot {
  const targets = new Map(target.measurements.map(m => [m.id, m]));
  const expectations = new Map(expected?.measurements.map(m => [m.id, m]));
  const fallbacks = new Map(fallback.measurements.map(m => [m.id, m]));
  return {
    measurements: current.measurements.map(measurement => {
      const next = targets.get(measurement.id), previous = expectations.get(measurement.id);
      return next && (!expected || previous && sameMeasurement(measurement, previous))
        ? { ...measurement, kind: next.kind, atomIds: [...next.atomIds] } as SceneMeasurement
        : fallbacks.get(measurement.id) ?? measurement;
    }),
    focus: !expected || sameFocus(current.focus, expected.focus)
      ? target.focus ? { ...target.focus, atomIds: [...target.focus.atomIds] } : null : fallback.focus,
  };
}

function sameCell(before: ModelState, after: ModelState): boolean {
  return before.structure.cell.vectors.every((v, axis) => v.every((value, component) =>
    Math.abs(value - after.structure.cell.vectors[axis]![component]!) < EPSILON));
}

function diagonalRepeat(before: ModelState, after: ModelState): Vec3 | null {
  const repeat: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const oldVector = before.structure.cell.vectors[axis]!, newVector = after.structure.cell.vectors[axis]!;
    const component = oldVector.reduce((best, value, index) => Math.abs(value) > Math.abs(oldVector[best]!) ? index : best, 0);
    const ratio = newVector[component]! / oldVector[component]!;
    const rounded = Math.round(ratio);
    if (rounded < 1 || Math.abs(ratio - rounded) > EPSILON || oldVector.some((value, i) => Math.abs(value * rounded - newVector[i]!) > EPSILON)) return null;
    repeat.push(rounded);
  }
  const copies = repeat.reduce((a, b) => a * b, 1);
  if (copies <= 1 || after.structure.sites.length !== before.structure.sites.length * copies) return null;
  const oldSites = new Map(before.structure.sites.map(s => [s.siteId, s]));
  for (const site of after.structure.sites) {
    const original = oldSites.get(site.originSiteId ?? "");
    if (!original || !site.copyOffset || site.fractionalPosition.some((v, i) =>
      Math.abs(v - (original.fractionalPosition[i]! + site.copyOffset![i]!) / repeat[i]!) > EPSILON)) return null;
  }
  return repeat as Vec3;
}

function commonTranslation(before: ModelState, after: ModelState): Vec3 | null {
  if (before.structure.sites.length !== after.structure.sites.length) return null;
  const oldSites = new Map(before.structure.sites.map(site => [site.siteId, site]));
  const pairs: [Vec3, Vec3][] = [];
  for (const site of after.structure.sites) {
    const old = oldSites.get(site.siteId);
    if (!old) return null;
    pairs.push([old.fractionalPosition, site.fractionalPosition]);
  }
  const oldDefects = new Map(before.defects.map(d => [d.id, d]));
  const defectPairs = after.defects.flatMap(d => oldDefects.has(d.id)
    ? [[oldDefects.get(d.id)!.fractionalPosition, d.fractionalPosition] as [Vec3, Vec3]] : []);
  // A centered anchor retains the intended translation instead of an arbitrary wrapped image.
  const anchor = [...defectPairs, ...pairs].find(([, target]) => target.every(v => Math.abs(v - 0.5) < EPSILON)) ?? pairs[0];
  if (!anchor) return null;
  const shift = anchor[1].map((value, i) => value - anchor[0][i]!) as Vec3;
  if (!pairs.every(([old, next]) => next.every((v, i) => {
    const delta = v - old[i]! - shift[i]!;
    return Math.abs(delta - Math.round(delta)) < EPSILON;
  }))) return null;
  return shift;
}

export function mapModelReferences(snapshot: ModelReferenceSnapshot, before: ModelState, after: ModelState,
  beforeScene: SceneSpec, afterScene: SceneSpec): ModelReferenceSnapshot {
  const unchangedCell = sameCell(before, after);
  const repeat = unchangedCell ? null : diagonalRepeat(before, after);
  const translation = unchangedCell ? commonTranslation(before, after) : null;
  // Ordinary site edits retain identity and intentionally update measured geometry.
  if (unchangedCell && (!translation || translation.every(v => Math.abs(v) < EPSILON))) return cloneModelReferences(snapshot);
  const shift = translation ? fractionalToCartesian(translation, before.structure.cell.vectors) : [0, 0, 0];
  const beforeAtoms = new Map(beforeScene.atoms.map(atom => [atom.id, atom]));
  const afterSites = new Map(after.structure.sites.map(site => [site.siteId, site]));
  const candidates = new Map<string, AtomSpec[]>();
  for (const atom of afterScene.atoms) {
    const origin = repeat ? afterSites.get(atom.siteId)?.originSiteId : atom.siteId;
    if (!origin) continue;
    const group = candidates.get(origin) ?? [];
    group.push(atom); candidates.set(origin, group);
  }
  const afterIds = new Set(afterScene.atoms.map(atom => atom.id));
  const mapped = new Map<string, string>();
  const map = (id: string) => {
    if (mapped.has(id)) return mapped.get(id)!;
    if (id.startsWith(INVALID_REFERENCE)) return id;
    const atom = beforeAtoms.get(id);
    const target = atom && (repeat || translation) ? candidates.get(atom.siteId)?.find(candidate =>
      candidate.position.every((value, i) => Math.abs(value - atom.position[i]! - shift[i]!) < EPSILON)) : undefined;
    let result = target?.id ?? `${INVALID_REFERENCE}${id}`;
    while (!target && afterIds.has(result)) result = `\0${result}`;
    mapped.set(id, result);
    return result;
  };
  return { measurements: snapshot.measurements.map(m => mapMeasurement(m, map)),
    focus: snapshot.focus ? { ...snapshot.focus, atomIds: snapshot.focus.atomIds.map(map) } : null };
}

export function transitionModelReferences(current: ModelReferenceSnapshot, before: ModelState, after: ModelState,
  beforeScene: SceneSpec, afterScene: SceneSpec, replay?: ModelReferenceReplay): ModelReferenceSnapshot {
  const mapped = mapModelReferences(current, before, after, beforeScene, afterScene);
  return replay ? mergeModelReferences(current, replay.target, replay.expected, mapped) : mapped;
}
