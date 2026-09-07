import { DEFAULT_EXPORT_DPI } from "../model/exportSettings";

// Canvas-produced JPEGs carry JFIF density, not camera EXIF metadata.
export async function withJpegDpi(blob: Blob, dpi: number = DEFAULT_EXPORT_DPI): Promise<Blob> {
  if (!Number.isInteger(dpi) || dpi <= 0 || dpi > 65535) throw new Error("JPEG DPI is invalid.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) throw new Error("JPEG data is invalid.");
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) throw new Error("JPEG marker is invalid.");
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) throw new Error("JPEG data is incomplete.");
    if (marker === 0xe0 && length >= 16 && view.getUint32(offset + 4) === 0x4a464946 && bytes[offset + 8] === 0) {
      bytes[offset + 11] = 1;
      view.setUint16(offset + 12, dpi);
      view.setUint16(offset + 14, dpi);
      return new Blob([bytes], { type: "image/jpeg" });
    }
    offset += 2 + length;
  }
  const jfif = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0]);
  const header = new DataView(jfif.buffer);
  header.setUint16(12, dpi);
  header.setUint16(14, dpi);
  return new Blob([bytes.slice(0, 2), jfif, bytes.slice(2)], { type: "image/jpeg" });
}
