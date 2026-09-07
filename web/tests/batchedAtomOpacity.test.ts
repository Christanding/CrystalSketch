import { describe, expect, test } from "bun:test";
import {
  BatchedMesh,
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  ShaderLib,
  SphereGeometry,
  Vector3,
  type DataTexture,
} from "three";

import {
  batchedInstanceRgbaProgramCacheKey,
  patchBatchedInstanceRgbaShader,
  setBatchedInstanceRgba,
} from "../src/scene/batchedInstanceRgba";
import { calibrateCartoonDiffuseShader, shadeCelFragmentShader, shadeJadeFragmentShader } from "../src/scene/StructureMaterial";
import { populateAtomSelectionRim } from "../src/scene/BatchedAtoms";

describe("batched instance RGBA adapter", () => {
  test("selection rims share one geometry and material while tracking individual radii and positions", () => {
    const geometry = new SphereGeometry(1, 12, 8);
    const material = new MeshBasicMaterial();
    const mesh = new InstancedMesh(geometry, material, 128);
    const positionAttribute = geometry.getAttribute("position");
    const items = Array.from({ length: 128 }, (_, i) => ({ position: [i * 4, i % 3, 0] as [number, number, number], radius: 0.5 + i / 128 }));
    try {
      populateAtomSelectionRim(mesh, items);
      expect(mesh.count).toBe(128);
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.geometry.getAttribute("position")).toBe(positionAttribute);
      expect(mesh.material).toBe(material);
      const matrix = new Matrix4();
      for (const index of [0, 63, 127]) {
        mesh.getMatrixAt(index, matrix);
        const position = new Vector3().setFromMatrixPosition(matrix);
        const scale = new Vector3().setFromMatrixScale(matrix);
        expect(position.toArray()).toEqual(items[index]!.position);
        expect(scale.x).toBeCloseTo(items[index]!.radius * 1.04, 6);
        expect(scale.y).toBeCloseTo(scale.x, 6);
        expect(scale.z).toBeCloseTo(scale.x, 6);
      }
      populateAtomSelectionRim(mesh, items.slice(0, 1));
      expect(mesh.count).toBe(1);
      expect(mesh.boundingBox!.max.x).toBeLessThan(1);
      expect(mesh.geometry).toBe(geometry);
    } finally { mesh.dispose(); geometry.dispose(); material.dispose(); }
  });
  test("jade scattering remains light-driven and preserves batched alpha and highlights", () => {
    const rgba = patchBatchedInstanceRgbaShader(ShaderLib.phong.vertexShader, ShaderLib.phong.fragmentShader);
    const fragment = shadeJadeFragmentShader(rgba.fragmentShader);
    expect(fragment).toContain("directLight.color * material.diffuseColor * jadePhase * jadeTransmittance");
    expect(fragment).toContain("exp(-2.3 * jadeThickness)");
    expect(fragment).toContain("reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong");
    expect(fragment).toContain("if ( diffuseColor.a <= 0.0001 ) discard;");
    expect(fragment).toContain("#include <colorspace_fragment>");
    expect(fragment).not.toContain("totalEmissiveRadiance +=");
    expect(() => shadeJadeFragmentShader(ShaderLib.basic.fragmentShader)).toThrow("jade scattering adapter");
  });

  test("cel key-light shading preserves highlights, fill, batched transparency and color output", () => {
    const rgba = patchBatchedInstanceRgbaShader(ShaderLib.phong.vertexShader, ShaderLib.phong.fragmentShader);
    const fragment = shadeCelFragmentShader(rgba.fragmentShader);
    expect(fragment).toContain("celIrradiance = irradiance");
    expect(fragment).toContain("directionalLights[0].direction");
    expect(fragment).toContain("reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong");
    expect(fragment).toContain("if ( diffuseColor.a <= 0.0001 ) discard;");
    expect(fragment).toContain("#include <colorspace_fragment>");
    expect(fragment).not.toContain("totalEmissiveRadiance +=");
    expect(() => shadeCelFragmentShader(ShaderLib.basic.fragmentShader)).toThrow("cel adapter");
  });

  test("uses batched color alpha with both material and vertex colors", () => {
    for (const shader of [
      ShaderLib.basic,
      ShaderLib.phong,
      ShaderLib.toon!,
      ShaderLib.lambert,
      ShaderLib.physical,
      ShaderLib.standard,
    ]) {
      const patched = patchBatchedInstanceRgbaShader(
        shader.vertexShader,
        shader.fragmentShader,
      );

      expect(patched.vertexShader).toContain("vec4 getBatchingColor");
      expect(patched.vertexShader).toContain("vColor.rgb *= color;");
      expect(patched.vertexShader).toContain("vColor.a *= batchingColor.a;");
      expect(patched.fragmentShader).toContain("#define USE_COLOR_ALPHA");
      expect(patched.fragmentShader).toContain(
        "if ( diffuseColor.a <= 0.0001 ) discard;",
      );
    }
    expect(batchedInstanceRgbaProgramCacheKey()).toContain("three-r171-v1");
  });

  test("calibrates cartoon diffuse light while preserving batched colors, alpha, and highlights", () => {
    const rgba = patchBatchedInstanceRgbaShader(ShaderLib.phong.vertexShader, ShaderLib.phong.fragmentShader);
    const fragment = calibrateCartoonDiffuseShader(rgba.fragmentShader);
    expect(fragment).toContain("reflectedLight.directDiffuse *= PI;");
    expect(fragment).toContain("reflectedLight.indirectDiffuse *= PI;");
    expect(fragment).not.toContain("reflectedLight.directSpecular *=");
    expect(fragment).not.toContain("totalEmissiveRadiance +=");
    expect(fragment).toContain("if ( diffuseColor.a <= 0.0001 ) discard;");
    expect(fragment).toContain("#include <colorspace_fragment>");
    expect(fragment).toContain("#include <aomap_fragment>");
    expect(calibrateCartoonDiffuseShader(ShaderLib.toon!.fragmentShader)).toContain("reflectedLight.directDiffuse *= PI;");
    expect(() => calibrateCartoonDiffuseShader(ShaderLib.basic.fragmentShader)).toThrow("lit shader no longer matches");
  });

  test("keeps default front-face colors near the palette and retains unlit shadows", () => {
    const irradiance = .6 + .7 / Math.sqrt(5.5);
    for (const hex of ["#f1abbc", "#97cff2", "#9caee7"]) {
      const base = new Color(hex);
      const old = base.clone().multiplyScalar(irradiance / Math.PI).getHex();
      const calibrated = base.clone().multiplyScalar(irradiance).getHex();
      const original = base.getHex();
      const channelDistance = (color: number) => [16, 8, 0].reduce((sum, shift) =>
        sum + Math.abs(((color >> shift) & 255) - ((original >> shift) & 255)), 0);
      expect(channelDistance(calibrated)).toBeLessThan(channelDistance(old) / 4);
      expect(base.clone().multiplyScalar(.6).getHex()).not.toBe(original);
      expect(base.clone().multiplyScalar(0).getHex()).toBe(0);
    }
  });

  test("fails loudly when the pinned Three.js shader contract changes", () => {
    expect(() => patchBatchedInstanceRgbaShader("void main() {}", "void main() {}"))
      .toThrow("Three.js shader no longer matches");
  });

  test("writes RGB and alpha into Three r171's batched color texel", () => {
    const mesh = new BatchedMesh(1, 24, 36, new MeshBasicMaterial());
    const geometry = new BoxGeometry();
    const geometryId = mesh.addGeometry(geometry);
    const batchId = mesh.addInstance(geometryId);

    setBatchedInstanceRgba(mesh, batchId, new Color("#336699"), 0.25);

    const texture = (
      mesh as BatchedMesh & { _colorsTexture: DataTexture }
    )._colorsTexture;
    expect(texture.image.data[0]).toBeCloseTo(new Color("#336699").r);
    expect(texture.image.data[1]).toBeCloseTo(new Color("#336699").g);
    expect(texture.image.data[2]).toBeCloseTo(new Color("#336699").b);
    expect(texture.image.data[3]).toBe(0.25);

    mesh.setColorAt(batchId, new Color("#ffffff"));
    expect(texture.image.data[3]).toBe(0.25);
    mesh.setColorAt(batchId, new Color("#336699"));
    expect(texture.image.data[3]).toBe(0.25);

    geometry.dispose();
    mesh.dispose();
  });
});
