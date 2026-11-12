import { describe, expect, it } from "vitest";

import { loadBingoStyle } from "../../../src/bingo/style-loader";

describe("Bingo-Stilchunks", () => {
  it("lädt Broadcast dynamisch", async () => {
    await expect(loadBingoStyle("broadcast")).resolves.toBeUndefined();
  });
});
