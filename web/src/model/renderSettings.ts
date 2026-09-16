export type RenderMode = "realtime" | "path-traced";
export const STUDIO_PRESET_OPTIONS = [
  "original", "softbox", "side", "rim", "uniform", "overhead", "dual-strip", "rembrandt",
] as const;
export type StudioPreset = typeof STUDIO_PRESET_OPTIONS[number];
/** Canonical main-light directions for the photographic rigs, in camera-space degrees. */
export const STUDIO_PRESET_LIGHT_DIRECTIONS: Readonly<Partial<Record<StudioPreset, readonly [number, number]>>> = {
  uniform: [0, 30],
  overhead: [0, 90],
  "dual-strip": [-65, 15],
  rembrandt: [-45, 40],
};
export type RenderQuality = "draft" | "standard" | "high" | "ultra";

/** Rendering choices are independent of element colors, materials and model geometry. */
export interface RenderSettings {
  mode: RenderMode;
  studio: StudioPreset;
  environmentRotation: number;
  exposure: number;
  aoEnabled: boolean;
  aoIntensity: number;
  aoRadius: number;
  quality: RenderQuality;
}

export interface PhysicalMaterialOverrides {
  roughness?: number;
  metalness?: number;
  clearcoat?: number;
  transmission?: number;
}

export interface RenderProgress {
  phase: "idle" | "preparing" | "rendering" | "paused" | "complete" | "unsupported" | "error";
  samples: number;
  targetSamples: number;
  elapsedMs: number;
  message?: string;
}

export const IDLE_RENDER_PROGRESS: RenderProgress = {
  phase: "idle", samples: 0, targetSamples: 0, elapsedMs: 0,
};

export const DEFAULT_RENDER_SETTINGS: Readonly<RenderSettings> = Object.freeze({
  mode: "realtime",
  studio: "original",
  environmentRotation: 0,
  exposure: 1,
  aoEnabled: false,
  aoIntensity: 0.6,
  aoRadius: 1,
  quality: "standard",
});

export const RENDER_QUALITY: Record<RenderQuality, {
  previewSamples: number; exportSamples: number; bounces: number; previewScale: number;
}> = {
  draft: { previewSamples: 24, exportSamples: 64, bounces: 3, previewScale: 0.65 },
  standard: { previewSamples: 128, exportSamples: 256, bounces: 5, previewScale: 0.8 },
  high: { previewSamples: 256, exportSamples: 512, bounces: 8, previewScale: 1 },
  ultra: { previewSamples: 512, exportSamples: 2048, bounces: 12, previewScale: 1 },
};

export function readRenderSettings(value?: Partial<RenderSettings> | null): RenderSettings {
  const d = DEFAULT_RENDER_SETTINGS;
  return {
    mode: value?.mode === "path-traced" ? "path-traced" : "realtime",
    studio: STUDIO_PRESET_OPTIONS.includes(value?.studio as StudioPreset) ? value!.studio! : d.studio,
    environmentRotation: finiteRange(value?.environmentRotation, 0, 360, d.environmentRotation),
    exposure: finiteRange(value?.exposure, 0.25, 3, d.exposure),
    aoEnabled: value?.aoEnabled === true,
    aoIntensity: finiteRange(value?.aoIntensity, 0, 2, d.aoIntensity),
    aoRadius: finiteRange(value?.aoRadius, 0.25, 3, d.aoRadius),
    quality: ["draft", "standard", "high", "ultra"].includes(value?.quality ?? "") ? value!.quality! : d.quality,
  };
}

export function readPhysicalMaterialOverrides(value?: PhysicalMaterialOverrides): PhysicalMaterialOverrides {
  if (!value) return {};
  return Object.fromEntries((["roughness", "metalness", "clearcoat", "transmission"] as const)
    .filter(key => typeof value[key] === "number" && Number.isFinite(value[key]))
    .map(key => [key, Math.min(1, Math.max(0, value[key]!))]));
}

function finiteRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
