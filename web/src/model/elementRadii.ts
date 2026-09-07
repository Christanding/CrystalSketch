import type { AtomRadiusModel, AtomSpec } from "../api/scene";
import elementRadii from "../data/element-radii.json";
import { cartoonElement } from "./cartoonElements";
import { findPeriodicElement } from "../data/periodic-table";

interface ElementRadiiData {
  elements: Record<string, Record<AtomRadiusModel, number>>;
}

const ELEMENT_RADII = elementRadii as ElementRadiiData;

export function atomRadiusForModel(atom: AtomSpec, model: AtomRadiusModel): number {
  return elementRadiusForModel(atom.element, model);
}

export function elementRadiusForModel(element: string, model: AtomRadiusModel): number {
  if (model === "atomic") return cartoonElement(element).atomRadius;
  const radii = ELEMENT_RADII.elements[element];
  if (radii === undefined) {
    // Rendering fallback only: no physical radius is inferred for missing data.
    if (findPeriodicElement(element)) return 1;
    throw new Error(`No element radius is defined for element ${element}.`);
  }
  return radii[model];
}

export function hasElementRadius(element: string): boolean {
  return ELEMENT_RADII.elements[element] !== undefined;
}

export function elementRadiusSymbols(): string[] {
  return Object.keys(ELEMENT_RADII.elements);
}
