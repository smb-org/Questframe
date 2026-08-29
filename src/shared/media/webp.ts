export type ImageDimensions = { width: number; height: number };

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const byteAt = (bytes: Uint8Array, offset: number): number => bytes[offset] ?? 0;

const uint24 = (bytes: Uint8Array, offset: number): number =>
  byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8) | (byteAt(bytes, offset + 2) << 16);

const validateDimensions = (width: number, height: number): ImageDimensions => {
  if (width < 32 || height < 32) throw new Error("WebP muss mindestens 32 × 32 Pixel groß sein.");
  if (width > 512 || height > 512) throw new Error("WebP darf höchstens 512 × 512 Pixel groß sein.");
  return { width, height };
};

export const inspectWebP = (bytes: Uint8Array): ImageDimensions => {
  if (
    bytes.byteLength < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    throw new Error("Datei ist kein vollständiges WebP.");
  }
  const declaredSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
  if (declaredSize > bytes.byteLength) throw new Error("Datei ist kein vollständiges WebP.");
  const chunk = ascii(bytes, 12, 4);
  const dataOffset = 20;

  if (chunk === "VP8X") {
    return validateDimensions(
      uint24(bytes, dataOffset + 4) + 1,
      uint24(bytes, dataOffset + 7) + 1,
    );
  }

  if (
    chunk === "VP8 " &&
    bytes[dataOffset + 3] === 0x9d &&
    bytes[dataOffset + 4] === 0x01 &&
    bytes[dataOffset + 5] === 0x2a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return validateDimensions(
      view.getUint16(dataOffset + 6, true) & 0x3fff,
      view.getUint16(dataOffset + 8, true) & 0x3fff,
    );
  }

  if (chunk === "VP8L" && bytes[dataOffset] === 0x2f) {
    const bits =
      byteAt(bytes, dataOffset + 1) |
      (byteAt(bytes, dataOffset + 2) << 8) |
      (byteAt(bytes, dataOffset + 3) << 16) |
      (byteAt(bytes, dataOffset + 4) << 24);
    return validateDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }

  throw new Error("Nicht unterstütztes WebP-Profil.");
};
