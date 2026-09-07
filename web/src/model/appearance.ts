import type { AtomSpec } from "../api/scene";
import { cartoonElement } from "./cartoonElements";
import {
  autoDistinctElementColorOverrides,
  DEFAULT_COLOR_SCHEME_ID,
  elementColorsForScheme,
  elementColorForScheme,
  hasElementColor,
  type ElementColorOverrides,
  type ColorScheme,
} from "./colorSchemes";
import {
  DEFAULT_MATERIAL_PRESET_ID,
  type MaterialPresetId,
} from "./materialPresets";
import {
  createDefaultObjectStyleState,
  type AtomRadiusStyleModel,
  type ObjectStyleState,
} from "./objectStyles";

export const DEFAULT_BOND_COLOR = "#d2d2d2";
export const DEFAULT_LIGHT_DIRECTION: [number, number] = [56.31, 39.76];

export type BondColorMode = "unicolor" | "bicolor";
export type ColorSchemeMode = "preset" | "custom";
export type CrystalAxisColors = Record<"a" | "b" | "c", string>;

export interface CustomColormap {
  baseColorScheme: ColorScheme;
  elements: Record<string, string>;
}

export interface StyleState {
  polyhedronColors?: Record<string, string>;
  lightDirection?: [azimuth: number, elevation: number];
  mainLightIntensity?: number;
  ambientLightIntensity?: number;
  atomRadius: number;
  atomRadiusModel: AtomRadiusStyleModel;
  bondColor: string;
  bondColorMode: BondColorMode;
  bondThickness: number;
  colorScheme: ColorScheme;
  colorSchemeMode: ColorSchemeMode;
  customColormap: CustomColormap | null;
  distinguishSimilarColors: boolean;
  fogAffectsUnitCell: boolean;
  fogAmount: number;
  fogEnabled: boolean;
  fogStart: number;
  materialPreset: MaterialPresetId;
  objectStyles: ObjectStyleState;
}

export type CrystalAxisMaterialState = Pick<StyleState,
  "materialPreset" | "ambientLightIntensity" | "mainLightIntensity" | "lightDirection"
> & { lightStrength: number };

export function crystalAxisMaterialForStyle(style: Pick<StyleState,
  "materialPreset" | "ambientLightIntensity" | "mainLightIntensity" | "lightDirection"
>, lightStrength = 1): CrystalAxisMaterialState {
  return {
    materialPreset: style.materialPreset,
    ambientLightIntensity: style.ambientLightIntensity,
    mainLightIntensity: style.mainLightIntensity,
    lightDirection: style.lightDirection,
    lightStrength,
  };
}

export const DEFAULT_CRYSTAL_AXIS_MATERIAL = crystalAxisMaterialForStyle({ materialPreset: DEFAULT_MATERIAL_PRESET_ID });

export const DEFAULT_STYLE: StyleState = {
  atomRadius: 55,
  atomRadiusModel: "atomic",
  bondColor: DEFAULT_BOND_COLOR,
  bondColorMode: "bicolor",
  bondThickness: 150,
  colorScheme: DEFAULT_COLOR_SCHEME_ID,
  colorSchemeMode: "custom",
  customColormap: { baseColorScheme: DEFAULT_COLOR_SCHEME_ID,
    elements: elementColorsForScheme("sakura-sky") },
  distinguishSimilarColors: false,
  fogAffectsUnitCell: false,
  fogAmount: 40,
  fogEnabled: false,
  fogStart: 40,
  materialPreset: DEFAULT_MATERIAL_PRESET_ID,
  objectStyles: createDefaultObjectStyleState(),
};

export const STYLE_SCALE_MIN: Pick<StyleState, "atomRadius" | "bondThickness"> = {
  atomRadius: 0,
  bondThickness: 0,
};

export const STYLE_SCALE_MAX: Pick<StyleState, "atomRadius" | "bondThickness"> = {
  atomRadius: 100,
  bondThickness: 200,
};

export const STYLE_FOG_AMOUNT_MIN = 0;
export const STYLE_FOG_AMOUNT_MAX = 100;
export const STYLE_FOG_START_MIN = 0;
export const STYLE_FOG_START_MAX = 100;

export function createDefaultStyle(): StyleState {
  return {
    ...DEFAULT_STYLE,
    objectStyles: createDefaultObjectStyleState(),
  };
}

export function polyhedronColorForElement(style: Pick<StyleState, "polyhedronColors">, element: string): string {
  return style.polyhedronColors?.[element] ?? (hasElementColor(element, "sakura-sky")
    ? elementColorForScheme(element, "sakura-sky") : cartoonElement(element).color);
}

export function createCustomColormapFromScheme(
  colorScheme: ColorScheme,
): CustomColormap {
  return {
    baseColorScheme: colorScheme,
    elements: elementColorsForScheme(colorScheme),
  };
}

export function createCustomColormapFromStyle(
  atoms: readonly AtomSpec[],
  style: StyleState,
): CustomColormap {
  const baseColorScheme = baseColorSchemeForStyle(style);
  return {
    baseColorScheme,
    elements: {
      ...elementColorsForScheme(baseColorScheme),
      ...elementColorOverridesForStyle(atoms, style),
    },
  };
}

export function hasCustomColormapChanges(customColormap: CustomColormap): boolean {
  const baseElements = elementColorsForScheme(customColormap.baseColorScheme);
  const customElements = customColormap.elements;
  const elementSymbols = new Set([
    ...Object.keys(baseElements),
    ...Object.keys(customElements),
  ]);

  for (const element of elementSymbols) {
    if (customElements[element] !== baseElements[element]) {
      return true;
    }
  }

  return false;
}

export function baseColorSchemeForStyle(style: StyleState): ColorScheme {
  if (style.colorSchemeMode === "custom" && style.customColormap) {
    return style.customColormap.baseColorScheme;
  }
  return style.colorScheme;
}

export function crystalAxisColorsForStyle(style: StyleState): CrystalAxisColors {
  const scheme = baseColorSchemeForStyle(style);
  const overrides = style.colorSchemeMode === "custom" ? style.customColormap?.elements : undefined;
  // Fixed full-palette anchors keep theme identity even in one-/two-element structures.
  // They define color roles only, never a chemical or crystallographic axis mapping.
  return {
    a: elementColorForScheme("Si", scheme, overrides),
    b: elementColorForScheme("N", scheme, overrides),
    c: elementColorForScheme("O", scheme, overrides),
  };
}

export function elementColorOverridesForStyle(
  atoms: readonly AtomSpec[],
  style: StyleState,
): ElementColorOverrides | undefined {
  if (style.colorSchemeMode === "custom") {
    return style.customColormap?.elements;
  }

  return autoDistinctElementColorOverrides(
    atoms,
    style.colorScheme,
    style.distinguishSimilarColors,
  );
}
