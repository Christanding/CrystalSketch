import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Layers, MonitorCog, Palette, Pause, Play, RotateCcw, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MESH_QUALITY_LABEL_KEYS } from "../../i18n/exportSettingsText";
import {
  MESH_QUALITY_OPTIONS, STRUCTURE_LINE_WIDTH_MAX, STRUCTURE_LINE_WIDTH_MIN, STRUCTURE_LINE_WIDTH_STEP,
  type MeshQuality, type StyleState, type UnitCellLineStyle,
} from "../../model";
import { isPhysicalMaterialPreset } from "../../model/materialPresets";
import {
  IDLE_RENDER_PROGRESS, readRenderSettings, STUDIO_PRESET_OPTIONS, STUDIO_PRESET_LIGHT_DIRECTIONS,
  type RenderMode, type RenderProgress, type RenderQuality, type RenderSettings, type StudioPreset,
} from "../../model/renderSettings";
import {
  clampLightStrength, formatLightStrengthPercent, lightStrengthToSliderPosition,
  MAX_LIGHT_STRENGTH, MIN_LIGHT_STRENGTH, parseLightStrengthPercentInput,
  sliderPositionToLightStrength, snapLightStrengthSliderPosition,
} from "../viewState";
import {
  InspectorRangeRow, InspectorSelectRow, InspectorSettingsSection, InspectorSwitchRow,
  INSPECTOR_SELECT_ITEM_CLASS, INSPECTOR_SELECT_TRIGGER_CLASS,
  type InspectorSettingsActions, type InspectorSettingsModel,
} from "./InspectorSettingsPanel";
import { LightingControls } from "./LightingControls";

const RENDER_REASON_KEYS = {
  "unsupported-material": "rendering.reasons.unsupportedMaterial",
  "scene-too-large": "rendering.reasons.sceneTooLarge",
  "webgl-unavailable": "rendering.reasons.webglUnavailable",
  "prepare-failed": "rendering.reasons.prepareFailed",
  "render-failed": "rendering.reasons.renderFailed",
  "ao-failed": "rendering.reasons.aoFailed",
  resampling: "rendering.reasons.resampling",
} as const;

export interface RenderingPanelProps {
  style: StyleState;
  onStyleChange: Dispatch<SetStateAction<StyleState>>;
  settingsModel: InspectorSettingsModel;
  settingsActions: InspectorSettingsActions;
  renderingProgress?: RenderProgress;
  renderingPaused?: boolean;
  onRenderingPausedChange?: (paused: boolean) => void;
  onRenderingRestart?: () => void;
}

export function RenderingPanel({
  style, onStyleChange, settingsModel: model, settingsActions: actions,
  renderingProgress: progress = IDLE_RENDER_PROGRESS, renderingPaused = false,
  onRenderingPausedChange, onRenderingRestart,
}: RenderingPanelProps) {
  const { t } = useTranslation();
  const settings = readRenderSettings(style.rendering);
  const physicalMaterial = isPhysicalMaterialPreset(style.materialPreset);
  const mode = physicalMaterial ? settings.mode : "realtime";
  const highQuality = mode === "path-traced";
  const ambientOcclusionEnabled = physicalMaterial && settings.aoEnabled;

  function changeSettings(patch: Partial<RenderSettings>) {
    onStyleChange(current => ({ ...current, rendering: { ...readRenderSettings(current.rendering), ...patch } }));
  }

  function changeMode(mode: RenderMode) {
    if (mode === "path-traced" && !physicalMaterial) return;
    if (mode === settings.mode) return;
    changeSettings({ mode });
    onRenderingPausedChange?.(false);
  }

  function changeStudio(studio: StudioPreset) {
    const direction = STUDIO_PRESET_LIGHT_DIRECTIONS[studio];
    onStyleChange(current => ({
      ...current,
      ...(direction ? { lightDirection: [direction[0], direction[1]] as [number, number] } : {}),
      rendering: { ...readRenderSettings(current.rendering), studio },
    }));
  }

  return <div className="flex flex-col gap-3">
    <ToggleGroup type="single" variant="primary" size="sm" spacing={1}
      value={mode} aria-label={t("rendering.mode")} className="grid h-7 w-full grid-cols-2"
      onValueChange={value => { if (value) changeMode(value as RenderMode); }}>
      <ToggleGroupItem value="realtime" className="h-7 min-w-0 text-[13px]">{t("rendering.realtime")}</ToggleGroupItem>
      <ToggleGroupItem value="path-traced" disabled={!physicalMaterial} className="h-7 min-w-0 text-[13px]">{t("rendering.highQuality")}</ToggleGroupItem>
    </ToggleGroup>

    {!physicalMaterial ? <p className="text-xs leading-relaxed text-muted-foreground">{t("rendering.physicalRequired")}</p> : null}

    {highQuality ? <>
      <RenderSelect label={t("rendering.quality")} value={settings.quality}
        onValueChange={value => changeSettings({ quality: value as RenderQuality })}>
        {(["draft", "standard", "high", "ultra"] as const).map(value => <SelectItem key={value} value={value}
          className={INSPECTOR_SELECT_ITEM_CLASS}>{t(`rendering.qualities.${value}`)}</SelectItem>)}
      </RenderSelect>
      {settings.quality === "ultra" ? <p className="text-xs leading-relaxed text-muted-foreground">{t("rendering.ultraHint")}</p> : null}
      {physicalMaterial ? <RenderingStatus progress={progress} paused={renderingPaused}
        onPausedChange={onRenderingPausedChange} onRestart={onRenderingRestart}
        onRecover={() => changeMode("realtime")} /> : null}
      <p className="text-xs leading-relaxed text-muted-foreground">{t("rendering.progressHint")}</p>
    </> : physicalMaterial && progress.phase === "error" ? <RenderingStatus progress={progress} paused={false}
      onRestart={onRenderingRestart} recoveryLabel={t("rendering.disableAo")}
      onRecover={() => { changeSettings({ aoEnabled: false }); onRenderingRestart?.(); }} /> : null}

    <Separator />

    <InspectorSettingsSection id="inspector-studio-settings" icon={Sun} title={t("rendering.lighting")}>
      <RenderSelect label={t("rendering.studio")} value={settings.studio} disabled={!physicalMaterial}
        onValueChange={value => changeStudio(value as StudioPreset)}>
        {STUDIO_PRESET_OPTIONS.map(value => <SelectItem key={value} value={value}
          className={INSPECTOR_SELECT_ITEM_CLASS}>{t(`rendering.studios.${value}`)}</SelectItem>)}
      </RenderSelect>
      <RenderNumber label={t("rendering.environmentRotation")} value={settings.environmentRotation}
        min={0} max={360} step={5} suffix="°" disabled={!physicalMaterial}
        onValueChange={environmentRotation => changeSettings({ environmentRotation })} />
      <RenderNumber label={t("rendering.exposure")} value={settings.exposure}
        min={0.25} max={3} step={0.05} disabled={!physicalMaterial} onValueChange={exposure => changeSettings({ exposure })} />
      {!physicalMaterial ? <p className="text-xs leading-relaxed text-muted-foreground">{t("rendering.studioPhysicalOnly")}</p> : null}
      <InspectorRangeRow label={t("settings.lightStrength")} value={model.lightStrength}
        min={MIN_LIGHT_STRENGTH} max={MAX_LIGHT_STRENGTH} clampValue={clampLightStrength}
        formatPercent={formatLightStrengthPercent} onValueChange={actions.onLightStrengthChange}
        parsePercentInput={parseLightStrengthPercentInput} sliderPositionToValue={sliderPositionToLightStrength}
        snapSliderPosition={snapLightStrengthSliderPosition} valueToSliderPosition={lightStrengthToSliderPosition} />
      {actions.onLightDirectionChange && actions.onMainLightIntensityChange && actions.onAmbientLightIntensityChange ? (
        <LightingControls direction={model.lightDirection} mainIntensity={model.mainLightIntensity}
          ambientIntensity={model.ambientLightIntensity} onDirectionChange={actions.onLightDirectionChange}
          onMainIntensityChange={actions.onMainLightIntensityChange} onAmbientIntensityChange={actions.onAmbientLightIntensityChange} />
      ) : null}
    </InspectorSettingsSection>

    <Separator />

    <InspectorSettingsSection id="inspector-occlusion-settings" icon={Layers} title={t("rendering.occlusion")}>
      <InspectorSwitchRow checked={ambientOcclusionEnabled} disabled={highQuality || !physicalMaterial} label={t("rendering.aoEnabled")}
        onCheckedChange={aoEnabled => changeSettings({ aoEnabled })} />
      {highQuality ? <p className="text-xs leading-relaxed text-muted-foreground">{t("rendering.aoRealtimeOnly")}</p> : null}
      {!physicalMaterial ? <p className="text-xs leading-relaxed text-muted-foreground">{t("rendering.aoPhysicalOnly")}</p> : null}
      <RenderNumber label={t("rendering.aoIntensity")} value={settings.aoIntensity} min={0} max={2} step={0.05}
        disabled={highQuality || !ambientOcclusionEnabled} onValueChange={aoIntensity => changeSettings({ aoIntensity })} />
      <details className="mt-1">
        <summary className="cursor-pointer rounded-sm py-1 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {t("rendering.advanced")}
        </summary>
        <RenderNumber label={t("rendering.aoRadius")} value={settings.aoRadius} min={0.25} max={3} step={0.05}
          disabled={highQuality || !ambientOcclusionEnabled} onValueChange={aoRadius => changeSettings({ aoRadius })} />
      </details>
    </InspectorSettingsSection>

    <Separator />

    <InspectorSettingsSection id="inspector-image-settings" icon={Palette} title={t("rendering.image")}>
      <InspectorSwitchRow checked={model.showCrystalAxisLabels} label={t("settings.showCrystalAxisLabels")}
        onCheckedChange={actions.onShowCrystalAxisLabelsChange} />
      <InspectorSwitchRow checked={model.fogAffectsUnitCell} label={t("settings.applyDepthFadingToUnitCell")}
        onCheckedChange={actions.onFogAffectsUnitCellChange} />
      <RenderSelect label={t("settings.unitCellLineStyle")} value={model.unitCellLineStyle}
        onValueChange={value => actions.onUnitCellLineStyleChange(value as UnitCellLineStyle)}>
        <SelectItem value="solid" className={INSPECTOR_SELECT_ITEM_CLASS}>{t("settings.solid")}</SelectItem>
        <SelectItem value="dashed" className={INSPECTOR_SELECT_ITEM_CLASS}>{t("settings.dashed")}</SelectItem>
      </RenderSelect>
      <RenderNumber label={t("settings.unitCellLineWidth")} value={model.structureLineWidth.unitCell}
        min={STRUCTURE_LINE_WIDTH_MIN} max={STRUCTURE_LINE_WIDTH_MAX} step={STRUCTURE_LINE_WIDTH_STEP} suffix="px"
        onValueChange={unitCell => actions.onStructureLineWidthChange(current => ({ ...current, unitCell }))} />
      <RenderNumber label={t("settings.polyhedraEdgeWidth")} value={model.structureLineWidth.polyhedra}
        min={STRUCTURE_LINE_WIDTH_MIN} max={STRUCTURE_LINE_WIDTH_MAX} step={STRUCTURE_LINE_WIDTH_STEP / 2} suffix="px"
        onValueChange={polyhedra => actions.onStructureLineWidthChange(current => ({ ...current, polyhedra }))} />
      <InspectorSwitchRow checked={model.isCustomColorScheme ? false : model.distinguishSimilarColors}
        disabled={model.isCustomColorScheme} label={t("settings.distinguishSimilarColors")}
        onCheckedChange={actions.onDistinguishSimilarColorsChange} />
    </InspectorSettingsSection>

    <Separator />

    <InspectorSettingsSection id="inspector-preview-settings" icon={MonitorCog} title={t("rendering.preview")}>
      <RenderSelect label={t("settings.previewQuality")} value={model.previewMeshQuality}
        onValueChange={value => actions.onPreviewMeshQualityChange(value as MeshQuality)}>
        {MESH_QUALITY_OPTIONS.map(value => <SelectItem key={value} value={value}
          className={INSPECTOR_SELECT_ITEM_CLASS}>{t(MESH_QUALITY_LABEL_KEYS[value])}</SelectItem>)}
      </RenderSelect>
      <InspectorSwitchRow checked={model.showFpsOverlay} label={t("settings.showFps")}
        onCheckedChange={actions.onShowFpsOverlayChange} />
    </InspectorSettingsSection>
  </div>;
}

function RenderSelect({ label, value, onValueChange, children, disabled = false }: {
  label: string; value: string; onValueChange: (value: string) => void; children: ReactNode; disabled?: boolean;
}) {
  return <InspectorSelectRow label={label}>
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={INSPECTOR_SELECT_TRIGGER_CLASS}><SelectValue /></SelectTrigger>
      <SelectContent position="popper" className="!bg-background !text-foreground">{children}</SelectContent>
    </Select>
  </InspectorSelectRow>;
}

function RenderNumber({ label, disabled = false, ...props }: {
  label: string; value: number; min: number; max: number; step: number; suffix?: string;
  disabled?: boolean; onValueChange: (value: number) => void;
}) {
  return <fieldset disabled={disabled} className={disabled ? "min-w-0 opacity-55" : "min-w-0"}>
    <InspectorSelectRow label={label}>
      <NumberStepper aria-label={label} className="justify-self-end" {...props} />
    </InspectorSelectRow>
  </fieldset>;
}

function RenderingStatus({ progress, paused, onPausedChange, onRestart, onRecover, recoveryLabel }: {
  progress: RenderProgress; paused: boolean; onPausedChange?: (paused: boolean) => void;
  onRestart?: () => void; onRecover: () => void; recoveryLabel?: string;
}) {
  const { t } = useTranslation();
  const failed = progress.phase === "error" || progress.phase === "unsupported";
  const canPause = progress.phase === "rendering" || progress.phase === "preparing" || progress.phase === "paused";
  const isPaused = paused || progress.phase === "paused";
  const phase = canPause && isPaused ? "paused" : progress.phase;
  const samples = Math.max(0, Math.floor(progress.samples));
  const target = Math.max(0, Math.floor(progress.targetSamples));
  const reason = progress.message ? RENDER_REASON_KEYS[progress.message as keyof typeof RENDER_REASON_KEYS] : undefined;

  return <div className="space-y-2 text-xs">
    <p role="status" aria-live="polite" className={failed ? "text-destructive" : "text-muted-foreground"}>
      {reason ? t(reason) : progress.message ?? t(`rendering.phases.${phase}`)}
    </p>
    {target > 0 && !failed ? <>
      <progress aria-label={t("rendering.sampleProgress")} max={target} value={Math.min(samples, target)}
        className="block h-1 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-foreground [&::-moz-progress-bar]:bg-foreground" />
      <div className="flex items-center justify-between gap-2 tabular-nums text-muted-foreground">
        <span>{t("rendering.samples", { current: samples, target })}</span>
        <span>{t("rendering.elapsed", { seconds: Math.max(0, progress.elapsedMs / 1000).toFixed(1) })}</span>
      </div>
    </> : null}
    <div className="flex flex-wrap gap-2">
      {canPause && onPausedChange ? <Button size="sm" variant="outline" className="h-7 text-xs"
        onClick={() => onPausedChange(!isPaused)}>
        {isPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        {t(isPaused ? "rendering.resume" : "rendering.pause")}
      </Button> : null}
      {onRestart && (failed || progress.phase === "complete") ? <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRestart}>
        <RotateCcw aria-hidden="true" />{t(failed ? "rendering.retry" : "rendering.restart")}
      </Button> : null}
      {failed ? <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRecover}>{recoveryLabel ?? t("rendering.backToRealtime")}</Button> : null}
    </div>
  </div>;
}
