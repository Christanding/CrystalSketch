import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";

import type { ExportBackground } from "../model";
import { DEFAULT_EXPORT_DPI } from "../model/exportSettings";
import type { RasterExportImage } from "../scene/exportRenderer";
import {
  exportTextColor,
  exportTextHaloColor,
  hexColorToRgbComponents,
} from "./rasterCanvas";

// WOFF preserves glyph tables needed by the pinned PDF fontkit subsetter;
// browsers use the smaller WOFF2 of the same WenKai subset. Glyph records in
// this WOFF are 4-byte aligned, avoiding fontkit's short-loca rounding bug.
const WENKAI_PDF_FONT_URL = new URL("../assets/fonts/LXGWWenKai-UI.woff", import.meta.url).href;
const NUMERAL_PDF_FONT_URLS: Record<number, string> = {
  300: new URL("../../node_modules/@fontsource/geist-mono/files/geist-mono-latin-300-normal.woff", import.meta.url).href,
  400: new URL("../../node_modules/@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff", import.meta.url).href,
  500: new URL("../../node_modules/@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff", import.meta.url).href,
  600: new URL("../../node_modules/@fontsource/geist-mono/files/geist-mono-latin-600-normal.woff", import.meta.url).href,
};
const pdfFonts = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

export async function encodeRasterTextPdf(
  rasterImage: RasterExportImage,
  options: { background: ExportBackground; halo: boolean; dpi?: number },
): Promise<Blob> {
  const { PDFDocument, degrees, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([rasterImage.width, rasterImage.height]);
  const imageBytes = new Uint8Array(await rasterImage.blob.arrayBuffer());
  const image = await pdf.embedPng(imageBytes);
  const { textFont, numeralFont } = await embedPdfTextFonts(pdf);
  const textColor = rgb(...hexColorToRgbComponents(exportTextColor(options.background)));
  const textHaloColor = rgb(...hexColorToRgbComponents(exportTextHaloColor(options.background)));

  page.drawImage(image, {
    height: rasterImage.height,
    width: rasterImage.width,
    x: 0,
    y: 0,
  });

  for (const item of rasterImage.textItems ?? []) {
    const runs = (item.label.match(/[0-9]+|[^0-9]+/g) ?? []).map(label => {
      const font = /^[0-9]/.test(label) ? numeralFont : textFont;
      return { label, font, width: font.widthOfTextAtSize(label, item.size) };
    });
    const width = runs.reduce((sum, run) => sum + run.width, 0);
    let x = item.fontStyle === "italic" ? item.x - width / 2 : item.x;
    const y = rasterImage.height - item.y - item.size * 0.36;
    for (const run of runs) {
      const textOptions = {
        font: run.font,
        size: item.size,
        x,
        y,
        ySkew: degrees(item.fontStyle === "italic" ? 12 : 0),
      };
      if (options.halo) {
        const haloOffset = Math.max(0.75, item.size / 96);
        for (const [offsetX, offsetY] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          page.drawText(run.label, {
            ...textOptions,
            color: textHaloColor,
            x: x + offsetX * haloOffset,
            y: y + offsetY * haloOffset,
          });
        }
      }
      page.drawText(run.label, { ...textOptions, color: textColor });
      x += run.width;
    }
  }

  await drawMeasurementLabelLayers(pdf, page, rasterImage);
  const scale = pdfPointScale(options.dpi ?? DEFAULT_EXPORT_DPI);
  page.setSize(rasterImage.width * scale, rasterImage.height * scale);
  page.scaleContent(scale, scale);

  const pdfBytes = await pdf.save();
  const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBuffer).set(pdfBytes);
  return new Blob([pdfBuffer], { type: "application/pdf" });
}

export async function encodeRasterPdf(rasterImage: RasterExportImage, dpi: number = DEFAULT_EXPORT_DPI): Promise<Blob> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([rasterImage.width, rasterImage.height]);
  const imageBytes = new Uint8Array(await rasterImage.blob.arrayBuffer());
  const image = await pdf.embedPng(imageBytes);

  page.drawImage(image, {
    height: rasterImage.height,
    width: rasterImage.width,
    x: 0,
    y: 0,
  });

  await drawMeasurementLabelLayers(pdf, page, rasterImage);
  const scale = pdfPointScale(dpi);
  page.setSize(rasterImage.width * scale, rasterImage.height * scale);
  page.scaleContent(scale, scale);

  const pdfBytes = await pdf.save();
  const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBuffer).set(pdfBytes);
  return new Blob([pdfBuffer], { type: "application/pdf" });
}

async function drawMeasurementLabelLayers(pdf: PDFDocument, page: PDFPage, rasterImage: RasterExportImage): Promise<void> {
  const { concatTransformationMatrix, pushGraphicsState, popGraphicsState, rgb,
    setLineWidth, setStrokingRgbColor, setTextRenderingMode, TextRenderingMode } = await import("pdf-lib");
  for (const layer of rasterImage.measurementLabels ?? []) {
    if (layer.text) {
      const text = layer.text;
      const color = rgb(...hexColorToRgbComponents(text.color));
      const [textFont, numeralFont] = await Promise.all([
        embedPdfFont(pdf, WENKAI_PDF_FONT_URL),
        embedPdfFont(pdf, NUMERAL_PDF_FONT_URLS[text.fontWeight] ?? NUMERAL_PDF_FONT_URLS[400]!),
      ]);
      for (const run of text.runs) {
        const font = run.family === "numeral" ? numeralFont : textFont;
        const advance = font.widthOfTextAtSize(run.label, text.fontSize);
        if (!(advance > 0)) continue;
        // Canvas and PDF shaping have different metrics. Keep the browser's
        // measured run starts/advances and alphabetic baseline, including the
        // canvas maxWidth squeeze and fractional sprite projection.
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(
          run.width / advance, 0, 0, 1, layer.x + run.x, rasterImage.height - layer.y - text.baselineY,
        ));
        if (run.strokeWidth) {
          // Match the measured browser synthetic-bold expansion for WenKai,
          // without changing the genuine Geist digit outlines.
          page.pushOperators(setLineWidth(run.strokeWidth),
            setStrokingRgbColor(...hexColorToRgbComponents(text.color)),
            setTextRenderingMode(TextRenderingMode.FillAndOutline));
        }
        page.drawText(run.label, { font, size: text.fontSize, color, x: 0, y: 0 });
        page.pushOperators(popGraphicsState());
      }
      continue;
    }
    // Accept older callers that only carry a bitmap; new exports include text.
    const image = await pdf.embedPng(new Uint8Array(await layer.image.blob.arrayBuffer()));
    page.drawImage(image, {
      width: layer.image.width,
      height: layer.image.height,
      x: layer.x,
      y: rasterImage.height - layer.y - layer.image.height,
    });
  }
}

function pdfPointScale(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("PDF DPI is invalid.");
  return 72 / dpi;
}

async function embedPdfTextFonts(pdf: PDFDocument): Promise<{ textFont: PDFFont; numeralFont: PDFFont }> {
  const [textFont, numeralFont] = await Promise.all([
    embedPdfFont(pdf, WENKAI_PDF_FONT_URL),
    embedPdfFont(pdf, NUMERAL_PDF_FONT_URLS[400]!),
  ]);
  return { textFont, numeralFont };
}

function embedPdfFont(pdf: PDFDocument, url: string): Promise<PDFFont> {
  let fonts = pdfFonts.get(pdf);
  if (!fonts) { fonts = new Map(); pdfFonts.set(pdf, fonts); }
  let font = fonts.get(url);
  if (!font) {
    font = (async () => {
      type PdfFontkit = Parameters<PDFDocument["registerFontkit"]>[0];
      type PdfFontkitModule = typeof import("@pdf-lib/fontkit") & { default?: PdfFontkit };
      const [fontkitModule, bytes] = await Promise.all([
        import("@pdf-lib/fontkit") as Promise<PdfFontkitModule>, fetchFontBytes(url),
      ]);
      pdf.registerFontkit(fontkitModule.default ?? fontkitModule);
      return pdf.embedFont(bytes, { subset: true });
    })();
    fonts.set(url, font);
  }
  return font;
}

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load PDF font asset: ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
