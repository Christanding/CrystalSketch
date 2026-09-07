import { describe, expect, test } from "bun:test";

import {
  combinedLayerBounds,
  currentFigureExportMargins,
  defaultFigureExportLayout,
  layoutCombinedExport,
  offsetTextItems,
  type PreparedCombinedExport,
} from "../src/export/combinedExportRaster";

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
});

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
