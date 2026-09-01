// Drag-to-swap: the rules behind pressing a tile, dragging it across the board
// and dropping it on another one. Pure and framework-free so they're unit
// tested (src/dragSwap.test.js) without a DOM; App.jsx owns the pointer
// plumbing — capture, the transform that follows the finger, the store write —
// and is verified by hand in the browser like the rest of the board.
//
// Drag and tap answer to the same rules: a locked row is settled, so its tiles
// neither travel nor accept a traveller, and a release that lands nowhere
// valid is simply not a swap.
//
// Coordinates: every function here takes rects and points in ONE space and
// never mixes them. App.jsx works in PAGE coordinates (see toPageRect) so a
// scroll partway through a drag can't desync a measurement taken before it.

// How far the pointer has to travel before a press stops being a tap and
// becomes a drag. Below this the press is still a tap, so tap-to-swap, the
// `:active` scale and hover all behave exactly as they did. Sized to clear a
// finger's natural jitter without making a deliberate drag feel sticky.
export const DRAG_THRESHOLD_PX = 7;

// A DOMRect is viewport-relative and goes stale the moment the page scrolls;
// page coordinates don't. Takes the four edges rather than a DOMRect so it can
// be called with a plain object in a test.
export function toPageRect(rect, scrollX, scrollY) {
  return {
    left: rect.left + scrollX,
    right: rect.right + scrollX,
    top: rect.top + scrollY,
    bottom: rect.bottom + scrollY,
  };
}

// Has the pointer moved far enough from the press to mean a drag? Compared
// squared, so no square root and no axis is privileged — the threshold is a
// circle around the press, not a box.
export function passedDragThreshold(dx, dy, threshold = DRAG_THRESHOLD_PX) {
  return dx * dx + dy * dy >= threshold * threshold;
}

// Is this tile in play — can it be picked up, and can something be dropped on
// it? The same test handleTap applies before a tap swap: a locked row is out.
export function isTileInPlay(index, lockedRows) {
  if (!Number.isInteger(index) || index < 0 || index > 15) return false;
  return !lockedRows[Math.floor(index / 4)];
}

// The tile whose box contains the point, or null when the point is off the
// board. `rects` is indexed by tile index and may have holes: it's read off
// the live tile elements, and one that hasn't mounted is null. Tile boxes
// don't overlap, so the first hit is the only hit.
export function tileIndexAt(rects, x, y) {
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (!rect) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return i;
  }
  return null;
}

// Where a drag that started on `from` would land if it were released at
// (x, y) — or null, which is every way a release does nothing: off the board,
// back on the tile it came from, on a locked row's tile, or from a tile whose
// OWN row was locked under it while it was in the air. Both ends are checked
// at the moment of release, not just the destination: the lock button stays
// reachable while a tile is held (keyboard Space, a second finger), and
// handleTap re-checks the picked-up tile's row the same way before a tap swap.
export function dropTargetIndex(rects, x, y, from, lockedRows) {
  if (!isTileInPlay(from, lockedRows)) return null;
  const over = tileIndexAt(rects, x, y);
  if (over === null || over === from) return null;
  return isTileInPlay(over, lockedRows) ? over : null;
}
