import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrthographicCamera, Quaternion, Vector3 } from "three";

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
import { exportFogColor } from "../src/scene/ExportSceneContent";
import {
  applyOrthographicFrustum,
  computeCameraFitZoom,
  computeOrthographicFrustum,
  computeStandardCameraPose,
} from "../src/scene/viewMath";
import { computeOrientationGizmoAxes } from "../src/scene/orientationGizmoMath";

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
