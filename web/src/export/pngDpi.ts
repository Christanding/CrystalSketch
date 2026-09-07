import { DEFAULT_EXPORT_DPI } from "../model/exportSettings";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function withPngDpi(blob: Blob, dpi: number = DEFAULT_EXPORT_DPI): Promise<Blob> {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("PNG DPI is invalid.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 33 || new DataView(bytes.buffer).getUint32(0) !== 0x89504e47) {
    throw new Error("无法写入 DPI：PNG 数据无效");
  }
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set(new TextEncoder().encode("pHYs"), 4);
  const density = Math.round(dpi / .0254);
  view.setUint32(8, density);
  view.setUint32(12, density);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const parts: BlobPart[] = [bytes.slice(0, 33), chunk];
  const input = new DataView(bytes.buffer);
  for (let offset = 33; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("PNG 数据不完整");
    const end = offset + input.getUint32(offset) + 12;
    if (end > bytes.length) throw new Error("PNG 数据不完整");
    if (input.getUint32(offset + 4) !== 0x70485973) parts.push(bytes.slice(offset, end));
    offset = end;
  }
  return new Blob(parts, { type: "image/png" });
}
