// Unit tests for dragSwap.js — the rules behind drag-to-swap (src/dragSwap.js).
//
// The pointer plumbing is a browser thing and is verified by hand; what can
// drift silently is the arithmetic underneath it — a threshold that turns taps
// into drags, a hit test that lets a locked row take a drop, a coordinate
// space that desyncs after a scroll. Runs as plain Node, like share.test.js.

import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  dropTargetIndex,
  isTileInPlay,
  passedDragThreshold,
  shouldCancelPointerPress,
  tileIndexAt,
  toPageRect,
} from "./dragSwap.js";

const NO_LOCKS = [false, false, false, false];

// A 4x4 board of 100x100 tiles with no gap, its top-left corner at (0, 0), in
// whatever space the caller is working in. Tile i covers
// [col*100, col*100+100] x [row*100, row*100+100].
function board({ offsetX = 0, offsetY = 0 } = {}) {
  return Array.from({ length: 16 }, (_, i) => {
    const left = offsetX + (i % 4) * 100;
    const top = offsetY + Math.floor(i / 4) * 100;
    return { left, right: left + 100, top, bottom: top + 100 };
  });
}

describe("passedDragThreshold", () => {
  it("keeps a still press, and a jitter under the threshold, a tap", () => {
    expect(passedDragThreshold(0, 0)).toBe(false);
    expect(passedDragThreshold(4, 4)).toBe(false);
    expect(passedDragThreshold(-6, 0)).toBe(false);
  });

  it("becomes a drag once the pointer clears the threshold on any axis", () => {
    expect(passedDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(passedDragThreshold(0, -DRAG_THRESHOLD_PX)).toBe(true);
    expect(passedDragThreshold(20, 30)).toBe(true);
  });

  it("measures a circle, not a box: diagonal travel counts on both axes", () => {
    // 5,5 is 7.07px away — over the 7px threshold, though neither axis is.
    expect(passedDragThreshold(5, 5)).toBe(true);
    expect(passedDragThreshold(5, 0)).toBe(false);
  });

  it("takes an explicit threshold", () => {
    expect(passedDragThreshold(9, 0, 12)).toBe(false);
    expect(passedDragThreshold(12, 0, 12)).toBe(true);
  });
});

describe("shouldCancelPointerPress", () => {
  it("accepts only the live pointer's own cancel", () => {
    expect(shouldCancelPointerPress(17, 17)).toBe(true);
    expect(shouldCancelPointerPress(17, 23)).toBe(false);
  });
});

describe("toPageRect", () => {
  it("shifts a viewport rect by the scroll offset", () => {
    expect(toPageRect({ left: 10, right: 60, top: 20, bottom: 70 }, 5, 200)).toEqual({
      left: 15,
      right: 65,
      top: 220,
      bottom: 270,
    });
  });

  it("is the identity at the top of the page", () => {
    const rect = { left: 10, right: 60, top: 20, bottom: 70 };
    expect(toPageRect(rect, 0, 0)).toEqual(rect);
  });

  it("keeps a rect and a pointer in step across a scroll", () => {
    // The tile sits 300px down the page. Measured before a 250px scroll and
    // hit-tested after it, the same page point still lands inside it.
    const before = toPageRect({ left: 0, right: 100, top: 300, bottom: 400 }, 0, 0);
    const pointerAfterScroll = 60 + 250; // clientY 60 once the page scrolled 250
    expect(tileIndexAt([before], 50, pointerAfterScroll)).toBe(0);
  });
});

describe("isTileInPlay", () => {
  it("accepts every tile when nothing is locked", () => {
    for (let i = 0; i < 16; i++) expect(isTileInPlay(i, NO_LOCKS)).toBe(true);
  });

  it("rules out every tile of a locked row, and only that row", () => {
    const locks = [false, true, false, false];
    expect(isTileInPlay(3, locks)).toBe(true);
    for (let i = 4; i < 8; i++) expect(isTileInPlay(i, locks)).toBe(false);
    expect(isTileInPlay(8, locks)).toBe(true);
  });

  it("rejects anything that isn't a board index", () => {
    expect(isTileInPlay(-1, NO_LOCKS)).toBe(false);
    expect(isTileInPlay(16, NO_LOCKS)).toBe(false);
    expect(isTileInPlay(1.5, NO_LOCKS)).toBe(false);
    expect(isTileInPlay(null, NO_LOCKS)).toBe(false);
  });
});

describe("tileIndexAt", () => {
  const rects = board();

  it("finds the tile under the point", () => {
    expect(tileIndexAt(rects, 50, 50)).toBe(0);
    expect(tileIndexAt(rects, 350, 50)).toBe(3);
    expect(tileIndexAt(rects, 50, 350)).toBe(12);
    expect(tileIndexAt(rects, 250, 150)).toBe(6);
  });

  it("returns null off the board", () => {
    expect(tileIndexAt(rects, -1, 50)).toBeNull();
    expect(tileIndexAt(rects, 50, 401)).toBeNull();
    expect(tileIndexAt(rects, 500, 500)).toBeNull();
  });

  it("counts the edges as inside, so a drop on a border still lands", () => {
    expect(tileIndexAt(rects, 0, 0)).toBe(0);
    expect(tileIndexAt([rects[5]], 200, 200)).toBe(0);
  });

  it("skips tiles that haven't mounted", () => {
    const withHole = [...rects];
    withHole[0] = null;
    expect(tileIndexAt(withHole, 50, 50)).toBeNull();
    expect(tileIndexAt(withHole, 150, 50)).toBe(1);
  });

  it("works in an offset space, so a scrolled or inset board hits the same", () => {
    const offset = board({ offsetX: 40, offsetY: 900 });
    expect(tileIndexAt(offset, 90, 950)).toBe(0);
    expect(tileIndexAt(offset, 50, 50)).toBeNull();
  });
});

describe("dropTargetIndex", () => {
  const rects = board();

  it("lands on the tile under the release point", () => {
    expect(dropTargetIndex(rects, 250, 150, 0, NO_LOCKS)).toBe(6);
  });

  it("cancels when the release is off the board", () => {
    expect(dropTargetIndex(rects, 800, 150, 0, NO_LOCKS)).toBeNull();
  });

  it("cancels when the tile is dropped back on itself", () => {
    expect(dropTargetIndex(rects, 50, 50, 0, NO_LOCKS)).toBeNull();
  });

  it("cancels over a locked row: locked tiles are not drop targets", () => {
    const locks = [false, false, true, false];
    expect(dropTargetIndex(rects, 50, 250, 0, locks)).toBeNull();
    // The unlocked row below it still takes the drop.
    expect(dropTargetIndex(rects, 50, 350, 0, locks)).toBe(12);
  });

  it("swaps across rows and within one alike", () => {
    expect(dropTargetIndex(rects, 150, 50, 0, NO_LOCKS)).toBe(1);
    expect(dropTargetIndex(rects, 150, 350, 0, NO_LOCKS)).toBe(13);
  });

  it("cancels when the source's own row was locked under it mid-drag", () => {
    // Tile 0 was picked up unlocked; its row got locked while it was in the
    // air. The release over an unlocked tile must not move it.
    const locks = [true, false, false, false];
    expect(dropTargetIndex(rects, 250, 150, 0, locks)).toBeNull();
    // The same release from a source that is still in play lands as before.
    expect(dropTargetIndex(rects, 250, 150, 4, locks)).toBe(6);
  });

  it("re-checks both ends: a source and a target in different locked rows", () => {
    const locks = [true, false, true, false];
    expect(dropTargetIndex(rects, 50, 250, 0, locks)).toBeNull();
    expect(dropTargetIndex(rects, 50, 350, 0, locks)).toBeNull();
    expect(dropTargetIndex(rects, 50, 350, 4, locks)).toBe(12);
  });
});
