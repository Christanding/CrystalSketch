import { describe, expect, test } from "bun:test";

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
    ]);
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
      "colorWrite",
      "depthTest",
      "depthWrite",
      "opacity",
      "side",
      "transparent",
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
