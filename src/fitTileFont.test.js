// Unit tests for fitTileFont — the shrink-to-fit loop that sizes Connections
// tile text (src/fitTileFont.js).
//
// The real overflow geometry (does PENNSYLVANIA fit at 8px in a 375px column?)
// depends on the font and the layout engine and is verified in-browser. But the
// step-down loop itself is pure control flow over four numbers, so we exercise
// it here with a fake element — no jsdom, no real layout. These lock down the
// 0.5px decrement, the MIN_TILE_FONT floor, and the +1px sub-pixel tolerance:
// all silent-regression risks a refactor could change with no crash and no lint
// error. Runs as plain Node, like worker/puzzle.test.js.

import { describe, expect, it } from "vitest";
import { fitTileFont, MIN_TILE_FONT, MAX_TILE_FONT } from "./fitTileFont.js";

// A stand-in for the tile <button>. `overflowsAtOrAbove` is the font size at or
// above which the content is treated as overflowing its box; below it, it fits.
// fitTileFont only reads scrollWidth/clientWidth/scrollHeight/clientHeight and
// writes style.fontSize, so a getter keyed off the current fontSize suffices.
function fakeTile({ overflowsAtOrAbove = Infinity, clientWidth = 100, clientHeight = 100 } = {}) {
  const el = { style: {}, clientWidth, clientHeight };
  const fs = () => parseFloat(el.style.fontSize);
  Object.defineProperty(el, "scrollWidth", {
    get: () => (fs() >= overflowsAtOrAbove ? clientWidth + 50 : clientWidth - 50),
  });
  Object.defineProperty(el, "scrollHeight", { get: () => clientHeight - 50 });
  return el;
}

describe("fitTileFont", () => {
  it("leaves a tile that already fits at the max font", () => {
    const el = fakeTile({ overflowsAtOrAbove: Infinity });
    fitTileFont(el);
    expect(parseFloat(el.style.fontSize)).toBe(MAX_TILE_FONT);
  });

  it("steps down by 0.5px and stops at the first size that fits", () => {
    // Overflows at every size >= 12; the first fitting step below that is 11.5,
    // proving the loop decrements by 0.5 and stops as soon as it fits.
    const el = fakeTile({ overflowsAtOrAbove: 12 });
    fitTileFont(el);
    expect(parseFloat(el.style.fontSize)).toBe(11.5);
  });

  it("never shrinks below the MIN_TILE_FONT floor even if still overflowing", () => {
    const el = fakeTile({ overflowsAtOrAbove: 0 }); // overflows at every size
    fitTileFont(el);
    expect(parseFloat(el.style.fontSize)).toBe(MIN_TILE_FONT);
  });

  it("tolerates exactly 1px of overflow without shrinking", () => {
    const el = { style: {}, clientWidth: 100, clientHeight: 100 };
    Object.defineProperty(el, "scrollWidth", { get: () => 101 }); // clientWidth + 1
    Object.defineProperty(el, "scrollHeight", { get: () => 100 });
    fitTileFont(el);
    expect(parseFloat(el.style.fontSize)).toBe(MAX_TILE_FONT);
  });

  it("shrinks when overflow exceeds the 1px tolerance", () => {
    const el = { style: {}, clientWidth: 100, clientHeight: 100 };
    Object.defineProperty(el, "scrollWidth", { get: () => 102 }); // past the +1 slack
    Object.defineProperty(el, "scrollHeight", { get: () => 100 });
    fitTileFont(el);
    expect(parseFloat(el.style.fontSize)).toBeLessThan(MAX_TILE_FONT);
  });

  it("shrinks on vertical overflow, not just horizontal", () => {
    const el = { style: {}, clientWidth: 100, clientHeight: 100 };
    Object.defineProperty(el, "scrollWidth", { get: () => 100 });
    Object.defineProperty(el, "scrollHeight", { get: () => 200 });
    fitTileFont(el);
    expect(parseFloat(el.style.fontSize)).toBe(MIN_TILE_FONT);
  });
});
