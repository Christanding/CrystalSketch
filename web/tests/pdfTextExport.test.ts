import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { encodeRasterPdf, encodeRasterTextPdf } from "../src/export/pdfTextExport";
import { EXPORT_DPI_OPTIONS } from "../src/model/exportSettings";

test("embeds WenKai text and Geist Mono digits in the exported PDF", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) =>
    new Response(await readFile(new URL(String(input))))) as typeof fetch;
  try {
    const blob = await encodeRasterTextPdf({
      width: 160, height: 100,
      blob: new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGd8AAAAASUVORK5CYII=", "base64")], { type: "image/png" }),
      textItems: [
        { label: "晶体 Cu 12.34", size: 12, x: 5, y: 20 },
        { label: "a", size: 12, x: 15, y: 50, fontStyle: "italic" },
      ],
    }, { background: "transparent", halo: true, dpi: 300 });
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    expect(pdf.getPage(0).getSize()).toEqual({ width: 38.4, height: 24 });
    const streams = pdf.getPage(0).node.lookup(PDFName.of("Contents"), PDFArray);
    expect(inflateSync(streams.lookup(0, PDFRawStream).contents).toString()).toContain("0.24 0 0 0.24 0 0 cm");
    const fonts = pdf.getPages()[0]!.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const names = fonts.entries().map(([, reference]) =>
      pdf.context.lookup(reference, PDFDict).lookup(PDFName.of("BaseFont"), PDFName).asString());
    expect(names.some(name => name.includes("LXGWWenKai-Medium"))).toBe(true);
    expect(names.some(name => name.includes("GeistMono-Regular"))).toBe(true);
    // Font names and extracted text can be correct while short-loca glyph offsets
    // are corrupt. Decode every embedded glyph, including the axis/legend letters.
    let embeddedFonts = 0;
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      const bytes = inflateSync(object.contents);
      if (bytes.subarray(0, 4).toString() !== "true") continue;
      const font = fontkit.create(bytes);
      embeddedFonts++;
      for (let index = 0; index < font.numGlyphs; index++) {
        expect(() => font.getGlyph(index).path.toSVG()).not.toThrow();
      }
    }
    expect(embeddedFonts).toBe(2);
    expect(blob.size).toBeLessThan(20_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sets PDF print dimensions for every DPI without changing the embedded raster", async () => {
  const raster = { width: 1200, height: 600,
    blob: new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGd8AAAAASUVORK5CYII=", "base64")], { type: "image/png" }) };
  for (const dpi of EXPORT_DPI_OPTIONS) {
    const pdf = await PDFDocument.load(await (await encodeRasterPdf(raster, dpi)).arrayBuffer());
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(1200 * 72 / dpi, 8);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(600 * 72 / dpi, 8);
    const content = pdf.getPage(0).node.lookup(PDFName.of("Contents"), PDFArray);
    const drawing = inflateSync(content.lookup(1, PDFRawStream).contents).toString();
    expect(drawing).toContain("1200 0 0 600 0 0 cm");
  }
  const defaultPdf = await PDFDocument.load(await (await encodeRasterPdf(raster)).arrayBuffer());
  expect(defaultPdf.getPage(0).getSize()).toEqual({ width: 144, height: 72 });
});
