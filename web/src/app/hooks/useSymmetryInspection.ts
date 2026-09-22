import { useEffect, useMemo, useState } from "react";
import type { SceneSpec } from "../../api/scene";
import type { ModelSymmetryResult } from "../../api/modelSymmetry";
import type { PeriodicStructure } from "../../model/periodicStructure";
import type { StyleState } from "../../model";
import { resolveAtomOpacityForStyle, resolveAtomRadiusForStyle, resolveAtomVisibleForStyle } from "../../model/objectStyles";
import type { SceneSelection } from "../../selection/SceneSelection";

const NO_SITES: ReadonlySet<string> = new Set();

export interface SymmetryInspectionGroup {
  id: string;
  number: number;
  element: string;
  members: { siteId: string; label: string; visible: boolean }[];
  wyckoffLetters: string[];
  siteSymmetrySymbols: string[];
  hasDetails: boolean;
}

export interface SymmetryInspectionController {
  analysis: ModelSymmetryResult | null;
  groups: SymmetryInspectionGroup[];
  valid: boolean;
  enabled: boolean;
  activeGroupId: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onInspectGroup: (groupId: string) => void;
}

/** Inspection never writes the edit selection, scene geometry, or saved appearance. */
export function useSymmetryInspection({ sessionId, revision, structure, analysis, scene, style,
  showAtoms, atomOpacity, selection, inspectedAtomId, active }: {
  sessionId: string | undefined;
  revision: number | undefined;
  structure: PeriodicStructure | null;
  analysis: ModelSymmetryResult | null;
  scene: SceneSpec | null;
  style: StyleState;
  showAtoms: boolean;
  atomOpacity: number;
  selection: SceneSelection;
  inspectedAtomId: string | null;
  active: boolean;
}) {
  const [inspection, setInspection] = useState<{
    sessionId: string | undefined; revision: number | undefined; analysis: ModelSymmetryResult | null;
    groupId: string | null; selection: SceneSelection;
  } | null>(null);
  // Clear the temporary choice on leaving the panel. The active guard below also
  // removes the overlay immediately, before this cleanup effect runs.
  useEffect(() => { if (!active) setInspection(null); }, [active]);
  const visibleSites = useMemo(() => new Set(showAtoms ? scene?.atoms.filter(atom =>
    resolveAtomVisibleForStyle(atom, style.objectStyles)
      && resolveAtomOpacityForStyle(atom, style.objectStyles, atomOpacity) > 0
      && resolveAtomRadiusForStyle(atom, style) > 0).map(atom => atom.siteId) : []),
  [scene?.atoms, showAtoms, style, atomOpacity]);
  const result = useMemo(() => inspectSymmetryGroups(structure, analysis, visibleSites), [structure, analysis, visibleSites]);
  const enabled = active && result.valid && inspection !== null && inspection.analysis === analysis
    && inspection.sessionId === sessionId && inspection.revision === revision;
  const inspectedSiteId = useMemo(() => scene?.atoms.find(atom => atom.id === inspectedAtomId)?.siteId,
    [scene?.atoms, inspectedAtomId]);
  const groupId = enabled && inspection.selection === selection && inspection.groupId
    ? inspection.groupId : result.groups.find(group => group.members.some(member => member.siteId === inspectedSiteId))?.id ?? null;
  const activeGroupId = enabled ? groupId : null;
  const equivalentSiteIds = useMemo<ReadonlySet<string>>(() => {
    const group = result.groups.find(item => item.id === activeGroupId);
    return group ? new Set(group.members.map(member => member.siteId)) : NO_SITES;
  }, [result.groups, activeGroupId]);
  const controller: SymmetryInspectionController = {
    analysis, groups: result.groups, valid: result.valid, enabled, activeGroupId,
    onEnabledChange: enabled => setInspection(enabled && active && result.valid
      ? { sessionId, revision, analysis, groupId: null, selection } : null),
    onInspectGroup: groupId => {
      if (active && result.valid && result.groups.some(group => group.id === groupId)) {
        setInspection({ sessionId, revision, analysis, groupId, selection });
      }
    },
  };
  return { controller, equivalentSiteIds };
}

function inspectSymmetryGroups(structure: PeriodicStructure | null, analysis: ModelSymmetryResult | null,
  visibleSites: ReadonlySet<string>): { valid: boolean; groups: SymmetryInspectionGroup[] } {
  if (!structure || !analysis || !Array.isArray(analysis.equivalentSites)) return { valid: false, groups: [] };
  const sites = new Map(structure.sites.map((site, index) => [site.siteId, { site, index }]));
  const seen = new Set<string>();
  const details = new Map(Array.isArray(analysis.siteDetails) ? analysis.siteDetails
    .filter(detail => detail && typeof detail.siteId === "string").map(detail => [detail.siteId, detail]) : []);
  const groups: SymmetryInspectionGroup[] = [];
  for (const ids of analysis.equivalentSites) {
    if (!Array.isArray(ids) || !ids.length) return { valid: false, groups: [] };
    const members: SymmetryInspectionGroup["members"] = [];
    const elements = new Set<string>();
    for (const id of ids) {
      const entry = sites.get(id);
      if (!entry || seen.has(id)) return { valid: false, groups: [] };
      seen.add(id);
      const { site, index } = entry;
      const element = structure.species[site.speciesIndex]!;
      elements.add(element);
      members.push({ siteId: id, label: `${element}:${site.displayAtomNumber ?? site.sourceAtomNumber ?? index + 1}`,
        visible: visibleSites.has(id) });
    }
    if (elements.size !== 1) return { valid: false, groups: [] };
    const entries = ids.map(id => details.get(id));
    const hasDetails = entries.every(detail => typeof detail?.wyckoffLetter === "string" && detail.wyckoffLetter.length > 0
      && typeof detail.siteSymmetrySymbol === "string" && detail.siteSymmetrySymbol.length > 0);
    groups.push({ id: ids[0]!, number: groups.length + 1, element: [...elements][0]!, members, hasDetails,
      wyckoffLetters: hasDetails ? [...new Set(entries.map(detail => detail!.wyckoffLetter))] : [],
      siteSymmetrySymbols: hasDetails ? [...new Set(entries.map(detail => detail!.siteSymmetrySymbol))] : [] });
  }
  return { valid: seen.size === sites.size, groups: seen.size === sites.size ? groups : [] };
}
