import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MAX_POLYHEDRON_CENTERS, type AutoPolyhedronAvailability,
  type PolyhedronDisplayState, type PolyhedronDisplayIssue } from "../../../model/polyhedronDisplay";

export interface PolyhedronControlModel {
  state: PolyhedronDisplayState;
  selectedAtomCount: number;
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
  const busy = connectivityStatus === "loading" || model.blocked;
  const tooMany = model.selectedAtomCount > MAX_POLYHEDRON_CENTERS;
  const status = model.blocked ? t("polyhedra.blocked") : connectivityStatus === "loading" ? t("polyhedra.loading")
    : connectivityStatus === "deferred" ? t("polyhedra.deferred")
      : connectivityStatus === "error" ? t("polyhedra.error")
        : selected ? t("polyhedra.selectedSummary", { requested: model.requested, generated: model.generated })
          : model.generated === 0 ? t(`polyhedra.unavailable.${model.availability}`)
            : enabled ? t("polyhedra.visibleSummary", { generated: model.generated, visible: model.visible }) : "";

  return <section className="space-y-1.5 px-1.5 pb-1" aria-label={t("polyhedra.scope")}>
    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t("polyhedra.scope")}>
      <Button type="button" size="sm" variant={selected ? "outline" : "secondary"}
        className="h-7 px-1 text-xs" aria-pressed={!selected} disabled={busy} onClick={model.onAutomatic}>
        {t("polyhedra.automatic")}
      </Button>
      <Button type="button" size="sm" variant={selected ? "secondary" : "outline"}
        className="h-7 px-1 text-xs" aria-pressed={selected}
        disabled={busy || !model.selectedAtomCount || tooMany} onClick={model.onUseSelection}>
        {t("polyhedra.useSelection")}
      </Button>
    </div>
    {status ? <p role="status" aria-live="polite" className="text-xs leading-relaxed text-muted-foreground">{status}</p> : null}
    {!model.blocked ? <p className="text-[11px] leading-relaxed text-muted-foreground">
      {tooMany ? t("polyhedra.tooMany", { count: MAX_POLYHEDRON_CENTERS })
        : selected ? t("polyhedra.pinnedHint") : t("polyhedra.selectHint")}
    </p> : null}
    {selected && !model.blocked && connectivityStatus === "ready" && model.issues.length ? <ul className="max-h-28 list-none space-y-1 overflow-y-auto text-[11px] leading-relaxed text-muted-foreground">
      {model.issues.slice(0, 3).map(issue => <li key={issue.centerAtomId} className="break-words">
        {t(`polyhedra.issue.${issue.reason}`, { atom: issue.centerAtomId, count: issue.neighborCount })}
      </li>)}
      {model.issues.length > 3 ? <li>{t("polyhedra.moreIssues", { count: model.issues.length - 3 })}</li> : null}
    </ul> : null}
    {!selected && enabled && model.generated > model.visible && connectivityStatus === "ready" ?
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("polyhedra.hiddenHint")}</p> : null}
    {enabled && model.generated > 0 && opacity === 0 ?
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("polyhedra.transparentHint")}</p> : null}
  </section>;
}
