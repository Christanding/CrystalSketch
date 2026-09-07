import { normalizeRollDegrees } from "../../../../scene/crystalCamera";

export function shortestRollDelta(from: number, to: number): number {
  const delta = ((toPositiveRollDegrees(to) - toPositiveRollDegrees(from) + 540) % 360) - 180;
  return delta === -180 ? 180 : delta;
}

export function rollDisplayAnimationProgress(progress: number): number {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clampedProgress) ** 3;
}

export function formatRollValue(value: number): string {
  return String(displayRollDegrees(value));
}

export function rollValueInputWidth(value: string): string {
  return `${Math.min(8, Math.max(1, value.length))}ch`;
}

export function toPositiveRollDegrees(value: number): number {
  const signedValue = normalizeRollDegrees(value);
  return signedValue < 0 ? signedValue + 360 : signedValue;
}

export function displayRollDegrees(value: number): number {
  const roundedValue = Math.round(toPositiveRollDegrees(value));
  return roundedValue >= 360 ? 0 : roundedValue;
}

export function parseRollInput(value: string): number | null {
  const nextValue = Number(value.trim().replace(/°$/, ""));
  return Number.isFinite(nextValue) ? nextValue : null;
}
