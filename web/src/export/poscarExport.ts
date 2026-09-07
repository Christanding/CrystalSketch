import type { SceneSpec } from "../api/scene";
import { apiUrl } from "../api/url";
import { isVaspFilename, parseVaspStructure } from "../api/vasp";
import type { PeriodicStructure } from "../model/periodicStructure";

const ELEMENTS = new Set(("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn "
  + "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu "
  + "Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" "));

export type PoscarErrorCode = "sourceRequired" | "backendUnavailable" | "disordered" | "implicitHydrogens" | "invalidCell"
  | "unknownElement" | "invalidCoordinates" | "invalidConstraints" | "unmatchedDeletion" | "emptyStructure" | "sourceMismatch";
export class PoscarExportError extends Error {
  constructor(readonly code: PoscarErrorCode) { super(code); }
}

export interface PoscarPreview {
  text: string;
  atomCount: number;
  removedCount: number;
  species: string[];
  counts: number[];
  selectiveDynamics: boolean;
  removedPeriodicSites: boolean;
}

export interface PoscarSource {
  file: File | null;
  fileName: string | null;
  scene: SceneSpec;
  deletedAtomIds: readonly string[];
  model?: { structure: PeriodicStructure; revision: number };
}

export type PoscarFormatCode = "header" | "scale" | "vector" | "species" | "counts" | "mode" | "rows" | "coordinates" | "flags";
export class PoscarFormatError extends Error {
  constructor(readonly code: PoscarFormatCode, readonly line: number) { super(code); }
}

// The editor exports structure-only VASP 5 files. Reject trailing MD/velocity blocks
// and malformed rows instead of letting a permissive reader silently discard edits.
export function validatePoscarText(text: string): PoscarPreview {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const tokens = (index: number) => (lines[index] ?? "").trim().split(/\s+/);
  const numeric = (value: string) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(value)
    && Number.isFinite(Number(value.replace(/[dD]/g, "e")));
  const fail = (code: PoscarFormatCode, index: number): never => { throw new PoscarFormatError(code, index + 1); };
  if (lines.length < 8) fail("header", lines.length);
  const scales = tokens(1);
  if (!scales.every(numeric) || !(scales.length === 1 && Number(scales[0]!.replace(/[dD]/g, "e")) !== 0
    || scales.length === 3 && scales.every(value => Number(value.replace(/[dD]/g, "e")) > 0))) fail("scale", 1);
  for (let line = 2; line < 5; line++) if (tokens(line).length !== 3 || !tokens(line).every(numeric)) fail("vector", line);
  const species = tokens(5);
  if (!species.every(element => ELEMENTS.has(element))) fail("species", 5);
  const counts = tokens(6);
  if (counts.length !== species.length || !counts.every(value => /^\d+$/.test(value) && Number(value) > 0)) fail("counts", 6);
  const total = counts.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isSafeInteger(total) || total > 25_600) fail("counts", 6);
  const selective = /^selective\s+dynamics$/i.test(lines[7]?.trim() ?? "");
  const modeLine = selective ? 8 : 7;
  if (!/^(direct|cartesian)$/i.test(lines[modeLine]?.trim() ?? "")) fail("mode", modeLine);
  const start = modeLine + 1;
  if (lines.length !== start + total) fail("rows", Math.min(lines.length, start + total));
  for (let line = start; line < lines.length; line++) {
    const values = tokens(line);
    if (values.length !== (selective ? 6 : 3) || !values.slice(0, 3).every(numeric)) fail("coordinates", line);
    if (selective && !values.slice(3).every(value => /^[TF]$/.test(value))) fail("flags", line);
  }
  const structure = parseVaspStructure(lines.join("\n"));
  const result = createPoscar(structure, { atoms: [] }, []);
  return { ...result, text };
}

export async function preparePoscar(source: PoscarSource, signal?: AbortSignal): Promise<PoscarPreview> {
  if (source.model) return createPoscar(source.model.structure, source.scene, [], source.fileName ?? "CrystalSketch");
  if (!source.file) throw new PoscarExportError("sourceRequired");
  const structure = await readCalculationStructure(source.file, signal);
  return createPoscar(structure, source.scene, source.deletedAtomIds, source.fileName ?? "CrystalSketch");
}

export async function readCalculationStructure(file: File, signal?: AbortSignal): Promise<PeriodicStructure> {
  let structure: PeriodicStructure;
  if (isVaspFilename(file.name)) {
    structure = parseVaspStructure(await file.text());
  } else {
    let response: Response;
    try {
      response = await fetch(apiUrl("/api/structure-data"), { method: "POST", body: file, signal,
        headers: { "x-crystalsketch-filename": encodeURIComponent(file.name) } });
    } catch (error) {
      signal?.throwIfAborted();
      throw new PoscarExportError("backendUnavailable");
    }
    if (!response.headers.get("content-type")?.includes("application/json")) throw new PoscarExportError("backendUnavailable");
    const payload = await response.json();
    if (!response.ok) {
      if (payload.detail?.code === "disordered-structure") throw new PoscarExportError("disordered");
      if (payload.detail?.code === "implicit-hydrogens") throw new PoscarExportError("implicitHydrogens");
      if (payload.detail?.code === "invalid-cell") throw new PoscarExportError("invalidCell");
      throw new PoscarExportError("backendUnavailable");
    }
    structure = payload as PeriodicStructure;
  }
  signal?.throwIfAborted();
  return structure;
}

export function createPoscar(structure: PeriodicStructure, scene: Pick<SceneSpec, "atoms">,
  deletedAtomIds: readonly string[], title = "CrystalSketch"): PoscarPreview {
  const vectors = structure.cell.vectors;
  const validVector = (value: number[]) => value.length === 3 && value.every(Number.isFinite);
  if (vectors.length !== 3 || !vectors.every(validVector)) throw new PoscarExportError("invalidCell");
  const a = vectors[0]!, b = vectors[1]!, c = vectors[2]!;
  const determinant = a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!)
    - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  if (!Number.isFinite(determinant) || determinant <= 1e-10) throw new PoscarExportError("invalidCell");
  const siteIds = new Set(structure.sites.map(site => site.siteId));
  if (siteIds.size !== structure.sites.length || scene.atoms.some(atom => !siteIds.has(atom.siteId))) {
    throw new PoscarExportError("sourceMismatch");
  }
  const atomsById = new Map(scene.atoms.map(atom => [atom.id, atom]));
  const removedSites = new Set<string>();
  let removedPeriodicSites = false;
  for (const id of deletedAtomIds) {
    const atom = atomsById.get(id);
    // A recomputed bond graph may no longer contain a previously deleted image.
    const siteId = atom?.siteId ?? id.replace(/-image-[-\d]+$/, "");
    if (!siteIds.has(siteId)) throw new PoscarExportError("unmatchedDeletion");
    removedSites.add(siteId);
    removedPeriodicSites ||= atom?.isPeriodicImage ?? id !== siteId;
  }
  const groups = structure.species.map(() => [] as PeriodicStructure["sites"]);
  for (const site of structure.sites) {
    if (removedSites.has(site.siteId)) continue;
    if (!validVector(site.fractionalPosition) || !Number.isInteger(site.speciesIndex) || !groups[site.speciesIndex]) {
      throw new PoscarExportError("invalidCoordinates");
    }
    if (!ELEMENTS.has(structure.species[site.speciesIndex]!)) throw new PoscarExportError("unknownElement");
    if (site.selectiveDynamics && (site.selectiveDynamics.length !== 3
      || !site.selectiveDynamics.every(value => typeof value === "boolean"))) throw new PoscarExportError("invalidConstraints");
    groups[site.speciesIndex]!.push(site);
  }
  const remaining = groups.flat();
  if (!remaining.length) throw new PoscarExportError("emptyStructure");
  const selective = remaining.some(site => site.selectiveDynamics !== undefined);
  if (selective && remaining.some(site => !site.selectiveDynamics)) throw new PoscarExportError("invalidConstraints");
  const species = structure.species.filter((_, index) => groups[index]!.length > 0);
  const counts = groups.filter(group => group.length > 0).map(group => group.length);
  const formatVector = (values: number[]) => values.map(value => value.toFixed(16)).join("  ");
  const comment = title.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 40) || "CrystalSketch";
  const lines = [comment, "1.0", ...vectors.map(formatVector), species.join("  "), counts.join("  "),
    ...(selective ? ["Selective dynamics"] : []), "Direct",
    ...remaining.map(site => formatVector(site.fractionalPosition)
      + (site.selectiveDynamics ? "  " + site.selectiveDynamics.map(value => value ? "T" : "F").join(" ") : ""))];
  return { text: lines.join("\n") + "\n", atomCount: remaining.length, removedCount: removedSites.size,
    species, counts, selectiveDynamics: selective, removedPeriodicSites };
}
