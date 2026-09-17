import type { SceneSpec } from "../api/scene";
import type { CameraPoseSnapshot } from "../scene/cameraPose";
import type {
  RasterExportBounds,
  RasterExportImage,
  RasterExportTextItem,
} from "../scene/exportRenderer";
import type {
  ComponentOpacityState,
  ComponentVisibilityState,
  ExportSettingsState,
  FigureExportLayout,
  StyleState,
  StructureLineWidthState,
  UnitCellLineStyle,
} from "../model";
import {
  baseColorSchemeForStyle,
  crystalAxisColorsForStyle,
  crystalAxisMaterialForStyle,
  elementColorOverridesForStyle,
  isFigureExportLayout,
  exportDpi,
} from "../model";
import { deriveElementLegendEntries } from "../app/elementLegend";
import {
  canvasToPngBlob,
  assertExportCanvasSize,
  canvasToRasterBlob,
  exportTextColor,
  fillCanvasBackground,
  rasterFormatForExportFormat,
} from "./rasterCanvas";
import {
  legendExportStyle,
  renderLegendCanvas,
} from "./legendExport";
import { renderExportRaster } from "./structureRasterExport";
import type { FigureRenderControl } from "./types";
import {
  CRYSTAL_AXIS_LABEL_HALO_COLOR,
  crystalAxisExportSize,
} from "./crystalAxesExport";

const EXPORT_ACCESSORY_PADDING_RATIO = 0.08;

export type MovableFigureLayerId = "legend" | "crystalAxes" | `measurement:${string}`;

export interface CombinedExportRasterOptions {
  renderControl?: FigureRenderControl;
  cameraPose: CameraPoseSnapshot;
  componentOpacity: ComponentOpacityState;
  componentVisibility: ComponentVisibilityState;
  lightStrength: number;
  scene: SceneSpec;
  settings: ExportSettingsState;
  showCrystalAxisLabels: boolean;
  style: StyleState;
  structureLineWidth: StructureLineWidthState;
  unitCellLineStyle: UnitCellLineStyle;
  visibleScene: SceneSpec | null;
}

export interface CombinedExportLayer {
  id?: "structure" | MovableFigureLayerId;
  label?: string;
  previewBlob?: Blob;
  image: RasterExportImage;
  textItems: RasterExportTextItem[];
  x: number;
  y: number;
}

export interface PreparedCombinedExport {
  layers: CombinedExportLayer[];
  width: number;
  height: number;
}

export async function prepareCombinedExportLayers({
  renderControl,
  cameraPose,
  componentOpacity,
  componentVisibility,
  lightStrength,
  scene,
  settings,
  showCrystalAxisLabels,
  style,
  structureLineWidth,
  unitCellLineStyle,
  visibleScene,
}: CombinedExportRasterOptions): Promise<PreparedCombinedExport> {
  const layers: CombinedExportLayer[] = [];
  let measurementLayers: CombinedExportLayer[] = [];
  let structureBounds: RasterExportBounds = fullLayerBounds(settings.width, settings.height);

  if (settings.components.structure) {
    if (!visibleScene) {
      throw new Error("No structure is available to export.");
    }

    const structureImage = await renderExportRaster({
      renderControl,
      cameraPose,
      componentOpacity,
      componentVisibility,
      lightStrength,
      settings,
      style,
      structureLineWidth,
      unitCellLineStyle,
      visibleScene,
      separateMeasurementLabels: true,
    });
    const structureLayers = structureExportLayers(structureImage);
    structureBounds = structureImage.accessoryReferenceBounds ?? combinedContentBounds(structureLayers);
    const [structureLayer, ...labels] = structureLayers;
    layers.push(structureLayer!);
    measurementLayers = labels;
  }

  const accessoryReferenceSize = exportAccessoryReferenceSizeFromBounds(structureBounds);
  const accessoryPadding = Math.round(accessoryReferenceSize * EXPORT_ACCESSORY_PADDING_RATIO);

  if (settings.components.legend) {
    const colorScheme = baseColorSchemeForStyle(style);
    const elementColorOverrides = elementColorOverridesForStyle(scene.atoms, style);
    const renderedLegend = renderLegendCanvas({
      background: "transparent",
      entries: deriveElementLegendEntries(scene, colorScheme, elementColorOverrides),
      includeText: settings.format !== "pdf",
      layout: settings.legendLayout,
      style: legendExportStyle(settings, accessoryReferenceSize),
      supersampling: settings.supersampling,
      textBackground: settings.background,
    });
    const position = combinedLegendPosition(
      settings.legendLayout,
      structureBounds,
      renderedLegend.canvas.width,
      renderedLegend.canvas.height,
      accessoryPadding,
    );
    layers.push({
      id: "legend",
      image: {
        blob: await canvasToPngBlob(renderedLegend.canvas, exportDpi(settings)),
        height: renderedLegend.canvas.height,
        width: renderedLegend.canvas.width,
      },
      textItems: settings.format === "pdf" ? renderedLegend.textItems : [],
      x: position.x,
      y: position.y,
    });
  }

  if (settings.components.crystalAxes) {
    const { renderCrystalAxesRasterImage } = await import("../scene/exportRenderer");
    const crystalAxesImage = await renderCrystalAxesRasterImage({
      axisColors: crystalAxisColorsForStyle(style),
      materialState: crystalAxisMaterialForStyle(style, lightStrength),
      backgroundColor: null,
      cameraPose,
      cellVectors: scene.cell.vectors,
      imageFormat: "png",
      includeLabelTextItems: settings.format === "pdf" && showCrystalAxisLabels,
      labelColor: exportTextColor(settings.background),
      labelHaloColor: CRYSTAL_AXIS_LABEL_HALO_COLOR,
      showLabelHalo:
        settings.format !== "pdf" &&
        settings.background !== "black" &&
        showCrystalAxisLabels,
      showLabels: settings.format !== "pdf" && showCrystalAxisLabels,
      size: crystalAxisExportSize(settings, accessoryReferenceSize),
      supersampling: settings.supersampling,
    });
    const position = combinedCrystalAxesPosition(
      structureBounds,
      crystalAxesImage.width,
      crystalAxesImage.height,
      accessoryPadding,
    );
    layers.push({
      id: "crystalAxes",
      image: crystalAxesImage,
      textItems: settings.format === "pdf" ? crystalAxesImage.textItems ?? [] : [],
      x: position.x,
      y: position.y,
    });
  }

  return { layers: [...layers, ...measurementLayers], width: settings.width, height: settings.height };
}

/** Split only the supplied text payload; the structure raster is already label-free. */
export function structureExportLayers(image: RasterExportImage): CombinedExportLayer[] {
  const { measurementLabels, ...baseImage } = image;
  return [
    { id: "structure", image: measurementLabels ? baseImage : image, textItems: [], x: 0, y: 0 },
    ...(measurementLabels ?? []).map(label => ({ id: `measurement:${label.id}` as const,
      label: label.label, image: label.image, textItems: [], x: label.x, y: label.y })),
  ];
}

export async function renderCombinedExportRaster(options: CombinedExportRasterOptions): Promise<RasterExportImage> {
  return composeCombinedExportRaster(await prepareCombinedExportLayers(options), options.settings);
}

export function layoutCombinedExport(prepared: PreparedCombinedExport, layout?: FigureExportLayout) {
  if (layout !== undefined && !isFigureExportLayout(layout)) {
    throw new Error("Figure export layout is invalid.");
  }
  const layers = prepared.layers.map(layer => {
    const offset = layer.id && layer.id !== "structure" ? figureExportLayerOffset(layout, layer.id) : { x: 0, y: 0 };
    const measurement = layer.id?.startsWith("measurement:");
    const movedX = layer.x + offset.x * prepared.width;
    const movedY = layer.y + offset.y * prepared.height;
    const x = measurement ? movedX : Math.round(movedX);
    const y = measurement ? movedY : Math.round(movedY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Figure export layout is invalid.");
    return { ...layer, x, y };
  });
  const contentBounds = combinedContentBounds(layers);
  const bounds = layout?.margins
    ? expandContentBounds(contentBounds, layout.margins, Math.min(prepared.width, prepared.height))
    : combinedLayerBounds(layers, prepared.width, prepared.height);
  return { layers, bounds, contentBounds };
}

export function defaultFigureExportLayout(): FigureExportLayout {
  return { legend: { x: 0, y: 0 }, crystalAxes: { x: 0, y: 0 } };
}

export function figureExportLayerOffset(layout: FigureExportLayout | undefined, id: MovableFigureLayerId): { x: number; y: number } {
  if (id === "legend" || id === "crystalAxes") return layout?.[id] ?? { x: 0, y: 0 };
  const measurementId = id.slice("measurement:".length);
  const labels = layout?.measurementLabels;
  return labels && Object.hasOwn(labels, measurementId) ? labels[measurementId]! : { x: 0, y: 0 };
}

export function withFigureExportLayerOffset(layout: FigureExportLayout | undefined, id: MovableFigureLayerId,
  offset: { x: number; y: number }): FigureExportLayout {
  const current = layout ?? defaultFigureExportLayout();
  const next = id === "legend" || id === "crystalAxes" ? { ...current, [id]: { ...offset } }
    : { ...current, measurementLabels: { ...current.measurementLabels, [id.slice("measurement:".length)]: { ...offset } } };
  if (!isFigureExportLayout(next)) throw new Error("Figure export layout is invalid.");
  return next;
}

/** Separate structure files use their own canvas, without combined accessory placement. */
export function structureOnlyFigureExportLayout(layout: FigureExportLayout | undefined): FigureExportLayout | undefined {
  if (layout === undefined) return undefined;
  if (!isFigureExportLayout(layout)) throw new Error("Figure export layout is invalid.");
  if (!layout.measurementLabels || Object.keys(layout.measurementLabels).length === 0) return undefined;
  return { ...defaultFigureExportLayout(), measurementLabels: Object.fromEntries(
    Object.entries(layout.measurementLabels).map(([id, offset]) => [id, { ...offset }]),
  ) };
}

export function currentFigureExportMargins(prepared: PreparedCombinedExport, layout?: FigureExportLayout) {
  if (layout?.margins) return layout.margins;
  const { bounds, contentBounds } = layoutCombinedExport(prepared, layout);
  const reference = Math.min(prepared.width, prepared.height);
  return {
    top: Math.max(0, (contentBounds.minY - bounds.minY) / reference),
    right: Math.max(0, (bounds.maxX - contentBounds.maxX) / reference),
    bottom: Math.max(0, (bounds.maxY - contentBounds.maxY) / reference),
    left: Math.max(0, (contentBounds.minX - bounds.minX) / reference),
  };
}

function combinedContentBounds(layers: CombinedExportLayer[]): RasterExportBounds {
  if (!layers.length) return fullLayerBounds(1, 1);
  const bounds = layers.reduce((result, layer) => {
    const content = layer.image.contentBounds ?? fullLayerBounds(layer.image.width, layer.image.height);
    return {
      minX: Math.min(result.minX, layer.x + content.minX),
      minY: Math.min(result.minY, layer.y + content.minY),
      maxX: Math.max(result.maxX, layer.x + content.maxX),
      maxY: Math.max(result.maxY, layer.y + content.maxY),
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return { ...bounds, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY };
}

function expandContentBounds(bounds: RasterExportBounds, margins: NonNullable<FigureExportLayout["margins"]>, reference: number): RasterExportBounds {
  const minX = Math.floor(bounds.minX - margins.left * reference);
  const minY = Math.floor(bounds.minY - margins.top * reference);
  const maxX = Math.ceil(bounds.maxX + margins.right * reference);
  const maxY = Math.ceil(bounds.maxY + margins.bottom * reference);
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export async function composeCombinedExportRaster(
  prepared: PreparedCombinedExport,
  settings: ExportSettingsState,
): Promise<RasterExportImage> {
  const { layers, bounds: outputBounds } = layoutCombinedExport(prepared, settings.previewLayout);
  assertExportCanvasSize(outputBounds.width, outputBounds.height, "combined");
  const canvas = document.createElement("canvas");
  canvas.width = outputBounds.width;
  canvas.height = outputBounds.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare the combined export canvas.");
  }

  fillCanvasBackground(context, outputBounds.width, outputBounds.height, settings.background);
  const textItems: RasterExportTextItem[] = [];
  const measurementLabels: NonNullable<RasterExportImage["measurementLabels"]> = [];
  const shiftX = -outputBounds.minX;
  const shiftY = -outputBounds.minY;
  for (const layer of layers) {
    const x = layer.x + shiftX;
    const y = layer.y + shiftY;
    if (settings.format === "pdf" && layer.id?.startsWith("measurement:")) {
      const id = layer.id.slice("measurement:".length);
      measurementLabels.push({ id, label: layer.label ?? id, image: layer.image, x, y });
      continue;
    }
    await drawRasterExportImage(context, layer.image, x, y);
    textItems.push(...offsetTextItems(layer.textItems, x, y));
  }

  const blob =
    settings.format === "pdf"
      ? await canvasToPngBlob(canvas, exportDpi(settings))
      : await canvasToRasterBlob(canvas, rasterFormatForExportFormat(settings.format), exportDpi(settings));
  return {
    blob,
    height: outputBounds.height,
    textItems,
    width: outputBounds.width,
    ...(measurementLabels.length ? { measurementLabels } : {}),
  };
}

function exportAccessoryReferenceSizeFromBounds(bounds: RasterExportBounds): number {
  return Math.sqrt(bounds.width * bounds.height);
}

function combinedLegendPosition(
  legendLayout: "horizontal" | "vertical",
  structureBounds: RasterExportBounds,
  layerWidth: number,
  layerHeight: number,
  padding: number,
) {
  const centerY = (structureBounds.minY + structureBounds.maxY) / 2;
  if (legendLayout === "vertical") {
    return {
      x: structureBounds.maxX + padding,
      y: Math.round(centerY - layerHeight / 2),
    };
  }

  const centerX = (structureBounds.minX + structureBounds.maxX) / 2;
  return {
    x: Math.round(centerX - layerWidth / 2),
    y: structureBounds.maxY + padding,
  };
}

function combinedCrystalAxesPosition(
  structureBounds: RasterExportBounds,
  layerWidth: number,
  layerHeight: number,
  padding: number,
) {
  return {
    x: structureBounds.minX - layerWidth - padding,
    y: structureBounds.maxY - layerHeight,
  };
}

function fullLayerBounds(width: number, height: number): RasterExportBounds {
  return {
    height,
    maxX: width,
    maxY: height,
    minX: 0,
    minY: 0,
    width,
  };
}

export function combinedLayerBounds(
  layers: CombinedExportLayer[],
  baseWidth: number,
  baseHeight: number,
) {
  const bounds = layers.reduce(
    (current, layer) => {
      const content = layer.id?.startsWith("measurement:") && layer.image.contentBounds
        ? layer.image.contentBounds : fullLayerBounds(layer.image.width, layer.image.height);
      return {
        maxX: Math.max(current.maxX, layer.x + content.maxX),
        maxY: Math.max(current.maxY, layer.y + content.maxY),
        minX: Math.min(current.minX, layer.x + content.minX),
        minY: Math.min(current.minY, layer.y + content.minY),
      };
    },
    {
      maxX: baseWidth,
      maxY: baseHeight,
      minX: 0,
      minY: 0,
    },
  );
  const minX = Math.floor(bounds.minX);
  const minY = Math.floor(bounds.minY);
  const maxX = Math.ceil(bounds.maxX);
  const maxY = Math.ceil(bounds.maxY);
  return {
    height: Math.max(1, maxY - minY),
    maxX,
    maxY,
    minX,
    minY,
    width: Math.max(1, maxX - minX),
  };
}

export function offsetTextItems(
  textItems: RasterExportTextItem[],
  offsetX: number,
  offsetY: number,
): RasterExportTextItem[] {
  return textItems.map((item) => ({
    ...item,
    x: item.x + offsetX,
    y: item.y + offsetY,
  }));
}

async function drawRasterExportImage(
  context: CanvasRenderingContext2D,
  image: RasterExportImage,
  x: number,
  y: number,
) {
  const bitmap = await createImageBitmap(image.blob);
  try {
    context.drawImage(bitmap, x, y, image.width, image.height);
  } finally {
    bitmap.close();
  }
}
