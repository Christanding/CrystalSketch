import { buildVaspScene, parseVaspScene } from "./vasp";
import type { VaspParseRequest } from "./vaspWorker";

self.onmessage = (event: MessageEvent<VaspParseRequest>) => {
  const { content, structure, cutoffOverrides, bondTolerance } = event.data;
  try {
    self.postMessage({ scene: structure ? buildVaspScene(structure, cutoffOverrides, bondTolerance)
      : parseVaspScene(content ?? "", cutoffOverrides, bondTolerance) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "VASP parsing failed." });
  }
};
