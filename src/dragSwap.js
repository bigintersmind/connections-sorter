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

// The two scales a drag puts on screen, shared by the live drag (App.jsx's
// liftTransform) and by the settle seeds below so the two can't drift apart.
// They're a matched pair: the carried tile rides at 1.04 under the finger and
// the tile it's over swells to 1.06, so the target's 3px ring stays visible
// around the tile landing on it. Swap them round and the ring disappears.
export const DRAG_LIFT_SCALE = 1.04;
export const DROP_TARGET_SCALE = 1.06;

// The settle after a committed drop, in two spans, both timed by App.jsx
// against transitions that live in index.css — so dragSwap.test.js reads the
// stylesheet and checks the numbers still agree.
//
// The glide is .tile's own `transform 0.15s`: the frame the seeds come off,
// both tiles start moving, and by SETTLE_GLIDE_MS each is at rest in its new
// cell. That is exactly how long the displaced tile spends lifted over cells
// that aren't its own, which is how long a press has to fall through it
// (.tile-crossing) — bound the dead spot to any longer and a quick grab of
// the tile that just landed in the vacated cell would miss.
export const SETTLE_GLIDE_MS = 150;
// The whole settle runs past the longest transition .tile has — the 0.3s
// box-shadow, which fades the carried tile's drop and the target's ring — so
// the lift that keeps both tiles above the board is only ever taken away once
// nothing of the settle is still painting.
export const SETTLE_MS = 320;

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

// A refused second contact can still emit pointercancel on its tile. Only the
// pointer that owns the live press is allowed to cancel it.
export function shouldCancelPointerPress(activePointerId, cancelledPointerId) {
  return activePointerId === cancelledPointerId;
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

// The two tiles a committed drop leaves in flight, expressed as the transforms
// they need on the FIRST frame after the swap so that frame is a pure re-seat:
// nothing moves, the carried word is still under the finger. Tile identity is
// positional (key={idx}), so the swap hands the element at `over` the word the
// player was carrying and the element at `from` the word that was sitting on
// the target — each has to start where its new word visually was on the last
// held frame, and only then be let go so .tile's transform transition (0.15s,
// index.css) carries it to rest. That's the FLIP: seed, unseed, transition.
//
// `rects` is the same page-coordinate measurement the drag took on its first
// move, so this costs no layout; dx/dy are how far the pointer travelled from
// the press, read off the release event rather than the last rendered frame.
export function settleTransforms(rects, from, over, dx, dy) {
  const source = rects[from];
  const target = rects[over];
  return {
    // The element at `over` now carries the dragged word: put it back exactly
    // where the carried tile was — its own cell, offset by the gap between the
    // two cells and by the pointer's travel — at the carried scale.
    arriving:
      `translate(${source.left - target.left + dx}px, ${source.top - target.top + dy}px)` +
      ` scale(${DRAG_LIFT_SCALE})`,
    // The element at `from` now carries the displaced word: put it back on the
    // drop target's cell, at the scale the drop target was holding. No dx/dy —
    // that tile never followed the pointer.
    displaced:
      `translate(${target.left - source.left}px, ${target.top - source.top}px)` +
      ` scale(${DROP_TARGET_SCALE})`,
  };
}
