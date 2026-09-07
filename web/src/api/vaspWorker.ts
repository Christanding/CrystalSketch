import type { BondCutoffRange, SceneSpec } from "./scene";
import { buildVaspScene, parseVaspScene } from "./vasp";
import type { PeriodicStructure } from "../model/periodicStructure";

export interface VaspParseRequest {
  content?: string;
  structure?: PeriodicStructure;
  cutoffOverrides?: Record<string, BondCutoffRange>;
  bondTolerance?: number;
}

export async function parseVaspFile(file: File, options: Omit<VaspParseRequest, "content"> & { signal?: AbortSignal }): Promise<SceneSpec> {
  options.signal?.throwIfAborted();
  const content = await file.text();
  options.signal?.throwIfAborted();
  // Small files parse faster in-place; larger structures must not block UI input.
  if (file.size < 64 * 1024 || typeof window === "undefined" || typeof window.Worker !== "function") {
    return parseVaspScene(content, options.cutoffOverrides, options.bondTolerance);
  }
  return parseInWorker({ content, cutoffOverrides: options.cutoffOverrides, bondTolerance: options.bondTolerance }, options.signal);
}

export async function buildStructureScene(structure: PeriodicStructure,
  options: { cutoffOverrides?: Record<string, BondCutoffRange>; bondTolerance?: number; signal?: AbortSignal } = {}): Promise<SceneSpec> {
  options.signal?.throwIfAborted();
  if (structure.sites.length < 512 || typeof window === "undefined" || typeof window.Worker !== "function") {
    return buildVaspScene(structure, options.cutoffOverrides, options.bondTolerance);
  }
  return parseInWorker({ structure, cutoffOverrides: options.cutoffOverrides, bondTolerance: options.bondTolerance }, options.signal);
}

function parseInWorker(request: VaspParseRequest, signal?: AbortSignal): Promise<SceneSpec> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./vasp.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    worker.onmessage = (event: MessageEvent<{ scene?: SceneSpec; error?: string }>) => {
      cleanup();
      if (event.data.scene) resolve(event.data.scene);
      else reject(new Error(event.data.error ?? "VASP parsing failed."));
    };
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || "VASP worker failed.")); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      worker.postMessage(request);
    } catch (error) { cleanup(); reject(error); }
  });
}
