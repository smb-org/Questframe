import { describe, expect, it } from "vitest";

import { inspectWebP } from "../../../src/shared/media/webp";

const vp8x = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  const riffSize = bytes.length - 8;
  new DataView(bytes.buffer).setUint32(4, riffSize, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const view = new DataView(bytes.buffer);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  view.setUint8(24, widthMinusOne & 0xff);
  view.setUint8(25, (widthMinusOne >> 8) & 0xff);
  view.setUint8(26, (widthMinusOne >> 16) & 0xff);
  view.setUint8(27, heightMinusOne & 0xff);
  view.setUint8(28, (heightMinusOne >> 8) & 0xff);
  view.setUint8(29, (heightMinusOne >> 16) & 0xff);
  return bytes;
};

const simpleWebP = (chunk: "VP8 " | "VP8L", width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set(Array.from(chunk, (value) => value.charCodeAt(0)), 12);
  const view = new DataView(bytes.buffer);
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else {
    bytes[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  }
  return bytes;
};

describe("WebP boundary inspection", () => {
  it("reads VP8X dimensions without decoding image content", () => {
    expect(inspectWebP(vp8x(512, 320))).toEqual({ width: 512, height: 320 });
  });

  it("rejects non-WebP, truncated, too-small and too-large portraits", () => {
    expect(() => inspectWebP(new Uint8Array(30))).toThrow(/WebP/);
    expect(() => inspectWebP(vp8x(31, 64))).toThrow(/32/);
    expect(() => inspectWebP(vp8x(513, 64))).toThrow(/512/);
    expect(() => inspectWebP(vp8x(64, 64).slice(0, 20))).toThrow(/WebP/);
  });

  it("reads lossy VP8 and lossless VP8L dimensions", () => {
    expect(inspectWebP(simpleWebP("VP8 ", 320, 240))).toEqual({ width: 320, height: 240 });
    expect(inspectWebP(simpleWebP("VP8L", 128, 96))).toEqual({ width: 128, height: 96 });
  });

  it("rejects lying RIFF lengths, bad signatures and unsupported chunks", () => {
    const lying = vp8x(64, 64);
    new DataView(lying.buffer).setUint32(4, 1000, true);
    expect(() => inspectWebP(lying)).toThrow(/vollständiges/);

    const lossy = simpleWebP("VP8 ", 64, 64);
    lossy[23] = 0;
    expect(() => inspectWebP(lossy)).toThrow(/unterstütztes/);
    const lossless = simpleWebP("VP8L", 64, 64);
    lossless[20] = 0;
    expect(() => inspectWebP(lossless)).toThrow(/unterstütztes/);
    const unsupported = vp8x(64, 64);
    unsupported.set([0x4a, 0x55, 0x4e, 0x4b], 12);
    expect(() => inspectWebP(unsupported)).toThrow(/unterstütztes/);
  });
});
