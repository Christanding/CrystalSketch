import { Matrix3, Vector3 } from "three";
import { cartoonElement } from "../model/cartoonElements";
import type { AtomSpec, BondCutoffRange, BondFamilySpec, BondSpec, SceneSpec } from "./scene";
import { buildVaspPolyhedra } from "./vaspPolyhedra";
import type { PeriodicStructure, StructureSite } from "../model/periodicStructure";

const BOUNDARY_TOLERANCE = 0.02;
const BOND_TOLERANCE = 1.15;
// Match the backend scene and search budgets; never build an unbounded supercell.
const MAX_SCENE_ATOMS = 64_000;
const MAX_SCENE_BONDS = 256_000;
const MAX_SEARCH_CANDIDATES = 1_024_000;

function number(token: string, label: string): number {
  const value = Number(token.replace(/[dD]/g, "e"));
  if (!token || !Number.isFinite(value)) throw new Error(`${label}不是有效数字`);
  return value;
}

function vector(line: string | undefined, label: string): Vector3 {
  const tokens = line?.trim().split(/\s+/) ?? [];
  if (tokens.length < 3) throw new Error(`${label}缺少三个分量`);
  return new Vector3(...tokens.slice(0, 3).map(value => number(value, label)));
}

export function isVaspFilename(filename: string): boolean {
  return /^(POSCAR|CONTCAR)$/i.test(filename.split(/[\\/]/).at(-1) ?? "");
}

export function parseVaspStructure(content: string): PeriodicStructure {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r/g, "")
    .split("\n").map(line => line.trim());
  if (lines.length < 8) throw new Error("文件不完整，不符合 POSCAR/CONTCAR 格式");
  const raw = [vector(lines[2], "晶格矢量 a"), vector(lines[3], "晶格矢量 b"), vector(lines[4], "晶格矢量 c")] as const;
  const volume = Math.abs(raw[0].dot(new Vector3().crossVectors(raw[1], raw[2])));
  if (volume < 1e-10) throw new Error("晶胞体积为零");
  const scales = (lines[1] ?? "").split(/\s+/).map(value => number(value, "缩放因子"));
  const firstScale = scales[0] ?? 0;
  let scale: Vector3;
  if (scales.length === 1 && firstScale !== 0) {
    const value = firstScale < 0 ? Math.cbrt(-firstScale / volume) : firstScale;
    scale = new Vector3(value, value, value);
  } else if (scales.length === 3 && scales.every(value => value > 0)) {
    scale = new Vector3(...scales);
  } else {
    throw new Error("缩放因子应为一个非零数或三个正数");
  }
  const [a, b, c] = raw;
  raw.forEach(value => value.multiply(scale));
  const inverse = new Matrix3().set(a.x, b.x, c.x, a.y, b.y, c.y, a.z, b.z, c.z).invert();
  let cursor = 5;
  const species = (lines[cursor++] ?? "").split(/\s+/);
  const oldFormat = species.every(value => /^\d+$/.test(value));
  const elements = oldFormat ? species.map((_, index) => `X${index + 1}`) : species.map((name, index) => {
    const match = name.match(/^([A-Za-z]{1,2})(?:_|$)/);
    const symbol = match?.[1];
    return symbol ? symbol.charAt(0).toUpperCase() + symbol.slice(1).toLowerCase() : `X${index + 1}`;
  });
  const countTokens = oldFormat ? species : (lines[cursor++] ?? "").split("!")[0]!.trim().split(/\s+/);
  if (elements.length !== countTokens.length || !countTokens.every(value => /^\d+$/.test(value))) {
    throw new Error("元素与原子数不匹配");
  }
  const counts = countTokens.map(Number);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("原子数无效");
  if (total > 25_600) throw new Error("结构超过 25,600 个原子的预览上限");
  const selective = /^s/i.test(lines[cursor] ?? "");
  if (selective) cursor++;
  const mode = lines[cursor++] ?? "";
  if (!/^[dck]/i.test(mode)) throw new Error("坐标类型必须为 Direct 或 Cartesian");
  if (lines.length < cursor + total) throw new Error(`坐标行不足：应有 ${total} 行`);
  const sites: StructureSite[] = [];
  let sourceIndex = 0;
  for (const [speciesIndex, element] of elements.entries()) {
    for (let i = 0; i < (counts[speciesIndex] ?? 0); i++, sourceIndex++) {
      const line = lines[cursor++];
      const fractional = vector(line, `原子 ${sourceIndex + 1} 坐标`);
      if (!/^d/i.test(mode)) fractional.multiply(scale).applyMatrix3(inverse);
      const site: StructureSite = { siteId: `${element}-${sourceIndex}`, sourceAtomNumber: sourceIndex + 1, speciesIndex,
        fractionalPosition: fractional.toArray() };
      if (selective) {
        const flags = line!.split(/\s+/).slice(3, 6);
        if (flags.length !== 3 || !flags.every(flag => /^[tf]$/i.test(flag))) {
          throw new Error(`原子 ${sourceIndex + 1} 的 Selective dynamics 标记必须为三个 T/F`);
        }
        site.selectiveDynamics = flags.map(flag => /^t$/i.test(flag)) as [boolean, boolean, boolean];
      }
      sites.push(site);
    }
  }
  return { cell: { vectors: [a.toArray(), b.toArray(), c.toArray()] }, species: elements, sites };
}

export function parseVaspScene(
  content: string,
  cutoffOverrides: Record<string, BondCutoffRange> = {},
  tolerance = BOND_TOLERANCE,
): SceneSpec {
  return buildVaspScene(parseVaspStructure(content), cutoffOverrides, tolerance);
}

export function buildVaspScene(
  structure: PeriodicStructure,
  cutoffOverrides: Record<string, BondCutoffRange> = {},
  tolerance = BOND_TOLERANCE,
): SceneSpec {
  if (!Number.isFinite(tolerance) || tolerance < .8 || tolerance > 1.5) throw new Error("成键容差应在 0.8–1.5 之间");
  const [a, b, c] = structure.cell.vectors.map(value => new Vector3(...value)) as [Vector3, Vector3, Vector3];
  const inverse = new Matrix3().set(a.x, b.x, c.x, a.y, b.y, c.y, a.z, b.z, c.z).invert();
  const elements = structure.species;
  const counts = elements.map(() => 0);
  for (const site of structure.sites) counts[site.speciesIndex]!++;
  const total = structure.sites.length;
  const atomsByPosition = new Map<string, AtomSpec>();
  for (const [sourceIndex, site] of structure.sites.entries()) {
    const element = elements[site.speciesIndex]!;
    const fractional = new Vector3(...site.fractionalPosition);
    fractional.fromArray(fractional.toArray().map(value => ((value % 1) + 1) % 1));
    const shifts = fractional.toArray().map(value => value < BOUNDARY_TOLERANCE
      ? [0, 1] : value > 1 - BOUNDARY_TOLERANCE ? [0, -1] : [0]) as [number[], number[], number[]];
    for (const da of shifts[0]) for (const db of shifts[1]) for (const dc of shifts[2]) {
      const offset: [number, number, number] = [da, db, dc];
      const shifted = fractional.clone().add(new Vector3(...offset));
      const position = new Vector3().addScaledVector(a, shifted.x)
        .addScaledVector(b, shifted.y).addScaledVector(c, shifted.z);
      const siteId = site.siteId;
      const isPeriodicImage = offset.some(value => value !== 0);
      const atom: AtomSpec = {
        id: isPeriodicImage ? `${siteId}-image-${offset.join("-")}` : siteId,
        siteId, siteIndex: sourceIndex, sourceAtomNumber: site.displayAtomNumber ?? site.sourceAtomNumber ?? sourceIndex + 1, element,
        position: position.toArray(), fractionalPosition: shifted.toArray(),
        imageOffset: offset, isPeriodicImage,
        imageReasons: isPeriodicImage ? ["boundary"] : [],
        visibilityDependencies: isPeriodicImage ? ["boundaryAtoms"] : [],
        visibilityDependencyGroups: isPeriodicImage ? [["boundaryAtoms"]] : [],
      };
      const key = positionKey(atom);
      const previous = atomsByPosition.get(key);
      if (!previous || previous.isPeriodicImage && !isPeriodicImage) atomsByPosition.set(key, atom);
      if (atomsByPosition.size > MAX_SCENE_ATOMS) throw new Error("周期镜像超过 64,000 个原子的预览上限");
    }
  }
  const atoms = [...atomsByPosition.values()];
  const sourceCount = atoms.length;
  appendBondedImages(atoms, [a, b, c], inverse, cutoffOverrides, tolerance);
  const { bonds, bondFamilies } = calculateCartoonBonds(atoms, cutoffOverrides, tolerance, sourceCount);
  const polyhedra = buildVaspPolyhedra(atoms, bonds, sourceCount);
  const angle = (first: Vector3, second: Vector3) => (first.angleTo(second) * 180 / Math.PI).toFixed(1);
  return {
    sourceFormat: "vasp", bondTolerance: tolerance, cell: { vectors: [a.toArray(), b.toArray(), c.toArray()] },
    atoms, bonds, bondFamilies, polyhedra, connectivity: "ready", bondAlgorithm: "cartoon-distance",
    summary: {
      formula: elements.flatMap((element, index) => counts[index] ? [`${element}${counts[index] === 1 ? "" : counts[index]}`] : []).join(""),
      atomCount: total,
      cell: { a: a.length().toFixed(2), b: b.length().toFixed(2), c: c.length().toFixed(2),
        alpha: angle(b, c), beta: angle(a, c), gamma: angle(a, b) },
      symmetry: { available: false, spaceGroup: null, spaceGroupNumber: null,
        pointGroup: null, pointGroupSchoenflies: null, crystalSystem: null, latticeSystem: null },
    },
  };
}

function bondCutoff(first: AtomSpec, second: AtomSpec, overrides: Record<string, BondCutoffRange>, tolerance: number): BondCutoffRange {
  return overrides[[first.element, second.element].sort().join("|")] ?? { min: .4,
    max: (cartoonElement(first.element).bondRadius + cartoonElement(second.element).bondRadius) * tolerance };
}

function maximumCutoff(atoms: AtomSpec[], overrides: Record<string, BondCutoffRange>, tolerance: number): number {
  let maximum = 1;
  for (const atom of atoms) maximum = Math.max(maximum, 2 * cartoonElement(atom.element).bondRadius * tolerance);
  for (const range of Object.values(overrides)) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min < 0 || range.max < range.min) {
      throw new Error("成键距离范围无效");
    }
    maximum = Math.max(maximum, range.max);
  }
  return maximum;
}

function positionKey(atom: Pick<AtomSpec, "element" | "position">): string {
  return `${atom.element}:${atom.position.map(value => Math.round(value * 1e6)).join(",")}`;
}

function appendBondedImages(atoms: AtomSpec[], lattice: Vector3[], inverse: Matrix3,
  overrides: Record<string, BondCutoffRange>, tolerance: number) {
  const sources = atoms.slice();
  const size = maximumCutoff(atoms, overrides, tolerance);
  const buckets = new Map<string, AtomSpec[]>();
  const byPosition = new Map(atoms.map(atom => [positionKey(atom), atom]));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const atom of sources) {
    const key = atom.position.map(value => Math.floor(value / size)).join(",");
    const bucket = buckets.get(key) ?? [];
    bucket.push(atom);
    buckets.set(key, bucket);
    atom.fractionalPosition.forEach((value, axis) => {
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    });
  }
  // Reciprocal row norms bound fractional displacement, including skew cells and images beyond ±1.
  const e = inverse.elements;
  const reach = [0, 1, 2].map(axis => size * Math.hypot(e[axis]!, e[axis + 3]!, e[axis + 6]!));
  let imagesSearched = 0;
  let pairsSearched = 0;
  for (const site of sources.filter(atom => !atom.isPeriodicImage)) {
    const low = site.fractionalPosition.map((value, axis) => Math.ceil(min[axis]! - value - reach[axis]!));
    const high = site.fractionalPosition.map((value, axis) => Math.floor(max[axis]! - value + reach[axis]!));
    imagesSearched += high.reduce((count, value, axis) => count * (value - low[axis]! + 1), 1);
    if (!Number.isFinite(imagesSearched) || imagesSearched > MAX_SEARCH_CANDIDATES) {
      throw new Error("周期邻居搜索范围过大，请减小成键距离或检查晶胞");
    }
    for (let a = low[0]!; a <= high[0]!; a++) for (let b = low[1]!; b <= high[1]!; b++) for (let c = low[2]!; c <= high[2]!; c++) {
      if (a === 0 && b === 0 && c === 0) continue;
      const offset: [number, number, number] = [a, b, c];
      const fractional = site.fractionalPosition.map((value, axis) => value + offset[axis]!) as [number, number, number];
      const point = new Vector3();
      lattice.forEach((vector, axis) => point.addScaledVector(vector, fractional[axis]!));
      const position = point.toArray();
      const [x, y, z] = position.map(value => Math.floor(value / size)) as [number, number, number];
      let image = byPosition.get(positionKey({ element: site.element, position }));
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const source of buckets.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
          if (++pairsSearched > MAX_SEARCH_CANDIDATES) throw new Error("周期邻居搜索过密，请减小成键距离或结构规模");
          const length = Math.hypot(...position.map((value, axis) => value - source.position[axis]!));
          const cutoff = bondCutoff(site, source, overrides, tolerance);
          if (!(length > cutoff.min && length < cutoff.max)) continue;
          if (!image) {
            if (atoms.length >= MAX_SCENE_ATOMS) throw new Error("周期镜像超过 64,000 个原子的预览上限");
            image = { ...site, id: `${site.siteId}-image-${offset.join("-")}`, position,
              fractionalPosition: fractional, imageOffset: offset, isPeriodicImage: true,
              imageReasons: [], visibilityDependencies: [], visibilityDependencyGroups: [] };
            atoms.push(image);
            byPosition.set(positionKey(image), image);
          }
          if (!image.isPeriodicImage) continue;
          if (!image.imageReasons.includes("bonded")) image.imageReasons.push("bonded");
          const group = source.isPeriodicImage ? ["boundaryAtoms", "oneHopBondedAtoms"] as const : ["oneHopBondedAtoms"] as const;
          if (!image.visibilityDependencyGroups.some(existing => existing.join() === group.join())) image.visibilityDependencyGroups.push([...group]);
          for (const dependency of group) if (!image.visibilityDependencies.includes(dependency)) image.visibilityDependencies.push(dependency);
        }
      }
    }
  }
}

export function calculateCartoonBonds(atoms: AtomSpec[], overrides: Record<string, BondCutoffRange> = {}, tolerance = BOND_TOLERANCE, sourceCount = atoms.length) {
  const bonds: BondSpec[] = [];
  const families = new Map<string, BondFamilySpec>();
  // Spatial buckets avoid a quadratic scan while preserving the original distance rule.
  const size = maximumCutoff(atoms, overrides, tolerance);
  const buckets = new Map<string, number[]>();
  const cells = atoms.map(atom => atom.position.map(value => Math.floor(value / size)) as [number, number, number]);
  cells.forEach((cell, index) => {
    const key = cell.join(",");
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  atoms.forEach((start, i) => {
    if (i >= sourceCount) return;
    const [x, y, z] = cells[i]!;
    const candidates: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of buckets.get(`${x + dx},${y + dy},${z + dz}`) ?? []) if (j > i) candidates.push(j);
    }
    for (const j of candidates.sort((first, second) => first - second)) {
      const end = atoms[j]!;
      const length = Math.hypot(...start.position.map((value, axis) => value - end.position[axis]!));
      const elements = [start.element, end.element].sort() as [string, string];
      const familyKey = elements.join("|");
      const cutoff = bondCutoff(start, end, overrides, tolerance);
      if (!(length > cutoff.min && length < cutoff.max)) continue;
      if (bonds.length >= MAX_SCENE_BONDS) throw new Error("化学键超过 256,000 条的预览上限");
      const id = `${start.id}|${end.id}`;
      bonds.push({ id, relationId: id, familyKey, startSiteId: start.siteId, endSiteId: end.siteId,
        startImageOffset: start.imageOffset, endImageOffset: end.imageOffset,
        relativeImageOffset: end.imageOffset.map((value, axis) => value - start.imageOffset[axis]!) as [number, number, number],
        startAtomIndex: i, endAtomIndex: j, length, visibilityDependencies: [], visibilityDependencyGroups: [] });
      const family = families.get(familyKey) ?? { key: familyKey, elements, minLength: length, maxLength: length };
      family.minLength = Math.min(family.minLength!, length);
      family.maxLength = Math.max(family.maxLength!, length);
      families.set(familyKey, family);
    }
  });
  return { bonds, bondFamilies: [...families.values()] };
}
