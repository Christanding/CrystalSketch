declare module "n8ao" {
  import type { Camera, Scene } from "three";
  import { Pass } from "three/addons/postprocessing/Pass.js";
  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      gammaCorrection: boolean; neuralDenoise: boolean; accumulate: boolean;
      aoRadius: number; intensity: number; transparencyAware: boolean;
    };
    setQualityMode(quality: "Low" | "Medium" | "High" | "Ultra"): void;
    firstFrame(): void;
  }
}
