import { describe, expect, test } from "bun:test";
import { isIridescenceThicknessRange, isPhysicalMaterialPreset, materialPresetById, PHYSICAL_MATERIAL_PRESET_IDS } from "../src/model/materialPresets";
import { Color, MeshPhysicalMaterial, type MeshPhysicalMaterialParameters } from "three";

import {
  DEFAULT_MATERIAL_PRESET_ID,
  MATERIAL_PRESET_OPTIONS,
  MATERIAL_PRESETS,
  isIllustrationMaterialPreset,
  buildMaterialPresetCatalog,
  validateMaterialPresetData,
} from "../src/app/materialPresets";

describe("material presets", () => {
  test("loads bundled material presets from JSON data", () => {
    expect(DEFAULT_MATERIAL_PRESET_ID).toBe("cartoon");
    expect(MATERIAL_PRESETS.map((preset) => preset.id)).toEqual([
      "cartoon",
      "soft-ceramic",
      "satin-matte",
      "cel-shaded",
      "colored-metal",
      "soft-jade",
      "soft-velvet",
      "pbr-ceramic",
      "pbr-matte",
      "pbr-metal",
      "pbr-glass",
      "pbr-glazed-ceramic",
      "pbr-glossy-plastic",
      "pbr-matte-rubber",
      "pbr-mirror-metal",
      "pbr-frosted-glass",
      "pbr-velvet",
      "pbr-pearl",
      "modern-matte",
      "classic-matte",
      "glossy",
      "metallic",
      "2-5d",
      "2d",
    ]);
    expect(MATERIAL_PRESET_OPTIONS).toEqual([
      { label: "卡通", value: "cartoon" },
      { label: "柔釉陶瓷", value: "soft-ceramic" },
      { label: "丝缎哑光", value: "satin-matte" },
      { label: "赛璐璐", value: "cel-shaded" },
      { label: "彩色金属", value: "colored-metal" },
      { label: "温润玉石", value: "soft-jade" },
      { label: "细绒柔光", value: "soft-velvet" },
      { label: "物理陶瓷", value: "pbr-ceramic" },
      { label: "物理磨砂", value: "pbr-matte" },
      { label: "物理金属", value: "pbr-metal" },
      { label: "物理玻璃", value: "pbr-glass" },
      { label: "高釉陶瓷", value: "pbr-glazed-ceramic" },
      { label: "亮面塑料", value: "pbr-glossy-plastic" },
      { label: "橡胶哑光", value: "pbr-matte-rubber" },
      { label: "镜面金属", value: "pbr-mirror-metal" },
      { label: "磨砂玻璃", value: "pbr-frosted-glass" },
      { label: "丝绒柔光", value: "pbr-velvet" },
      { label: "珠光涂层", value: "pbr-pearl" },
    ]);
  });

  test("limits PBR gates to the explicit eleven presets without exposing hidden legacy finishes", () => {
    expect(PHYSICAL_MATERIAL_PRESET_IDS).toHaveLength(11);
    for (const id of PHYSICAL_MATERIAL_PRESET_IDS) {
      expect(isPhysicalMaterialPreset(id)).toBe(true);
      expect(MATERIAL_PRESET_OPTIONS.some(option => option.value === id)).toBe(true);
    }
    for (const id of ["cartoon", "colored-metal", "modern-matte", "classic-matte", "glossy", "metallic", "2-5d", "2d", "pbr-unknown", "pbr-glass-extra", "constructor", ""]) {
      expect(isPhysicalMaterialPreset(id)).toBe(false);
    }
    for (const id of ["modern-matte", "classic-matte", "glossy", "metallic", "2-5d", "2d"]) {
      expect(MATERIAL_PRESET_OPTIONS.some(option => option.value === id)).toBe(false);
    }
  });

  test("constructs the new native PBR lobes without overriding the element base color", () => {
    for (const id of PHYSICAL_MATERIAL_PRESET_IDS.slice(4)) {
      const { props } = materialPresetById(id).material;
      const material = new MeshPhysicalMaterial({ ...props, color: "#9eafcb" } as MeshPhysicalMaterialParameters);
      try {
        expect(material.color.getHexString()).toBe("9eafcb");
        expect(props).not.toHaveProperty("color");
        expect(props).not.toHaveProperty("opacity");
        expect(props).not.toHaveProperty("toneMapped");
        expect(material.roughness).toBeGreaterThan(0);
        for (const [key, value] of Object.entries(props)) {
          const actual = (material as unknown as Record<string, unknown>)[key];
          if (typeof value === "number") expect(actual).toBe(value);
          else if (actual instanceof Color) expect(actual.getHexString()).toBe("ffffff");
          else if (key === "iridescenceThicknessRange") expect(actual).toEqual(value);
        }
        if (material.clearcoat > 0) expect(material.clearcoatRoughness).toBeGreaterThan(0);
      } finally { material.dispose(); }
    }
    expect(materialPresetById("pbr-glazed-ceramic").material.props.clearcoat).toBe(1);
    expect(materialPresetById("pbr-glossy-plastic").material.props.clearcoat).toBe(0);
    expect(Number(materialPresetById("pbr-matte-rubber").material.props.specularIntensity)).toBeLessThan(0.2);
    expect(materialPresetById("pbr-mirror-metal").material.props.metalness).toBe(1);
    expect(Number(materialPresetById("pbr-frosted-glass").material.props.transmission)).toBeGreaterThan(0.5);
    expect(materialPresetById("pbr-velvet").material.props.sheenColor).toBe("#ffffff");
    expect(Number(materialPresetById("pbr-pearl").material.props.iridescence)).toBeGreaterThan(0);
  });

  test("accepts only finite ordered two-number iridescence ranges, not arbitrary material arrays", () => {
    const catalog = (value: unknown) => catalogWithPreset({
      material: { type: "MeshPhysicalMaterial", props: { iridescenceThicknessRange: value } },
    });
    for (const range of [[160, 360], [0, 0], [0, 360], [200, 200]]) {
      expect(isIridescenceThicknessRange(range)).toBe(true);
      expect(validateMaterialPresetData(catalog(range)).presets[0]?.material.props.iridescenceThicknessRange).toEqual(range);
    }
    for (const value of [[], [100], [100, 200, 300], [360, 160], [-1, 300], [100, Number.NaN], [0, Infinity], ["100", 200], [false, 200], null, 300, { min: 100, max: 300 }]) {
      expect(isIridescenceThicknessRange(value)).toBe(false);
      expect(() => validateMaterialPresetData(catalog(value))).toThrow();
    }
    for (const key of ["roughness", "clearcoat", "sheenColor", "specularColor"]) {
      expect(() => validateMaterialPresetData(catalogWithPreset({
        material: { type: "MeshPhysicalMaterial", props: { [key]: [0.2, 0.8] } },
      }))).toThrow("does not support array values");
    }
    expect(() => validateMaterialPresetData(catalogWithPreset({
      material: { type: "MeshStandardMaterial", props: { iridescenceThicknessRange: [160, 360] } },
    }))).toThrow("is not supported");
  });

  test("keeps bundled preset materials and lighting in the passthrough schema", () => {
    for (const preset of MATERIAL_PRESETS) {
      expect([
        "MeshToonMaterial",
        "MeshPhongMaterial",
        "MeshBasicMaterial",
        "MeshLambertMaterial",
        "MeshPhysicalMaterial",
        "MeshStandardMaterial",
      ]).toContain(preset.material.type);
      expect(preset.material.props).toEqual(expect.any(Object));
      expect(Array.isArray(preset.lighting)).toBe(true);
      if (isIllustrationMaterialPreset(preset.id)) {
        expect(preset.overrides?.polyhedron?.material?.type).toBe("MeshToonMaterial");
      } else if (isPhysicalMaterialPreset(preset.id)) {
        expect(preset.material.type).toBe("MeshPhysicalMaterial");
        expect(preset.lighting).toEqual([]);
        expect(preset.material.props).toEqual(expect.objectContaining({
          roughness: expect.any(Number), metalness: expect.any(Number),
          clearcoat: expect.any(Number), transmission: expect.any(Number),
        }));
      } else if (preset.id === "2d") {
        expect(preset.overrides).toBeUndefined();
      } else {
        expect(preset.overrides?.polyhedron?.material?.type).toBe(
          "MeshStandardMaterial",
        );
        expect(preset.overrides?.polyhedron?.material?.props).toEqual(
          expect.any(Object),
        );
        expect(preset.overrides?.polyhedron?.material?.props).not.toHaveProperty(
          "fog",
        );
      }

      for (const light of preset.lighting) {
        expect(["AmbientLight", "HemisphereLight", "cameraDirectional"]).toContain(
          light.type,
        );
        expect(light.props).toEqual(expect.any(Object));
      }
    }
  });

  test("rejects unsupported material types", () => {
    expect(() =>
      validateMaterialPresetData(
        catalogWithPreset({
          material: {
            props: {},
            type: "MeshDepthMaterial",
          },
        }),
      ),
    ).toThrow("material presets.presets[0].material.type must be one of");
  });

  test("rejects duplicate preset IDs", () => {
    expect(() =>
      validateMaterialPresetData({
        defaultPresetId: "classic-matte",
        presets: [
          validPreset({ id: "classic-matte" }),
          validPreset({ id: "classic-matte" }),
        ],
        version: 1,
      }),
    ).toThrow('Duplicate material preset ID "classic-matte".');
  });

  test("rejects missing labels", () => {
    const preset: Record<string, unknown> = validPreset();
    delete preset.label;

    expect(() =>
      validateMaterialPresetData({
        defaultPresetId: "classic-matte",
        presets: [preset],
        version: 1,
      }),
    ).toThrow(
      "material presets.presets[0].label must be a non-empty string.",
    );
  });

  test("accepts appearance props from the material-specific allowlist", () => {
    expect(
      validateMaterialPresetData(
        catalogWithPreset({
          material: {
            props: {
              emissive: "#ffffff",
              emissiveIntensity: 0.08,
              metalness: 0.12,
              roughness: 0.4,
            },
            type: "MeshStandardMaterial",
          },
        }),
      ).presets[0]?.material.props,
    ).toMatchObject({ emissive: "#ffffff", metalness: 0.12 });
  });

  test("rejects material props that can override renderer policy", () => {
    for (const property of [
      "blending",
      "color",
      "colorWrite",
      "depthTest",
      "depthWrite",
      "opacity",
      "side",
      "transparent",
      "toneMapped",
    ]) {
      expect(() =>
        validateMaterialPresetData(
          catalogWithPreset({
            material: {
              props: { [property]: false },
              type: "MeshStandardMaterial",
            },
          }),
        ),
      ).toThrow(`material presets.presets[0].material.props.${property} is not supported`);
    }
  });

  test("rejects unknown future material props until they are reviewed", () => {
    expect(() =>
      validateMaterialPresetData(
        catalogWithPreset({
          material: {
            props: { customFutureProp: [1, "two", false] },
            type: "MeshStandardMaterial",
          },
        }),
      ),
    ).toThrow("material presets.presets[0].material.props.customFutureProp is not supported");
  });

  test("accepts per-target material overrides", () => {
    const catalog = validateMaterialPresetData(
      catalogWithPreset({
        overrides: {
          polyhedron: {
            material: {
              props: {
                metalness: 0.08,
                roughness: 0.25,
              },
              type: "MeshStandardMaterial",
            },
          },
        },
      }),
    );

    expect(catalog.presets[0]?.overrides?.polyhedron?.material).toEqual({
      props: {
        metalness: 0.08,
        roughness: 0.25,
      },
      type: "MeshStandardMaterial",
    });
  });

  test("rejects unsupported material override targets", () => {
    expect(() =>
      validateMaterialPresetData(
        catalogWithPreset({
          overrides: {
            label: {
              material: {
                props: {},
                type: "MeshBasicMaterial",
              },
            },
          },
        }),
      ),
    ).toThrow("material presets.presets[0].overrides.label is not supported.");
  });

  test("rejects non-json prop values", () => {
    expect(() =>
      validateMaterialPresetData(
        catalogWithPreset({
          material: {
            props: {
              roughness: Number.NaN,
            },
            type: "MeshStandardMaterial",
          },
        }),
      ),
    ).toThrow("material presets.presets[0].material.props.roughness must be a finite number.");
  });

  test("rejects unsupported light types", () => {
    expect(() =>
      validateMaterialPresetData(
        catalogWithPreset({
          lighting: [
            {
              props: {
                intensity: 1.78,
              },
              type: "PointLight",
            },
          ],
        }),
      ),
    ).toThrow(
      "material presets.presets[0].lighting[0].type must be one of",
    );
  });

  test("builds split preset files in catalog order", () => {
    const catalog = buildMaterialPresetCatalog(
      {
        defaultPresetId: "modern-matte",
        presetOrder: ["modern-matte", "classic-matte"],
        version: 1,
      },
      {
        "classic-matte.json": validPreset({ id: "classic-matte", label: "Classic Matte" }),
        "modern-matte.json": validPreset({
          id: "modern-matte",
          label: "Modern Matte",
          material: {
            props: {
              flatShading: false,
              metalness: 0,
              roughness: 0.58,
            },
            type: "MeshStandardMaterial",
          },
        }),
      },
    );

    expect(catalog.defaultPresetId).toBe("modern-matte");
    expect(catalog.presets.map((preset) => preset.id)).toEqual([
      "modern-matte",
      "classic-matte",
    ]);
  });

  test("rejects preset files not listed in catalog order", () => {
    expect(() =>
      buildMaterialPresetCatalog(
        {
          defaultPresetId: "classic-matte",
          presetOrder: ["classic-matte"],
          version: 1,
        },
        {
          "classic-matte.json": validPreset({ id: "classic-matte" }),
          "glossy.json": validPreset({ id: "glossy", label: "Glossy" }),
        },
      ),
    ).toThrow('Bundled material preset "glossy" is not listed');
  });

});

function catalogWithPreset(presetPatch: Record<string, unknown>) {
  return {
    defaultPresetId: "classic-matte",
    presets: [validPreset(presetPatch)],
    version: 1,
  };
}

function validPreset(patch: Record<string, unknown> = {}) {
  return {
    id: "classic-matte",
    label: "Classic Matte",
    lighting: [
      {
        props: {
          intensity: 0.68,
        },
        type: "AmbientLight",
      },
      {
        props: {
          intensity: 1.78,
          offset: [0.32, 0.22, 0],
        },
        type: "cameraDirectional",
      },
    ],
    material: {
      props: {
        flatShading: false,
      },
      type: "MeshLambertMaterial",
    },
    ...patch,
  };
}
