import type { PDFDocument, PDFFont } from "pdf-lib";

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
const NUMERAL_PDF_FONT_URL = new URL("../../node_modules/@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff", import.meta.url).href;

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

  const scale = pdfPointScale(dpi);
  page.setSize(rasterImage.width * scale, rasterImage.height * scale);
  page.scaleContent(scale, scale);

  const pdfBytes = await pdf.save();
  const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBuffer).set(pdfBytes);
  return new Blob([pdfBuffer], { type: "application/pdf" });
}

function pdfPointScale(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("PDF DPI is invalid.");
  return 72 / dpi;
}

async function embedPdfTextFonts(pdf: PDFDocument): Promise<{ textFont: PDFFont; numeralFont: PDFFont }> {
  type PdfFontkit = Parameters<PDFDocument["registerFontkit"]>[0];
  type PdfFontkitModule = typeof import("@pdf-lib/fontkit") & { default?: PdfFontkit };
  const fontkitModule = (await import("@pdf-lib/fontkit")) as PdfFontkitModule;
  pdf.registerFontkit(fontkitModule.default ?? fontkitModule);
  const [textBytes, numeralBytes] = await Promise.all([
    fetchFontBytes(WENKAI_PDF_FONT_URL),
    fetchFontBytes(NUMERAL_PDF_FONT_URL),
  ]);
  return {
    textFont: await pdf.embedFont(textBytes, { subset: true }),
    numeralFont: await pdf.embedFont(numeralBytes, { subset: true }),
  };
}

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load PDF font asset: ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
