import { useTranslation } from "react-i18next";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HexColorPicker } from "../HexColorPicker";
import { PercentSliderRow } from "./sharedControls";
import { atomSiteIndex } from "../../atomInspector";
import type { AtomSpec } from "../../../api/scene";
import { measurementIsDisplayed, type MeasurementDisplayMode } from "../../../model/measurements";
import type { MeasurementTool, MeasurementToolsController } from "../../hooks/useMeasurementTools";

function atomLabel(atom: AtomSpec) {
  return `${atom.element} #${atomSiteIndex(atom)}${atom.isPeriodicImage ? ` [${atom.imageOffset.join(", ")}]` : ""}`;
}

export function MeasurementToolsPanel({ tools, visibleAtomIds }: { tools: MeasurementToolsController; visibleAtomIds: ReadonlySet<string> }) {
  const { t } = useTranslation();
  return <div className="flex flex-col gap-3 px-1 py-1 text-[13px]">
    <div className="grid grid-cols-3 gap-1" role="group" aria-label={t("measurement.mode")}>
      {(["inspect", "distance", "angle"] as const).map((mode: MeasurementTool) =>
        <Button key={mode} size="sm" variant={tools.tool === mode ? "secondary" : "outline"}
          aria-pressed={tools.tool === mode} className="h-7 px-1 text-xs" onClick={() => tools.setTool(mode)}>
          {t(`measurement.${mode}`)}
        </Button>)}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t(`measurement.${tools.tool}Hint`)}</p>
    <p className="text-xs text-muted-foreground" role="status">{t("measurement.selectionCount", { atoms: tools.selection.atoms.size, bonds: tools.selection.bonds.size })}</p>
    {tools.tool === "distance" || tools.tool === "angle" ? <section className="rounded-md border p-2" aria-label={t("measurement.current")}>
      <ol className="space-y-1 text-xs">{tools.draftAtoms.map((atom, index) => <li key={atom.id}>{String.fromCharCode(65 + index)} · {atomLabel(atom)}</li>)}</ol>
      <p className="my-2 text-base" aria-live="polite">{tools.currentMeasurement?.label ?? (tools.draft ? t("measurement.degenerate") : t("measurement.awaitAtoms"))}</p>
      <div className="flex gap-2">
        <Button size="sm" className="h-7 text-xs" disabled={!tools.canPin} onClick={tools.pinMeasurement}>{t("measurement.pin")}</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={tools.clearDraft}>{t("measurement.clearDraft")}</Button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("measurement.imageHint")}</p>
    </section> : null}
    <Separator />
    <form onSubmit={event => { event.preventDefault(); tools.submitSearch(); }} className="flex gap-2">
      <Input aria-label={t("measurement.atomNumber")} inputMode="numeric" placeholder={t("measurement.atomNumber")}
        className="h-8 min-w-0 text-xs" value={tools.search} onChange={event => tools.setSearch(event.target.value)} />
      <Button type="submit" size="sm" variant="outline" className="h-8">{t("measurement.search")}</Button>
    </form>
    {tools.searchNumber !== null ? <div className="max-h-28 overflow-y-auto" aria-label={t("measurement.searchResults")}>
      {!tools.results.length ? <p role="status" className="text-xs text-muted-foreground">{t("measurement.noResults")}</p> : tools.results.map(atom =>
        <Button key={atom.id} variant="ghost" size="sm" className="h-7 w-full justify-start px-1 text-xs" disabled={!visibleAtomIds.has(atom.id)}
          onClick={() => tools.locateAtom(atom)} title={!visibleAtomIds.has(atom.id) ? t("measurement.hiddenAtom") : t("measurement.locate")}>
          {atomLabel(atom)}{!visibleAtomIds.has(atom.id) ? ` · ${t("measurement.hidden")}` : ""}
        </Button>)}
    </div> : null}
    <div className="grid grid-cols-2 gap-1">
      <Button size="sm" variant="outline" className="h-7 px-1 text-xs" disabled={!tools.canFocus} onClick={() => tools.focusSelection(false)}>{t("measurement.onlySelected")}</Button>
      <Button size="sm" variant="outline" className="h-7 px-1 text-xs" disabled={!tools.canFocus} onClick={() => tools.focusSelection(true)}>{t("measurement.withNeighbors")}</Button>
    </div>
    {tools.focus ? <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={tools.exitFocus}>{t("measurement.exitFocus")}</Button> : null}
    <Separator />
    <div className="flex items-center justify-between">
      <span>{t("measurement.displayMode")}</span>
      <Select value={tools.labelStyle.displayMode ?? "all"} onValueChange={value => tools.setLabelStyle(current => ({ ...current, displayMode: value as MeasurementDisplayMode }))}>
        <SelectTrigger size="sm" aria-label={t("measurement.displayMode")} className="h-7 w-36"><SelectValue /></SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="all">{t("measurement.displayAll")}</SelectItem>
          <SelectItem value="distance">{t("measurement.displayDistance")}</SelectItem>
          <SelectItem value="angle">{t("measurement.displayAngle")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center justify-between">
      <span>{t("measurement.showLabels")}</span>
      <Switch aria-label={t("measurement.showLabels")} checked={tools.labelStyle.showLabels}
        onCheckedChange={showLabels => tools.setLabelStyle(current => ({ ...current, showLabels }))} />
    </div>
    {tools.labelStyle.showLabels ? <div className="space-y-2">
      <div className="flex items-center justify-between px-1.5">
        <span>{t("measurement.labelColor")}</span>
        <HexColorPicker pickerId="measurement:label" ariaLabel={t("measurement.labelColor")}
          inputLabel={t("measurement.labelColorValue")} side="right" value={tools.labelStyle.color}
          onValueChange={color => tools.setLabelStyle(current => ({ ...current, color }))} />
      </div>
      <PercentSliderRow accessibleLabel={t("measurement.fontScale")} label={t("measurement.fontScale")}
        valueLabel={t("measurement.scale")} min={50} max={250} value={tools.labelStyle.fontScale}
        onValueChange={fontScale => tools.setLabelStyle(current => ({ ...current, fontScale }))} />
      <div className="flex items-center justify-between gap-2 px-1.5">
        <span>{t("measurement.fontWeight")}</span>
        <Select value={String(tools.labelStyle.fontWeight)} onValueChange={value => tools.setLabelStyle(current => ({ ...current, fontWeight: Number(value) as 300 | 400 | 500 | 600 }))}>
          <SelectTrigger size="sm" aria-label={t("measurement.fontWeight")} className="h-7 w-28"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="300">{t("measurement.light")}</SelectItem>
            <SelectItem value="400">{t("measurement.regular")}</SelectItem>
            <SelectItem value="500">{t("measurement.medium")}</SelectItem>
            <SelectItem value="600">{t("measurement.bold")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div> : null}
    <Separator />
    <div className="flex items-center justify-between">
      <span>{t("measurement.saved")}</span>
      <Button variant="ghost" size="icon" className="size-6" disabled={!tools.resolvedMeasurements.length}
        aria-label={t("measurement.clearSaved")} onClick={tools.clearMeasurements}><Trash2 className="size-3.5" /></Button>
    </div>
    <ul className="max-h-32 space-y-1 overflow-y-auto">{tools.resolvedMeasurements.map(({ definition, resolved }, index) =>
      <li key={definition.id} className={`flex items-center justify-between gap-1 rounded border px-2 py-1 ${measurementIsDisplayed(definition, tools.labelStyle) ? "" : "opacity-50"}`}>
        <span className="text-xs">{index + 1}. {resolved?.label ?? t("measurement.unavailable")}</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label={t("measurement.remove", { index: index + 1 })}
          onClick={() => tools.removeMeasurement(definition.id)}><X className="size-3" /></Button>
      </li>)}</ul>
    <p className="text-[11px] leading-relaxed text-muted-foreground">{t("measurement.savedHint")}</p>
  </div>;
}
