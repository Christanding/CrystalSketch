import { type CSSProperties, type PointerEvent, useId } from "react";
import { useTranslation } from "react-i18next";

import { NumberStepper } from "@/components/ui/number-stepper";
import { DEFAULT_LIGHT_DIRECTION } from "../../model/appearance";
import { useAutoBlurSlider } from "../controls/commonPanel/sharedControls";

// Pointer coordinates project onto the camera-facing hemisphere, as in the original widget.
export function lightDirectionFromPoint(x: number, y: number): [number, number] {
  const length = Math.max(1, Math.hypot(x, y));
  x /= length;
  y /= length;
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return [Math.atan2(x, z) * 180 / Math.PI, Math.asin(y) * 180 / Math.PI];
}

export function LightingControls({
  direction = DEFAULT_LIGHT_DIRECTION,
  mainIntensity = 0.7,
  ambientIntensity = 0.6,
  onDirectionChange,
  onMainIntensityChange,
  onAmbientIntensityChange,
}: {
  direction?: [number, number];
  mainIntensity?: number;
  ambientIntensity?: number;
  onDirectionChange: (value: [number, number]) => void;
  onMainIntensityChange: (value: number) => void;
  onAmbientIntensityChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const gradientId = useId();
  const azimuth = direction[0] * Math.PI / 180;
  const elevation = direction[1] * Math.PI / 180;
  const x = Math.cos(elevation) * Math.sin(azimuth);
  const y = Math.sin(elevation);
  const z = Math.cos(elevation) * Math.cos(azimuth);
  const shade = Math.min(180, 30 + ambientIntensity * 75);
  const highlight = Math.min(250, shade + mainIntensity * Math.max(0, z) * 190);

  function updateFromPointer(event: PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.44;
    onDirectionChange(lightDirectionFromPoint(
      (event.clientX - rect.left - rect.width / 2) / radius,
      (rect.top + rect.height / 2 - event.clientY) / radius,
    ));
  }

  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3">
        <button
          type="button"
          aria-label={t("settings.lightDirection")}
          title={t("settings.lightDirectionHint")}
          className="size-[5.5rem] touch-none select-none rounded-md border bg-background p-0 cursor-crosshair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            updateFromPointer(event);
          }}
          onPointerMove={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event);
          }}
          onPointerUp={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            updateFromPointer(event);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={event => {
            if (!event.key.startsWith("Arrow")) return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : 2;
            const next: [number, number] = [...direction];
            if (event.key === "ArrowLeft") next[0] -= step;
            if (event.key === "ArrowRight") next[0] += step;
            if (event.key === "ArrowUp") next[1] += step;
            if (event.key === "ArrowDown") next[1] -= step;
            next[0] = ((next[0] + 540) % 360) - 180;
            next[1] = Math.max(-90, Math.min(90, next[1]));
            onDirectionChange(next);
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 100 100" className="size-full">
            <defs>
              <radialGradient id={gradientId} cx={`${50 + x * 30}%`} cy={`${50 - y * 30}%`} r="75%">
                <stop offset="0" stopColor={`rgb(${highlight}, ${highlight}, ${highlight})`} />
                <stop offset="0.45" stopColor={`rgb(${shade}, ${shade}, ${shade})`} />
                <stop offset="1" stopColor={`rgb(${shade * 0.35}, ${shade * 0.35}, ${shade * 0.35})`} />
              </radialGradient>
            </defs>
            <circle cx="50" cy="50" r="44" fill={`url(#${gradientId})`} stroke="#262626" strokeWidth="1.5" />
            <circle cx={50 + x * 44} cy={50 - y * 44} r="3" fill={z >= 0 ? "#fff" : "#737373"} stroke="#262626" strokeWidth="1" />
          </svg>
        </button>
        <div className="min-w-0 space-y-3">
          <LightIntensitySlider label={t("settings.mainLight")} value={mainIntensity} max={2} onValueChange={onMainIntensityChange} />
          <LightIntensitySlider label={t("settings.ambientLight")} value={ambientIntensity} max={1.5} onValueChange={onAmbientIntensityChange} />
        </div>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">{t("settings.lightDirectionHint")}</p>
      {([0, 1] as const).map(axis => (
        <div key={axis} className="flex min-h-8 items-center justify-between gap-3">
          <span>{axis === 0 ? t("settings.lightAzimuth") : t("settings.lightElevation")}</span>
          <NumberStepper
            aria-label={axis === 0 ? t("settings.lightAzimuth") : t("settings.lightElevation")}
            min={axis === 0 ? -180 : -90} max={axis === 0 ? 180 : 90} step={1} suffix="°"
            value={direction[axis]}
            onValueChange={value => {
              const next: [number, number] = [...direction];
              next[axis] = value;
              onDirectionChange(next);
            }}
          />
        </div>
      ))}
    </div>
  );
}

function LightIntensitySlider({ label, value, max, onValueChange }: {
  label: string;
  value: number;
  max: number;
  onValueChange: (value: number) => void;
}) {
  const sliderBlur = useAutoBlurSlider();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <NumberStepper aria-label={label} value={value} min={0} max={max} step={0.05} onValueChange={onValueChange} />
      </div>
      <span className="opacity-slider-shell relative mx-2 block h-5" style={{ "--opacity-slider-position": `${value / max * 100}%` } as CSSProperties}>
        <input
          type="range" aria-label={label} min={0} max={max} step={0.05} value={value}
          className="opacity-slider absolute inset-0 z-10 h-full w-full"
          ref={sliderBlur.ref}
          onChange={event => onValueChange(Number(event.currentTarget.value))}
          onPointerDown={sliderBlur.handlePointerDown}
          onPointerUp={sliderBlur.handlePointerEnd}
          onPointerCancel={sliderBlur.handlePointerEnd}
        />
        <span aria-hidden="true" className="opacity-slider-track pointer-events-none" />
        <span aria-hidden="true" className="opacity-slider-fill pointer-events-none" />
        <span aria-hidden="true" className="opacity-slider-thumb pointer-events-none" />
      </span>
    </div>
  );
}
