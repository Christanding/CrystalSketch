import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { SymmetryInspectionController } from "../hooks/useSymmetryInspection";

export function SymmetryInspectionPanel({ controller, toleranceChanged }: {
  controller: SymmetryInspectionController;
  toleranceChanged: boolean;
}) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(30);
  const { analysis, groups, valid, enabled, activeGroupId } = controller;
  if (!analysis) return <p className="text-xs text-muted-foreground">{t("symmetryInspection.findFirst")}</p>;
  if (!valid) return <p className="text-xs text-muted-foreground">{t("symmetryInspection.invalidResult")}</p>;
  const setting = analysis.setting;
  return <details className="min-w-0 rounded-md border p-2.5"
    onToggle={event => { if (!event.currentTarget.open) controller.onEnabledChange(false); }}>
    <summary className="cursor-pointer text-xs font-medium">{t("symmetryInspection.groups", { count: groups.length })}</summary>
    <div className="mt-3 flex min-w-0 flex-col gap-2.5">
      <p className="text-xs text-muted-foreground">{t("symmetryInspection.result", { pointGroup: analysis.pointGroup, tolerance: analysis.tolerance })}</p>
      {toleranceChanged ? <p role="status" className="text-xs">{t("symmetryInspection.oldTolerance")}</p> : null}
      {setting ? <p className="break-words text-[11px] text-muted-foreground">
        {t("symmetryInspection.setting", { number: setting.hallNumber, symbol: setting.hallSymbol, choice: setting.choice || "—" })}
      </p> : null}
      <label className="flex items-center justify-between gap-2 text-xs">
        {t("symmetryInspection.highlight")}
        <Switch checked={enabled} onCheckedChange={controller.onEnabledChange} aria-label={t("symmetryInspection.highlight")} />
      </label>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("symmetryInspection.readOnlyHint")}</p>
      {!setting || groups.some(group => !group.hasDetails) ? <p className="text-xs text-muted-foreground">{t("symmetryInspection.missingDetails")}</p> : null}
      <ul className="max-h-72 space-y-2 overflow-y-auto" aria-label={t("symmetryInspection.groupList")}>
        {groups.slice(0, limit).map(group => <li key={group.id} className="min-w-0 rounded-md border p-2">
          <Button type="button" variant={activeGroupId === group.id ? "secondary" : "ghost"} size="sm"
            className="h-auto min-h-8 w-full justify-start whitespace-normal px-1 py-1 text-left text-xs"
            aria-pressed={activeGroupId === group.id} onClick={() => controller.onInspectGroup(group.id)}>
            {t("symmetryInspection.group", { number: group.number, element: group.element, count: group.members.length })}
          </Button>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("symmetryInspection.visible", {
            count: group.members.filter(member => member.visible).length, total: group.members.length })}</p>
          {group.hasDetails ? <p className="mt-1 break-words text-[11px]">{t("symmetryInspection.siteDetails", {
            wyckoff: group.wyckoffLetters.join(", "), symmetry: group.siteSymmetrySymbols.join(", ") })}</p> : null}
          <details className="mt-1 text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">{t("symmetryInspection.members")}</summary>
            <p className="mt-1 max-h-28 overflow-y-auto break-words leading-relaxed">
              {group.members.map(member => member.label + (member.visible ? "" : ` (${t("symmetryInspection.hidden")})`)).join(", ")}
            </p>
          </details>
        </li>)}
      </ul>
      {groups.length > limit ? <Button size="sm" variant="ghost" onClick={() => setLimit(current => current + 30)}>{t("symmetryInspection.more")}</Button> : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("symmetryInspection.settingHint")}</p>
    </div>
  </details>;
}
