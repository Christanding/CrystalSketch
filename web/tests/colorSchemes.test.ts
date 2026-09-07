import { describe, expect, test } from "bun:test";

import type { AtomSpec } from "../src/api/scene";
import {
  COLOR_SCHEMES,
  COLOR_SCHEME_OPTIONS,
  DEFAULT_COLOR_SCHEME_ID,
  autoDistinctElementColorOverrides,
  buildColormapCatalog,
  colorSchemeTokenStyle,
  elementColorForScheme,
  hasElementColor,
} from "../src/app/colorSchemes";
import { elementRadiusSymbols } from "../src/app/elementRadii";
import { createCustomColormapFromStyle, createDefaultStyle, crystalAxisColorsForStyle, elementColorOverridesForStyle } from "../src/model/appearance";
import { hexToOklch, oklchDistance } from "../src/model/colorSchemes/oklch";

const ILLUSTRATION_SCHEMES = [
  { label: "Sakura Sky", value: "sakura-sky" },
  { label: "Summer Meadow", value: "summer-meadow" },
  { label: "Apricot Ice", value: "apricot-ice" },
  { label: "Iris Apricot", value: "iris-apricot" },
  { label: "Sea Salt Coral", value: "sea-salt-coral" },
  { label: "Amber Mauve", value: "amber-mauve" },
];
const REFERENCE_SCHEMES = [
  { label: "CARTO Pastel", value: "carto-pastel" },
  { label: "Nord", value: "nord" },
  { label: "Grand Budapest 2", value: "grand-budapest-2" },
  { label: "Paul Tol Bright", value: "paul-tol-bright" },
  { label: "Rosé Pine Dawn", value: "rose-pine-dawn" },
  { label: "Tableau 10", value: "tableau-10" },
  { label: "Moonrise3", value: "moonrise-3" },
  { label: "Royal2", value: "royal-2" },
];

describe("color schemes", () => {
  test("colored metal preserves the stored custom element palette", () => {
    const atoms = atomsWithElements(["Cu", "I", "Ni", "O", "Zn"]);
    const original = createDefaultStyle();
    expect(createCustomColormapFromStyle(atoms, { ...original, materialPreset: "colored-metal" }).elements).toEqual(original.customColormap!.elements);
    expect(elementColorOverridesForStyle(atoms, { ...original, materialPreset: "colored-metal" })).toEqual(original.customColormap!.elements);
  });

  test("crystal axes share each palette without depending on the loaded material", () => {
    const triplets = new Set<string>();
    for (const { value } of COLOR_SCHEME_OPTIONS) {
      const style = { ...createDefaultStyle(), colorScheme: value, colorSchemeMode: "preset" as const };
      const colors = crystalAxisColorsForStyle(style);
      expect(colors).toEqual({
        a: elementColorForScheme("Si", value),
        b: elementColorForScheme("N", value),
        c: elementColorForScheme("O", value),
      });
      expect(new Set(Object.values(colors)).size).toBe(3);
      triplets.add(JSON.stringify(colors));
    }
    expect(triplets.size).toBe(COLOR_SCHEME_OPTIONS.length);
  });

  test("crystal axes respect startup and saved custom palette colors without mutating them", () => {
    const style = createDefaultStyle();
    expect(crystalAxisColorsForStyle(style)).toEqual(crystalAxisColorsForStyle({
      ...style, colorScheme: "sakura-sky", colorSchemeMode: "preset",
    }));
    style.customColormap = { baseColorScheme: "summer-meadow", elements: { Si: "#abcdef", O: "#123456" } };
    const saved = JSON.stringify(style);
    expect(crystalAxisColorsForStyle(style)).toEqual({
      a: "#abcdef", b: elementColorForScheme("N", "summer-meadow"), c: "#123456",
    });
    expect(JSON.stringify(style)).toBe(saved);
  });

  test("loads bundled colormaps from catalog data", () => {
    expect(DEFAULT_COLOR_SCHEME_ID).toBe("vesta-soft");
    expect(COLOR_SCHEMES.map((colormap) => colormap.id)).toEqual([
      ...ILLUSTRATION_SCHEMES.map(option => option.value),
      ...REFERENCE_SCHEMES.map(option => option.value),
      "vesta-soft",
      "vesta",
      "jmol-soft",
      "jmol",
    ]);
    expect(COLOR_SCHEME_OPTIONS.map(({ label, value }) => ({ label, value }))).toEqual([
      ...ILLUSTRATION_SCHEMES,
      ...REFERENCE_SCHEMES,
      { label: "VESTA Soft", value: "vesta-soft" },
      { label: "VESTA", value: "vesta" },
      { label: "Jmol Soft", value: "jmol-soft" },
      { label: "Jmol", value: "jmol" },
    ]);
  });

  test("orders softened schemes before their source schemes", () => {
    expect(COLOR_SCHEME_OPTIONS.map((option) => option.value)).toEqual([
      ...ILLUSTRATION_SCHEMES.map(option => option.value),
      ...REFERENCE_SCHEMES.map(option => option.value),
      "vesta-soft",
      "vesta",
      "jmol-soft",
      "jmol",
    ]);
  });

  test("derives token styles from catalog token elements", () => {
    expect(colorSchemeTokenStyle("vesta-soft")).toEqual({
      background:
        "linear-gradient(90deg, #f2c0c0 0% 25%, #8d5434 25% 50%, #a9b3df 50% 75%, #e15949 75% 100%)",
    });
    expect(COLOR_SCHEME_OPTIONS.find(option => option.value === "vesta-soft")?.tokenStyle).toEqual(
      colorSchemeTokenStyle("vesta-soft"),
    );
  });

  test("keeps the current default palette recoverable without changing startup style", () => {
    const style = createDefaultStyle();
    expect(style.colorSchemeMode).toBe("custom");
    expect(style.customColormap?.elements.Cu).toBe("#f1abbc");
    expect(style.customColormap?.elements.I).toBe("#97cff2");
    for (const [element, color] of Object.entries(style.customColormap!.elements)) {
      expect(elementColorForScheme(element, "sakura-sky")).toBe(color);
    }
  });

  test("previews the current structure's elements instead of a fixed CuI swatch", () => {
    const expected = `linear-gradient(90deg, ${elementColorForScheme("Na", "summer-meadow")} 0% 50%, ${elementColorForScheme("Cl", "summer-meadow")} 50% 100%)`;
    expect(colorSchemeTokenStyle("summer-meadow", ["Na", "Cl", "Na"]).background).toBe(expected);
    expect(colorSchemeTokenStyle("summer-meadow", ["not-an-element"])).toEqual(colorSchemeTokenStyle("summer-meadow"));
  });

  test("illustration and reference themes distinguish representative non-CuI materials", () => {
    const materials = [
      ["Na", "Cl"], ["Si", "O"], ["Ti", "O"], ["Ga", "N"],
      ["Cs", "Pb", "I"], ["Li", "Fe", "P", "O"], ["C", "H", "N", "O"],
      ["Zn", "O"], ["Ni", "O"], ["Ca", "Ti", "O"], ["Mo", "S"], ["Zn", "S"],
      ["Ca", "P", "O"], ["Cu", "Fe", "I"], ["Cu", "Pb", "I"], ["Cu", "Ni", "I"], ["Fe", "N"],
    ];
    for (const {value} of [...ILLUSTRATION_SCHEMES, ...REFERENCE_SCHEMES]) {
      for (const elements of materials) {
        for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
          const first = elementColorForScheme(elements[i]!, value);
          const second = elementColorForScheme(elements[j]!, value);
          expect(oklchDistance(hexToOklch(first), hexToOklch(second)), `${value}: ${elements[i]}/${elements[j]}`).toBeGreaterThan(0.09);
        }
      }
    }
    const startupColors = Object.values(createDefaultStyle().customColormap!.elements);
    // Related elements may share a theme family, but not one catch-all color.
    expect(new Set(startupColors).size).toBeGreaterThan(50);
    expect(startupColors.filter(color => color === "#c4b5de")).toHaveLength(0);
  });

  test("theme identity also changes on NiO, ZnO and non-CuI oxides", () => {
    for (let i = 0; i < ILLUSTRATION_SCHEMES.length; i++) for (let j = i + 1; j < ILLUSTRATION_SCHEMES.length; j++) {
      const first = ILLUSTRATION_SCHEMES[i]!.value;
      const second = ILLUSTRATION_SCHEMES[j]!.value;
      for (const material of [["Ni", "O"], ["Zn", "O"], ["Sr", "Ti", "O"]]) {
        const change = material.reduce((sum, element) => sum + oklchDistance(
          hexToOklch(elementColorForScheme(element, first)), hexToOklch(elementColorForScheme(element, second)),
        ), 0);
        expect(change).toBeGreaterThan(0.1);
      }
    }
  });

  test("reference palettes retain their original core colors", () => {
    const sourceColors: Record<string, string[]> = {
      "carto-pastel": ["#66c5cc", "#f6cf71", "#f89c74", "#dcb0f2", "#87c55f", "#9eb9f3", "#fe88b1", "#c9db74", "#8be0a4", "#b497e7", "#d3b484", "#b3b3b3"],
      nord: ["#8fbcbb", "#88c0d0", "#81a1c1", "#5e81ac", "#bf616a", "#d08770", "#ebcb8b", "#a3be8c", "#b48ead"],
      "grand-budapest-2": ["#e6a0c4", "#c6cdf7", "#d8a499", "#7294d4"],
      "paul-tol-bright": ["#4477aa", "#ee6677", "#228833", "#ccbb44", "#66ccee", "#aa3377", "#bbbbbb"],
      "rose-pine-dawn": ["#b4637a", "#ea9d34", "#d7827e", "#286983", "#56949f", "#907aa9"],
      "tableau-10": ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"],
      "moonrise-3": ["#85d4e3", "#f4b5bd", "#9c964a", "#cdc08c", "#fad77b"],
      "royal-2": ["#9a8822", "#f5cdb4", "#f8afa8", "#fddda0", "#74a089"],
    };
    for (const [scheme, colors] of Object.entries(sourceColors)) {
      const actual = Object.values(COLOR_SCHEMES.find(option => option.id === scheme)!.elements);
      for (const color of colors) expect(actual).toContain(color);
    }
  });

  test("reference assignments are stable across material composition and custom edits", () => {
    for (const { value } of REFERENCE_SCHEMES) {
      const style = { ...createDefaultStyle(), colorScheme: value, colorSchemeMode: "preset" as const, distinguishSimilarColors: false };
      for (const elements of [["Cu", "I"], ["Ni", "O"], ["Zn", "O"], ["Li", "Fe", "P", "O"]]) {
        const colors = createCustomColormapFromStyle(atomsWithElements(elements), style).elements;
        const reversed = createCustomColormapFromStyle(atomsWithElements([...elements].reverse()), style).elements;
        expect(colors).toEqual(reversed);
        for (const element of elements) expect(colors[element]).toBe(elementColorForScheme(element, value));
      }
      const original = elementColorForScheme("O", value);
      expect(elementColorForScheme("O", value, { O: "#abcdef" })).toBe("#abcdef");
      expect(elementColorForScheme("O", value)).toBe(original);
    }
  });

  test("illustration palettes use stable element colors and distinct Cu/I pairs", () => {
    for (const {value} of ILLUSTRATION_SCHEMES) {
      const cu = elementColorForScheme("Cu", value);
      const iodine = elementColorForScheme("I", value);
      expect(oklchDistance(hexToOklch(cu), hexToOklch(iodine))).toBeGreaterThan(0.15);
      for (const element of ["Cu", "I", "Zn", "Ge", "S", "Se", "Te"]) {
        const color = elementColorForScheme(element, value);
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
        expect(hexToOklch(color).lightness).toBeGreaterThan(0.65);
        expect(hexToOklch(color).lightness).toBeLessThan(0.91);
        expect(colorSchemeTokenStyle(value).background).toBeDefined();
      }
    }
  });

  test("cover every frontend element radius symbol", () => {
    const radiusElements = elementRadiusSymbols();

    for (const { value } of COLOR_SCHEME_OPTIONS) {
      const missingElements = radiusElements.filter(
        (element) => !hasElementColor(element, value),
      );

      expect(missingElements).toEqual([]);
    }
  });

  test("define Jmol colors for registry-only placeholders", () => {
    expect(elementColorForScheme("D", "jmol")).toBe("#ffffff");
    expect(elementColorForScheme("XX", "jmol")).toBe("#4c4c4c");
  });

  test("defines softened Jmol Soft colors", () => {
    expect(elementColorForScheme("H", "jmol-soft")).toBe("#dedede");
    expect(elementColorForScheme("N", "jmol-soft")).toBe("#4769d6");
    expect(elementColorForScheme("O", "jmol-soft")).toBe("#e15a4b");
  });

  test("defines softened VESTA Soft colors", () => {
    expect(elementColorForScheme("O", "vesta-soft")).toBe("#e15949");
    expect(elementColorForScheme("Cl", "vesta-soft")).toBe("#87e17c");
    expect(elementColorForScheme("Si", "vesta-soft")).toBe("#3a61cf");
  });

  test("auto-distinguishes only lower-priority similar element colors", () => {
    const atoms = atomsWithElements(["O", "V"]);

    expect(autoDistinctElementColorOverrides(atoms, "vesta-soft", false)).toBeUndefined();

    const overrides = autoDistinctElementColorOverrides(atoms, "vesta-soft", true);
    expect(overrides?.O).toBeUndefined();
    expect(overrides?.V).toBeDefined();
    expect(overrides?.V).not.toBe(elementColorForScheme("V", "vesta-soft"));
  });

  test("auto-distinguishes same-hue VESTA Soft blues such as calcium and titanium", () => {
    const overrides = autoDistinctElementColorOverrides(
      atomsWithElements(["Ca", "Ti"]),
      "vesta-soft",
      true,
    );

    expect(overrides?.Ti).toBeUndefined();
    expect(overrides?.Ca).toBeDefined();
    expect(overrides?.Ca).not.toBe(elementColorForScheme("Ca", "vesta-soft"));
  });

  test("builds split colormap files in catalog order", () => {
    const catalog = buildColormapCatalog(
      {
        colormaps: [
          {
            file: "custom-soft.json",
            id: "custom-soft",
            label: "Custom Soft",
            tokenElements: ["H", "O"],
          },
          {
            file: "custom.json",
            id: "custom",
            label: "Custom",
            tokenElements: ["H", "O"],
          },
        ],
        defaultColorSchemeId: "custom-soft",
        version: 1,
      },
      {
        "../data/colormaps/presets/custom.json": validColormap({ name: "custom" }),
        "../data/colormaps/presets/custom-soft.json": validColormap({
          name: "custom-soft",
        }),
      },
    );

    expect(catalog.defaultColorSchemeId).toBe("custom-soft");
    expect(catalog.colormaps.map((colormap) => colormap.id)).toEqual([
      "custom-soft",
      "custom",
    ]);
  });

  test("rejects colormap files not listed in catalog", () => {
    expect(() =>
      buildColormapCatalog(
        {
          colormaps: [
            {
              file: "custom.json",
              id: "custom",
              label: "Custom",
              tokenElements: ["H", "O"],
            },
          ],
          defaultColorSchemeId: "custom",
          version: 1,
        },
        {
          "../data/colormaps/presets/custom.json": validColormap({ name: "custom" }),
          "../data/colormaps/presets/extra.json": validColormap({ name: "extra" }),
        },
      ),
    ).toThrow('Bundled colormap file "extra.json" is not listed');
  });

  test("rejects catalog token elements with no color", () => {
    expect(() =>
      buildColormapCatalog(
        {
          colormaps: [
            {
              file: "custom.json",
              id: "custom",
              label: "Custom",
              tokenElements: ["H", "Si"],
            },
          ],
          defaultColorSchemeId: "custom",
          version: 1,
        },
        {
          "../data/colormaps/presets/custom.json": validColormap({ name: "custom" }),
        },
      ),
    ).toThrow('token element "Si" has no color');
  });
});

function validColormap(patch: Record<string, unknown> = {}) {
  return {
    elements: {
      H: "#ffffff",
      O: "#ff0000",
    },
    name: "custom",
    ...patch,
  };
}

function atomsWithElements(elements: string[]): AtomSpec[] {
  return elements.map((element, index) => ({
    element,
    id: `${element}-${index}`,
    siteId: `${element}-${index}`,
    siteIndex: index,
    position: [index, 0, 0] as [number, number, number],
    fractionalPosition: [index, 0, 0] as [number, number, number],
    imageOffset: [0, 0, 0] as [number, number, number],
    isPeriodicImage: false,
    imageReasons: [],
    visibilityDependencies: [],
    visibilityDependencyGroups: [],
  }));
}
