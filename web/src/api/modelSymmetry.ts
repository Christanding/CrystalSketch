import type { PeriodicStructure } from "../model/periodicStructure";
import type { SymmetrySummary } from "./scene";

export interface ModelSymmetryResult {
  number: number;
  symbol: string;
  pointGroup: string;
  operationCount: number;
  equivalentSites: string[][];
  tolerance: number;
}
export interface ModelSymmetryCandidate {
  structure: PeriodicStructure;
  result: ModelSymmetryResult;
  maxDisplacement: number;
  rmsDisplacement: number;
}

export function modelSymmetrySummary(result: ModelSymmetryResult): SymmetrySummary {
  const limits = [2, 15, 74, 142, 167, 194, 230];
  const systems = ["triclinic", "monoclinic", "orthorhombic", "tetragonal", "trigonal", "hexagonal", "cubic"];
  const crystalSystem = systems[limits.findIndex(limit => result.number <= limit)] ?? null;
  return { available: true, spaceGroup: result.symbol, spaceGroupNumber: result.number,
    pointGroup: result.pointGroup, pointGroupSchoenflies: null, crystalSystem,
    latticeSystem: crystalSystem === "trigonal" ? result.symbol.startsWith("R") ? "rhombohedral" : "hexagonal" : crystalSystem };
}
export class ModelSymmetryError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function request<T>(action: "find" | "impose", structure: PeriodicStructure, symprec: number,
  signal: AbortSignal, expectedNumber?: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/model-symmetry/${action}`, { method: "POST", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ structure, symprec, expectedNumber }) });
  } catch (failure) { signal.throwIfAborted(); throw new ModelSymmetryError("unavailable"); }
  if (!response.headers.get("content-type")?.includes("application/json")) throw new ModelSymmetryError("unavailable");
  const result = await response.json();
  if (!response.ok) throw new ModelSymmetryError(result.detail?.code ?? "unavailable");
  signal.throwIfAborted();
  return result as T;
}
export const findModelSymmetry = (structure: PeriodicStructure, symprec: number, signal: AbortSignal) =>
  request<ModelSymmetryResult>("find", structure, symprec, signal);
export const imposeModelSymmetry = (structure: PeriodicStructure, result: ModelSymmetryResult, signal: AbortSignal) =>
  request<ModelSymmetryCandidate>("impose", structure, result.tolerance, signal, result.number);
