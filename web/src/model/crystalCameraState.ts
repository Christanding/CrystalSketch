import type { VectorTuple } from "./vector";

export type CrystalCameraScreenDirection = "right" | "upward" | "outward";
export type CrystalCameraPrimaryDirection = CrystalCameraScreenDirection;
export type CrystalAxisLabel = "a" | "b" | "c";

// User-facing right-handed frame. viewVector is expressed in Three.js camera space.
export const CRYSTAL_SCREEN_AXES: readonly {
  label: "X" | "Y" | "Z";
  direction: CrystalCameraScreenDirection;
  viewVector: VectorTuple;
}[] = [
  { label: "X", direction: "outward", viewVector: [0, 0, 1] },
  { label: "Y", direction: "right", viewVector: [1, 0, 0] },
  { label: "Z", direction: "upward", viewVector: [0, 1, 0] },
];

export interface CrystalCameraState {
  direct: VectorTuple;
  primary: CrystalCameraPrimaryDirection;
  reciprocal: VectorTuple;
  secondary: CrystalCameraScreenDirection;
  rollDegrees: number;
}
