export const RASTER_WIDTH = 384;
export const RASTER_HEIGHT = 216;
export const PIXELS_PER_RASTER_UNIT = 5;
export const PIXELS_PER_HUD_UNIT = 1;

export type StagePixelPoint = {
  x: number;
  y: number;
};

export type RasterPoint = {
  x: number;
  y: number;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** Converts displayed stage pixels into persisted placement coordinates. */
export const stagePixelsToRaster = (
  point: StagePixelPoint,
  pixelsPerUnit = PIXELS_PER_RASTER_UNIT,
): RasterPoint => {
  return {
    x: clamp(Math.round(point.x / pixelsPerUnit), 0, RASTER_WIDTH),
    y: clamp(Math.round(point.y / pixelsPerUnit), 0, RASTER_HEIGHT),
  };
};
