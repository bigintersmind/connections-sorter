// Unit tests for the tile shrink-to-fit arithmetic (src/fitTileFont.js).
//
// The real geometry (does PERISHABLE fit at 8.5px in a 320px column?) depends
// on the font and the layout engine and is verified in-browser. What's tested
// here is the pure sizing rule behind it — fitTileFontSize — fed a stub
// measurer with a simple, predictable width model, so the wrap simulation,
// the half-pixel grid, the floor, the +1px tolerance, letter-spacing and the
// tile-width-dependent cap are all pinned down without a DOM. fitTileFonts,
// the canvas-and-DOM shim around it, is exercised by hand in the browser
// like the rest of App.jsx. Runs as plain Node, like worker/puzzle.test.js.

import { describe, expect, it } from "vitest";
import {
  BASE_TILE_FONT,
  MAX_TILE_FONT,
  MIN_TILE_FONT,
  TILE_FONT_STEP,
  fitTileFontSize,
  tileFontCap,
} from "./fitTileFont.js";

// A monospace-ish model: every character is 0.6em wide. Kerning-free and
// linear, so expected widths can be worked out by hand.
const EM = 0.6;
const measure = (text, size) => text.length * size * EM;

// A generous square: 100px content box fits anything short at 14px.
const box = { width: 100, height: 100, measure };

const fit = (overrides) => fitTileFontSize({ ...box, ...overrides });

// The largest half-step at which `chars` characters fit `width` (+4px of
// tolerated overhang) under the model — what the function should find by
// stepping down.
const expectedFor = (chars, width, cap = BASE_TILE_FONT) => {
  let size = cap;
  while (size > MIN_TILE_FONT && chars * size * EM > width + 4) size -= TILE_FONT_STEP;
  return size;
};

describe("fitTileFontSize", () => {
  it("leaves a word that already fits at the cap", () => {
    expect(fit({ text: "ECHO" })).toBe(BASE_TILE_FONT);
  });

  it("steps a long word down on the half-pixel grid to the first size that fits", () => {
    // 12 chars × 0.6em: 64.8px at 9 fits a 62px box (66 with tolerance),
    // 68.4px at 9.5 doesn't.
    const size = fit({ text: "PENNSYLVANIA", width: 62 });
    expect(size).toBe(expectedFor(12, 62));
    expect(size).toBe(9);
    expect((size / TILE_FONT_STEP) % 1).toBe(0);
  });

  it("returns exactly the largest fitting size, never one step too small", () => {
    for (const width of [40, 55, 63, 70, 84, 99]) {
      const size = fit({ text: "TOOTHPASTE", width });
      expect(size).toBe(expectedFor(10, width));
      // One more half-step would overflow (or we're already at the cap).
      if (size < BASE_TILE_FONT) expect(10 * (size + TILE_FONT_STEP) * EM).toBeGreaterThan(width + 4);
    }
  });

  it("never shrinks below the MIN_TILE_FONT floor even if still overflowing", () => {
    expect(fit({ text: "SUPERCALIFRAGILISTIC", width: 20 })).toBe(MIN_TILE_FONT);
  });

  it("tolerates up to 4px of overhang (2px a side, into the padding) without shrinking", () => {
    // ABCD at 14px = 33.6px wide. A 29.7px box is 3.9px short: still fits.
    expect(fit({ text: "ABCD", width: 29.7 })).toBe(BASE_TILE_FONT);
    // 4.1px short: shrinks.
    expect(fit({ text: "ABCD", width: 29.5 })).toBeLessThan(BASE_TILE_FONT);
  });

  it("wraps at spaces rather than shrinking, when the lines fit the height", () => {
    // Joined, MAGIC WAND is 10 chars = 84px at 14: too wide for 60. Wrapped,
    // WAND/MAGIC are 33.6 and 42 wide — both fit — and two lines are
    // 2 × 14 × 1.15 = 32.2px tall, well inside 100.
    expect(fit({ text: "MAGIC WAND", width: 60 })).toBe(BASE_TILE_FONT);
  });

  it("keeps words on one line while they fit, and shrinks only for the widest word", () => {
    // TOP HAT = 7 chars = 58.8px at 14 → one line in a 60px box, no shrink.
    expect(fit({ text: "TOP HAT", width: 60 })).toBe(BASE_TILE_FONT);
    // With PERISHABLE as one of the words, the size is set by that word alone,
    // exactly as it would be for the word on its own.
    expect(fit({ text: "A PERISHABLE B", width: 60 })).toBe(fit({ text: "PERISHABLE", width: 60 }));
  });

  it("shrinks when the wrapped lines are taller than the box", () => {
    // Four 3-letter words: each is 25.2px at 14 (fits a 30px line) but any
    // two joined are 58.8px (don't), so it's four lines — 64.4px tall at 14.
    // A 40px-tall box forces a size where 4 × size × 1.15 ≤ 44 → 9.5.
    const size = fit({ text: "AAA BBB CCC DDD", width: 30, height: 40 });
    expect(size).toBe(9.5);
    expect(4 * size * 1.15).toBeLessThanOrEqual(44);
    expect(4 * (size + TILE_FONT_STEP) * 1.15).toBeGreaterThan(44);
  });

  it("uses the caller's line-height for the height check", () => {
    const tight = fit({ text: "AAA BBB CCC DDD", width: 30, height: 40, lineHeight: 1 });
    const loose = fit({ text: "AAA BBB CCC DDD", width: 30, height: 40, lineHeight: 1.5 });
    expect(tight).toBe(11); // 4 × 11 = 44 ≤ 44, 4 × 11.5 = 46 doesn't
    expect(loose).toBe(MIN_TILE_FONT); // 6 × 8 = 48 > 44: the floor, and it clips
  });

  it("adds letter-spacing after every character, the last one included", () => {
    // ABCD at 14px is 33.6px; with 1px tracking it's 37.6px — over a 33px box
    // by 4.6px, past the tolerance, so it shrinks; without tracking it fits.
    expect(fit({ text: "ABCD", width: 33 })).toBe(BASE_TILE_FONT);
    expect(fit({ text: "ABCD", width: 33, letterSpacing: 1 })).toBeLessThan(BASE_TILE_FONT);
  });

  it("collapses runs of whitespace like the browser does", () => {
    expect(fit({ text: "  MAGIC   WAND ", width: 60 })).toBe(fit({ text: "MAGIC WAND", width: 60 }));
  });

  it("returns the cap for empty text", () => {
    expect(fit({ text: "   " })).toBe(BASE_TILE_FONT);
  });

  it("honours a larger cap and still fits the word to the box", () => {
    // At cap 18.5 ECHO is 44.4px: fits 100. TOOTHPASTE at 18.5 is 111px: must
    // step down from the cap, not from 14.
    expect(fit({ text: "ECHO", cap: 18.5 })).toBe(18.5);
    const size = fit({ text: "TOOTHPASTE", cap: 18.5 });
    expect(size).toBe(expectedFor(10, 100, 18.5));
    expect(size).toBeGreaterThan(BASE_TILE_FONT);
  });
});

describe("tileFontCap", () => {
  it("is the phone cap for phone-sized tiles", () => {
    // 320px and 390px viewports: 70.5px and 88px tiles.
    expect(tileFontCap(70.5)).toBe(BASE_TILE_FONT);
    expect(tileFontCap(88)).toBe(BASE_TILE_FONT);
  });

  it("grows with the tile above that, on the half-pixel grid", () => {
    expect(tileFontCap(98)).toBe(15.5); // 430px phone
    expect(tileFontCap(115.5)).toBe(18.5); // the 500px desktop board
    for (const w of [90, 97, 103, 110, 119]) {
      const cap = tileFontCap(w);
      expect((cap / TILE_FONT_STEP) % 1).toBe(0);
      expect(cap).toBeGreaterThanOrEqual(BASE_TILE_FONT);
      expect(cap).toBeLessThanOrEqual(MAX_TILE_FONT);
    }
  });

  it("never exceeds the absolute cap", () => {
    expect(tileFontCap(200)).toBe(MAX_TILE_FONT);
    expect(tileFontCap(1000)).toBe(MAX_TILE_FONT);
  });

  it("is monotonic in tile width", () => {
    let last = 0;
    for (let w = 40; w <= 200; w += 1) {
      const cap = tileFontCap(w);
      expect(cap).toBeGreaterThanOrEqual(last);
      last = cap;
    }
  });
});
