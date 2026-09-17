import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { AtomSpec, SceneSpec } from "../../../api/scene";
import { atomSiteIndex, formatCellOffset } from "../../atomInspector";
import { MAX_POLYHEDRON_CENTERS, type AutoPolyhedronAvailability,
  type PolyhedronDisplayState, type PolyhedronDisplayIssue } from "../../../model/polyhedronDisplay";

export interface PolyhedronControlModel {
  state: PolyhedronDisplayState;
  selectedAtomIds: ReadonlySet<string>;
  scene: SceneSpec | null;
  requested: number;
  generated: number;
  visible: number;
  issues: readonly PolyhedronDisplayIssue[];
  availability: AutoPolyhedronAvailability;
  blocked: boolean;
  onUseSelection: () => void;
  onAutomatic: () => void;
}

export function PolyhedronControls({ model, connectivityStatus, enabled, opacity }: {
  model: PolyhedronControlModel;
  connectivityStatus: "deferred" | "loading" | "ready" | "error";
  enabled: boolean;
  opacity: number;
}) {
  const { t } = useTranslation();
  const selected = model.state.mode === "selected";
  const atoms = model.scene?.polyhedronAtoms ?? model.scene?.atoms;
  const atomsById = useMemo(() => new Map(atoms?.map(atom => [atom.id, atom])), [atoms]);
  const labelForId = (id: string) => {
    const atom = atomsById.get(id);
    return atom ? centerLabel(atom) : id;
  };
  const selectedIds = [...model.selectedAtomIds];
  const selectionLabel = selectedIds.slice(0, 3).map(labelForId).join(", ")
    + (selectedIds.length > 3 ? ` … (${selectedIds.length})` : "");
  const selectionChanged = model.state.mode === "selected" && selectedIds.length > 0
    && (selectedIds.length !== model.state.centerAtomIds.length
      || !model.state.centerAtomIds.every(id => model.selectedAtomIds.has(id)));
  const busy = connectivityStatus === "loading" || model.blocked;
  const tooMany = selectedIds.length > MAX_POLYHEDRON_CENTERS;
  const status = model.blocked ? t("polyhedra.blocked") : connectivityStatus === "loading" ? t("polyhedra.loading")
    : connectivityStatus === "deferred" ? t("polyhedra.deferred")
      : connectivityStatus === "error" ? t("polyhedra.error")
        : selected ? t("polyhedra.selectedSummary", { requested: model.requested, generated: model.generated })
          : model.generated === 0 ? t(`polyhedra.unavailable.${model.availability}`)
            : enabled ? t("polyhedra.visibleSummary", { generated: model.generated, visible: model.visible }) : "";

  return <section className="space-y-1.5 px-1.5 pb-1" aria-label={t("polyhedra.scope")}>
    <p className="text-xs font-medium">{t(selected ? "polyhedra.selectedMode" : "polyhedra.automaticMode")}</p>
    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t("polyhedra.scope")}>
      <Button type="button" size="sm" variant={selected ? "outline" : "secondary"}
        className="h-auto min-h-7 whitespace-normal px-1 py-1 text-xs" aria-pressed={!selected} disabled={busy} onClick={model.onAutomatic}>
        {t("polyhedra.automatic")}
      </Button>
      <Button type="button" size="sm" variant={selectedIds.length ? "default" : "outline"}
        className="h-auto min-h-7 min-w-0 whitespace-normal break-words px-1 py-1 text-xs" aria-pressed={selected}
        disabled={busy || !selectedIds.length || tooMany} onClick={model.onUseSelection}>
        {selectedIds.length === 1 ? t("polyhedra.generateForAtom", { atom: labelForId(selectedIds[0]!) })
          : selectedIds.length > 1 ? t("polyhedra.generateForCount", { count: selectedIds.length }) : t("polyhedra.useSelection")}
      </Button>
    </div>
    {selectedIds.length ? <p className="break-words text-xs text-muted-foreground">{t("polyhedra.currentSelection", { atoms: selectionLabel })}</p> : null}
    {selectionChanged ? <p role="status" className="text-xs leading-relaxed">{t("polyhedra.selectionChanged")}</p> : null}
    {status ? <p role="status" aria-live="polite" className="text-xs leading-relaxed text-muted-foreground">{status}</p> : null}
    {selected && connectivityStatus === "ready" && model.generated > 0 ? <ul className="space-y-1 text-xs" aria-label={t("polyhedra.generatedCenters")}>
      {model.scene?.polyhedra.slice(0, 3).map(polyhedron => {
        const atom = atoms?.[polyhedron.centerAtomIndex];
        if (!atom) return null;
        const count = new Set(polyhedron.hullAtomIndices.filter(index => index !== polyhedron.centerAtomIndex)).size;
        return <li key={atom.id} className="break-words">{t("polyhedra.centerDetails", { atom: centerLabel(atom), count })}</li>;
      })}
      {model.generated > 3 ? <li className="text-muted-foreground">{t("polyhedra.moreCenters", { count: model.generated - 3 })}</li> : null}
    </ul> : null}
    {!model.blocked ? <p className="text-[11px] leading-relaxed text-muted-foreground">
      {tooMany ? t("polyhedra.tooMany", { count: MAX_POLYHEDRON_CENTERS })
        : selected ? t("polyhedra.pinnedHint") : t("polyhedra.selectHint")}
    </p> : null}
    {selected && !model.blocked && connectivityStatus === "ready" && model.issues.length ? <ul className="max-h-28 list-none space-y-1 overflow-y-auto text-[11px] leading-relaxed text-muted-foreground">
      {model.issues.slice(0, 3).map(issue => <li key={issue.centerAtomId} className="break-words">
        {t(`polyhedra.issue.${issue.reason}`, { atom: labelForId(issue.centerAtomId), count: issue.neighborCount })}
      </li>)}
      {model.issues.length > 3 ? <li>{t("polyhedra.moreIssues", { count: model.issues.length - 3 })}</li> : null}
    </ul> : null}
    {!selected && enabled && model.generated > model.visible && connectivityStatus === "ready" ?
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("polyhedra.hiddenHint")}</p> : null}
    {enabled && model.generated > 0 && opacity === 0 ?
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("polyhedra.transparentHint")}</p> : null}
  </section>;
}

function centerLabel(atom: AtomSpec): string {
  const site = `${atom.element}:${atomSiteIndex(atom)}`;
  return atom.isPeriodicImage ? `${site} [${formatCellOffset(atom.imageOffset)}]` : site;
}
