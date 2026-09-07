import { describe, expect, test } from "bun:test";
import { withPngDpi } from "../src/export/pngDpi";
import { withJpegDpi } from "../src/export/jpegDpi";
import { EXPORT_DPI_OPTIONS } from "../src/model/exportSettings";

describe("raster DPI metadata", () => {
  test("writes each selected PNG density once without changing image dimensions or data", async () => {
    const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGd8AAAAASUVORK5CYII=", "base64");
    let blob = new Blob([original], { type: "image/png" });
    for (const dpi of EXPORT_DPI_OPTIONS) {
      blob = await withPngDpi(blob, dpi);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      const chunks: string[] = [];
      const imageData: number[] = [];
      for (let position = 8; position < bytes.length;) {
        const length = view.getUint32(position);
        const name = new TextDecoder().decode(bytes.slice(position + 4, position + 8));
        chunks.push(name);
        if (name === "pHYs") {
          expect(view.getUint32(position + 8)).toBe(Math.round(dpi / 0.0254));
          expect(view.getUint32(position + 12)).toBe(Math.round(dpi / 0.0254));
          expect(bytes[position + 16]).toBe(1);
        } else imageData.push(...bytes.slice(position, position + length + 12));
        position += length + 12;
      }
      expect(chunks.filter(name => name === "pHYs")).toHaveLength(1);
      expect(new Uint8Array(imageData)).toEqual(original.subarray(8));
    }
  });

  test("updates JPEG JFIF inches density while preserving encoded image bytes", async () => {
    const header = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0];
    const scan = [0xff, 0xda, 0, 2, 19, 23, 41, 0xff, 0xd9];
    let blob = new Blob([new Uint8Array([...header, ...scan])], { type: "image/jpeg" });
    for (const dpi of EXPORT_DPI_OPTIONS) {
      blob = await withJpegDpi(blob, dpi);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      expect(bytes[13]).toBe(1);
      expect(view.getUint16(14)).toBe(dpi);
      expect(view.getUint16(16)).toBe(dpi);
      expect(bytes.slice(header.length)).toEqual(new Uint8Array(scan));
      expect(bytes.length).toBe(header.length + scan.length);
    }
    const withoutJfif = new Blob([new Uint8Array([0xff, 0xd8, ...scan])], { type: "image/jpeg" });
    const inserted = new Uint8Array(await (await withJpegDpi(withoutJfif, 300)).arrayBuffer());
    expect(new TextDecoder().decode(inserted.slice(6, 11))).toBe("JFIF\0");
    expect(new DataView(inserted.buffer).getUint16(14)).toBe(300);
    expect(inserted.slice(20)).toEqual(new Uint8Array(scan));
  });

  test("rejects invalid densities and malformed input", async () => {
    await expect(withPngDpi(new Blob(["png"]), 300)).rejects.toThrow();
    await expect(withJpegDpi(new Blob(["jpg"]), 300)).rejects.toThrow();
    await expect(withJpegDpi(new Blob([]), 0)).rejects.toThrow();
    await expect(withPngDpi(new Blob([]), NaN)).rejects.toThrow();
  });
});
