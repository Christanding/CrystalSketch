import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Crosshair, Focus, LoaderCircle, RotateCcw, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { StructureSite } from "../../model/periodicStructure";
import {
  cartesianToFractional,
  fractionalToCartesian,
  type Coordinates,
  type DefectRecord,
  type ModelOperation,
  type ModelState,
  type Vec3,
} from "../../model/structureModel";
import { PeriodicTablePicker } from "./PeriodicTablePicker";

export interface ModelingPanelController {
  model: ModelState | null;
  selectedSiteIds: readonly string[];
  busy: boolean;
  error: string | null;
  preview: { title: string; affectedSites?: number; maxDisplacement?: number; warnings?: readonly string[] } | null;
  symmetry: { spaceGroup: string; spaceGroupNumber: number; operationCount: number; tolerance: number } | null;
  onCreateModel: () => void;
  onPreviewOperation: (operation: ModelOperation) => void;
  onApply: () => void;
  onCancel: () => void;
  onFindSymmetry: (tolerance: number) => void;
  onPreviewImpose: () => void;
  onLocateDefect: (defectId: string) => void;
}

type VectorDraft = [string, string, string];
const AXES = ["a", "b", "c"] as const;
const CARTESIAN_AXES = ["x", "y", "z"] as const;
const INTERSTITIAL_POSITION: Vec3 = [0.5, 0.5, 0.5];

export function ModelingPanel({ controller }: { controller: ModelingPanelController }) {
  const { t } = useTranslation();
  const { model, busy, preview, error } = controller;
  const locked = busy || preview !== null;
  const selectedSites = useMemo(() => {
    const selected = new Set(controller.selectedSiteIds);
    return model?.structure.sites.filter(site => selected.has(site.siteId)) ?? [];
  }, [model, controller.selectedSiteIds]);

  useEffect(() => {
    if (!preview) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      controller.onCancel();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [preview, controller.onCancel]);

  if (!model) return <div className="flex flex-col gap-3 p-4">
    <Button variant="outline" size="sm" onClick={controller.onCreateModel} disabled={busy}>
      {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" /> : null}
      {t("modeling.createCopy")}
    </Button>
    {error ? <PanelError>{error}</PanelError> : null}
  </div>;

  const cellKey = JSON.stringify(model.structure.cell.vectors);
  const selectedKey = cellKey + selectedSites.map(site => `${site.siteId}:${site.speciesIndex}:${site.fractionalPosition.join(",")}:${site.selectiveDynamics?.join(",")}`).join("|");
  return <div className="flex min-h-0 flex-1 flex-col" data-modeling-panel="">
    <div className="stable-scrollbar-gutter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      <PanelSection title={t("modeling.cell")}>
        <div className="grid grid-cols-[1rem_repeat(3,minmax(0,1fr))] gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums" aria-label={t("modeling.cell")}>
          {model.structure.cell.vectors.map((vector, index) => <div key={index} className="contents">
            <span className="text-muted-foreground">{AXES[index]}</span>
            {vector.map((value, axis) => <span key={axis} className="text-right">{formatNumber(value)}</span>)}
          </div>)}
        </div>
        <SupercellEditor disabled={locked} onPreview={controller.onPreviewOperation} />
      </PanelSection>
      <Separator />
      <PanelSection title={t("modeling.selectedSites", { count: selectedSites.length })}>
        {selectedSites.length ? <SelectedSitesEditor key={selectedKey} sites={selectedSites} model={model}
          disabled={locked} onPreview={controller.onPreviewOperation} />
          : <p className="text-xs text-muted-foreground">{t("modeling.selectSites")}</p>}
      </PanelSection>
      <Separator />
      <PanelSection title={t("modeling.interstitial")}>
        <InterstitialEditor key={cellKey} model={model} disabled={locked} onPreview={controller.onPreviewOperation} />
      </PanelSection>
      <Separator />
      <PanelSection title={t("modeling.defects")}>
        {model.defects.length ? <ul className="flex flex-col gap-2">
          {model.defects.map(defect => <DefectRow key={defect.id} model={model} defect={defect} disabled={locked}
            onLocate={controller.onLocateDefect} onPreview={controller.onPreviewOperation} />)}
        </ul> : <p className="text-xs text-muted-foreground">{t("modeling.noDefects")}</p>}
      </PanelSection>
      <Separator />
      <PanelSection title={t("modeling.symmetry")}>
        <SymmetryEditor controller={controller} disabled={locked} />
      </PanelSection>
    </div>
    {(preview || error || busy) ? <div className="flex shrink-0 flex-col gap-2 border-t bg-card px-4 py-3" data-modeling-transaction="">
      {error ? <PanelError>{error}</PanelError> : null}
      {preview ? <>
        <p className="text-sm font-medium">{t("modeling.preview")} · {preview.title}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {preview.affectedSites !== undefined ? <span>{t("modeling.affectedSites", { count: preview.affectedSites })}</span> : null}
          {preview.maxDisplacement !== undefined ? <span>{t("modeling.maxDisplacement", { value: formatNumber(preview.maxDisplacement) })}</span> : null}
        </div>
        {preview.warnings?.length ? <Alert><AlertTriangle /><AlertDescription>{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</AlertDescription></Alert> : null}
      </> : null}
      <div className="flex items-center justify-end gap-2">
        {busy ? <span role="status" className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{t("modeling.busy")}</span> : null}
        <Button size="sm" variant="outline" onClick={controller.onCancel}><X data-icon="inline-start" />{t("modeling.cancel")}</Button>
        {preview ? <Button size="sm" onClick={controller.onApply} disabled={busy || Boolean(error)}><Check data-icon="inline-start" />{t("modeling.apply")}</Button> : null}
      </div>
    </div> : null}
  </div>;
}

function SupercellEditor({ disabled, onPreview }: OperationEditorProps) {
  const { t } = useTranslation();
  const [repeat, setRepeat] = useState<VectorDraft>(["1", "1", "1"]);
  const [invalid, setInvalid] = useState(false);
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
    <legend className="sr-only">{t("modeling.supercell")}</legend>
    <div className="grid grid-cols-3 gap-2">
      {AXES.map((axis, index) => <label key={axis} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {axis}<Input inputMode="numeric" value={repeat[index]} aria-label={t("modeling.repeatAxis", { axis })} aria-invalid={invalid}
          className="h-8 min-w-0" onChange={event => { setRepeat(withDraftValue(repeat, index, event.target.value)); setInvalid(false); }} />
      </label>)}
    </div>
    {invalid ? <p role="alert" className="text-xs text-destructive">{t("modeling.invalidRepeat")}</p> : null}
    <Button size="sm" variant="outline" disabled={disabled || repeat.every(value => Number(value) === 1)} onClick={() => {
      const values = parseVector(repeat);
      if (!values || !values.every(value => Number.isInteger(value) && value > 0)) { setInvalid(true); return; }
      onPreview({ type: "supercell", repeat: values });
    }}>{t("modeling.supercell")}</Button>
  </fieldset>;
}

interface OperationEditorProps {
  disabled: boolean;
  onPreview: (operation: ModelOperation) => void;
}

function SelectedSitesEditor({ sites, model, disabled, onPreview }: OperationEditorProps & { sites: StructureSite[]; model: ModelState }) {
  const { t } = useTranslation();
  const [element, setElement] = useState(model.structure.species[sites[0]!.speciesIndex]!);
  const [flags, setFlags] = useState<(boolean | "indeterminate")[]>(() => AXES.map((_, index) => {
    const values = sites.map(site => site.selectiveDynamics?.[index] ?? true);
    return values.every(value => value === values[0]) ? values[0]! : "indeterminate";
  }));
  const siteIds = sites.map(site => site.siteId);
  return <div className="flex flex-col gap-3">
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
      <legend className="sr-only">{t("modeling.element")}</legend>
      <PeriodicTablePicker value={element} onChange={setElement} disabled={disabled} label={t("modeling.element")} />
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="outline" disabled={disabled || sites.every(site => model.structure.species[site.speciesIndex] === element)}
          onClick={() => onPreview({ type: "substitute", siteIds, element })}>{t("modeling.substitute")}</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPreview({ type: "vacancy", siteIds })}>{t("modeling.vacancy")}</Button>
      </div>
    </fieldset>
    {sites.length === 1 ? <PositionEditor initial={sites[0]!.fractionalPosition} vectors={model.structure.cell.vectors}
      disabled={disabled} action={t("modeling.move")}
      onPreview={(position, coordinates) => onPreview({ type: "move", siteId: sites[0]!.siteId, position, coordinates })} /> : null}
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-xs text-muted-foreground">{t("modeling.constraints")}</legend>
      <div className="grid grid-cols-3 gap-2">
        {AXES.map((axis, index) => <label key={axis} className="flex items-center gap-2 text-xs">
          <Checkbox checked={flags[index]} disabled={disabled} aria-label={t("modeling.freeAxis", { axis })}
            onCheckedChange={value => setFlags(current => current.map((flag, i) => i === index ? value === true : flag))} />
          {axis} {flags[index] === "indeterminate" ? "–" : flags[index] ? "T" : "F"}
        </label>)}
      </div>
      <Button size="sm" variant="outline" disabled={disabled || flags.includes("indeterminate")}
        onClick={() => onPreview({ type: "constraints", siteIds, flags: flags as [boolean, boolean, boolean] })}>{t("modeling.previewConstraints")}</Button>
    </fieldset>
  </div>;
}

function InterstitialEditor({ model, disabled, onPreview }: OperationEditorProps & { model: ModelState }) {
  const { t } = useTranslation();
  const [element, setElement] = useState(model.structure.species[0]!);
  return <div className="flex flex-col gap-2">
    <PeriodicTablePicker value={element} onChange={setElement} disabled={disabled} label={t("modeling.element")} />
    <PositionEditor initial={INTERSTITIAL_POSITION} vectors={model.structure.cell.vectors} disabled={disabled}
      action={t("modeling.addInterstitial")} onPreview={(position, coordinates) => onPreview({ type: "interstitial", element, position, coordinates })} />
  </div>;
}

function PositionEditor({ initial, vectors, disabled, action, onPreview }: {
  initial: Vec3; vectors: Vec3[]; disabled: boolean; action: string;
  onPreview: (position: Vec3, coordinates: Coordinates) => void;
}) {
  const { t } = useTranslation();
  const [coordinates, setCoordinates] = useState<Coordinates>("direct");
  const [draft, setDraft] = useState<VectorDraft>(() => formatVector(initial));
  const [invalid, setInvalid] = useState(false);
  function changeCoordinates(next: Coordinates) {
    if (next === coordinates) return;
    const value = parseVector(draft);
    if (!value) { setInvalid(true); return; }
    setDraft(formatVector(next === "cartesian" ? fractionalToCartesian(value, vectors) : cartesianToFractional(value, vectors)));
    setCoordinates(next);
  }
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
    <legend className="sr-only">{t("modeling.position")}</legend>
    <ToggleGroup type="single" variant="outline" size="sm" value={coordinates} disabled={disabled}
      aria-label={t("modeling.coordinateMode")} className="w-full" onValueChange={value => { if (value) changeCoordinates(value as Coordinates); }}>
      <ToggleGroupItem value="direct" className="flex-1">{t("modeling.direct")}</ToggleGroupItem>
      <ToggleGroupItem value="cartesian" className="flex-1">{t("modeling.cartesian")}</ToggleGroupItem>
    </ToggleGroup>
    <div className="grid grid-cols-3 gap-2">
      {(coordinates === "direct" ? AXES : CARTESIAN_AXES).map((axis, index) => <label key={axis} className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {axis}{coordinates === "cartesian" ? " (Å)" : ""}
        <Input inputMode="decimal" value={draft[index]} aria-label={t("modeling.coordinateAxis", { axis })}
          aria-invalid={invalid} className="h-8 min-w-0 px-2" onChange={event => { setDraft(withDraftValue(draft, index, event.target.value)); setInvalid(false); }} />
      </label>)}
    </div>
    {invalid ? <p role="alert" className="text-xs text-destructive">{t("modeling.invalidVector")}</p> : null}
    <Button size="sm" variant="outline" disabled={disabled} onClick={() => {
      const value = parseVector(draft);
      if (!value) { setInvalid(true); return; }
      onPreview(value, coordinates);
    }}>{action}</Button>
  </fieldset>;
}

function DefectRow({ model, defect, disabled, onLocate, onPreview }: OperationEditorProps & {
  model: ModelState; defect: DefectRecord; onLocate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const site = model.structure.sites.find(candidate => candidate.siteId === defect.siteId);
  const element = site ? model.structure.species[site.speciesIndex]
    : defect.originalElement ?? (defect.originalSite ? model.structure.species[defect.originalSite.speciesIndex] : undefined);
  const displayNumber = site?.displayAtomNumber ?? defect.originalSite?.displayAtomNumber
    ?? site?.sourceAtomNumber ?? defect.originalSite?.sourceAtomNumber;
  const kind = t(defect.kind === "vacancy" ? "modeling.vacancy" : defect.kind === "substitution" ? "modeling.substitute" : "modeling.interstitial");
  const label = `${kind} · ${defect.originalElement && defect.kind === "substitution" ? `${defect.originalElement} → ` : ""}${element ?? ""}${displayNumber !== undefined ? ` #${displayNumber}` : ""}`;
  return <li className="flex items-center gap-2">
    <div className="min-w-0 flex-1">
      <p className="truncate text-xs" title={label}>{label}</p>
      <p className="font-mono text-[10px] text-muted-foreground">{defect.fractionalPosition.map(formatNumber).join(", ")}</p>
    </div>
    <div className="flex shrink-0 gap-0.5">
      <Button size="icon" variant="ghost" className="size-7" disabled={disabled} aria-label={t("modeling.locateDefect", { defect: label })}
        title={t("modeling.locateDefect", { defect: label })} onClick={() => onLocate(defect.id)}><Crosshair /></Button>
      <Button size="icon" variant="ghost" className="size-7" disabled={disabled} aria-label={t("modeling.centerDefect", { defect: label })}
        title={t("modeling.centerDefect", { defect: label })} onClick={() => onPreview({ type: "center", defectId: defect.id })}><Focus /></Button>
      <Button size="icon" variant="ghost" className="size-7" disabled={disabled} aria-label={t("modeling.restoreDefect", { defect: label })}
        title={t("modeling.restoreDefect", { defect: label })} onClick={() => onPreview({ type: "restore", defectId: defect.id })}><RotateCcw /></Button>
    </div>
  </li>;
}

function SymmetryEditor({ controller, disabled }: { controller: ModelingPanelController; disabled: boolean }) {
  const { t } = useTranslation();
  const foundTolerance = controller.symmetry?.tolerance;
  const [tolerance, setTolerance] = useState(() => foundTolerance === undefined ? "1e-5" : String(foundTolerance));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (foundTolerance === undefined) return;
    setTolerance(String(foundTolerance)); setInvalid(false);
  }, [foundTolerance]);
  const matchesResult = foundTolerance !== undefined && tolerance.trim() !== "" && Number(tolerance) === foundTolerance;
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
    <legend className="sr-only">{t("modeling.symmetry")}</legend>
    <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      {t("modeling.tolerance")}
      <Input inputMode="decimal" aria-label={t("modeling.tolerance")} value={tolerance} aria-invalid={invalid} className="h-8 w-28"
        onChange={event => { setTolerance(event.target.value); setInvalid(false); }} />
    </label>
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => {
      const value = Number(tolerance);
      if (!tolerance.trim() || !Number.isFinite(value) || value <= 0) { setInvalid(true); return; }
      controller.onFindSymmetry(value);
    }}>{t("modeling.find")}</Button>
    {invalid ? <p role="alert" className="text-xs text-destructive">{t("modeling.invalidTolerance")}</p> : null}
    {controller.symmetry ? <div className="flex items-center justify-between gap-2 text-xs">
      <span>{controller.symmetry.spaceGroup} · #{controller.symmetry.spaceGroupNumber}</span>
      <span className="text-muted-foreground">{t("modeling.operationCount", { count: controller.symmetry.operationCount })}</span>
    </div> : null}
    <Button variant="outline" size="sm" disabled={disabled || !matchesResult} onClick={controller.onPreviewImpose}>{t("modeling.impose")}</Button>
  </fieldset>;
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2.5" aria-label={title}>
    <h2 className="text-sm font-medium">{title}</h2>{children}
  </section>;
}

function PanelError({ children }: { children: ReactNode }) {
  return <Alert variant="destructive"><AlertTriangle /><AlertDescription>{children}</AlertDescription></Alert>;
}

function parseVector(draft: VectorDraft): Vec3 | null {
  const values = draft.map(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) ? Number(value) : NaN);
  return values.every(Number.isFinite) ? values as Vec3 : null;
}

function withDraftValue(draft: VectorDraft, index: number, value: string): VectorDraft {
  return draft.map((current, i) => i === index ? value : current) as VectorDraft;
}

function formatNumber(value: number): string { return Number(value.toPrecision(6)).toString(); }
function formatVector(vector: Vec3): VectorDraft { return vector.map(String) as VectorDraft; }
