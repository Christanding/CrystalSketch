import { describe, expect, spyOn, test } from "bun:test";
import { Children, type ReactElement, type ReactNode } from "react";
import * as Fiber from "@react-three/fiber";
import { OrthographicCamera, Quaternion, Scene, Vector3 } from "three";
import { parseVaspScene } from "../src/api/vasp";
import { createDefaultComponentOpacity, createDefaultComponentVisibility, createDefaultExportSettings,
  createDefaultStyle, DEFAULT_STRUCTURE_LINE_WIDTH } from "../src/model";
import { DEFAULT_MEASUREMENT_STYLE } from "../src/model/measurements";
import { layoutMeasurementLabels, measurementLabelSize } from "../src/model/measurementLabelLayout";
import { createMeasurementLabelCanvas, measurementLabelCanvasText, displayedMeasurements, measurementAngleArcPositions,
  measurementLayoutObstacles } from "../src/scene/MeasurementAnnotations";
import { applyCameraPoseSnapshot, createCameraPoseSnapshot } from "../src/scene/cameraPose";
import { applyOrthographicExportFrame, computeStructureExportFramePlan, computeStructureProjectedBounds } from "../src/scene/exportFrame";
import { ExportSceneContent } from "../src/scene/ExportSceneContent";
import * as Renderer from "../src/scene/exportRenderer";
import * as Cartoon from "../src/scene/CartoonOutline";
import * as PathTracing from "../src/scene/pathTracingExport";
import { renderExportRaster } from "../src/export/structureRasterExport";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="), char => char.charCodeAt(0));
type SceneProps = Parameters<typeof ExportSceneContent>[0];

function fixture(): Renderer.RenderStructureRasterOptions {
  const scene = parseVaspScene("measurements\n1\n10 0 0\n0 10 0\n0 0 10\nZn Cu O\n1 1 1\nDirect\n.5 .3 .3\n.5 .5 .3\n.5 .5 .5");
  const ids = scene.atoms.filter(atom => !atom.isPeriodicImage).map(atom => atom.id);
  scene.measurements = [
    { id: "distance", kind: "distance", atomIds: [ids[0]!, ids[1]!] },
    { id: "angle", kind: "angle", atomIds: [ids[0]!, ids[1]!, ids[2]!] },
  ];
  scene.measurementStyle = { ...DEFAULT_MEASUREMENT_STYLE, color: "#9b2351", fontWeight: 600, fontScale: 25 };
  return { scene, backgroundColor: null, cameraPose: createCameraPoseSnapshot(new Quaternion(.5, .5, .5, .5), [1, -.5, .25]),
    componentOpacity: createDefaultComponentOpacity(), width: 720, height: 500, imageFormat: "png",
    lightStrength: 1, meshQuality: "medium", showAtoms: false, showUnitCell: false,
    style: createDefaultStyle(), structureLineWidth: DEFAULT_STRUCTURE_LINE_WIDTH, supersampling: 1, unitCellLineStyle: "solid" };
}

function rendererHarness() {
  const rendered: SceneProps[] = [];
  const cameras: OrthographicCamera[] = [];
  const glyphs: { label: string; font: string; color: string; x: number; y: number; maxWidth: number; width: number; height: number }[] = [];
  const encodings: { width: number; height: number; type: string | undefined }[] = [];
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  const contextSpy = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
    if (contextId !== "2d") return null;
    const cached = contexts.get(this);
    if (cached) return cached;
    const canvas = this;
    const context = { font: "", fillStyle: "", textBaseline: "alphabetic", fillRect() {}, drawImage() {},
      measureText(label: string) {
        return { width: [...label].reduce((width, char) => width + (/\d/.test(char) ? 33.6 : char === "Å" ? 38.64 : 19.6), 0),
          actualBoundingBoxAscent: context.textBaseline === "alphabetic" ? 51.24 : 20,
          actualBoundingBoxDescent: context.textBaseline === "alphabetic" ? 1.12 : 32.36,
          actualBoundingBoxLeft: context.font.startsWith("600 ") ? .875 : 0,
          actualBoundingBoxRight: 20 + (context.font.startsWith("600 ") ? .875 : 0) };
      },
      fillText(label: string, x: number, y: number, maxWidth: number) {
        glyphs.push({ label, x, y, maxWidth, font: context.font, color: String(context.fillStyle), width: canvas.width, height: canvas.height });
      },
      getImageData(_x: number, _y: number, width: number, height: number) {
        const data = new Uint8ClampedArray(width * height * 4);
        // Exercise real alpha-bound extraction with transparent margins and antialiased ink.
        for (let y = Math.floor(height / 4); y < Math.ceil(height * .75); y++) {
          for (let x = Math.floor(width / 4); x < Math.ceil(width * .75); x++) data[(y * width + x) * 4 + 3] = 128;
        }
        return { data };
      },
    } as unknown as CanvasRenderingContext2D;
    contexts.set(canvas, context);
    return context;
  } as HTMLCanvasElement["getContext"]);
  const blobSpy = spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    encodings.push({ width: this.width, height: this.height, type });
    callback(new Blob([PNG], { type: "image/png" }));
  });
  const rootSpy = spyOn(Fiber, "createRoot").mockImplementation(canvas => {
    const camera = new OrthographicCamera();
    cameras.push(camera);
    const state = { camera, scene: new Scene(), advance() {}, gl: { domElement: canvas, setClearColor() {}, dispose() {}, render() {} } } as unknown as Fiber.RootState;
    return {
      async configure(options: { onCreated?: (state: Fiber.RootState) => void }) { options.onCreated?.(state); },
      render(tree: ReactNode) {
        const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children) as ReactElement<Record<string, unknown>>[];
        const content = children.find(child => child.type === ExportSceneContent) as ReactElement<SceneProps>;
        rendered.push(content.props);
        applyCameraPoseSnapshot(camera, content.props.cameraPose, content.props.layout.standardPose.distance, content.props.layout.span);
        applyOrthographicExportFrame(camera, content.props.exportFramePlan);
        camera.updateMatrixWorld();
        const ready = children.find(child => typeof child.props.onReady === "function");
        (ready!.props.onReady as () => void)();
        return { getState: () => state };
      },
      unmount() {},
    } as unknown as ReturnType<typeof Fiber.createRoot>;
  });
  const outlineSpy = spyOn(Cartoon, "createCartoonRenderer").mockImplementation(() => ({ render() {}, dispose() {} }));
  return { rendered, cameras, glyphs, encodings,
    restore() { outlineSpy.mockRestore(); rootSpy.mockRestore(); blobSpy.mockRestore(); contextSpy.mockRestore(); } };
}

describe("separate measurement text export", () => {
  test("reuses the sprite glyph canvas with the existing font, baseline and color", () => {
    const harness = rendererHarness();
    try {
      const canvas = createMeasurementLabelCanvas("2.000 Å", "#ad2345", 600);
      expect(harness.glyphs).toEqual([{ label: "2.000 Å", color: "#ad2345", x: 212, y: 47,
        maxWidth: 400, width: 424, height: 88,
        font: '600 56px "CrystalSketch Numerals", "LXGW WenKai", "LXGW WenKai Full", serif' }]);
      expect([canvas.width, canvas.height]).toEqual([424, 88]);
    } finally { harness.restore(); }
  });

  test("carries the measured alphabetic baseline and mixed font runs at fractional output scale", () => {
    const harness = rendererHarness();
    try {
      const canvas = createMeasurementLabelCanvas("2.000 Å", "#ad2345", 600);
      const text = measurementLabelCanvasText(canvas, "2.000 Å", "#ad2345", 600, 26.5, 5.5);
      expect(text).toMatchObject({ color: "#ad2345", fontWeight: 600, fontSize: 3.5 });
      expect(text.baselineY).toBeCloseTo((47 + 51.24 - 20) / 16, 10);
      expect(text.inkBounds).toEqual({ minX: 13.1953125, maxX: 14.5546875, minY: 1.6875,
        maxY: 4.96, width: 1.359375, height: 3.2725 });
      expect(text.runs.map(run => [run.label, run.family])).toEqual([
        ["2", "numeral"], [".", "text"], ["000", "numeral"], [" Å", "text"],
      ]);
      const width = (4 * 33.6 + 2 * 19.6 + 38.64) / 16;
      expect(text.runs[0]!.x).toBeCloseTo(26.5 / 2 - width / 2, 10);
      expect(text.runs[1]!.x).toBeCloseTo(text.runs[0]!.x + 33.6 / 16, 10);
      expect(text.runs[1]!.strokeWidth).toBeCloseTo(1.75 / 16, 10);
      expect(text.runs[0]!.strokeWidth).toBeUndefined();
      expect(text.runs.reduce((sum, run) => sum + run.width, 0)).toBeCloseTo(width, 10);
      expect(canvas.getContext("2d")!.textBaseline).toBe("middle");
      // Overflow is squeezed horizontally by fillText(maxWidth), not vertically.
      const long = "1234567890".repeat(3);
      const squeezedCanvas = createMeasurementLabelCanvas(long, "#333333", 300);
      const squeezed = measurementLabelCanvasText(squeezedCanvas, long, "#333333", 300, 64, 11);
      expect(squeezed.fontSize).toBe(7);
      expect(squeezed.runs[0]!.x).toBeCloseTo(1.5, 10);
      expect(squeezed.runs[0]!.width).toBeCloseTo(61, 10);
    } finally { harness.restore(); }
  });

  test("projects movable layers from the actual export camera and retains the original framing at 1x and 2x", async () => {
    const harness = rendererHarness();
    const options = fixture();
    const original = JSON.stringify(options);
    try {
      const baseline = await Renderer.renderStructureRasterImage(options);
      expect(baseline.measurementLabels).toBeUndefined();
      expect(Object.hasOwn(baseline, "accessoryReferenceBounds")).toBe(false);
      expect(harness.rendered[0]!.scene).toBe(options.scene);
      const exports: Renderer.RasterExportImage[] = [];
      for (const supersampling of [1, 2] as const) {
        const unsplit = supersampling === 1 ? baseline : await Renderer.renderStructureRasterImage({ ...options, supersampling });
        const image = await Renderer.renderStructureRasterImage({ ...options, supersampling, separateMeasurementLabels: true });
        expect(image.accessoryReferenceBounds).toEqual(unsplit.contentBounds);
        expect(Object.hasOwn(unsplit, "accessoryReferenceBounds")).toBe(false);
        exports.push(image);
        const content = harness.rendered.at(-1)!;
        const camera = harness.cameras.at(-1)!;
        expect(content.scene.measurementStyle!.showLabels).toBe(false);
        expect(content.scene.measurements).toBe(options.scene.measurements);
        const expectedFrame = computeStructureExportFramePlan({ ...options, width: options.width * supersampling,
          height: options.height * supersampling, groupPosition: content.layout.groupPosition });
        expect(content.exportFramePlan).toEqual(expectedFrame);
        const measurements = displayedMeasurements(options.scene);
        const anchors = layoutMeasurementLabels({ measurements, cameraQuaternion: camera.quaternion.toArray(), span: content.layout.span,
          fontScale: options.scene.measurementStyle!.fontScale,
          ...measurementLayoutObstacles({ scene: options.scene, style: options.style, showAtoms: options.showAtoms,
            atomOpacity: options.componentOpacity.atoms, bondOpacity: options.componentOpacity.bonds }) });
        expect(image.measurementLabels!.map(layer => layer.id)).toEqual(["distance", "angle"]);
        for (const [index, layer] of image.measurementLabels!.entries()) {
          const measurement = measurements[index]!;
          const size = measurementLabelSize(measurement.label, content.layout.span, options.scene.measurementStyle!.fontScale);
          const anchor = new Vector3(...anchors.get(layer.id)!).add(new Vector3(...content.layout.groupPosition)).project(camera);
          const pxWidth = size.width * camera.zoom * options.width / (camera.right - camera.left);
          const pxHeight = size.height * camera.zoom * options.height / (camera.top - camera.bottom);
          expect(layer.x).toBeCloseTo((anchor.x + 1) * options.width / 2 - pxWidth * .5, 8);
          expect(layer.y).toBeCloseTo((1 - anchor.y) * options.height / 2 - pxHeight * .92, 8);
          expect(layer.image.width).toBe(Math.ceil(pxWidth));
          expect(layer.image.height).toBe(Math.ceil(pxHeight));
          expect(layer.image.blob.type).toBe("image/png");
          expect(layer.text).toMatchObject({ color: "#9b2351", fontWeight: 600 });
          expect(layer.text!.fontSize).toBeCloseTo(56 * pxHeight / 88, 10);
          expect(layer.text!.baselineY).toBeCloseTo((47 + 51.24 - 20) * pxHeight / 88, 10);
          const ink = layer.image.contentBounds!;
          expect(ink.minX).toBe(Math.floor(layer.image.width / 4));
          expect(ink.maxX).toBe(Math.ceil(layer.image.width * .75));
          expect(ink.width).toBeLessThan(layer.image.width);
          expect(ink.height).toBeLessThan(layer.image.height);
        }
        const baseBounds = computeStructureProjectedBounds({ ...options, scene: content.scene, groupPosition: content.layout.groupPosition })!;
        expect(image.contentBounds!.minX).toBeCloseTo(((baseBounds.minX - expectedFrame.centerX) * expectedFrame.zoom + expectedFrame.width / 2) / supersampling, 8);
        expect(harness.glyphs.at(-1)!.color).toBe("#9b2351");
        expect(harness.glyphs.at(-1)!.font.startsWith("600 ")).toBe(true);
      }
      const positions = (image: Renderer.RasterExportImage) => image.measurementLabels!.map(layer => [layer.x, layer.y, layer.image.width, layer.image.height]);
      expect(positions(exports[0]!)).toEqual(positions(exports[1]!));
      expect(JSON.stringify(options)).toBe(original);
    } finally { harness.restore(); }
  });

  test("keeps line and arc definitions while extracting only displayed resolved labels in standard and PBR paths", async () => {
    const harness = rendererHarness();
    const traced: Parameters<typeof PathTracing.renderPathTracedExport>[0][] = [];
    const pathSpy = spyOn(PathTracing, "renderPathTracedExport").mockImplementation(async options => {
      traced.push(options);
      return options.renderer.domElement;
    });
    try {
      for (const pbr of [false, true]) {
        const options = fixture();
        if (pbr) options.style = { ...options.style, materialPreset: "pbr-ceramic", rendering: { ...options.style.rendering!, mode: "path-traced" } };
        options.scene.measurementStyle!.displayMode = "angle";
        options.scene.measurements = [...options.scene.measurements!, { id: "missing", kind: "angle", atomIds: ["absent", "b", "c"] }];
        const image = await Renderer.renderStructureRasterImage({ ...options, separateMeasurementLabels: true });
        expect(image.measurementLabels!.map(layer => layer.id)).toEqual(["angle"]);
        const rasterSource = harness.rendered.at(-1)!.scene;
        expect(rasterSource.measurementStyle!.showLabels).toBe(false);
        expect(displayedMeasurements(rasterSource)).toHaveLength(1);
        expect(measurementAngleArcPositions(displayedMeasurements(rasterSource)[0]!).length).toBeGreaterThan(3);
        if (pbr) expect(traced.at(-1)!.source).toBe(rasterSource);
        const count = harness.glyphs.length;
        options.scene.measurementStyle!.showLabels = false;
        expect((await Renderer.renderStructureRasterImage({ ...options, separateMeasurementLabels: true })).measurementLabels).toEqual([]);
        expect(harness.glyphs).toHaveLength(count);
      }
    } finally { pathSpy.mockRestore(); harness.restore(); }
  });

  test("forwards the extraction opt-in through the structure export wrapper and preserves its metadata", async () => {
    const measurementLabels: Renderer.RasterExportMeasurementLabel[] = [{ id: "length", label: "2.000 Å", x: 15, y: 20,
      image: { blob: new Blob([PNG], { type: "image/png" }), width: 42, height: 9 } }];
    const renderer = spyOn(Renderer, "renderStructureRasterImage").mockResolvedValue({ blob: new Blob([PNG], { type: "image/png" }), width: 720, height: 500, measurementLabels });
    try {
      const options = fixture();
      const image = await renderExportRaster({ ...options, visibleScene: options.scene,
        componentVisibility: createDefaultComponentVisibility(), settings: createDefaultExportSettings(), separateMeasurementLabels: true });
      expect(renderer.mock.calls[0]![0].separateMeasurementLabels).toBe(true);
      expect(image.measurementLabels).toBe(measurementLabels);
    } finally { renderer.mockRestore(); }
  });

  test("keeps split JPEG intermediates lossless only when resolved visible text will be composed", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 19, 23, 41, 0xff, 0xd9]);
    const renderer = spyOn(Renderer, "renderStructureRasterImage").mockImplementation(async options => ({
      blob: options.imageFormat === "png" ? new Blob([PNG], { type: "image/png" }) : new Blob([jpeg], { type: "image/jpeg" }),
      width: options.width, height: options.height,
    }));
    try {
      const source = fixture().scene;
      const cases = [
        { scene: source, separate: true, composed: true },
        { scene: source, separate: false, composed: false },
        { scene: source, separate: undefined, composed: false },
        { scene: { ...source, measurementStyle: { ...source.measurementStyle!, showLabels: false } }, separate: true, composed: false },
        { scene: { ...source, measurements: [] }, separate: true, composed: false },
        { scene: { ...source, atoms: [] }, separate: true, composed: false },
        { scene: { ...source, measurements: source.measurements!.filter(item => item.kind === "distance"),
          measurementStyle: { ...source.measurementStyle!, displayMode: "angle" as const } }, separate: true, composed: false },
      ];
      for (const format of ["jpg", "png", "pdf"] as const) for (const value of cases) {
        const expected = format === "jpg" && !value.composed ? "jpg" : "png";
        const image = await renderExportRaster({ ...fixture(), visibleScene: value.scene,
          componentVisibility: createDefaultComponentVisibility(), separateMeasurementLabels: value.separate,
          settings: { ...createDefaultExportSettings(), format, dpi: 300 } });
        expect(renderer.mock.calls.at(-1)![0].imageFormat).toBe(expected);
        expect(image.blob.type).toBe(expected === "jpg" ? "image/jpeg" : "image/png");
        const bytes = new Uint8Array(await image.blob.arrayBuffer());
        if (expected === "jpg") expect(new DataView(bytes.buffer).getUint16(14)).toBe(300);
        else expect(new DataView(bytes.buffer).getUint32(41)).toBe(Math.round(300 / .0254));
      }
    } finally { renderer.mockRestore(); }
  });
});
