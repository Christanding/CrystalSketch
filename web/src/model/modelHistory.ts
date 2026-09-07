import type { StructureSite } from "./periodicStructure";
import type { ModelState } from "./structureModel";

interface SiteVersion { index: number; site: StructureSite }
interface ModelPatchSide {
  cell: ModelState["structure"]["cell"];
  species: string[];
  defects: ModelState["defects"];
  sites: SiteVersion[];
}
export interface ModelPatch { ids: string[]; before: ModelPatchSide; after: ModelPatchSide }

export function createModelPatch(before: ModelState, after: ModelState): ModelPatch {
  const previous = new Map(before.structure.sites.map((site, index) => [site.siteId, { site, index }]));
  const next = new Map(after.structure.sites.map((site, index) => [site.siteId, { site, index }]));
  const ids = [...new Set([...previous.keys(), ...next.keys()])].filter(id => {
    const a = previous.get(id), b = next.get(id);
    return !a || !b || a.site !== b.site && JSON.stringify(a.site) !== JSON.stringify(b.site);
  });
  const side = (model: ModelState, sites: Map<string, SiteVersion>): ModelPatchSide => ({
    cell: model.structure.cell, species: model.structure.species, defects: model.defects,
    sites: ids.flatMap(id => { const site = sites.get(id); return site ? [site] : []; }),
  });
  return { ids, before: side(before, previous), after: side(after, next) };
}

export function applyModelPatch(model: ModelState, patch: ModelPatch, direction: "before" | "after"): ModelState {
  const target = patch[direction];
  const changed = new Set(patch.ids);
  const sites = model.structure.sites.filter(site => !changed.has(site.siteId));
  for (const { index, site } of [...target.sites].sort((a, b) => a.index - b.index)) sites.splice(index, 0, site);
  return { structure: { cell: target.cell, species: target.species, sites }, defects: target.defects };
}

export function isModelPatch(value: unknown): value is ModelPatch {
  if (!value || typeof value !== "object") return false;
  const patch = value as ModelPatch;
  return Array.isArray(patch.ids) && patch.ids.every(id => typeof id === "string")
    && [patch.before, patch.after].every(side => Boolean(side) && Array.isArray(side.cell?.vectors)
      && side.cell.vectors.length === 3 && side.cell.vectors.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
      && Array.isArray(side.species) && side.species.every(s => typeof s === "string") && Array.isArray(side.defects)
      && Array.isArray(side.sites) && side.sites.every(entry => Number.isInteger(entry.index) && entry.index >= 0
        && typeof entry.site?.siteId === "string" && Number.isInteger(entry.site.speciesIndex)
        && Array.isArray(entry.site.fractionalPosition) && entry.site.fractionalPosition.length === 3
        && entry.site.fractionalPosition.every(Number.isFinite)));
}
