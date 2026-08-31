import { describe, expect, it } from "vitest";

import { stagePixelsToRaster } from "../../../src/admin/ui/placement";

describe("Kompositions-Placement", () => {
  it("rechnet logische Bühnenpixel ins 5-Pixel-Raster um", () => {
    expect(stagePixelsToRaster({ x: 250, y: 125 })).toEqual({ x: 50, y: 25 });
  });

  it("rechnet HUD-Bühnenpixel 1:1 in HUD-Einheiten um", () => {
    expect(stagePixelsToRaster({ x: 250, y: 125 }, 1)).toEqual({ x: 250, y: 125 });
  });

  it("klemmt außerhalb der Bühne auf den erlaubten Bereich", () => {
    expect(stagePixelsToRaster({ x: -100, y: -1 })).toEqual({ x: 0, y: 0 });
    expect(stagePixelsToRaster({ x: 3_000, y: 2_000 })).toEqual({ x: 384, y: 216 });
    expect(stagePixelsToRaster({ x: 3_000, y: 2_000 }, 1)).toEqual({ x: 384, y: 216 });
  });
});
