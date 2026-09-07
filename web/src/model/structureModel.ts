import { Matrix3, Vector3 } from "three";
import type { BondCutoffRange, SceneSpec } from "../api/scene";
import { buildVaspScene } from "../api/vasp";
import { hasElementRadius } from "./elementRadii";
import { findPeriodicElement } from "../data/periodic-table";
import type { PeriodicStructure, StructureSite } from "./periodicStructure";

export type Vec3 = [number, number, number];
export type Coordinates = "direct" | "cartesian";
export interface DefectRecord {
  id: string;
  kind: "vacancy" | "substitution" | "interstitial";
  siteId: string;
  fractionalPosition: Vec3;
  originalSite?: StructureSite;
  originalElement?: string;
  originalIndex?: number;
  previousSubstitution?: { id: string; originalElement: string };
}
export interface ModelState {
  structure: PeriodicStructure;
  defects: DefectRecord[];
}
export type ModelOperation =
  | { type: "vacancy"; siteIds: string[] }
  | { type: "substitute"; siteIds: string[]; element: string }
  | { type: "interstitial"; element: string; position: Vec3; coordinates: Coordinates }
  | { type: "move"; siteId: string; position: Vec3; coordinates: Coordinates }
  | { type: "constraints"; siteIds: string[]; flags: [boolean, boolean, boolean] }
  | { type: "supercell"; repeat: Vec3 }
  | { type: "center"; defectId?: string; siteId?: string }
  | { type: "restore"; defectId: string };
export interface ModelOperationResult { state: ModelState; warnings: string[] }

const EDIT_ERRORS = {
  invalidCell: "晶胞必须包含三个有限的三维矢量",
  rightHandedCell: "建模需要体积非零的右手晶胞",
  atomLimit: "真实原子数必须在 1–25,600 之间",
  unknownElement: "结构包含未知元素，不能建模",
  invalidSiteId: "原子位点 ID 缺失或重复",
  invalidSpeciesIndex: "原子元素索引无效",
  invalidCoordinates: "坐标必须为三个有限数字",
  invalidConstraints: "固定约束必须为三个 T/F 标记",
  searchLimit: "晶胞过于倾斜或原子过密，无法安全检查周期距离",
  overlappingSites: "存在周期边界下重叠的原子位点",
  missingSite: "所选原子位点已不存在",
  invalidElement: "请选择有效元素",
  invalidCoordinateMode: "坐标类型无效",
  emptySelection: "请先选择原子",
  missingCenter: "请选择要居中的缺陷或原子",
  missingDefect: "缺陷记录已不存在",
  invalidRestore: "无法恢复该空位",
  invalidRepeat: "扩胞倍数必须为三个正整数",
  supercellLimit: "扩胞后真实原子数超过 25,600",
} as const;
export type ModelEditErrorCode = keyof typeof EDIT_ERRORS;
export class ModelEditError extends Error {
  constructor(readonly code: ModelEditErrorCode) { super(EDIT_ERRORS[code]); this.name = "ModelEditError"; }
}

const MAX_SITES = 25_600;
const OVERLAP_DISTANCE = 1e-5;
const CLOSE_DISTANCE = 0.5;
const SEARCH_BUDGET = 2_000_000;
const tuple = (values: number[]): Vec3 => [values[0]!, values[1]!, values[2]!];
const wrap = (value: number) => ((value % 1) + 1) % 1;
const cloneSite = (site: StructureSite): StructureSite => ({ ...site,
  fractionalPosition: [...site.fractionalPosition],
  ...(site.copyOffset ? { copyOffset: [...site.copyOffset] as Vec3 } : {}),
  ...(site.selectiveDynamics ? { selectiveDynamics: [...site.selectiveDynamics] as [boolean, boolean, boolean] } : {}),
});
const uid = () => crypto.randomUUID();

function latticeMatrix(structure: PeriodicStructure): Matrix3 {
  const vectors = structure.cell.vectors;
  if (vectors.length !== 3 || vectors.some(v => v.length !== 3 || !v.every(Number.isFinite))) {
    throw new ModelEditError("invalidCell");
  }
  const [a, b, c] = vectors as [Vec3, Vec3, Vec3];
  const matrix = new Matrix3().set(a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]);
  if (!Number.isFinite(matrix.determinant()) || matrix.determinant() <= 1e-10) throw new ModelEditError("rightHandedCell");
  return matrix;
}

export function validateModelStructure(structure: PeriodicStructure): void {
  latticeMatrix(structure);
  if (!structure.sites.length || structure.sites.length > MAX_SITES) throw new ModelEditError("atomLimit");
  if (!structure.species.every(element => findPeriodicElement(element))) throw new ModelEditError("unknownElement");
  const ids = new Set<string>();
  for (const site of structure.sites) {
    if (!site.siteId || ids.has(site.siteId)) throw new ModelEditError("invalidSiteId");
    ids.add(site.siteId);
    if (!Number.isInteger(site.speciesIndex) || !structure.species[site.speciesIndex]) throw new ModelEditError("invalidSpeciesIndex");
    if (site.fractionalPosition.length !== 3 || !site.fractionalPosition.every(Number.isFinite)) throw new ModelEditError("invalidCoordinates");
    if (site.selectiveDynamics && (site.selectiveDynamics.length !== 3 || !site.selectiveDynamics.every(v => typeof v === "boolean"))) {
      throw new ModelEditError("invalidConstraints");
    }
  }
}

/** Reciprocal bounds enumerate all images inside the cutoff, not just rounded fractions. */
export function inspectModelDistances(structure: PeriodicStructure): string[] {
  const matrix = latticeMatrix(structure);
  const inverse = matrix.clone().invert().elements;
  const reach = [0, 1, 2].map(i => CLOSE_DISTANCE * Math.hypot(inverse[i]!, inverse[i + 3]!, inverse[i + 6]!));
  const bins = reach.map(r => Math.max(1, Math.floor(1 / r)));
  const buckets = new Map<string, number[]>();
  const positions = structure.sites.map(site => site.fractionalPosition.map(wrap));
  let searches = 0;
  let shortest = Infinity;
  const imageDistance = (delta: number[], sameSite: boolean) => {
    const lo = delta.map((d, i) => Math.ceil(-d - reach[i]!));
    const hi = delta.map((d, i) => Math.floor(-d + reach[i]!));
    for (let a = lo[0]!; a <= hi[0]!; a++) for (let b = lo[1]!; b <= hi[1]!; b++) for (let c = lo[2]!; c <= hi[2]!; c++) {
      if (sameSite && a === 0 && b === 0 && c === 0) continue;
      if (++searches > SEARCH_BUDGET) throw new ModelEditError("searchLimit");
      const distance = new Vector3(delta[0]! + a, delta[1]! + b, delta[2]! + c).applyMatrix3(matrix).length();
      if (distance < OVERLAP_DISTANCE) throw new ModelEditError("overlappingSites");
      shortest = Math.min(shortest, distance);
    }
  };
  imageDistance([0, 0, 0], true);
  positions.forEach((position, index) => {
    const cell = position.map((v, i) => Math.min(bins[i]! - 1, Math.floor(v * bins[i]!)));
    const neighboring = cell.map((v, i) => [...new Set([-1, 0, 1].map(d => (v + d + bins[i]!) % bins[i]!))]);
    for (const a of neighboring[0]!) for (const b of neighboring[1]!) for (const c of neighboring[2]!) {
      for (const previous of buckets.get(`${a},${b},${c}`) ?? []) {
        if (++searches > SEARCH_BUDGET) throw new ModelEditError("searchLimit");
        imageDistance(position.map((v, i) => v - positions[previous]![i]!), false);
      }
    }
    const key = cell.join(",");
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  return shortest < CLOSE_DISTANCE ? [`周期原子间距仅 ${shortest.toFixed(4)} Å，请检查结构。`] : [];
}

export function createModelState(structure: PeriodicStructure): ModelState {
  validateModelStructure(structure);
  inspectModelDistances(structure);
  return { structure: { cell: { vectors: structure.cell.vectors.map(v => [...v]) },
    species: [...structure.species], sites: structure.sites.map(cloneSite) }, defects: [] };
}

export function fractionalToCartesian(position: Vec3, cellVectors: Vec3[]): Vec3 {
  return new Vector3(...position).applyMatrix3(latticeMatrix({ cell: { vectors: cellVectors }, species: [], sites: [] })).toArray();
}

export function cartesianToFractional(position: Vec3, cellVectors: Vec3[]): Vec3 {
  return new Vector3(...position).applyMatrix3(latticeMatrix({ cell: { vectors: cellVectors }, species: [], sites: [] }).invert()).toArray();
}

function cloneState(state: ModelState): ModelState {
  return { structure: { cell: { vectors: state.structure.cell.vectors.map(v => [...v]) },
    species: [...state.structure.species], sites: state.structure.sites.map(cloneSite) },
  defects: state.defects.map(defect => ({ ...defect, fractionalPosition: [...defect.fractionalPosition],
    ...(defect.previousSubstitution ? { previousSubstitution: { ...defect.previousSubstitution } } : {}),
    ...(defect.originalSite ? { originalSite: cloneSite(defect.originalSite) } : {}) })) };
}

export function applyModelOperation(input: ModelState, operation: ModelOperation): ModelOperationResult {
  validateModelStructure(input.structure);
  const state = cloneState(input);
  const structure = state.structure;
  let highestDisplayNumber = 0;
  const reserveNumber = (site: StructureSite, index: number) => {
    if (site.displayAtomNumber === undefined && site.sourceAtomNumber === undefined) site.displayAtomNumber = index + 1;
    highestDisplayNumber = Math.max(highestDisplayNumber, site.displayAtomNumber ?? site.sourceAtomNumber!);
  };
  structure.sites.forEach(reserveNumber);
  state.defects.forEach(defect => {
    if (defect.originalSite) reserveNumber(defect.originalSite, defect.originalIndex ?? structure.sites.length);
  });
  const nextDisplayNumber = () => ++highestDisplayNumber;
  const sitesById = new Map(structure.sites.map(site => [site.siteId, site]));
  const interstitialIds = new Set(state.defects.filter(d => d.kind === "interstitial").map(d => d.siteId));
  const findSite = (id: string) => {
    const site = sitesById.get(id);
    if (!site) throw new ModelEditError("missingSite");
    return site;
  };
  const speciesIndex = (element: string) => {
    if (!findPeriodicElement(element)) throw new ModelEditError("invalidElement");
    let index = structure.species.indexOf(element);
    if (index < 0) { index = structure.species.length; structure.species.push(element); }
    return index;
  };
  const position = (value: Vec3, coordinates: Coordinates): Vec3 => {
    if (value.length !== 3 || !value.every(Number.isFinite)) throw new ModelEditError("invalidCoordinates");
    if (coordinates !== "direct" && coordinates !== "cartesian") throw new ModelEditError("invalidCoordinateMode");
    return coordinates === "direct" ? [...value] : new Vector3(...value).applyMatrix3(latticeMatrix(structure).invert()).toArray();
  };
  if ("siteIds" in operation && !operation.siteIds.length) throw new ModelEditError("emptySelection");
  switch (operation.type) {
    case "vacancy": {
      const selected = new Set(operation.siteIds);
      operation.siteIds.forEach(findSite);
      const substitutions = new Map(state.defects.filter(d => d.kind === "substitution").map(d => [d.siteId, d]));
      state.defects = state.defects.filter(d => !selected.has(d.siteId) || d.kind === "vacancy");
      structure.sites.forEach((site, originalIndex) => {
        if (!selected.has(site.siteId)) return;
        const previousSubstitution = substitutions.get(site.siteId);
        if (!interstitialIds.has(site.siteId)) state.defects.push({ id: uid(), kind: "vacancy", siteId: site.siteId,
          fractionalPosition: [...site.fractionalPosition], originalSite: cloneSite(site), originalIndex,
          ...(previousSubstitution ? { previousSubstitution: { id: previousSubstitution.id, originalElement: previousSubstitution.originalElement! } } : {}) });
      });
      structure.sites = structure.sites.filter(site => !selected.has(site.siteId));
      break;
    }
    case "substitute": {
      const index = speciesIndex(operation.element);
      const substitutions = new Map(state.defects.filter(d => d.kind === "substitution").map(d => [d.siteId, d]));
      const removed = new Set<string>();
      for (const id of new Set(operation.siteIds)) {
        const site = findSite(id);
        const existing = substitutions.get(id);
        if (site.speciesIndex === index) continue;
        if (!interstitialIds.has(id)) {
          if (existing?.originalElement === operation.element) removed.add(existing.id);
          else if (!existing) state.defects.push({ id: uid(), kind: "substitution", siteId: id,
            fractionalPosition: [...site.fractionalPosition], originalElement: structure.species[site.speciesIndex] });
        }
        site.speciesIndex = index;
      }
      state.defects = state.defects.filter(d => !removed.has(d.id));
      break;
    }
    case "interstitial": {
      const site: StructureSite = { siteId: uid(), speciesIndex: speciesIndex(operation.element),
        displayAtomNumber: nextDisplayNumber(), fractionalPosition: position(operation.position, operation.coordinates) };
      structure.sites.push(site);
      state.defects.push({ id: uid(), kind: "interstitial", siteId: site.siteId, fractionalPosition: [...site.fractionalPosition] });
      break;
    }
    case "move": {
      const site = findSite(operation.siteId);
      site.fractionalPosition = position(operation.position, operation.coordinates);
      for (const defect of state.defects) if (defect.siteId === site.siteId) defect.fractionalPosition = [...site.fractionalPosition];
      break;
    }
    case "constraints":
      if (operation.flags.length !== 3 || !operation.flags.every(v => typeof v === "boolean")) throw new ModelEditError("invalidConstraints");
      for (const id of operation.siteIds) findSite(id).selectiveDynamics = [...operation.flags];
      break;
    case "center": {
      const target = operation.defectId ? state.defects.find(d => d.id === operation.defectId)?.fractionalPosition
        : operation.siteId ? findSite(operation.siteId).fractionalPosition : undefined;
      if (!target) throw new ModelEditError("missingCenter");
      const shift = target.map(v => 0.5 - v);
      const translate = (p: Vec3) => tuple(p.map((v, i) => wrap(v + shift[i]!)));
      for (const site of structure.sites) site.fractionalPosition = translate(site.fractionalPosition);
      for (const defect of state.defects) {
        defect.fractionalPosition = translate(defect.fractionalPosition);
        if (defect.originalSite) defect.originalSite.fractionalPosition = translate(defect.originalSite.fractionalPosition);
      }
      break;
    }
    case "restore": {
      const defect = state.defects.find(d => d.id === operation.defectId);
      if (!defect) throw new ModelEditError("missingDefect");
      if (defect.kind === "vacancy") {
        if (!defect.originalSite || structure.sites.some(s => s.siteId === defect.siteId)) throw new ModelEditError("invalidRestore");
        structure.sites.splice(Math.min(defect.originalIndex ?? structure.sites.length, structure.sites.length), 0, cloneSite(defect.originalSite));
        if (defect.previousSubstitution) state.defects.push({ ...defect.previousSubstitution, kind: "substitution",
          siteId: defect.siteId, fractionalPosition: [...defect.originalSite.fractionalPosition] });
      } else if (defect.kind === "substitution") findSite(defect.siteId).speciesIndex = speciesIndex(defect.originalElement!);
      else structure.sites = structure.sites.filter(s => s.siteId !== defect.siteId);
      state.defects = state.defects.filter(d => d.id !== defect.id);
      break;
    }
    case "supercell": {
      const repeat = operation.repeat;
      if (repeat.length !== 3 || !repeat.every(v => Number.isSafeInteger(v) && v > 0)) throw new ModelEditError("invalidRepeat");
      const copies = repeat.reduce((a, b) => a * b, 1);
      if (!Number.isSafeInteger(copies) || structure.sites.length * copies > MAX_SITES) throw new ModelEditError("supercellLimit");
      const shifts: Vec3[] = [];
      for (let a = 0; a < repeat[0]; a++) for (let b = 0; b < repeat[1]; b++) for (let c = 0; c < repeat[2]; c++) shifts.push([a, b, c]);
      const ids = new Map<string, string>();
      const copiedId = (id: string, copy: number) => {
        const key = `${id}:${copy}`;
        if (!ids.has(key)) ids.set(key, copy === 0 ? id : uid());
        return ids.get(key)!;
      };
      const expand = (p: Vec3, shift: Vec3) => tuple(p.map((v, i) => (v + shift[i]!) / repeat[i]!));
      structure.sites = structure.sites.flatMap(site => shifts.map((shift, copy) => ({ ...cloneSite(site),
        siteId: copiedId(site.siteId, copy), originSiteId: site.siteId, copyOffset: [...shift] as Vec3,
        displayAtomNumber: copy === 0 ? site.displayAtomNumber ?? site.sourceAtomNumber! : nextDisplayNumber(),
        fractionalPosition: expand(site.fractionalPosition, shift) })));
      state.defects = state.defects.flatMap(defect => shifts.map((shift, copy) => ({ ...defect, id: uid(),
        siteId: copiedId(defect.siteId, copy), fractionalPosition: expand(defect.fractionalPosition, shift),
        ...(defect.originalIndex === undefined ? {} : { originalIndex: defect.originalIndex * copies + copy }),
        ...(defect.previousSubstitution ? { previousSubstitution: { ...defect.previousSubstitution, id: uid() } } : {}),
        ...(defect.originalSite ? { originalSite: { ...cloneSite(defect.originalSite), siteId: copiedId(defect.siteId, copy),
          originSiteId: defect.siteId, copyOffset: [...shift] as Vec3,
          displayAtomNumber: copy === 0 ? defect.originalSite.displayAtomNumber ?? defect.originalSite.sourceAtomNumber! : nextDisplayNumber(),
          fractionalPosition: expand(defect.originalSite.fractionalPosition, shift) } } : {}) })));
      structure.cell.vectors = structure.cell.vectors.map((v, i) => tuple(v.map(n => n * repeat[i]!)));
      break;
    }
  }
  if (structure.sites.some(site => site.selectiveDynamics)) {
    for (const site of structure.sites) site.selectiveDynamics ??= [true, true, true];
  }
  validateModelStructure(structure);
  const warnings = inspectModelDistances(structure);
  if (structure.sites.some(site => !hasElementRadius(structure.species[site.speciesIndex]!))) warnings.push("missing-radius-data");
  return { state, warnings };
}

export function modelToScene(state: ModelState, cutoffOverrides: Record<string, BondCutoffRange> = {}, tolerance = 1.15): SceneSpec {
  return buildVaspScene(state.structure, cutoffOverrides, tolerance);
}
