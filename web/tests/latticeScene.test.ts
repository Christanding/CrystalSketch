import { describe, expect, spyOn, test } from "bun:test";
import { Children, createElement, type ReactElement, type ReactNode } from "react";
import * as Fiber from "@react-three/fiber";
import { renderToStaticMarkup } from "react-dom/server";
import { BufferAttribute, BufferGeometry, Color, CylinderGeometry, DataTexture, InstancedMesh, Mesh, MeshPhysicalMaterial, NeutralToneMapping, NoToneMapping, OrthographicCamera, Quaternion, Scene, ShaderMaterial, SphereGeometry, Texture, Vector3 } from "three";
import { PathTracingSceneGenerator } from "three-gpu-pathtracer";
import * as PathTracerLibrary from "three-gpu-pathtracer";
import type { WebGLPathTracer } from "three-gpu-pathtracer";

import type { AtomSpec, BondSpec, SceneSpec } from "../src/api/scene";
import { DEFAULT_MEASUREMENT_STYLE, resolveMeasurement } from "../src/model/measurements";
import { MeasurementAnnotations, displayedMeasurements, measurementAngleArcPositions, measurementLayoutObstacles } from "../src/scene/MeasurementAnnotations";
import { layoutMeasurementLabels, measurementLabelSize } from "../src/model/measurementLabelLayout";
import {
  createDefaultComponentOpacity,
  DEFAULT_STRUCTURE_LINE_WIDTH,
  createDefaultComponentVisibility,
  createDefaultStyle,
  polyhedronColorForElement,
  setAtomOverrideProperty,
  setBondOverrideProperty,
  visibleSceneForComponents,
} from "../src/model";
import {
  STRUCTURE_MATERIAL_TARGETS,
  resolveStructureMaterialFamilyForStyle,
  resolveStructureMaterialFamilyForTarget,
} from "../src/scene/materialPresetResolver";
import {
  CELL_FRAME_LINE_WIDTH_PIXELS,
  EXPORT_SCENE_MESH_DETAIL_PRESETS,
  PREVIEW_SCENE_MESH_DETAIL,
  SCENE_FOG_COLOR,
  STRUCTURE_RENDER_ORDER,
  cellFrameLinePositions,
  computeSceneLayout,
  createSceneFog,
  polyhedronGeometryFromAtoms,
  twoToneBondCylinderGeometry,
} from "../src/scene/LatticeScene";
import { compactLegendStyle, orientationGizmoContainerStyle, orientationGizmoSizeForViewport, previewLayoutForPanels } from "../src/app/layout/overlayLayout";
import {
  applyCameraPoseSnapshot,
  createCameraPoseSnapshot,
} from "../src/scene/cameraPose";
import {
  createPolyhedronSurfaceBatchBuild,
  disposePolyhedronSurfaceBatchBuild,
  POLYHEDRON_EDGE_COLOR,
  POLYHEDRON_EDGE_OPACITY,
  POLYHEDRON_EDGE_LINE_WIDTH_PIXELS,
} from "../src/scene/BatchedPolyhedra";
import { bondBatchPopulationKey } from "../src/scene/BatchedBonds";
import { createAtomRenderItems } from "../src/scene/AtomRenderItems";
import { createBondRenderItems } from "../src/scene/BondRenderItems";
import {
  createBatchPickRegistry,
  itemForBatchId,
  registerBatchPickItem,
} from "../src/scene/batchPicking";
import {
  createDefaultCrystalCameraState,
  stateWithDirectAxis,
} from "../src/scene/crystalCamera";
import {
  applyOrthographicExportFrame,
  computeStructureExportAspectRatio,
  computeStructureExportFramePlan,
  computeStructureProjectedBounds,
  type StructureExportFramePlan,
} from "../src/scene/exportFrame";
import { structureLineWidthScale } from "../src/scene/exportRenderer";
import { renderStructureRasterImage } from "../src/scene/exportRenderer";
import { ExportSceneContent, exportFogColor } from "../src/scene/ExportSceneContent";
import * as CartoonOutline from "../src/scene/CartoonOutline";
import * as PathTracingSceneModule from "../src/scene/pathTracingScene";
import { renderPathTracedExport } from "../src/scene/pathTracingExport";
import { readRenderSettings } from "../src/model/renderSettings";
import { isPhysicalMaterialPreset, materialPresetById, MATERIAL_PRESET_OPTIONS, PHYSICAL_MATERIAL_PRESET_IDS } from "../src/model/materialPresets";
import {
  applyOrthographicFrustum,
  computeCameraFitZoom,
  computeOrthographicFrustum,
  computeStandardCameraPose,
} from "../src/scene/viewMath";
import { computeOrientationGizmoAxes } from "../src/scene/orientationGizmoMath";
import { createCrystalPathTraceScene, type CrystalPathTraceSceneOptions } from "../src/scene/pathTracingScene";
import { collectTracePrimitives, createPrimitiveSceneUpdater, hasTriangleMeshes, installPrimitiveGeometry, packTracePrimitives } from "../src/scene/pathTracingPrimitives";
import * as PrimitiveBVH from "../src/scene/pathTracingPrimitiveBVH";

describe("export rendering compatibility", () => {
  test("keeps legacy outlines, full export dimensions and mesh detail despite restored PBR settings", async () => {
    const configurations: { width: number; height: number; top: number; left: number }[] = [];
    const renderedScenes: ReactElement<Parameters<typeof ExportSceneContent>[0]>[] = [];
    const outlineToneMappings: number[] = [];
    const downsampledSizes: number[][] = [];
    const states: Fiber.RootState[] = [];
    const rootSpy = spyOn(Fiber, "createRoot").mockImplementation(() => {
      const state = {
        camera: new OrthographicCamera(), scene: new Scene(), advance() {},
        gl: { setClearColor() {}, dispose() {}, toneMapping: NoToneMapping, toneMappingExposure: 1 },
      } as unknown as Fiber.RootState;
      states.push(state);
      return {
        async configure(options: { onCreated?: (state: Fiber.RootState) => void; size: { width: number; height: number; top: number; left: number } }) {
          configurations.push(options.size);
          options.onCreated?.(state);
        },
        render(tree: ReactNode) {
          const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children) as ReactElement<Record<string, unknown>>[];
          renderedScenes.push(children.find(child => child.type === ExportSceneContent) as ReactElement<Parameters<typeof ExportSceneContent>[0]>);
          const ready = children.find(child => typeof child.props.onReady === "function");
          (ready?.props.onReady as () => void)();
          return { getState: () => state };
        },
        unmount() {},
      } as unknown as ReturnType<typeof Fiber.createRoot>;
    });
    const outlineSpy = spyOn(CartoonOutline, "createCartoonRenderer").mockImplementation((renderer, toneMapping) => ({
      render() { outlineToneMappings.push(toneMapping ?? renderer.toneMapping); }, dispose() {},
    }));
    const contextSpy = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      expect(contextId).toBe("2d");
      const target = this;
      return {
        fillRect() {},
        drawImage(source: HTMLCanvasElement, ...coordinates: number[]) {
          if (coordinates.length === 4) downsampledSizes.push([source.width, source.height, target.width, target.height]);
        },
      } as unknown as CanvasRenderingContext2D;
    } as HTMLCanvasElement["getContext"]);
    const blobSpy = spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["image"], { type: "image/jpeg" })));
    try {
      for (const { value: materialPreset } of MATERIAL_PRESET_OPTIONS.filter(option => !isPhysicalMaterialPreset(option.value))) {
        const style = { ...createDefaultStyle(), materialPreset, rendering: readRenderSettings({
          mode: "path-traced", studio: "rim", exposure: 3, aoEnabled: true,
        }) };
        const original = structuredClone(style);
        const image = await renderStructureRasterImage({
          backgroundColor: "#ffffff", cameraPose: createCameraPoseSnapshot(new Quaternion()),
          componentOpacity: createDefaultComponentOpacity(), width: 2000, height: 2000,
          imageFormat: "jpg", lightStrength: 1, meshQuality: "high", scene: sceneWithOffCenterAtoms(),
          showAtoms: true, showUnitCell: true, style, structureLineWidth: DEFAULT_STRUCTURE_LINE_WIDTH,
          supersampling: 2, unitCellLineStyle: "solid",
        });
        expect({ width: image.width, height: image.height }).toEqual({ width: 2000, height: 2000 });
        expect(configurations.at(-1)).toEqual({ width: 4000, height: 4000, top: 0, left: 0 });
        expect(renderedScenes.at(-1)?.props.meshDetail).toBe(EXPORT_SCENE_MESH_DETAIL_PRESETS.high);
        expect(renderedScenes.at(-1)?.props.style).toBe(style);
        expect(downsampledSizes.at(-1)).toEqual([4000, 4000, 2000, 2000]);
        expect(outlineToneMappings.at(-1)).toBe(materialPreset === "colored-metal" ? NeutralToneMapping : NoToneMapping);
        expect(states.at(-1)?.gl.toneMappingExposure).toBe(1);
        expect(style).toEqual(original);
      }
      expect(outlineToneMappings).toHaveLength(MATERIAL_PRESET_OPTIONS.filter(option => !isPhysicalMaterialPreset(option.value)).length);
    } finally {
      blobSpy.mockRestore(); contextSpy.mockRestore(); outlineSpy.mockRestore(); rootSpy.mockRestore();
    }
  });

  test("admits the existing 2000-pixel 2x export budget without entering the GPU during validation", async () => {
    const preparationStop = new Error("stop before GPU allocation");
    const sceneSpy = spyOn(PathTracingSceneModule, "createCrystalPathTraceScene").mockRejectedValue(preparationStop);
    const source = sceneWithOffCenterAtoms();
    const options: Parameters<typeof renderPathTracedExport>[0] = {
      width: 4000, height: 4000, camera: new OrthographicCamera(),
      settings: readRenderSettings({ mode: "path-traced" }),
      source, layout: computeSceneLayout(source), style: { ...createDefaultStyle(), materialPreset: "pbr-ceramic" },
      meshDetail: EXPORT_SCENE_MESH_DETAIL_PRESETS.high,
      componentOpacity: createDefaultComponentOpacity(), showAtoms: true, showUnitCell: true,
      unitCellColor: "#444444", unitCellLineStyle: "solid", background: null,
      unitCellLineWidth: 1, polyhedronLineWidth: 1, lightStrength: 1,
      renderer: {} as Parameters<typeof renderPathTracedExport>[0]["renderer"], rasterScene: new Scene(),
    };
    try {
      await expect(renderPathTracedExport({ ...options, width: 4001 })).rejects.toThrow("1600 万内部像素");
      expect(sceneSpy).not.toHaveBeenCalled();
      await expect(renderPathTracedExport({ ...options, width: Number.NaN })).rejects.toThrow("1600 万内部像素");
      expect(sceneSpy).not.toHaveBeenCalled();
      await expect(renderPathTracedExport(options)).rejects.toBe(preparationStop);
      expect(sceneSpy).toHaveBeenCalledTimes(1);
      expect(sceneSpy.mock.calls[0]?.[0].meshDetail).toBe(EXPORT_SCENE_MESH_DETAIL_PRESETS.high);
    } finally { sceneSpy.mockRestore(); }
  });
});

describe("computeSceneLayout", () => {
  test("anchors the preview on the unit-cell center instead of atom distribution", () => {
    const scene = sceneWithOffCenterAtoms();

    expect(computeSceneLayout(scene).groupPosition).toEqual([-2.5, -1.5, -1]);
  });

  test("uses the Naumann standard view with direct c projected upward", () => {
    const pose = computeStandardCameraPose(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      3,
    );

    expectVectorClose(pose.outward, standardCubicOutward());
    expectVectorClose(pose.cameraUp, standardCubicUp());
    expect(dot(pose.outward, pose.cameraUp)).toBeCloseTo(0);
    expect(dot([0, 0, 1], pose.cameraUp)).toBeGreaterThan(0);
  });

  test("keeps the same Naumann standard view for rectangular orthogonal cells", () => {
    const pose = computeStandardCameraPose(
      [
        [2, 0, 0],
        [0, 3, 0],
        [0, 0, 4],
      ],
      4,
    );

    expectVectorClose(pose.outward, standardCubicOutward());
    expectVectorClose(pose.cameraUp, standardCubicUp());
  });

  test("uses the same basal viewing angle for hexagonal cells", () => {
    const pose = computeStandardCameraPose(
      [
        [1, 0, 0],
        [-0.5, Math.sqrt(3) / 2, 0],
        [0, 0, 1],
      ],
      3,
    );

    expectVectorClose(pose.outward, standardCubicOutward());
    expectVectorClose(pose.cameraUp, standardCubicUp());
  });

  test("fits the camera from the geometric mean of projected and available size", () => {
    const safeArea = {
      bottom: 116,
      left: 420,
      right: 176,
      top: 40,
    };
    const zoom = computeCameraFitZoom(
      {
        projectedHeight: 17,
        projectedWidth: 17,
      },
      1000,
      800,
      safeArea,
    );

    expect(zoom).toBeCloseTo(Math.sqrt(404 * 644) / (17 * 2));
  });

  test("fits from projected area scale instead of a longest-side cap", () => {
    const safeArea = {
      bottom: 116,
      left: 420,
      right: 176,
      top: 40,
    };
    const zoom = computeCameraFitZoom(
      {
        projectedHeight: 2,
        projectedWidth: 4,
      },
      1000,
      800,
      safeArea,
    );

    expect(zoom).toBeCloseTo(Math.sqrt(404 * 644) / (Math.sqrt(2 * 4) * 2));
  });

  test("offsets the orthographic frustum toward the safe-area center", () => {
    const frustum = computeOrthographicFrustum(1000, 800, 100, {
      bottom: 116,
      left: 420,
      right: 176,
      top: 40,
    });

    expect((frustum.left + frustum.right) / 2).toBeCloseTo(-1.22);
    expect((frustum.bottom + frustum.top) / 2).toBeCloseTo(-0.38);
  });

  test("keeps the unit-cell center visually anchored while orthographic zoom changes", () => {
    const width = 1000;
    const height = 800;
    const safeArea = {
      bottom: 116,
      left: 420,
      right: 176,
      top: 40,
    };
    const expectedScreenX =
      safeArea.left + (width - safeArea.left - safeArea.right) / 2;
    const expectedScreenY =
      safeArea.top + (height - safeArea.top - safeArea.bottom) / 2;

    for (const zoom of [10, 25, 50, 100, 200]) {
      const camera = new OrthographicCamera();
      camera.position.set(10, 10, 10);
      camera.lookAt(0, 0, 0);
      applyOrthographicFrustum(camera, width, height, zoom, safeArea);
      camera.updateMatrixWorld(true);

      const projectedCenter = new Vector3(0, 0, 0).project(camera);
      const screenX = ((projectedCenter.x + 1) / 2) * width;
      const screenY = ((-projectedCenter.y + 1) / 2) * height;

      expect(screenX).toBeCloseTo(expectedScreenX);
      expect(screenY).toBeCloseTo(expectedScreenY);
    }
  });

  test("fits narrow side panels by their actual bounds rather than a fixed top exclusion", () => {
    const viewport = { width: 651, height: 407 };
    const left = previewLayoutForPanels(viewport, {
      left: { left: 0, top: 0, width: 320, height: 407 },
      tabs: { left: 328, top: 29, width: 210, height: 32 },
    });
    expect(left.availableArea).toEqual({ left: 328, right: 12, top: 69, bottom: 8 });
    expect(viewport.width - left.safeArea.left - left.safeArea.right).toBe(311);
    expect(viewport.height - left.safeArea.top - left.safeArea.bottom).toBeGreaterThan(260);
    const right = previewLayoutForPanels(viewport, { right: { left: 291, top: 0, width: 360, height: 407 } });
    expect(right.availableArea.left).toBe(12);
    expect(right.availableArea.right).toBe(368);
    expect(right.safeArea.top).toBe(56);
    const inspected = previewLayoutForPanels(viewport, {
      right: { left: 291, top: 0, width: 360, height: 407 },
      inspection: { left: 12, top: 56, width: 271, height: 96 },
    });
    expect(inspected.safeArea.top).toBe(160);
    expect(inspected.availableArea.top).toBe(56);
    expect(viewport.height - inspected.safeArea.top - inspected.safeArea.bottom).toBeGreaterThan(190);
  });

  test("moves the mobile fit and overlays above the measured bottom dock as its height changes", () => {
    const viewport = { width: 390, height: 844 };
    const short = previewLayoutForPanels(viewport, { left: { left: 0, top: 664, width: 390, height: 180 } });
    const tall = previewLayoutForPanels(viewport, { right: { left: 0, top: 484, width: 390, height: 360 } });
    expect(short.availableArea.bottom).toBe(188);
    expect(tall.availableArea.bottom).toBe(368);
    expect(tall.safeArea.top).toBe(56);
    expect(viewport.height - tall.safeArea.top - tall.safeArea.bottom).toBeGreaterThan(300);
    const size = orientationGizmoSizeForViewport(viewport, tall.availableArea, true);
    const gizmo = orientationGizmoContainerStyle(tall.availableArea, size, true);
    const legend = compactLegendStyle(viewport, tall.availableArea, size);
    expect(size).toBeLessThanOrEqual(96);
    expect(Number(gizmo.bottom)).toBeGreaterThan(360);
    expect(Number(legend.bottom)).toBeGreaterThan(360);
    expect(Number(legend.left) + Number(legend.maxWidth) / 2).toBeLessThan(viewport.width);
  });

  test("describes the unit-cell frame as twelve screen-space line segments", () => {
    const positions = cellFrameLinePositions([
      [4, 0, 0],
      [1, 3, 0],
      [0, 0, 2],
    ]);

    expect(CELL_FRAME_LINE_WIDTH_PIXELS).toBe(1);
    expect(positions).toHaveLength(72);
    expect(positions.slice(0, 6)).toEqual([0, 0, 0, 4, 0, 0]);
    expect(positions.slice(-6)).toEqual([1, 3, 2, 5, 3, 2]);
  });

  test("draws transparent structure objects before polyhedron shells and overlays", () => {
    expect(STRUCTURE_RENDER_ORDER.atomMesh).toBeLessThan(
      STRUCTURE_RENDER_ORDER.bondMesh,
    );
    expect(STRUCTURE_RENDER_ORDER.bondMesh).toBeLessThan(
      STRUCTURE_RENDER_ORDER.unitCellFrame,
    );
    expect(STRUCTURE_RENDER_ORDER.unitCellFrame).toBeLessThan(
      STRUCTURE_RENDER_ORDER.polyhedronSurface,
    );
    expect(STRUCTURE_RENDER_ORDER.polyhedronSurface).toBeLessThan(
      STRUCTURE_RENDER_ORDER.polyhedronEdge,
    );
    expect(STRUCTURE_RENDER_ORDER.polyhedronEdge).toBeLessThan(
      STRUCTURE_RENDER_ORDER.atomSelectionRim,
    );
  });

  test("builds atom render items for batched atom rendering", () => {
    const defaultStyle = createDefaultStyle();
    const style = {
      ...defaultStyle,
      atomRadius: 150,
      objectStyles: setAtomOverrideProperty(
        defaultStyle.objectStyles,
        "Si-0",
        "opacity",
        35,
      ),
    };
    const [item] = createAtomRenderItems({
      atomOpacity: 70,
      atoms: [atom("Si-0", [1, 2, 3])],
      colorScheme: style.colorScheme,
      style,
    });

    expect(item?.id).toBe("Si-0");
    expect(item?.atom.id).toBe("Si-0");
    expect(item?.position).toEqual([1, 2, 3]);
    expect(item?.opacity).toBe(0.35);
    expect(item?.radius).toBeCloseTo(1.5 * 1.11);
    expect(item?.color.startsWith("#")).toBe(true);

    const [inheritedItem] = createAtomRenderItems({
      atomOpacity: 70,
      atoms: [atom("Si-0", [1, 2, 3])],
      colorScheme: defaultStyle.colorScheme,
      style: defaultStyle,
    });
    expect(inheritedItem?.opacity).toBe(0.7);

    const hiddenStyle = {
      ...defaultStyle,
      objectStyles: setAtomOverrideProperty(
        defaultStyle.objectStyles,
        "Si-0",
        "opacity",
        0,
      ),
    };
    expect(
      createAtomRenderItems({
        atomOpacity: 70,
        atoms: [atom("Si-0", [1, 2, 3])],
        colorScheme: hiddenStyle.colorScheme,
        style: hiddenStyle,
      }),
    ).toEqual([]);
  });

  test("resolves batched pick items including batch id zero", () => {
    const registry = createBatchPickRegistry<{ id: string; label: string }>();
    const item = { id: "Si-0", label: "first atom" };

    registerBatchPickItem(registry, 0, item);

    expect(itemForBatchId(registry, 0)).toBe(item);
    expect(itemForBatchId(registry, undefined)).toBeNull();
    expect(registry.batchIdByItemId.get("Si-0")).toBe(0);
  });

  test("excludes zero-opacity bonds before batching and picking", () => {
    const defaultStyle = createDefaultStyle();
    const hiddenBond = bond("bond-hidden", 0, 1);
    const visibleBond = bond("bond-visible", 1, 2);
    const style = {
      ...defaultStyle,
      objectStyles: setBondOverrideProperty(
        defaultStyle.objectStyles,
        hiddenBond.id,
        "opacity",
        0,
      ),
    };
    const items = createBondRenderItems({
      atoms: [
        atom("Si-0", [0, 0, 0]),
        atom("Si-1", [1, 0, 0]),
        atom("Si-2", [2, 0, 0]),
      ],
      bondColor: style.bondColor,
      bondOpacity: 80,
      bondRadius: 0.1,
      bonds: [hiddenBond, visibleBond],
      colorMode: style.bondColorMode,
      colorScheme: style.colorScheme,
      style,
    });

    expect(items.map((item) => item.id)).toEqual([visibleBond.id]);
    expect(items[0]?.opacity).toBe(0.8);
  });

  test("invalidates the bond population when RGBA or pick identity changes", () => {
    const style = createDefaultStyle();
    const [item] = createBondRenderItems({
      atoms: [atom("Si-0", [0, 0, 0]), atom("Si-1", [1, 0, 0])],
      bondColor: style.bondColor,
      bondOpacity: 80,
      bondRadius: 0.1,
      bonds: [bond("bond-original", 0, 1)],
      colorMode: style.bondColorMode,
      colorScheme: style.colorScheme,
      style,
    });
    expect(item).toBeDefined();
    if (!item) return;

    const keyFor = (items: typeof item[]) =>
      bondBatchPopulationKey({
        colorMode: style.bondColorMode,
        items,
        radialSegments: 12,
        radius: 0.1,
      });
    const initialKey = keyFor([item]);

    expect(keyFor([{ ...item, opacity: 0.4 }])).not.toBe(initialKey);
    expect(keyFor([{ ...item, id: "bond-replacement" }])).not.toBe(initialKey);
  });

  test("fits the preview layout from unit-cell bounds only", () => {
    const scene = sceneWithOffCenterAtoms();

    expect(computeSceneLayout(scene).span).toBeCloseTo(5);
    expect(computeSceneLayout(scene, "vdw").span).toBeCloseTo(5);
    expect(computeSceneLayout(scene, "vdw").cameraFitBounds).toEqual(
      computeSceneLayout(scene).cameraFitBounds,
    );
  });

  test("uses atom positions for the depth fading front and back references", () => {
    const scene = sceneWithOffCenterAtoms();
    const layout = computeSceneLayout(scene);
    const outward = new Vector3(...layout.standardPose.outward).normalize();
    const offset = new Vector3(...layout.groupPosition);
    const projections = scene.atoms.map((item) =>
      new Vector3(...item.position).add(offset).dot(outward),
    );
    const expectedFrontOffset = -Math.max(0, ...projections);
    const expectedBackOffset = Math.max(
      0.01 * layout.span,
      -Math.min(0, ...projections),
    );

    expect(layout.depthFadingFrontOffset).toBeCloseTo(expectedFrontOffset);
    expect(layout.depthFadingBackOffset).toBeCloseTo(expectedBackOffset);
  });

  test("tracks the standard-view projected fit size for slender unit cells", () => {
    const layout = computeSceneLayout(sceneWithLongCell());

    expect(layout.cameraFitBounds.projectedWidth).toBeGreaterThan(0);
    expect(layout.cameraFitBounds.projectedWidth).toBeLessThan(layout.span);
    expect(layout.cameraFitBounds.projectedHeight).toBeLessThan(layout.span);
  });

  test("uses the default standard-view projected footprint for 100 percent fit", () => {
    const layout = computeSceneLayout(sceneWithLongC());

    expect(layout.span).toBeCloseTo(10);
    expect(layout.cameraFitBounds.projectedWidth).toBeGreaterThan(0);
    expect(layout.cameraFitBounds.projectedHeight).toBeGreaterThan(0);
  });

  test("keeps the projected fit size fixed after the initial default view", () => {
    const scene = sceneWithLongC();
    const standardLayout = computeSceneLayout(scene);
    const aOutwardLayout = computeSceneLayout(
      scene,
      "uniform",
      stateWithDirectAxis(
        scene.cell.vectors,
        createDefaultCrystalCameraState(),
        "a",
      ),
    );

    expectVectorClose(aOutwardLayout.cameraPose.outward, [1, 0, 0]);
    expect(standardLayout.cameraFitBounds.projectedHeight).toBeGreaterThan(0);
    expect(aOutwardLayout.cameraFitBounds).toEqual(
      standardLayout.cameraFitBounds,
    );
  });

  test("resolves selected material family with per-target overrides", () => {
    const style = {
      ...createDefaultStyle(),
      materialPreset: "glossy",
    };
    const atomFamily = resolveStructureMaterialFamilyForTarget(style, "atom");
    const bondFamily = resolveStructureMaterialFamilyForTarget(style, "bond");
    const polyhedronFamily = resolveStructureMaterialFamilyForTarget(
      style,
      "polyhedron",
    );

    expect(STRUCTURE_MATERIAL_TARGETS).toEqual(["atom", "bond", "polyhedron"]);
    expect(atomFamily.id).toBe("glossy");
    expect(atomFamily.material.type).toBe("MeshStandardMaterial");
    expect(bondFamily).toEqual(atomFamily);
    expect(polyhedronFamily.id).toBe(atomFamily.id);
    expect(polyhedronFamily.lighting).toEqual(atomFamily.lighting);
    expect(polyhedronFamily.material.type).toBe("MeshStandardMaterial");
    expect(polyhedronFamily.material.props).not.toEqual(
      atomFamily.material.props,
    );
    expect(
      resolveStructureMaterialFamilyForStyle({
        ...style,
        materialPreset: "2d",
      }).material.type,
    ).toBe("MeshBasicMaterial");
    expect(
      resolveStructureMaterialFamilyForTarget(
        {
          ...style,
          materialPreset: "2d",
        },
        "polyhedron",
      ),
    ).toEqual(
      resolveStructureMaterialFamilyForTarget(
        {
          ...style,
          materialPreset: "2d",
        },
        "atom",
      ),
    );
  });

  test("keeps preview mesh detail aligned with the medium quality preset", () => {
    expect(PREVIEW_SCENE_MESH_DETAIL).toEqual({
      bondRadialSegments: 16,
      sphereHeightSegments: 24,
      sphereWidthSegments: 32,
    });
    expect(EXPORT_SCENE_MESH_DETAIL_PRESETS.low).toEqual({
      bondRadialSegments: 12,
      sphereHeightSegments: 16,
      sphereWidthSegments: 24,
    });
    expect(EXPORT_SCENE_MESH_DETAIL_PRESETS.medium).toBe(
      PREVIEW_SCENE_MESH_DETAIL,
    );
    expect(EXPORT_SCENE_MESH_DETAIL_PRESETS.high).toEqual({
      bondRadialSegments: 24,
      sphereHeightSegments: 32,
      sphereWidthSegments: 48,
    });
    expect(EXPORT_SCENE_MESH_DETAIL_PRESETS.xhigh.sphereWidthSegments).toBe(72);
    expect(EXPORT_SCENE_MESH_DETAIL_PRESETS.xhigh.bondRadialSegments).toBe(32);
  });

  test("scales exported structure line width from the tight content bounds", () => {
    expect(
      structureLineWidthScale(exportFramePlanWithBounds(2000, 2000), 1),
    ).toBeCloseTo(2);
    expect(
      structureLineWidthScale(exportFramePlanWithBounds(2000, 2000, 4), 4),
    ).toBeCloseTo(8);
    expect(
      structureLineWidthScale(exportFramePlanWithBounds(600, 600, 2), 2),
    ).toBeCloseTo(2);
    expect(
      structureLineWidthScale(exportFramePlanWithBounds(5000, 5000), 1),
    ).toBeCloseTo(5);
    expect(
      structureLineWidthScale(exportFramePlanWithBounds(2000, 2000), 1, 1.5),
    ).toBeCloseTo(3);
    expect(
      structureLineWidthScale(exportFramePlanWithBounds(2000, 2000), 2, 0.5),
    ).toBeCloseTo(1);
  });

  test("keeps polyhedron contours finer than the cell frame in preview and export", () => {
    const { polyhedra, unitCell } = DEFAULT_STRUCTURE_LINE_WIDTH;
    expect(polyhedra).toBe(0.75);
    expect(unitCell).toBe(1);
    expect(POLYHEDRON_EDGE_LINE_WIDTH_PIXELS * polyhedra / (CELL_FRAME_LINE_WIDTH_PIXELS * unitCell)).toBe(0.75);
    for (const size of [600, 2000, 5000]) {
      for (const supersampling of [1, 2]) {
        const frame = exportFramePlanWithBounds(size, size, supersampling);
        const edge = POLYHEDRON_EDGE_LINE_WIDTH_PIXELS * structureLineWidthScale(frame, supersampling, polyhedra);
        const cell = CELL_FRAME_LINE_WIDTH_PIXELS * structureLineWidthScale(frame, supersampling, unitCell);
        expect(edge / cell).toBeCloseTo(0.75);
      }
    }
  });

  test("builds bicolor bonds as one open cylinder side with a hard color boundary", () => {
    const geometry = twoToneBondCylinderGeometry({
      endColor: "#0000ff",
      length: 4,
      radialSegments: 4,
      radius: 0.5,
      startColor: "#ff0000",
    });
    const position = geometry.getAttribute("position");
    const color = geometry.getAttribute("color");
    const rowVertexCount = 5;

    expect(position.count).toBe(4 * rowVertexCount);
    expect(geometry.index?.count).toBe(2 * 4 * 2 * 3);
    expect(position.getY(0)).toBeCloseTo(-2);
    expect(position.getY(rowVertexCount)).toBeCloseTo(0);
    expect(position.getY(rowVertexCount * 2)).toBeCloseTo(0);
    expect(position.getY(rowVertexCount * 3)).toBeCloseTo(2);
    expect([
      color.getX(rowVertexCount),
      color.getY(rowVertexCount),
      color.getZ(rowVertexCount),
    ]).toEqual([1, 0, 0]);
    expect([
      color.getX(rowVertexCount * 2),
      color.getY(rowVertexCount * 2),
      color.getZ(rowVertexCount * 2),
    ]).toEqual([0, 0, 1]);

    for (let index = 0; index < position.count; index += 1) {
      const isCenterCapVertex =
        Math.abs(position.getY(index)) < 1e-12 &&
        Math.abs(position.getX(index)) < 1e-12 &&
        Math.abs(position.getZ(index)) < 1e-12;

      expect(isCenterCapVertex).toBe(false);
    }

    expect(firstTriangleNormalDotVertexNormal(geometry)).toBeGreaterThan(0);

    geometry.dispose();
  });

  test("captures and applies a narrow orthographic camera pose snapshot", () => {
    const sourceOrientation = new Quaternion();
    const snapshot = createCameraPoseSnapshot(sourceOrientation, [1, 2, 3]);
    const camera = new OrthographicCamera();

    applyCameraPoseSnapshot(camera, snapshot, 10, 3);

    expect(snapshot).toEqual({
      projection: "orthographic",
      quaternion: [0, 0, 0, 1],
      target: [1, 2, 3],
    });
    expect(camera.position.x).toBeCloseTo(1);
    expect(camera.position.y).toBeCloseTo(2);
    expect(camera.position.z).toBeCloseTo(13);
    expect(camera.up.x).toBeCloseTo(0);
    expect(camera.up.y).toBeCloseTo(1);
    expect(camera.up.z).toBeCloseTo(0);
    expect(camera.near).toBeCloseTo(0.01);
    expect(camera.far).toBeGreaterThanOrEqual(1000);
  });

  test("maps depth fading start and amount to a linear scene fog range", () => {
    expect(createSceneFog(40, 10, 6, 1, 0, 25)).toBeNull();

    const earlyFog = createSceneFog(40, 10, 6, 1, 50, 0);
    const lateFog = createSceneFog(40, 10, 6, 1, 50, 100);
    const subtleFog = createSceneFog(40, 10, 6, 1, 25, 25);
    const strongFog = createSceneFog(40, 10, 6, 1, 100, 25);
    const darkFog = createSceneFog(40, 10, 6, 1, 50, 25, "#111111");

    expect(earlyFog).not.toBeNull();
    expect(lateFog).not.toBeNull();
    expect(subtleFog).not.toBeNull();
    expect(strongFog).not.toBeNull();
    expect(earlyFog?.color.getHexString()).toBe(SCENE_FOG_COLOR.slice(1));
    expect(darkFog?.color.getHexString()).toBe("111111");
    expect(earlyFog!.near).toBeCloseTo(37);
    expect(lateFog!.near).toBeGreaterThan(earlyFog!.near);
    expect(lateFog!.near).toBeCloseTo(42);
    expect(lateFog!.far).toBeLessThan(earlyFog!.far);
    expect(strongFog!.near).toBeCloseTo(subtleFog!.near);
    expect(strongFog!.far).toBeLessThan(subtleFog!.far);

    const backDepth = 40 + 6;
    const earlyBackFade =
      (backDepth - earlyFog!.near) / (earlyFog!.far - earlyFog!.near);
    const lateBackFade =
      (backDepth - lateFog!.near) / (lateFog!.far - lateFog!.near);
    expect(earlyBackFade).toBeCloseTo(0.5);
    expect(lateBackFade).toBeCloseTo(0.5);
    expect(strongFog!.far).toBeCloseTo(backDepth);
  });

  test("disables fog for transparent exports instead of using preview fog color", () => {
    expect(exportFogColor(null)).toBeNull();
    expect(exportFogColor("#123456")).toBe("#123456");
  });

  test("derives export aspect from the projected currently visible content", () => {
    const scene = sceneWithExportVisibilityAtoms();
    const visibility = createDefaultComponentVisibility(scene);
    const cameraPose = createCameraPoseSnapshot(new Quaternion());
    const componentOpacity = createDefaultComponentOpacity();
    const style = { ...createDefaultStyle(), atomRadiusModel: "uniform" as const, atomRadius: 40 };

    const defaultVisibleScene = visibleSceneForComponents(scene, visibility);
    const withOneHopScene = visibleSceneForComponents(scene, {
      ...visibility,
      oneHopBondedAtoms: true,
    });

    expect(defaultVisibleScene).not.toBeNull();
    expect(withOneHopScene).not.toBeNull();
    expect(
      computeStructureExportAspectRatio({
        cameraPose,
        componentOpacity,
        scene: defaultVisibleScene!,
        showAtoms: true,
        showUnitCell: false,
        style,
      }),
    ).toBeCloseTo(2.25);
    expect(
      computeStructureExportAspectRatio({
        cameraPose,
        componentOpacity,
        scene: withOneHopScene!,
        showAtoms: true,
        showUnitCell: false,
        style,
      }),
    ).toBeCloseTo(9 / 14);

    const transparentOneHopStyle = {
      ...style,
      objectStyles: setAtomOverrideProperty(
        style.objectStyles,
        "Cl-1-one-hop",
        "opacity",
        0,
      ),
    };
    expect(
      computeStructureExportAspectRatio({
        cameraPose,
        componentOpacity,
        scene: withOneHopScene!,
        showAtoms: true,
        showUnitCell: false,
        style: transparentOneHopStyle,
      }),
    ).toBeCloseTo(2.25);
  });

  test("leaves export framing unchanged when measurements are empty or unresolved", () => {
    const scene = sceneWithOffCenterAtoms();
    const options = {
      cameraPose: createCameraPoseSnapshot(new Quaternion()),
      componentOpacity: createDefaultComponentOpacity(),
      scene,
      showAtoms: true,
      showUnitCell: false,
      style: createDefaultStyle(),
      width: 900,
      height: 600,
    };
    const original = computeStructureExportFramePlan(options);
    expect(computeStructureExportFramePlan({ ...options, scene: { ...scene, measurements: [] } })).toEqual(original);
    expect(computeStructureExportFramePlan({ ...options, scene: {
      ...scene, measurementStyle: { ...DEFAULT_MEASUREMENT_STYLE, fontScale: 250, color: "#ff0000" },
    } })).toEqual(original);
    expect(computeStructureExportFramePlan({ ...options, scene: {
      ...scene,
      measurements: [{ id: "missing", kind: "distance", atomIds: [scene.atoms[0]!.id, "missing-atom"] }],
    } })).toEqual(original);
  });

  test("frames distance annotations even when crystal geometry is hidden", () => {
    const scene = sceneWithMeasurementAtoms();
    scene.atoms = [atom("a", [0, -5, 0]), atom("b", [0, 5, 0])];
    const options = {
      cameraPose: createCameraPoseSnapshot(new Quaternion()),
      componentOpacity: createDefaultComponentOpacity(),
      groupPosition: [0, 0, 0] as [number, number, number],
      scene,
      showAtoms: false,
      showUnitCell: false,
      style: createDefaultStyle(),
    };
    expect(computeStructureProjectedBounds(options)).toBeNull();
    const bounds = computeStructureProjectedBounds({ ...options, scene: {
      ...scene,
      measurements: [{ id: "distance", kind: "distance", atomIds: ["a", "b"] }],
    } })!;
    const labelWidth = 20 * 0.042 * ("10.000 Å".length * 56 + 32) / 88;
    expect(bounds.width).toBeGreaterThanOrEqual(labelWidth);
    expect(bounds.minY).toBeLessThan(-5);
    expect(bounds.maxY).toBeGreaterThan(5);
    for (const fontScale of [50, 250]) {
      const styledScene: SceneSpec = {
        ...scene,
        measurements: [{ id: "distance", kind: "distance", atomIds: ["a", "b"] }],
        measurementStyle: { ...DEFAULT_MEASUREMENT_STYLE, fontScale, color: "#cc2200" },
      };
      const styledBounds = computeStructureProjectedBounds({ ...options, scene: styledScene })!;
      const [measurement] = displayedMeasurements(styledScene);
      const anchor = layoutMeasurementLabels({
        measurements: [measurement!], cameraQuaternion: options.cameraPose.quaternion, span: 20, fontScale,
      }).get("distance")!;
      const size = measurementLabelSize(measurement!.label, 20, fontScale);
      expect(size.width).toBeCloseTo(labelWidth * fontScale / 100);
      expect(styledBounds.minX).toBeLessThanOrEqual(anchor[0] - size.width / 2);
      expect(styledBounds.maxX).toBeGreaterThanOrEqual(anchor[0] + size.width / 2);
      expect(styledBounds.minY).toBeLessThanOrEqual(anchor[1] - size.height * 0.08);
      expect(styledBounds.maxY).toBeGreaterThanOrEqual(anchor[1] + size.height * 0.92);
      expect(computeStructureProjectedBounds({ ...options, scene: {
        ...styledScene,
        measurementStyle: { ...styledScene.measurementStyle!, color: "#0044cc", fontWeight: 600 },
      } })).toEqual(styledBounds);
    }
  });

  test("filters complete measurement groups and uses only displayed labels for export layout", () => {
    const scene = sceneWithMeasurementAtoms();
    scene.measurements = [
      { id: "distance", kind: "distance", atomIds: ["a", "b"] },
      { id: "angle", kind: "angle", atomIds: ["a", "b", "c"] },
    ];
    const originalMeasurements = JSON.stringify(scene.measurements);
    for (const displayMode of ["all", "distance", "angle"] as const) {
      const filteredScene: SceneSpec = { ...scene, measurementStyle: { ...DEFAULT_MEASUREMENT_STYLE, displayMode, showLabels: false } };
      const expectedIds = displayMode === "all" ? ["distance", "angle"] : [displayMode];
      expect(displayedMeasurements(filteredScene).map(item => item.definition.id)).toEqual(expectedIds);
      const markup = renderToStaticMarkup(createElement(MeasurementAnnotations, { scene: filteredScene }));
      expect(markup.match(/<primitive\b/g)).toHaveLength(displayMode === "all" ? 3 : displayMode === "distance" ? 1 : 2);
      const options = {
        cameraPose: createCameraPoseSnapshot(new Quaternion()), componentOpacity: createDefaultComponentOpacity(),
        scene: { ...filteredScene, measurementStyle: { ...filteredScene.measurementStyle!, showLabels: true, fontScale: 250 } },
        showAtoms: true, showUnitCell: false, style: createDefaultStyle(), width: 900, height: 600,
      };
      expect(computeStructureExportFramePlan(options)).toEqual(computeStructureExportFramePlan({ ...options, scene: {
        ...options.scene,
        measurements: scene.measurements.filter(item => expectedIds.includes(item.id)),
        measurementStyle: { ...options.scene.measurementStyle, displayMode: "all" },
      } }));
      expect(JSON.stringify(scene.measurements)).toBe(originalMeasurements);
    }
  });

  test("derives label obstacles from visible atoms and bonds with their rendered radii", () => {
    const scene = sceneWithMeasurementAtoms();
    scene.bonds = [bond("ab", 0, 1), bond("bc", 1, 2)];
    const style = createDefaultStyle();
    style.objectStyles = setAtomOverrideProperty(style.objectStyles, "a", "radius", 1.25);
    style.objectStyles = setAtomOverrideProperty(style.objectStyles, "b", "opacity", 0);
    style.objectStyles = setAtomOverrideProperty(style.objectStyles, "c", "visible", false);
    style.objectStyles = setBondOverrideProperty(style.objectStyles, "ab", "radius", 0.33);
    style.objectStyles = setBondOverrideProperty(style.objectStyles, "bc", "opacity", 0);
    expect(measurementLayoutObstacles({ scene, style })).toEqual({
      obstacles: [{ position: scene.atoms[0]!.position, radius: 1.25 }],
      segments: [{ start: scene.atoms[0]!.position, end: scene.atoms[1]!.position, radius: 0.33 }],
    });
    expect(measurementLayoutObstacles({ scene, style, showAtoms: false, bondOpacity: 0 })).toEqual({ obstacles: [], segments: [] });
  });

  test("hides measurement sprites and excludes text bounds while retaining unchanged angle geometry", () => {
    const scene = sceneWithMeasurementAtoms();
    const definition = { id: "straight", kind: "angle", atomIds: ["a", "b", "c"] } as const;
    scene.measurements = [{ ...definition, atomIds: [...definition.atomIds] }];
    const measurement = resolveMeasurement(scene, scene.measurements[0]!)!;
    const arc = measurementAngleArcPositions(measurement);
    const options = {
      cameraPose: createCameraPoseSnapshot(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)),
      componentOpacity: createDefaultComponentOpacity(),
      groupPosition: [0, 0, 0] as [number, number, number],
      scene,
      showAtoms: false,
      showUnitCell: false,
      style: createDefaultStyle(),
    };
    const withLabels = computeStructureProjectedBounds(options)!;
    const withoutLabels = { ...scene, measurementStyle: { ...DEFAULT_MEASUREMENT_STYLE, showLabels: false } };
    const geometryBounds = computeStructureProjectedBounds({ ...options, scene: withoutLabels })!;
    expect(geometryBounds.minY).toBeCloseTo(-2.6 - 20 * 0.0015 / 2);
    expect(geometryBounds.minY).toBeGreaterThan(withLabels.minY);
    const markup = renderToStaticMarkup(createElement(MeasurementAnnotations, { scene: withoutLabels, scale: 20 }));
    expect(markup.match(/<primitive\b/g)).toHaveLength(2);
    expect(markup).not.toContain("<sprite");
    for (const fontScale of [50, 250]) {
      const styledScene: SceneSpec = { ...withoutLabels, measurementStyle: {
        ...withoutLabels.measurementStyle, color: "#0044cc", fontScale, fontWeight: 600,
      } };
      const styledMeasurement = resolveMeasurement(styledScene, styledScene.measurements![0]!)!;
      expect(styledMeasurement.points).toEqual(measurement.points);
      expect(styledMeasurement.labelPosition).toEqual(measurement.labelPosition);
      expect(measurementAngleArcPositions(styledMeasurement)).toEqual(arc);
      expect(computeStructureProjectedBounds({ ...options, scene: styledScene })).toEqual(geometryBounds);
    }
  });

  test("keeps straight-angle arcs and billboard label corners inside rotated export frames", () => {
    const scene = sceneWithMeasurementAtoms();
    scene.measurements = [{ id: "straight", kind: "angle", atomIds: ["a", "b", "c"] }];
    const orientations = [
      new Quaternion(),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
      new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.1),
    ];
    const groupPosition: [number, number, number] = [4, -2, 5];
    const offset = new Vector3(...groupPosition);
    const span = computeSceneLayout(scene).span;
    for (const fontScale of [50, 100, 250]) {
      scene.measurementStyle = { ...DEFAULT_MEASUREMENT_STYLE, fontScale };
      const labelHeight = 0.042 * span * fontScale / 100;
      const labelWidth = labelHeight * ("180.00°".length * 56 + 32) / 88;
      for (const orientation of orientations) {
        const cameraPose = createCameraPoseSnapshot(orientation, [2, -3, 1]);
        const labelPosition = layoutMeasurementLabels({
          measurements: displayedMeasurements(scene), cameraQuaternion: cameraPose.quaternion, span, fontScale,
          ...measurementLayoutObstacles({ scene, style: createDefaultStyle() }),
        }).get("straight")!;
        const frame = computeStructureExportFramePlan({
          cameraPose,
          componentOpacity: createDefaultComponentOpacity(),
          groupPosition,
          scene,
          showAtoms: true,
          showUnitCell: false,
          style: createDefaultStyle(),
          width: 900,
          height: 600,
        });
        const camera = new OrthographicCamera();
        applyCameraPoseSnapshot(camera, cameraPose, 60, span);
        applyOrthographicExportFrame(camera, frame);
        camera.updateMatrixWorld();
        const right = new Vector3(1, 0, 0).applyQuaternion(orientation);
        const up = new Vector3(0, 1, 0).applyQuaternion(orientation);
        const points: Vector3[] = [];
        for (const x of [-0.5, 0.5]) {
          for (const y of [-0.08, 0.92]) {
            points.push(new Vector3(...labelPosition).add(offset)
              .addScaledVector(right, x * labelWidth)
              .addScaledVector(up, y * labelHeight));
          }
        }
        for (let index = 0; index <= 40; index += 1) {
          const angle = Math.PI * index / 40;
          points.push(new Vector3(-2.6 * Math.cos(angle), 0, -2.6 * Math.sin(angle)).add(offset));
        }
        for (const point of points) {
          const projected = point.project(camera);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("builds polyhedron geometry from returned hull atoms and faces", () => {
    const scene = sceneWithOffCenterAtoms();
    const polyhedron = {
      centerAtomIndex: 0,
      hullAtomIndices: [0, 1, 2, 3],
      faces: [
        [0, 1, 2],
        [0, 1, 3],
        [0, 2, 3],
        [1, 2, 3],
      ],
      visibilityDependencies: [],
      visibilityDependencyGroups: [],
    } satisfies SceneSpec["polyhedra"][number];

    const geometry = polyhedronGeometryFromAtoms(polyhedron, scene.atoms);

    expect(geometry?.getAttribute("position").count).toBe(4);
    expect(geometry?.index?.count).toBe(12);
    geometry?.dispose();
  });

  test("skips polyhedron geometry when hull atoms or face indices are invalid", () => {
    const scene = sceneWithOffCenterAtoms();

    expect(
      polyhedronGeometryFromAtoms(
        {
          centerAtomIndex: 0,
          hullAtomIndices: [0, 999, 2],
          faces: [[0, 1, 2]],
          visibilityDependencies: [],
          visibilityDependencyGroups: [],
        },
        scene.atoms,
      ),
    ).toBeNull();
    expect(
      polyhedronGeometryFromAtoms(
        {
          centerAtomIndex: 0,
          hullAtomIndices: [0, 1, 2],
          faces: [[0, 1, 3]],
          visibilityDependencies: [],
          visibilityDependencyGroups: [],
        },
        scene.atoms,
      ),
    ).toBeNull();
  });

  test("uses independent per-element colors and flat toon facets without altering atom styles", () => {
    expect(POLYHEDRON_EDGE_COLOR).toBe("#000000");
    expect(POLYHEDRON_EDGE_OPACITY).toBeGreaterThanOrEqual(0.9);
    expect(createDefaultComponentOpacity().polyhedra).toBe(40);
    const scene = sceneWithOffCenterAtoms();
    const style = createDefaultStyle();
    const centerElement = scene.atoms[0]!.element;
    const originalAtomStyles = JSON.stringify(style);
    const polyhedronStyle = { ...style, polyhedronColors: { [centerElement]: "#e99a70", Zn: "#8db8df" } };
    const batch = createPolyhedronSurfaceBatchBuild({ atoms: scene.atoms, polyhedra: [tetrahedronPolyhedron()], style: polyhedronStyle })!;
    expect(batch.items[0]!.color.getHexString()).toBe("e99a70");
    expect(polyhedronColorForElement(polyhedronStyle, "Zn")).toBe("#8db8df");
    expect(JSON.stringify(style)).toBe(originalAtomStyles);
    expect(polyhedronStyle.customColormap).toBe(style.customColormap);
    expect(polyhedronStyle.objectStyles).toBe(style.objectStyles);
    const normals = batch.items[0]!.geometry.getAttribute("normal");
    expect(normals.count).toBe(12);
    for (let i = 0; i < normals.count; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        expect(normals.array[(i + 1) * 3 + axis]).toBeCloseTo(normals.array[i * 3 + axis]!, 6);
        expect(normals.array[(i + 2) * 3 + axis]).toBeCloseTo(normals.array[i * 3 + axis]!, 6);
      }
    }
    const atomFamily = resolveStructureMaterialFamilyForTarget(style, "atom");
    const polyhedronFamily = resolveStructureMaterialFamilyForTarget(style, "polyhedron");
    expect(atomFamily.material.type).toBe("MeshPhongMaterial");
    expect(atomFamily.material.props.shininess).toBe(300);
    expect(polyhedronFamily.material.type).toBe("MeshToonMaterial");
    expect(polyhedronFamily.material.props).toEqual({});
    disposePolyhedronSurfaceBatchBuild(batch);
  });

  test("builds one surface batch for valid polyhedra and skips invalid entries", () => {
    const scene = sceneWithOffCenterAtoms();
    const atoms = [
      ...scene.atoms,
      atom("Si-4", [1.1, 0.1, 0.1]),
      atom("Si-5", [1.3, 0.1, 0.1]),
      atom("Si-6", [1.1, 0.3, 0.1]),
      atom("Si-7", [1.1, 0.1, 0.3]),
    ];
    const validPolyhedron = tetrahedronPolyhedron();
    const secondValidPolyhedron = {
      ...tetrahedronPolyhedron(),
      centerAtomIndex: 4,
      hullAtomIndices: [4, 5, 6, 7],
    };
    const invalidCenterPolyhedron = {
      ...tetrahedronPolyhedron(),
      centerAtomIndex: 999,
    };
    const invalidFacePolyhedron = {
      ...tetrahedronPolyhedron(),
      faces: [[0, 1, 4]],
    } satisfies SceneSpec["polyhedra"][number];

    const batch = createPolyhedronSurfaceBatchBuild({
      atoms,
      polyhedra: [
        validPolyhedron,
        invalidCenterPolyhedron,
        secondValidPolyhedron,
        invalidFacePolyhedron,
      ],
      style: createDefaultStyle(),
    });

    expect(batch).not.toBeNull();
    if (!batch) {
      throw new Error("Expected valid polyhedra to produce a surface batch.");
    }

    expect(batch.itemCount).toBe(2);
    expect(batch.maxVertexCount).toBe(24);
    expect(batch.maxIndexCount).toBe(24);
    expect(batch.items.map((item) => item.polyhedronIndex)).toEqual([0, 2]);
    expect(batch.edges).toHaveLength(12);
    expect(batch.key.startsWith("polyhedra:2:")).toBe(true);
    disposePolyhedronSurfaceBatchBuild(batch);
  });

  test("deduplicates coincident polyhedron surface faces across the batch", () => {
    const scene = sceneWithOffCenterAtoms();
    const batch = createPolyhedronSurfaceBatchBuild({
      atoms: scene.atoms,
      polyhedra: [
        tetrahedronPolyhedron(),
        {
          ...tetrahedronPolyhedron(),
          centerAtomIndex: 1,
        },
      ],
      style: createDefaultStyle(),
    });

    expect(batch).not.toBeNull();
    if (!batch) {
      throw new Error("Expected valid polyhedra to produce a surface batch.");
    }

    expect(batch.itemCount).toBe(1);
    expect(batch.maxVertexCount).toBe(12);
    expect(batch.maxIndexCount).toBe(12);
    expect(batch.items.map((item) => item.polyhedronIndex)).toEqual([0]);
    expect(batch.edges).toHaveLength(6);
    disposePolyhedronSurfaceBatchBuild(batch);
  });

  test("keeps nearly coincident but distinct polyhedron surface faces", () => {
    const scene = sceneWithOffCenterAtoms();
    const atoms = [
      ...scene.atoms,
      atom("Si-4", [0.10000001, 0.1, 0.1]),
      atom("Si-5", [0.3, 0.1, 0.1]),
      atom("Si-6", [0.1, 0.3, 0.1]),
      atom("Si-7", [0.1, 0.1, 0.3]),
    ];
    const batch = createPolyhedronSurfaceBatchBuild({
      atoms,
      polyhedra: [
        tetrahedronPolyhedron(),
        {
          ...tetrahedronPolyhedron(),
          centerAtomIndex: 4,
          hullAtomIndices: [4, 5, 6, 7],
        },
      ],
      style: createDefaultStyle(),
    });

    expect(batch).not.toBeNull();
    if (!batch) {
      throw new Error("Expected valid polyhedra to produce a surface batch.");
    }

    expect(batch.itemCount).toBe(2);
    expect(batch.items.map((item) => item.polyhedronIndex)).toEqual([0, 1]);
    expect(batch.edges).toHaveLength(9);
    disposePolyhedronSurfaceBatchBuild(batch);
  });

  test("normalizes orientation gizmo axes without orthogonalizing the cell", () => {
    const colors = { a: "#ff0000", b: "#00ff00", c: "#0000ff" };
    const axes = computeOrientationGizmoAxes([
      [4, 0, 0],
      [1, 3, 0],
      [0, 0, 2],
    ], colors);

    expect(axes.map((axis) => axis.label)).toEqual(["a", "b", "c"]);
    expect(axes.map((axis) => axis.color)).toEqual(Object.values(colors));
    expectVectorClose(axes[0]!.direction, [1, 0, 0]);
    expectVectorClose(axes[1]!.direction, [
      1 / Math.sqrt(10),
      3 / Math.sqrt(10),
      0,
    ]);
    expectVectorClose(axes[2]!.direction, [0, 0, 1]);
  });
});

function expectVectorClose(
  actual: [number, number, number],
  expected: [number, number, number],
) {
  expect(actual[0]).toBeCloseTo(expected[0]);
  expect(actual[1]).toBeCloseTo(expected[1]);
  expect(actual[2]).toBeCloseTo(expected[2]);
}

function standardCubicOutward(): [number, number, number] {
  const length = Math.sqrt(41);
  return [6 / length, 2 / length, 1 / length];
}

function standardCubicUp(): [number, number, number] {
  const length = Math.sqrt(1640);
  return [-6 / length, -2 / length, 40 / length];
}

function dot(left: [number, number, number], right: [number, number, number]) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

describe("path tracing structure snapshot", () => {
  function optionsFor(scene: SceneSpec): CrystalPathTraceSceneOptions {
    return { scene, style: createDefaultStyle(), componentOpacity: { atoms: 100, bonds: 100, polyhedra: 0, unitCell: 0 },
      groupPosition: [2, 3, 4], showAtoms: true, showUnitCell: false,
      unitCellColor: "#556677", unitCellRadius: 0.025, polyhedronEdgeRadius: 0.015, quality: "draft" };
  }

  function snapshotContents(snapshot: Awaited<ReturnType<typeof createCrystalPathTraceScene>>) {
    const result: unknown[] = [];
    snapshot.scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const geometry = object.geometry as BufferGeometry;
      const { uuid: _uuid, metadata: _metadata, ...material } = (object.material as MeshPhysicalMaterial).toJSON();
      result.push({ name: object.name, material, position: object.position.toArray(), scale: object.scale.toArray(),
        quaternion: object.quaternion.toArray(), index: Array.from(object.geometry.index?.array ?? []),
        attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) =>
          [name, { itemSize: attribute.itemSize, data: Array.from(attribute.array) }])) });
    });
    return result;
  }

  test("updates material, palette and positive opacity on the same meshes without retaining old preset properties", async () => {
    const source = sceneWithOffCenterAtoms(); source.bonds = []; source.polyhedra = [tetrahedronPolyhedron()];
    const initial = optionsFor(source);
    initial.showUnitCell = true;
    initial.componentOpacity = { atoms: 100, bonds: 100, polyhedra: 40, unitCell: 100 };
    initial.style.materialPreset = "pbr-ceramic";
    const snapshot = await createCrystalPathTraceScene(initial);
    const meshes: Mesh[] = []; snapshot.scene.traverse(object => { if (object instanceof Mesh) meshes.push(object); });
    const geometry = meshes.map(mesh => mesh.geometry), originalScene = snapshot.scene;
    const environment = new Texture(); snapshot.scene.environment = environment;
    try {
      for (const preset of ["pbr-glass", "pbr-ceramic", "pbr-glass", "pbr-ceramic"] as const) {
        const next = structuredClone(initial);
        next.style.materialPreset = preset;
        next.style.physicalMaterial = preset === "pbr-glass" ? { transmission: 0.7, roughness: 0.12 } : undefined;
        next.style.colorSchemeMode = "preset"; next.style.colorScheme = "nord"; next.style.distinguishSimilarColors = true;
        next.style.polyhedronColors = { Si: "#7faa55" };
        next.style.objectStyles.atomOverrides["Si-0"] = { color: "#ff3366", opacity: 47 };
        next.style.objectStyles.elementOverrides.Si = { opacity: 83 };
        next.componentOpacity = { atoms: 73, bonds: 68, polyhedra: 61, unitCell: 88 };
        next.unitCellColor = "#aabbcc";
        const fresh = await createCrystalPathTraceScene(next);
        try {
          expect(snapshot.updateAppearance(next)).toBe(true);
          expect(snapshot.scene === originalScene && snapshot.scene.environment === environment).toBe(true);
          expect(meshes.every((mesh, i) => snapshot.scene.getObjectByName(mesh.name) === mesh && mesh.geometry === geometry[i])).toBe(true);
          expect(snapshotContents(snapshot)).toEqual(snapshotContents(fresh));
        } finally { fresh.dispose(); }
      }
      snapshot.updateLineRadii(0.04, 0.03);
      expect(snapshot.updateAppearance({ ...initial, unitCellRadius: 0.04, polyhedronEdgeRadius: 0.03 })).toBe(true);
    } finally { snapshot.dispose(); environment.dispose(); }
  });

  test("splits shared two-tone color geometry only where needed and matches a newly built snapshot", async () => {
    const source = sceneWithOffCenterAtoms();
    source.bonds = [bond("first", 0, 1), bond("second", 2, 3)];
    const initial = optionsFor(source); initial.style.materialPreset = "pbr-ceramic";
    const snapshot = await createCrystalPathTraceScene(initial);
    const first = snapshot.scene.getObjectByName("first") as Mesh;
    const second = snapshot.scene.getObjectByName("second") as Mesh;
    const shared = first.geometry;
    expect(second.geometry).toBe(shared);
    const next = structuredClone(initial);
    next.style.objectStyles.atomOverrides["Si-0"] = { color: "#ff2200", opacity: 66 };
    next.style.objectStyles.bondOverrides.first = { opacity: 44 };
    next.style.objectStyles.bondFamilyOverrides[source.bonds[1]!.familyKey] = { opacity: 77 };
    const fresh = await createCrystalPathTraceScene(next);
    try {
      expect(snapshot.updateAppearance(next)).toBe(true);
      expect(first.geometry === shared).toBe(false);
      expect(second.geometry === shared).toBe(true);
      expect(first.geometry.userData.pathTracingCylinder).toBe(true);
      expect(first.geometry.getAttribute("color").itemSize).toBe(4);
      expect(snapshotContents(snapshot)).toEqual(snapshotContents(fresh));
      const unchanged = first.geometry;
      expect(snapshot.updateAppearance(structuredClone(next))).toBe(true);
      expect(first.geometry === unchanged && second.geometry === shared).toBe(true);
      expect(snapshot.updateAppearance(initial)).toBe(true);
      expect(first.geometry === shared && second.geometry === shared).toBe(true);
      expect(collectTracePrimitives(snapshot.scene).filter(item => item.kind === "cylinder").every(item => !item.capped)).toBe(true);
    } finally { fresh.dispose(); snapshot.dispose(); }
  });

  test("rejects geometry, zero-opacity and visibility changes without partially committing materials", async () => {
    const initial = optionsFor(sceneWithOffCenterAtoms());
    initial.style.materialPreset = "pbr-ceramic";
    initial.scene.bonds = [bond("bond", 0, 1)];
    const snapshot = await createCrystalPathTraceScene(initial);
    const before = snapshotContents(snapshot);
    const changes: ((next: CrystalPathTraceSceneOptions) => void)[] = [
      next => { next.scene.atoms[0]!.position[0] += 0.1; },
      next => { next.style.atomRadius += 3; },
      next => { next.style.objectStyles.atomOverrides["Si-0"] = { radius: 0.123 }; },
      next => { next.style.objectStyles.bondOverrides.bond = { radius: 0.31 }; },
      next => { next.style.objectStyles.atomOverrides["Si-0"] = { visible: false }; },
      next => { next.style.objectStyles.atomOverrides["Si-0"] = { opacity: 0 }; },
      next => { next.componentOpacity.bonds = 0; },
      next => { next.componentOpacity.polyhedra = 40; },
      next => { next.style.bondColorMode = "unicolor"; },
      next => { next.showAtoms = false; },
      next => { next.unitCellLineStyle = "dashed"; },
      next => { next.groupPosition[0] += 1; },
    ];
    try {
      for (const change of changes) {
        const next = structuredClone(initial); next.style.materialPreset = "pbr-glass"; change(next);
        expect(snapshot.updateAppearance(next)).toBe(false);
        expect(snapshotContents(snapshot)).toEqual(before);
      }
      const controller = new AbortController(); controller.abort();
      expect(() => snapshot.updateAppearance({ ...initial, signal: controller.signal })).toThrow();
      expect(snapshotContents(snapshot)).toEqual(before);
    } finally { snapshot.dispose(); }
  });

  test("uploads material indices and endpoint colors without refitting unchanged primitive bounds", async () => {
    const source = sceneWithOffCenterAtoms(); source.bonds = [bond("bond", 0, 1)];
    const initial = optionsFor(source); initial.style.materialPreset = "pbr-ceramic";
    const snapshot = await createCrystalPathTraceScene(initial);
    const { PhysicalPathTracingMaterial } = PathTracerLibrary as unknown as { PhysicalPathTracingMaterial: new () => ShaderMaterial };
    const material = new PhysicalPathTracingMaterial(), prefix = new MeshPhysicalMaterial(), merged = new BufferGeometry();
    let resets = 0;
    const tracer = { _materials: [prefix], _pathTracer: { material }, updateMaterials() {}, reset() { resets++; } } as unknown as WebGLPathTracer;
    const primitives = collectTracePrimitives(snapshot.scene), packed = packTracePrimitives(tracer, primitives);
    const bvh = PrimitiveBVH.buildPrimitiveBVH(packed.primitives, packed.bounds);
    const installed = installPrimitiveGeometry(tracer, bvh.nodes, bvh.nodeCount, packed.extraData, 4096, false);
    const update = createPrimitiveSceneUpdater(tracer, snapshot.scene, primitives, merged, bvh.nodes, installed, true);
    const refit = spyOn(PrimitiveBVH, "refitPrimitiveBVH");
    try {
      const before = bvh.nodes.slice(), next = structuredClone(initial);
      next.style.objectStyles.atomOverrides["Si-0"] = { color: "#ff0000" };
      expect(snapshot.updateAppearance(next)).toBe(true);
      expect(update(snapshot.scene)).toBe(true);
      expect(refit).toHaveBeenCalledTimes(0);
      expect(resets).toBe(1);
      for (let i = 0; i < before.length; i++) {
        if (i % 8 === 4 && before[i - 1] !== 0) continue;
        expect(bvh.nodes[i]).toBe(before[i]);
      }
      const texture = material.uniforms.crystalPrimitiveNodes!.value as DataTexture;
      const data: unknown = texture.image.data;
      if (!(data instanceof Float32Array)) throw new Error("Expected the packed primitive float texture");
      expect(Array.from(data.subarray(bvh.nodes.length + 4, bvh.nodes.length + 7))).toEqual([1, 0, 0]);
      (snapshot.scene.getObjectByName("Si-0") as Mesh).scale.multiplyScalar(1.1);
      snapshot.scene.updateMatrixWorld(true);
      expect(update(snapshot.scene)).toBe(true);
      expect(refit).toHaveBeenCalledTimes(1);
      expect(resets).toBe(2);
    } finally { refit.mockRestore(); installed.dispose(); material.dispose(); prefix.dispose(); merged.dispose(); snapshot.dispose(); }
  });

  test("rejects changed triangle geometry on the same mesh, including in-place attribute updates", () => {
    const scene = new Scene();
    const geometry = new BufferGeometry().setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    const mesh = new Mesh(geometry, new MeshPhysicalMaterial()); mesh.name = "triangle"; scene.add(mesh);
    const merged = geometry.clone().setAttribute("materialIndex", new BufferAttribute(new Uint32Array(3), 1));
    merged.addGroup(0, 3, 0);
    let uploads = 0;
    const materials = [mesh.material];
    const tracer = { _materials: materials, _pathTracer: { material: { materialIndexAttribute: { updateFrom() {} } } }, updateMaterials() {} } as unknown as WebGLPathTracer;
    const installed = { update() { uploads++; }, dispose() {}, restore() {} };
    const update = createPrimitiveSceneUpdater(tracer, scene, [], merged, new Float32Array(), installed, true);
    const replacement = geometry.clone(); replacement.getAttribute("position").setX(0, 0.4);
    try {
      mesh.geometry = replacement;
      expect(update(scene)).toBe(false);
      expect(uploads).toBe(0);
      expect((tracer as unknown as { _materials: MeshPhysicalMaterial[] })._materials).toBe(materials);
      mesh.geometry = geometry;
      geometry.getAttribute("position").setX(0, 0.2); geometry.getAttribute("position").needsUpdate = true;
      expect(update(scene)).toBe(false);
      expect(uploads).toBe(0);
    } finally { geometry.dispose(); replacement.dispose(); merged.dispose(); mesh.material.dispose(); }
  });

  test("packs actual atom and two-tone bond snapshots without changing identities, dimensions, colors or triangle material indices", async () => {
    const source = sceneWithOffCenterAtoms();
    source.atoms = [atom("Si-0", [0, 0, 0]), atom("Si-1", [1, 2, 0.5])];
    source.bonds = [bond("colored-bond", 0, 1)];
    const options = optionsFor(source);
    options.style.materialPreset = "pbr-glass";
    options.style.objectStyles.atomOverrides = { "Si-0": { color: "#ff0000", radius: 0.63, opacity: 42 }, "Si-1": { color: "#0000ff" } };
    const sourceBefore = JSON.stringify({ source, style: options.style });
    const snapshot = await createCrystalPathTraceScene(options);
    const prefix = new MeshPhysicalMaterial();
    try {
      const primitives = collectTracePrimitives(snapshot.scene);
      expect(primitives.map(primitive => primitive.kind)).toEqual(["sphere", "sphere", "cylinder"]);
      expect(hasTriangleMeshes(snapshot.scene, primitives)).toBe(false);
      expect(collectTracePrimitives(snapshot.scene, false)).toHaveLength(2);
      const materials = [prefix];
      let updates = 0;
      const tracer = { _materials: materials, updateMaterials() { updates++; } } as unknown as WebGLPathTracer;
      const packed = packTracePrimitives(tracer, primitives);
      expect(materials[0]).toBe(prefix);
      expect(updates).toBe(1);
      expect(materials).toEqual([prefix, ...primitives.map(primitive => primitive.mesh.material)]);
      expect(Array.from(packed.primitives.subarray(0, 6))).toEqual([2, 3, 4, Math.fround(0.63), 1, -1]);
      expect(primitives[0]!.mesh.material.opacity).toBe(0.42);
      const cylinder = primitives[2]!;
      expect(cylinder.kind).toBe("cylinder");
      if (cylinder.kind !== "cylinder") throw new Error("Missing analytic bond");
      expect(cylinder.capped).toBe(false);
      expect(cylinder.halfLength).toBeCloseTo(Math.sqrt(5.25) / 2);
      expect(Array.from(packed.extraData.subarray(4, 8))).toEqual([1, 0, 0, 0]);
      expect(Array.from(packed.extraData.subarray(8, 11))).toEqual([0, 0, 1]);
      const axis = new Vector3().fromArray(cylinder.axis).normalize();
      const radial = new Vector3(0, 0, 1).cross(axis).normalize();
      const otherRadial = axis.clone().cross(radial);
      for (const sign of [-1, 1]) for (let step = 0; step < 16; step++) {
        const angle = step * Math.PI / 8;
        const point = new Vector3().fromArray(cylinder.center).addScaledVector(axis, sign * cylinder.halfLength)
          .addScaledVector(radial, cylinder.radius * Math.cos(angle)).addScaledVector(otherRadial, cylinder.radius * Math.sin(angle));
        point.toArray().forEach((value, coordinate) => {
          expect(value).toBeGreaterThanOrEqual(packed.bounds[12 + coordinate]!);
          expect(value).toBeLessThanOrEqual(packed.bounds[15 + coordinate]!);
        });
      }
      expect(primitives.every(primitive => primitive.mesh.visible)).toBe(true);
      expect(JSON.stringify({ source, style: options.style })).toBe(sourceBefore);
    } finally { snapshot.dispose(); prefix.dispose(); }
  });

  test("leaves textured, deformed, flat, partial and non-circular geometry in the original triangle path", () => {
    const scene = new Scene();
    const sphere = () => {
      const mesh = new Mesh(new SphereGeometry(1, 8, 6), new MeshPhysicalMaterial());
      mesh.userData.kind = "atom"; scene.add(mesh); return mesh;
    };
    const accepted = sphere();
    const hidden = sphere(); hidden.visible = false;
    const stretched = sphere(); stretched.scale.y = 2;
    const flat = sphere(); flat.material.flatShading = true;
    const colored = sphere(); colored.material.vertexColors = true;
    const textured = sphere(); textured.material.map = new Texture();
    const morphed = sphere(); morphed.geometry.morphAttributes.position = [morphed.geometry.attributes.position!.clone()];
    const sheared = sphere(); sheared.matrixAutoUpdate = false;
    sheared.matrix.set(1, 0.2, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    const cone = new Mesh(new CylinderGeometry(0.5, 1, 2, 8), new MeshPhysicalMaterial());
    cone.userData.kind = "bond"; scene.add(cone);
    const partial = new Mesh(new CylinderGeometry(1, 1, 2, 8, 1, false, 0, Math.PI), new MeshPhysicalMaterial());
    partial.userData.kind = "bond"; scene.add(partial);
    const instanced = new InstancedMesh(new SphereGeometry(1, 8, 6), new MeshPhysicalMaterial(), 2);
    instanced.userData.kind = "atom"; scene.add(instanced);
    try {
      expect(collectTracePrimitives(scene).map(primitive => primitive.mesh)).toEqual([accepted]);
      expect(hasTriangleMeshes(scene, collectTracePrimitives(scene))).toBe(true);
      expect(hidden.visible).toBe(false);
      expect(stretched.scale.toArray()).toEqual([1, 2, 1]);
    } finally {
      textured.material.map.dispose();
      scene.children.forEach(object => { const mesh = object as Mesh; mesh.geometry.dispose(); (mesh.material as MeshPhysicalMaterial).dispose(); });
    }
  });

  test("includes capped cell and polyhedron-edge cylinders but never drops a remaining mesh or visible child", () => {
    const scene = new Scene();
    const meshes = ["unit-cell", "polyhedron-edge"].map(kind => {
      const mesh = new Mesh(new CylinderGeometry(1, 1, 1, 8), new MeshPhysicalMaterial({ color: 0, opacity: 0.95, transparent: true }));
      mesh.userData.kind = kind; mesh.scale.set(0.02, 3, 0.02); scene.add(mesh); return mesh;
    });
    try {
      const primitives = collectTracePrimitives(scene);
      expect(primitives).toHaveLength(2);
      expect(primitives.every(primitive => primitive.kind === "cylinder" && primitive.capped && primitive.halfLength === 1.5)).toBe(true);
      expect(hasTriangleMeshes(scene, primitives)).toBe(false);
      expect(primitives[0]!.mesh.material).toBe(meshes[0]!.material);
      meshes[0]!.material.flatShading = true;
      expect(hasTriangleMeshes(scene, collectTracePrimitives(scene))).toBe(true);
      meshes[0]!.material.flatShading = false;
      scene.remove(meshes[1]!); meshes[0]!.add(meshes[1]!);
      expect(collectTracePrimitives(scene).some(primitive => primitive.mesh === meshes[0])).toBe(false);
      expect(hasTriangleMeshes(scene, collectTracePrimitives(scene))).toBe(true);
    } finally { meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); }); }
  });

  test("rolls back the real vendor shader and owned texture when primitive shader installation throws", () => {
    const { PhysicalPathTracingMaterial } = PathTracerLibrary as unknown as { PhysicalPathTracingMaterial: new () => ShaderMaterial };
    const material = new PhysicalPathTracingMaterial();
    const original = material.fragmentShader;
    const fault = new Error("forced compilation listener failure");
    (material as unknown as { addEventListener(type: string, listener: () => void): void })
      .addEventListener("recompilation", () => { throw fault; });
    const dispose = spyOn(DataTexture.prototype, "dispose");
    try {
      const tracer = { _pathTracer: { material } } as unknown as WebGLPathTracer;
      expect(() => installPrimitiveGeometry(tracer, new Float32Array([0, 0, 0, 1, 0, 0, -1, 1]), 1, new Float32Array(), 4096)).toThrow(fault);
      expect(material.fragmentShader).toBe(original);
      expect(material.uniforms.crystalPrimitiveNodes).toBeUndefined();
      expect(material.uniforms.crystalPrimitiveNodeCount).toBeUndefined();
      expect(material.defines.CRYSTAL_HAS_TRIANGLES).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { dispose.mockRestore(); material.dispose(); }
  });

  test("carries every new PBR preset and the owned thin-film range into traced materials without changing color or geometry", async () => {
    const scene = sceneWithOffCenterAtoms();
    scene.atoms = [atom("Si-0", [0, 0, 0]), atom("Si-1", [0, 2, 0])];
    scene.bonds = [bond("colored-bond", 0, 1)];
    const sceneBefore = JSON.stringify(scene);
    let triangleCount: number | undefined;
    for (const presetId of PHYSICAL_MATERIAL_PRESET_IDS.slice(4)) {
      const options = optionsFor(scene);
      options.style.materialPreset = presetId;
      options.style.objectStyles.atomOverrides = { "Si-0": { color: "#9eafcb", radius: 0.63 }, "Si-1": { color: "#559988" } };
      const styleBefore = JSON.stringify(options.style);
      const props = materialPresetById(presetId).material.props;
      const snapshot = await createCrystalPathTraceScene(options);
      try {
        const atomMesh = snapshot.scene.getObjectByName("Si-0") as Mesh;
        const material = atomMesh.material as MeshPhysicalMaterial;
        expect(material.color.getHexString()).toBe("9eafcb");
        expect(atomMesh.scale.toArray()).toEqual([0.63, 0.63, 0.63]);
        expect(atomMesh.getWorldPosition(new Vector3()).toArray()).toEqual(options.groupPosition);
        expect(material.opacity).toBe(1);
        expect(material.transparent).toBe(false);
        for (const [key, value] of Object.entries(props)) {
          const actual = (material as unknown as Record<string, unknown>)[key];
          if (typeof value === "number") expect(actual).toBe(value);
          else if (actual instanceof Color) expect(actual.getHexString()).toBe("ffffff");
          else if (key === "iridescenceThicknessRange") {
            expect(actual).toEqual(value);
            expect(actual).not.toBe(value);
          }
        }
        const tracedBond = snapshot.scene.getObjectByName("colored-bond") as Mesh;
        const colors = tracedBond.geometry.getAttribute("color");
        expect(new Color().fromBufferAttribute(colors, 0).getHexString()).toBe("9eafcb");
        expect(new Color().fromBufferAttribute(colors, colors.count - 1).getHexString()).toBe("559988");
        triangleCount ??= snapshot.triangleCount;
        expect(snapshot.triangleCount).toBe(triangleCount);
        expect(JSON.stringify(scene)).toBe(sceneBefore);
        expect(JSON.stringify(options.style)).toBe(styleBefore);
      } finally { snapshot.dispose(); }
    }
  });

  test("uses the selected export mesh quality independently of sampling while preserving preview detail", async () => {
    const scene = sceneWithOffCenterAtoms();
    scene.atoms = [atom("Si-0", [0, 0, 0]), atom("Si-1", [0, 2, 0])];
    scene.bonds = [bond("bond", 0, 1)];
    const options = optionsFor(scene);
    options.style.bondColorMode = "unicolor";
    const preview = await createCrystalPathTraceScene(options);
    try {
      const sphere = (preview.scene.getObjectByName("Si-0") as Mesh).geometry as SphereGeometry;
      expect([sphere.parameters.widthSegments, sphere.parameters.heightSegments]).toEqual([24, 16]);
    } finally { preview.dispose(); }
    for (const meshDetail of Object.values(EXPORT_SCENE_MESH_DETAIL_PRESETS)) {
      const snapshot = await createCrystalPathTraceScene({ ...options, meshDetail });
      try {
        const sphere = (snapshot.scene.getObjectByName("Si-0") as Mesh).geometry as SphereGeometry;
        const cylinder = (snapshot.scene.getObjectByName("bond") as Mesh).geometry as CylinderGeometry;
        expect([sphere.parameters.widthSegments, sphere.parameters.heightSegments])
          .toEqual([meshDetail.sphereWidthSegments, meshDetail.sphereHeightSegments]);
        expect(cylinder.parameters.radialSegments).toBe(meshDetail.bondRadialSegments);
        expect(options.quality).toBe("draft");
      } finally { snapshot.dispose(); }
    }
  });

  test("preserves periodic atom identity, actual radii, opacity and the bond's two colored halves", async () => {
    const scene = sceneWithOffCenterAtoms();
    scene.atoms = [
      { ...atom("Si-0", [0, 0, 0]), sourceAtomNumber: 17 },
      { ...atom("Si-1-image", [0, 2, 0]), sourceAtomNumber: 18, isPeriodicImage: true, imageOffset: [0, 1, 0] },
      atom("hidden", [9, 9, 9]),
    ];
    scene.bonds = [bond("colored-bond", 0, 1)];
    const options = optionsFor(scene);
    options.style.objectStyles.atomOverrides = {
      "Si-0": { color: "#ff0000", radius: 0.63, opacity: 42 },
      "Si-1-image": { color: "#0000ff", radius: 0.37 },
      hidden: { opacity: 0 },
    };
    options.style.objectStyles.bondOverrides = { "colored-bond": { radius: 0.19, opacity: 65 } };
    const original = JSON.stringify({ scene, style: options.style });
    const snapshot = await createCrystalPathTraceScene(options);
    try {
      const first = snapshot.scene.getObjectByName("Si-0") as Mesh;
      const image = snapshot.scene.getObjectByName("Si-1-image") as Mesh;
      const tracedBond = snapshot.scene.getObjectByName("colored-bond") as Mesh;
      expect(first.getWorldPosition(new Vector3()).toArray()).toEqual([2, 3, 4]);
      expect(first.scale.x).toBeCloseTo(0.63);
      expect(first.material).toBeInstanceOf(MeshPhysicalMaterial);
      expect((first.material as MeshPhysicalMaterial).opacity).toBeCloseTo(0.42);
      expect(first.userData.sourceAtomNumber).toBe(17);
      expect(image.getWorldPosition(new Vector3()).toArray()).toEqual([2, 5, 4]);
      expect(image.userData.imageOffset).toEqual([0, 1, 0]);
      expect(image.userData.isPeriodicImage).toBe(true);
      expect(snapshot.scene.getObjectByName("hidden")).toBeUndefined();
      expect(new Vector3(0, -0.5, 0).applyMatrix4(tracedBond.matrixWorld).toArray()).toEqual([2, 3, 4]);
      expect(new Vector3(0, 0.5, 0).applyMatrix4(tracedBond.matrixWorld).toArray()).toEqual([2, 5, 4]);
      expect(tracedBond.scale.x).toBeCloseTo(0.19);
      expect((tracedBond.material as MeshPhysicalMaterial).opacity).toBeCloseTo(0.65);
      const colors = tracedBond.geometry.getAttribute("color");
      expect(colors.itemSize).toBe(4);
      expect(new Color().fromBufferAttribute(colors, 0).getHexString()).toBe("ff0000");
      expect(new Color().fromBufferAttribute(colors, colors.count - 1).getHexString()).toBe("0000ff");
      expect(JSON.stringify({ scene, style: options.style })).toBe(original);
    } finally { snapshot.dispose(); snapshot.dispose(); }
  });

  test("merges colored bonds and uncolored spheres into a consistent upstream RGBA buffer", async () => {
    const scene = sceneWithOffCenterAtoms();
    scene.atoms = [atom("Si-0", [0, 0, 0]), atom("Si-1", [0, 2, 0])];
    scene.bonds = [bond("colored-bond", 0, 1)];
    const options = optionsFor(scene);
    options.style.materialPreset = "pbr-ceramic";
    const snapshot = await createCrystalPathTraceScene(options);
    const generator = new PathTracingSceneGenerator(snapshot.scene);
    generator.generateBVH = false;
    try {
      const result = generator.generate();
      const geometry = result.geometry;
      expect(geometry.getAttribute("color").itemSize).toBe(4);
      expect(geometry.getAttribute("color").count).toBe(geometry.getAttribute("position").count);
      expect([...geometry.getAttribute("color").array].every(Number.isFinite)).toBe(true);
      geometry.dispose();
    } finally { snapshot.dispose(); }
  });

  test("keeps flat polyhedron facets and converts shared edges and the twelve cell lines once", async () => {
    const scene = sceneWithOffCenterAtoms();
    scene.polyhedra = [tetrahedronPolyhedron(), tetrahedronPolyhedron()];
    const options = optionsFor(scene);
    options.showAtoms = false;
    options.showUnitCell = true;
    options.componentOpacity.polyhedra = 40;
    options.componentOpacity.unitCell = 100;
    const snapshot = await createCrystalPathTraceScene(options);
    try {
      const meshes: Mesh[] = [];
      snapshot.scene.traverse(object => { if (object instanceof Mesh) meshes.push(object); });
      const surfaces = meshes.filter(mesh => mesh.userData.kind === "polyhedron");
      const edges = meshes.filter(mesh => mesh.userData.kind === "polyhedron-edge");
      expect(surfaces).toHaveLength(1);
      expect(edges).toHaveLength(6);
      expect(meshes.filter(mesh => mesh.userData.kind === "unit-cell")).toHaveLength(12);
      const normals = surfaces[0]!.geometry.getAttribute("normal");
      expect(normals.count).toBe(12);
      for (let index = 0; index < normals.count; index += 3) {
        const first = new Vector3().fromBufferAttribute(normals, index);
        expect(first.distanceTo(new Vector3().fromBufferAttribute(normals, index + 1))).toBeLessThan(1e-6);
        expect(first.distanceTo(new Vector3().fromBufferAttribute(normals, index + 2))).toBeLessThan(1e-6);
      }
      expect(edges.every(mesh => mesh.scale.x === options.polyhedronEdgeRadius)).toBe(true);
      expect(snapshot.scene.userData.studioRadius).toBeGreaterThanOrEqual(5);
    } finally { snapshot.dispose(); }
    const dashed = await createCrystalPathTraceScene({ ...options, unitCellLineStyle: "dashed" });
    try {
      const dashes: Mesh[] = [];
      dashed.scene.traverse(object => { if (object instanceof Mesh && object.userData.kind === "unit-cell") dashes.push(object); });
      expect(dashes.length).toBeGreaterThan(12);
      expect(dashes.every(mesh => mesh.scale.y <= 0.080001 && mesh.scale.y > 0)).toBe(true);
      expect(dashes[0]!.scale.y).toBeCloseTo(0.08, 6);
      expect(dashes[0]!.position.distanceTo(dashes[1]!.position)).toBeCloseTo(0.11, 6);
    } finally { dashed.dispose(); }
  });

  test("cancels between preparation batches and rejects geometry above the trace budget", async () => {
    const scene = sceneWithOffCenterAtoms();
    scene.atoms = Array.from({ length: 600 }, (_, index) => atom(`Si-${index}`, [index, 0, 0]));
    const controller = new AbortController();
    const pending = createCrystalPathTraceScene({ ...optionsFor(scene), signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(createCrystalPathTraceScene({ ...optionsFor(scene), quality: "high" }))
      .rejects.toMatchObject({ name: "PathTracingSceneError", code: "geometry-limit" });
  });
});

function tetrahedronPolyhedron(): SceneSpec["polyhedra"][number] {
  return {
    centerAtomIndex: 0,
    hullAtomIndices: [0, 1, 2, 3],
    faces: [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ],
    visibilityDependencies: [],
    visibilityDependencyGroups: [],
  };
}

function firstTriangleNormalDotVertexNormal(
  geometry: ReturnType<typeof twoToneBondCylinderGeometry>,
) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const index = geometry.index;

  expect(index).not.toBeNull();

  const a = index!.getX(0);
  const b = index!.getX(1);
  const c = index!.getX(2);
  const pointA = new Vector3(
    position.getX(a),
    position.getY(a),
    position.getZ(a),
  );
  const pointB = new Vector3(
    position.getX(b),
    position.getY(b),
    position.getZ(b),
  );
  const pointC = new Vector3(
    position.getX(c),
    position.getY(c),
    position.getZ(c),
  );
  const faceNormal = pointB.sub(pointA).cross(pointC.sub(pointA)).normalize();
  const vertexNormal = new Vector3(
    normal.getX(a),
    normal.getY(a),
    normal.getZ(a),
  );

  return faceNormal.dot(vertexNormal);
}

function sceneWithOffCenterAtoms(): SceneSpec {
  return {
    atoms: [
      atom("Si-0", [0.1, 0.1, 0.1]),
      atom("Si-1", [0.3, 0.1, 0.1]),
      atom("Si-2", [0.1, 0.3, 0.1]),
      atom("Si-3", [0.1, 0.1, 0.3]),
    ],
    bonds: [],
    bondFamilies: [],
    polyhedra: [],
    cell: {
      vectors: [
        [4, 0, 0],
        [1, 3, 0],
        [0, 0, 2],
      ],
    },
    summary: {
      atomCount: 4,
      cell: {
        a: "4.00",
        alpha: "90.00",
        b: "3.16",
        beta: "90.00",
        c: "2.00",
        gamma: "71.57",
      },
      formula: "Si",
      symmetry: {
        available: false,
        crystalSystem: null,
        latticeSystem: null,
        pointGroup: null,
        pointGroupSchoenflies: null,
        spaceGroup: null,
        spaceGroupNumber: null,
      },
    },
  };
}

function sceneWithMeasurementAtoms(): SceneSpec {
  return {
    ...sceneWithOffCenterAtoms(),
    atoms: [atom("a", [-10, 0, 0]), atom("b", [0, 0, 0]), atom("c", [10, 0, 0])],
    cell: { vectors: [[20, 0, 0], [0, 20, 0], [0, 0, 20]] },
  };
}

function sceneWithExportVisibilityAtoms(): SceneSpec {
  return {
    atoms: [
      atom("Na-0", [0, 0, 0]),
      {
        ...atom("Na-0-boundary", [1, 0, 0]),
        imageOffset: [1, 0, 0],
        imageReasons: ["boundary"],
        isPeriodicImage: true,
        visibilityDependencies: ["boundaryAtoms"],
        visibilityDependencyGroups: [["boundaryAtoms"]],
      },
      {
        ...atom("Cl-1-one-hop", [0, -2, 0]),
        imageOffset: [0, -1, 0],
        imageReasons: ["bonded"],
        isPeriodicImage: true,
        visibilityDependencies: ["oneHopBondedAtoms"],
        visibilityDependencyGroups: [["oneHopBondedAtoms"]],
      },
    ],
    bonds: [],
    bondFamilies: [],
    cell: {
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    },
    polyhedra: [],
    summary: {
      atomCount: 1,
      cell: {
        a: "1.00",
        alpha: "90.00",
        b: "1.00",
        beta: "90.00",
        c: "1.00",
        gamma: "90.00",
      },
      formula: "NaCl",
      symmetry: {
        available: false,
        crystalSystem: null,
        latticeSystem: null,
        pointGroup: null,
        pointGroupSchoenflies: null,
        spaceGroup: null,
        spaceGroupNumber: null,
      },
    },
  };
}

function sceneWithLongCell(): SceneSpec {
  return {
    ...sceneWithOffCenterAtoms(),
    atoms: [atom("Si-0", [0, 0, 0]), atom("Si-1", [10, 0, 0])],
    cell: {
      vectors: [
        [10, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    },
    summary: {
      ...sceneWithOffCenterAtoms().summary,
      atomCount: 2,
    },
  };
}

function sceneWithLongC(): SceneSpec {
  return {
    ...sceneWithOffCenterAtoms(),
    atoms: [atom("Si-0", [0, 0, 0]), atom("Si-1", [0, 0, 10])],
    cell: {
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 10],
      ],
    },
    summary: {
      ...sceneWithOffCenterAtoms().summary,
      atomCount: 2,
    },
  };
}

function exportFramePlanWithBounds(
  contentWidth: number,
  contentHeight: number,
  supersampling = 1,
): StructureExportFramePlan {
  return {
    aspectRatio: contentWidth / contentHeight,
    bounds: {
      centerX: contentWidth / 2,
      centerY: contentHeight / 2,
      height: contentHeight,
      maxX: contentWidth,
      maxY: contentHeight,
      minX: 0,
      minY: 0,
      width: contentWidth,
    },
    centerX: contentWidth / 2,
    centerY: contentHeight / 2,
    height: contentHeight * supersampling,
    width: contentWidth * supersampling,
    zoom: supersampling,
  };
}

function atom(id: string, position: [number, number, number]): AtomSpec {
  const siteIndex = Number(id.match(/-(\d+)/)?.[1] ?? 0);
  return {
    element: "Si",
    fractionalPosition: [0, 0, 0],
    id,
    imageOffset: [0, 0, 0],
    isPeriodicImage: false,
    imageReasons: [],
    visibilityDependencies: [],
    visibilityDependencyGroups: [],
    position,
    siteId: id,
    siteIndex,
  };
}

function bond(
  id: string,
  startAtomIndex: number,
  endAtomIndex: number,
): BondSpec {
  return {
    endAtomIndex,
    endImageOffset: [0, 0, 0],
    endSiteId: `Si-${endAtomIndex}`,
    familyKey: "Si-Si",
    id,
    length: 1,
    relationId: id,
    relativeImageOffset: [0, 0, 0],
    startAtomIndex,
    startImageOffset: [0, 0, 0],
    startSiteId: `Si-${startAtomIndex}`,
    visibilityDependencies: [],
    visibilityDependencyGroups: [],
  };
}
