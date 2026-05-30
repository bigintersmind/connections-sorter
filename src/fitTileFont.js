// Shrink-to-fit sizing for Connections tile text, matching the official app:
// words never break mid-string. Multi-word entries wrap at spaces; a single
// word that's too wide shrinks instead. CSS can't size text to its own length,
// so we measure the rendered button and step the font down until the content
// stops overflowing its square (or hits the floor).
//
// Kept out of App.jsx (like clipboardImage.js / worker/puzzle.js) because it's
// pure DOM-in/DOM-out: the React side owns *when* to call it (pre-paint, on
// resize, and once the web font loads); isolating the algorithm here lets it be
// unit-tested without a layout engine.
export const MAX_TILE_FONT = 14;
export const MIN_TILE_FONT = 8;

export function fitTileFont(el) {
  let fs = MAX_TILE_FONT;
  el.style.fontSize = fs + "px";
  // +1px tolerance absorbs sub-pixel rounding so tiles that already fit don't
  // shrink a needless step.
  while (
    fs > MIN_TILE_FONT &&
    (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
  ) {
    fs -= 0.5;
    el.style.fontSize = fs + "px";
  }
}
