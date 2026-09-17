import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  combinedLayerBounds,
  composeCombinedExportRaster,
  currentFigureExportMargins,
  defaultFigureExportLayout,
  figureExportLayerOffset,
  layoutCombinedExport,
  offsetTextItems,
  prepareCombinedExportLayers,
  structureExportLayers,
  structureOnlyFigureExportLayout,
  withFigureExportLayerOffset,
  type PreparedCombinedExport,
} from "../src/export/combinedExportRaster";
import { createDefaultExportSettings, isFigureExportLayout } from "../src/model/exportSettings";
import type { RasterExportImage } from "../src/scene/exportRenderer";
import type { SceneSpec } from "../src/api/scene";
import { createDefaultComponentOpacity, createDefaultComponentVisibility, createDefaultStyle,
  DEFAULT_STRUCTURE_LINE_WIDTH } from "../src/model";
import * as structureRasterExport from "../src/export/structureRasterExport";
import * as legendExport from "../src/export/legendExport";

describe("combined export layout", () => {
  test("expands output bounds around accessory layers", () => {
    const bounds = combinedLayerBounds(
      [
        {
          image: rasterImage(200, 160),
          textItems: [],
          x: 0,
          y: 0,
        },
        {
          image: rasterImage(48, 48),
          textItems: [],
          x: -64,
          y: 120,
        },
        {
          image: rasterImage(100, 24),
          textItems: [],
          x: 50,
          y: 180,
        },
      ],
      200,
      160,
    );

    expect(bounds).toEqual({
      height: 204,
      maxX: 200,
      maxY: 204,
      minX: -64,
      minY: 0,
      width: 264,
    });
  });

  test("offsets vector text items for PDF layer placement", () => {
    expect(
      offsetTextItems(
        [
          {
            fontStyle: "italic",
            fontWeight: 500,
            label: "a",
            size: 24,
            x: 10,
            y: 20,
          },
        ],
        32,
        -8,
      ),
    ).toEqual([
      {
        fontStyle: "italic",
        fontWeight: 500,
        label: "a",
        size: 24,
        x: 42,
        y: 12,
      },
    ]);
  });

  test("moves accessories without changing the structure or prepared raster data", () => {
    const prepared = previewLayers();
    const layout = { ...defaultFigureExportLayout(), legend: { x: 0.2, y: -0.25 }, crystalAxes: { x: 0.4, y: -0.1 } };
    const placed = layoutCombinedExport(prepared, layout);
    expect(placed.layers.map(({ x, y }) => [x, y])).toEqual([[0, 0], [90, 140], [16, 104]]);
    expect(prepared.layers.map(({ x, y }) => [x, y])).toEqual([[0, 0], [50, 180], [-64, 120]]);
    expect(placed.layers[0]!.image).toBe(prepared.layers[0]!.image);
    expect(placed.layers[1]!.textItems).toBe(prepared.layers[1]!.textItems);
    expect(offsetTextItems(placed.layers[1]!.textItems, placed.layers[1]!.x - placed.bounds.minX,
      placed.layers[1]!.y - placed.bounds.minY)[0]).toMatchObject({ x: 98, y: 152 });
  });

  test("reduces original blank space using content bounds and adds independent margins", () => {
    const prepared = previewLayers();
    const margins = { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 };
    const placed = layoutCombinedExport(prepared, { ...defaultFigureExportLayout(), margins });
    expect(placed.contentBounds).toEqual({ minX: -64, minY: 20, maxX: 180, maxY: 204, width: 244, height: 184 });
    expect(placed.bounds).toEqual({ minX: -128, minY: 4, maxX: 212, maxY: 252, width: 340, height: 248 });
    expect(currentFigureExportMargins(prepared)).toEqual({ top: 0.125, right: 0.125, bottom: 0, left: 0 });
    expect(currentFigureExportMargins(prepared, { ...defaultFigureExportLayout(), margins })).toBe(margins);
    const cropped = layoutCombinedExport(prepared, { ...defaultFigureExportLayout(), margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(cropped.bounds).toEqual(placed.contentBounds);
  });

  test("rejects invalid manual layout coordinates before canvas allocation", () => {
    expect(() => layoutCombinedExport(previewLayers(), { ...defaultFigureExportLayout(), legend: { x: NaN, y: 0 } })).toThrow();
    expect(() => layoutCombinedExport(previewLayers(), { ...defaultFigureExportLayout(), margins: { top: -1, right: 0, bottom: 0, left: 0 } })).toThrow();
  });

  test("splits measurement text into independent raster layers without mutating or retaining a nested label payload", () => {
    const image = measuredRasterImage();
    const layers = structureExportLayers(image);
    expect(layers.map(layer => layer.id)).toEqual(["structure", "measurement:distance-1", "measurement:angle-1"]);
    expect(layers.map(layer => layer.label)).toEqual([undefined, "2.450 Å", "109.47°"]);
    expect(layers[0]!.image.blob).toBe(image.blob);
    expect(layers[0]!.image.measurementLabels).toBeUndefined();
    expect(layers[1]!.image).toBe(image.measurementLabels![0]!.image);
    expect(layers[2]!.image).toBe(image.measurementLabels![1]!.image);
    expect(layers.map(layer => layer.textItems)).toEqual([[], [], []]);
    expect(layers.map(({ x, y }) => [x, y])).toEqual([[0, 0], [80, 75], [100, 90]]);
    expect(image.measurementLabels).toHaveLength(2);
  });

  test("updates only the selected layer offset and preserves other labels, accessories and margins", () => {
    const margins = { top: .1, right: .2, bottom: .3, left: .4 };
    const original = { ...defaultFigureExportLayout(), legend: { x: .2, y: .1 }, margins,
      measurementLabels: { "distance-1": { x: .1, y: -.1 } } };
    const offset = { x: -.2, y: .4 };
    const changed = withFigureExportLayerOffset(original, "measurement:angle-1", offset);
    expect(figureExportLayerOffset(changed, "measurement:angle-1")).toEqual(offset);
    expect(figureExportLayerOffset(changed, "measurement:distance-1")).toEqual({ x: .1, y: -.1 });
    expect(figureExportLayerOffset(changed, "legend")).toEqual({ x: .2, y: .1 });
    expect(changed.margins).toBe(margins);
    expect(original.measurementLabels).toEqual({ "distance-1": { x: .1, y: -.1 } });
    expect(changed.measurementLabels!["angle-1"]).not.toBe(offset);
    const movedLegend = withFigureExportLayerOffset(changed, "legend", { x: 0, y: 0 });
    expect(movedLegend.measurementLabels).toBe(changed.measurementLabels);
    expect(figureExportLayerOffset(undefined, "measurement:distance-1")).toEqual({ x: 0, y: 0 });
    expect(figureExportLayerOffset(defaultFigureExportLayout(), "measurement:constructor")).toEqual({ x: 0, y: 0 });
  });

  test("scales normalized measurement offsets with output resolution without changing their prepared rasters", () => {
    const image = measuredRasterImage();
    const prepared = { width: image.width, height: image.height, layers: structureExportLayers(image) };
    const layout = withFigureExportLayerOffset(undefined, "measurement:distance-1", { x: .25, y: -.125 });
    const placed = layoutCombinedExport(prepared, layout);
    expect(placed.layers.map(({ x, y }) => [x, y])).toEqual([[0, 0], [130, 55], [100, 90]]);
    const doubled = { width: 400, height: 320, layers: prepared.layers.map(layer => ({ ...layer,
      x: layer.x * 2, y: layer.y * 2, image: { ...layer.image, width: layer.image.width * 2, height: layer.image.height * 2 },
    })) };
    expect(layoutCombinedExport(doubled, layout).layers[1]).toMatchObject({ x: 260, y: 110 });
    expect(prepared.layers[1]).toMatchObject({ x: 80, y: 75 });
    expect(placed.layers[1]!.image).toBe(prepared.layers[1]!.image);
    expect(layoutCombinedExport(prepared, defaultFigureExportLayout()).layers[1]).toMatchObject({ x: 80, y: 75 });
    const fractional = { ...prepared, layers: prepared.layers.map(layer => layer.id === "measurement:distance-1"
      ? { ...layer, x: 80.25, y: 75.75 } : layer) };
    expect(layoutCombinedExport(fractional).layers[1]).toMatchObject({ x: 80.25, y: 75.75 });
    expect(layoutCombinedExport(fractional, layout).layers[1]).toMatchObject({ x: 130.25, y: 55.75 });
  });

  test("includes labels moved beyond any canvas edge in output bounds and manual margins", () => {
    const image = measuredRasterImage();
    const prepared = { width: image.width, height: image.height, layers: structureExportLayers(image) };
    const layout = withFigureExportLayerOffset(withFigureExportLayerOffset(undefined,
      "measurement:distance-1", { x: -.75, y: -.625 }), "measurement:angle-1", { x: .6, y: .5 });
    const placed = layoutCombinedExport(prepared, layout);
    expect(placed.bounds).toEqual({ minX: -70, minY: -25, maxX: 268, maxY: 184, width: 338, height: 209 });
    expect(placed.contentBounds).toEqual(placed.bounds);
    const padded = layoutCombinedExport(prepared, { ...layout, margins: { top: .1, right: .1, bottom: .1, left: .1 } });
    expect(padded.bounds).toEqual({ minX: -86, minY: -41, maxX: 284, maxY: 200, width: 370, height: 241 });
  });

  test("uses only actual prepared measurement IDs and preserves exports with no label payload", () => {
    const image = rasterImage(200, 160);
    const layers = structureExportLayers(image);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.image).toBe(image);
    const layout = withFigureExportLayerOffset(undefined, "measurement:removed-label", { x: -1000, y: 1000 });
    const withoutLabels = layoutCombinedExport({ width: 200, height: 160, layers }, layout);
    expect(withoutLabels.bounds).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 160, width: 200, height: 160 });
    const current = { width: 200, height: 160, layers: structureExportLayers(measuredRasterImage()) };
    expect(layoutCombinedExport(current, layout)).toEqual(layoutCombinedExport(current));
    expect(structureExportLayers({ ...image, measurementLabels: [] })).toHaveLength(1);
  });

  test("ignores transparent label padding at canvas edges and uses moved ink bounds for expansion and cropping", () => {
    const image: RasterExportImage = { ...measuredRasterImage(), measurementLabels: [{ id: "edge", label: "8.000 Å",
      image: { ...rasterImage(40, 40), contentBounds: { minX: 10, minY: 10, maxX: 30, maxY: 30, width: 20, height: 20 } },
      x: -10, y: -10,
    }] };
    const prepared = { width: 200, height: 160, layers: structureExportLayers(image) };
    const automatic = layoutCombinedExport(prepared);
    expect(automatic.bounds).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 160, width: 200, height: 160 });
    expect(automatic.contentBounds).toEqual({ minX: 0, minY: 0, maxX: 180, maxY: 140, width: 180, height: 140 });
    const moved = withFigureExportLayerOffset(undefined, "measurement:edge", { x: -.1, y: 0 });
    expect(layoutCombinedExport(prepared, moved).bounds).toEqual({ minX: -20, minY: 0, maxX: 200, maxY: 160, width: 220, height: 160 });
    const inside = withFigureExportLayerOffset(undefined, "measurement:edge", { x: .5, y: .5 });
    const cropped = layoutCombinedExport(prepared, { ...inside, margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(cropped.bounds).toEqual({ minX: 20, minY: 20, maxX: 180, maxY: 140, width: 160, height: 120 });
  });

  test("unions precise subpixel vector ink only for PDF without shrinking or changing raster label bounds", () => {
    const rasterBounds = { minX: 10, minY: 10, maxX: 30, maxY: 30, width: 20, height: 20 };
    const image: RasterExportImage = { ...measuredRasterImage(), measurementLabels: [{ id: "edge", label: "109.47°",
      image: { ...rasterImage(40, 40), contentBounds: rasterBounds }, x: -10, y: -10,
      text: { color: "#ff0000", fontWeight: 600, fontSize: 3.4, baselineY: 24, runs: [],
        inkBounds: { minX: 9.95, minY: 10.25, maxX: 29.8, maxY: 30.08, width: 19.85, height: 19.83 } },
    }] };
    const rasterLayers = structureExportLayers(image);
    const pdfLayers = structureExportLayers(image, true);
    expect(rasterLayers[1]!.image).toBe(image.measurementLabels![0]!.image);
    expect(rasterLayers[1]!.image.contentBounds).toBe(rasterBounds);
    expect(pdfLayers[1]!.image.blob).toBe(rasterLayers[1]!.image.blob);
    expect(pdfLayers[1]!.image.contentBounds).toEqual({ minX: 9.95, minY: 10, maxX: 30, maxY: 30.08, width: 20.05, height: 20.08 });
    const layout = { ...defaultFigureExportLayout(), margins: { top: 0, right: 0, bottom: 0, left: 0 } };
    const raster = layoutCombinedExport({ width: 200, height: 160, layers: rasterLayers }, layout);
    const pdf = layoutCombinedExport({ width: 200, height: 160, layers: pdfLayers }, layout);
    expect(raster.bounds).toEqual({ minX: 0, minY: 0, maxX: 180, maxY: 140, width: 180, height: 140 });
    expect(pdf.bounds).toEqual({ minX: -1, minY: 0, maxX: 180, maxY: 140, width: 181, height: 140 });
  });

  test("uses legacy reference bounds for accessory placement without retaining them in moved content bounds", async () => {
    const reference = { minX: 10, minY: 5, maxX: 190, maxY: 150, width: 180, height: 145 };
    const image: RasterExportImage = { ...measuredRasterImage(), accessoryReferenceBounds: reference };
    const renderStructure = spyOn(structureRasterExport, "renderExportRaster").mockResolvedValue(image);
    const legendCanvas = document.createElement("canvas");
    legendCanvas.width = 60;
    legendCanvas.height = 20;
    const renderLegend = spyOn(legendExport, "renderLegendCanvas").mockReturnValue({ canvas: legendCanvas, textItems: [] });
    const toBlob = spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
      callback(new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGd8AAAAASUVORK5CYII=", "base64")], { type: "image/png" }));
    });
    try {
      const scene: SceneSpec = { atoms: [], bonds: [], bondFamilies: [], polyhedra: [],
        cell: { vectors: [[10, 0, 0], [0, 10, 0], [0, 0, 10]] },
        summary: { atomCount: 0, formula: "", cell: { a: "10", b: "10", c: "10", alpha: "90", beta: "90", gamma: "90" },
          symmetry: { available: false, spaceGroup: null, spaceGroupNumber: null, pointGroup: null,
            pointGroupSchoenflies: null, crystalSystem: null, latticeSystem: null } },
      };
      const options = {
        cameraPose: { projection: "orthographic" as const, quaternion: [0, 0, 0, 1] as [number, number, number, number],
          target: [0, 0, 0] as [number, number, number] },
        componentOpacity: createDefaultComponentOpacity(), componentVisibility: createDefaultComponentVisibility(),
        lightStrength: 1, scene, visibleScene: scene, showCrystalAxisLabels: true, style: createDefaultStyle(),
        structureLineWidth: DEFAULT_STRUCTURE_LINE_WIDTH, unitCellLineStyle: "solid" as const,
        settings: { ...createDefaultExportSettings(), width: 200, height: 160,
          components: { structure: true, legend: true, crystalAxes: false } },
      };
      const prepared = await prepareCombinedExportLayers(options);
      expect(prepared.layers.map(layer => layer.id)).toEqual(["structure", "legend", "measurement:distance-1", "measurement:angle-1"]);
      expect(prepared.layers[1]).toMatchObject({ x: 70, y: 163 });
      expect(renderLegend.mock.calls[0]![0].style.fontSize).toBe(7);
      const moved = withFigureExportLayerOffset(undefined, "legend", { x: 0, y: -.5 });
      const cropped = layoutCombinedExport(prepared, { ...moved, margins: { top: 0, right: 0, bottom: 0, left: 0 } });
      expect(cropped.bounds).toEqual(image.contentBounds!);
      const movedLabel = withFigureExportLayerOffset(moved, "measurement:distance-1", { x: -.75, y: 0 });
      expect(layoutCombinedExport(prepared, { ...movedLabel, margins: { top: 0, right: 0, bottom: 0, left: 0 } }).bounds)
        .toEqual({ minX: -70, minY: 20, maxX: 180, maxY: 140, width: 250, height: 120 });
      renderStructure.mockResolvedValue({ ...image, accessoryReferenceBounds: undefined });
      const fallback = await prepareCombinedExportLayers(options);
      expect(fallback.layers[1]).toMatchObject({ x: 70, y: 151 });
      expect(renderLegend.mock.calls[1]![0].style.fontSize).toBe(6);
      renderStructure.mockResolvedValue({ ...image, accessoryReferenceBounds: undefined,
        measurementLabels: image.measurementLabels!.map((label, index) => index === 0 ? { ...label, x: 200 } : label),
      });
      const fallbackWithOutsideLabel = await prepareCombinedExportLayers(options);
      expect(fallbackWithOutsideLabel.layers[1]).toMatchObject({ x: 95, y: 153 });
      expect(renderLegend.mock.calls[2]![0].style.fontSize).toBe(7);
    } finally {
      toBlob.mockRestore();
      renderLegend.mockRestore();
      renderStructure.mockRestore();
    }
  });

  test("separate structure exports retain only measurement offsets and expand only when text leaves the original canvas", () => {
    const layout = { ...defaultFigureExportLayout(), legend: { x: 3, y: 4 }, crystalAxes: { x: -5, y: 6 },
      margins: { top: 2, right: 2, bottom: 2, left: 2 }, measurementLabels: { "distance-1": { x: .1, y: .1 } } };
    const separate = structureOnlyFigureExportLayout(layout)!;
    expect(separate).toEqual({ ...defaultFigureExportLayout(), measurementLabels: layout.measurementLabels });
    expect(separate.measurementLabels).not.toBe(layout.measurementLabels);
    expect(separate.measurementLabels!["distance-1"]).not.toBe(layout.measurementLabels["distance-1"]);
    const prepared = { width: 200, height: 160, layers: structureExportLayers(measuredRasterImage()) };
    expect(layoutCombinedExport(prepared, separate).bounds).toMatchObject({ width: 200, height: 160 });
    const outside = withFigureExportLayerOffset(separate, "measurement:distance-1", { x: -1, y: 0 });
    expect(layoutCombinedExport(prepared, outside).bounds).toMatchObject({ minX: -120, width: 320, height: 160 });
    expect(structureOnlyFigureExportLayout(defaultFigureExportLayout())).toBeUndefined();
    expect(structureOnlyFigureExportLayout(undefined)).toBeUndefined();
  });

  test("validates saved measurement offsets, rejecting arrays and non-finite values without breaking old layouts", () => {
    const defaults = defaultFigureExportLayout();
    expect(isFigureExportLayout(defaults)).toBe(true);
    expect(isFigureExportLayout({ ...defaults, measurementLabels: {} })).toBe(true);
    expect(isFigureExportLayout({ ...defaults, measurementLabels: { distance: { x: -.5, y: .25 } } })).toBe(true);
    for (const measurementLabels of [[], null, "offsets", { distance: [] }, { distance: null },
      { distance: { x: NaN, y: 0 } }, { distance: { x: 0, y: Infinity } }, { distance: { x: "1", y: 0 } },
      { distance: { x: 0 } }, { "": { x: 0, y: 0 } },
    ]) expect(isFigureExportLayout({ ...defaults, measurementLabels })).toBe(false);
    expect(() => withFigureExportLayerOffset(undefined, "measurement:distance", { x: NaN, y: 0 })).toThrow();
    const overflow = withFigureExportLayerOffset(undefined, "measurement:distance-1", { x: Number.MAX_VALUE, y: 0 });
    expect(() => layoutCombinedExport({ width: 200, height: 160, layers: structureExportLayers(measuredRasterImage()) }, overflow)).toThrow();
  });

  test("defers PDF text rasters with final canvas shifts while PNG draws each label once", async () => {
    const drawImage = mock();
    const context = { drawImage, clearRect: mock(), fillRect: mock() } as unknown as CanvasRenderingContext2D;
    const getContext = spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const toBlob = spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
      callback(new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGd8AAAAASUVORK5CYII=", "base64")], { type: "image/png" }));
    });
    const originalBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ close() {} }) as ImageBitmap;
    try {
      const image = measuredRasterImage();
      const prepared = { width: 200, height: 160, layers: structureExportLayers(image) };
      const previewLayout = withFigureExportLayerOffset(undefined, "measurement:distance-1", { x: -.75, y: -.625 });
      const settings = { ...createDefaultExportSettings(), previewLayout };
      const pdf = await composeCombinedExportRaster(prepared, { ...settings, format: "pdf" });
      expect(pdf).toMatchObject({ width: 270, height: 185, measurementLabels: [
        { id: "distance-1", label: "2.450 Å", x: 0, y: 0 },
        { id: "angle-1", label: "109.47°", x: 170, y: 115 },
      ] });
      expect(pdf.measurementLabels![0]!.image).toBe(image.measurementLabels![0]!.image);
      expect(pdf.measurementLabels![0]!.text).toBe(image.measurementLabels![0]!.text);
      expect(pdf.textItems).toEqual([]);
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(drawImage.mock.calls[0]!.slice(1)).toEqual([70, 25, 200, 160]);
      drawImage.mockClear();
      const png = await composeCombinedExportRaster(prepared, { ...settings, format: "png" });
      expect(png).toMatchObject({ width: 270, height: 185 });
      expect(png.measurementLabels).toBeUndefined();
      expect(drawImage.mock.calls.map(call => call.slice(1))).toEqual([
        [70, 25, 200, 160], [0, 0, 30, 12], [170, 115, 48, 14],
      ]);
      const label = image.measurementLabels![0]!;
      const withVectorInk = { ...image, measurementLabels: [{ ...label, text: { ...label.text!,
        inkBounds: { minX: -.05, minY: .25, maxX: 29.8, maxY: 12.08, width: 29.85, height: 11.83 } } }] };
      const vectorPrepared = { ...prepared, layers: structureExportLayers(withVectorInk, true) };
      const vectorSettings = { ...settings, format: "pdf" as const,
        previewLayout: { ...previewLayout, margins: { top: 0, right: 0, bottom: 0, left: 0 } } };
      const preview = layoutCombinedExport(vectorPrepared, vectorSettings.previewLayout);
      const output = await composeCombinedExportRaster(vectorPrepared, vectorSettings);
      expect(output.width).toBe(preview.bounds.width);
      expect(output.height).toBe(preview.bounds.height);
      expect(output.measurementLabels![0]!.x).toBeCloseTo(preview.layers[1]!.x - preview.bounds.minX, 10);
      expect(output.measurementLabels![0]!.x + label.text!.runs[0]!.x).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.createImageBitmap = originalBitmap;
      toBlob.mockRestore();
      getContext.mockRestore();
    }
  });
});

function measuredRasterImage(): RasterExportImage {
  return { ...rasterImage(200, 160),
    contentBounds: { minX: 20, minY: 20, maxX: 180, maxY: 140, width: 160, height: 120 },
    measurementLabels: [
      { id: "distance-1", label: "2.450 Å", image: rasterImage(30, 12), x: 80, y: 75,
        text: { color: "#9b2351", fontWeight: 600, fontSize: 7, baselineY: 8.25,
          runs: [{ label: "2", family: "numeral", x: 4.5, width: 4.2 }] } },
      { id: "angle-1", label: "109.47°", image: rasterImage(48, 14), x: 100, y: 90 },
    ],
  };
}

function previewLayers(): PreparedCombinedExport {
  return { width: 200, height: 160, layers: [
    { id: "structure", image: { ...rasterImage(200, 160), contentBounds: { minX: 20, minY: 20, maxX: 180, maxY: 140, width: 160, height: 120 } }, textItems: [], x: 0, y: 0 },
    { id: "legend", image: rasterImage(100, 24), textItems: [{ label: "Cu", size: 12, x: 8, y: 12 }], x: 50, y: 180 },
    { id: "crystalAxes", image: rasterImage(48, 48), textItems: [], x: -64, y: 120 },
  ] };
}

function rasterImage(width: number, height: number) {
  return {
    blob: new Blob(["image"]),
    height,
    width,
  };
}
