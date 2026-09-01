// Shrink-to-fit sizing for Connections tile text, matching the official app:
// words never break mid-string. Multi-word entries wrap at spaces; a single
// word that's too wide shrinks instead. CSS can't size text to its own length,
// so the text is measured and the font stepped down until it fits its square
// (or hits the floor).
//
// The measuring happens on a canvas, not in the DOM. The earlier version wrote
// a font size to each tile and read `scrollWidth` back, in a loop — every
// read after a write forces a synchronous layout, and 16 tiles × up to 12
// steps meant a pass could force 192 of them, on every resize event. Now a
// pass reads each tile's geometry once (all reads, then all writes, so at most
// one layout is forced), measures the words on a shared 2D context with the
// tile's own font, and writes each tile's size once. `fitTileFontSize` is the
// arithmetic, pure and unit-tested with a stub measurer; `fitTileFonts` is the
// thin DOM shim around it that App.jsx calls (pre-paint, on resize via a
// ResizeObserver, and once the web font lands).

// The cap is 14px on a phone — the size the official app uses — and grows
// with the tile above that so a 115px desktop tile doesn't carry phone-sized
// type: a fixed fraction of the tile's width, on the half-pixel grid, between
// the phone cap and an absolute cap. 0.16 keeps a 390px phone's 88px tiles at
// exactly 14 and lands a 500px board's tiles at 18.5.
export const BASE_TILE_FONT = 14;
export const MAX_TILE_FONT = 20;
export const MIN_TILE_FONT = 8;
export const TILE_FONT_STEP = 0.5;
const TILE_FONT_RATIO = 0.16;

// Overhang tolerance, in px: text that runs past its content box by up to this
// much is treated as fitting. The tile centres its text, so the overhang is
// split between the two sides — 2px each, into 5px of padding — and a tile
// that fits to the eye doesn't shrink a needless step. Calibrated in-browser
// against the old scrollWidth loop, which accepted 1px of scrollWidth
// overflow — but scrollWidth only sees the far half of a centred overhang,
// floored, so anything under 4px passed. At 1–3 the long words sat a
// half-step smaller than before at some widths; at 4 no word is smaller, a
// few long ones are a half-step larger, and every text box still sits 4px or
// more inside the tile's border (checked from 320 to 1280px).
const TOLERANCE = 4;

export function tileFontCap(tileWidth) {
  const scaled = Math.round((tileWidth * TILE_FONT_RATIO) / TILE_FONT_STEP) * TILE_FONT_STEP;
  return Math.min(MAX_TILE_FONT, Math.max(BASE_TILE_FONT, scaled));
}

// The largest font size on the half-pixel grid, from `cap` down to
// MIN_TILE_FONT, at which `text` fits a content box of `width` × `height`:
// no line wider than the box, and the wrapped lines together no taller than
// it. Below the floor the caller's `overflow: hidden` takes over.
//
// `measure(text, size)` is the advance width of `text` set at `size` px in the
// tile's font; letter-spacing is added here (CSS adds it after every
// character, the last included), so the measurer needn't know about it.
// Wrapping is simulated the way the browser wraps `white-space: normal` text
// with `overflow-wrap: normal`: greedy, breaking only at spaces. (The browser
// may also break after a hyphen; not modelling that only ever errs toward a
// smaller size, never toward overflow.)
export function fitTileFontSize({
  text,
  width,
  height,
  cap = BASE_TILE_FONT,
  measure,
  lineHeight = 1.15,
  letterSpacing = 0,
}) {
  const words = text.trim().split(/[ \t\n\r]+/).filter(Boolean);
  if (words.length === 0) return cap;
  const widthOf = (run, size) => measure(run, size) + letterSpacing * [...run].length;

  // Integer half-steps, so the sizes come out exact (14, 13.5, …) rather than
  // accumulating float error.
  for (let half = Math.round(cap / TILE_FONT_STEP); half >= MIN_TILE_FONT / TILE_FONT_STEP; half--) {
    const size = half * TILE_FONT_STEP;
    if (fits(words, size, width, height, lineHeight, widthOf)) return size;
  }
  // Nothing fit, not even the floor: the floor it is, and the tile clips.
  return MIN_TILE_FONT;
}

function fits(words, size, width, height, lineHeight, widthOf) {
  let lines = 1;
  let line = words[0];
  let widest = widthOf(line, size);
  if (widest > width + TOLERANCE) return false;
  for (let i = 1; i < words.length; i++) {
    const candidate = `${line} ${words[i]}`;
    if (widthOf(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    lines++;
    line = words[i];
    const w = widthOf(line, size);
    if (w > width + TOLERANCE) return false;
    widest = Math.max(widest, w);
  }
  return lines * size * lineHeight <= height + TOLERANCE;
}

// ---- DOM shim ------------------------------------------------------------

let context = null;

// Fit every tile in `tiles` (null entries — unmounted refs — are skipped).
// Reads come first and writes last, so a pass forces at most one layout, and
// none at all when it runs after layout (inside a ResizeObserver callback).
export function fitTileFonts(tiles) {
  const els = tiles.filter(Boolean);
  if (els.length === 0) return;
  context ??= document.createElement("canvas").getContext("2d");

  // All tiles share one style, so one computed-style read serves the pass.
  const cs = getComputedStyle(els[0]);
  const font = (size) => `${cs.fontWeight} ${size}px ${cs.fontFamily}`;
  const ratio = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
  const lineHeight = Number.isFinite(ratio) ? ratio : 1.2;
  const letterSpacing = parseFloat(cs.letterSpacing) || 0;
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const uppercase = cs.textTransform === "uppercase";

  // clientWidth/clientHeight, not getBoundingClientRect: the tiles and their
  // cells animate `transform` (the entrance, the selected lift), and a
  // bounding rect read mid-animation would be the scaled box. Layout metrics
  // ignore transforms.
  const jobs = els.map((el) => ({
    el,
    text: uppercase ? el.textContent.toUpperCase() : el.textContent,
    width: el.clientWidth - padX,
    height: el.clientHeight - padY,
    cap: tileFontCap(el.clientWidth),
  }));

  const measure = (text, size) => {
    context.font = font(size);
    return context.measureText(text).width;
  };
  for (const job of jobs) {
    const px = `${fitTileFontSize({ ...job, measure, lineHeight, letterSpacing })}px`;
    if (job.el.style.fontSize !== px) job.el.style.fontSize = px;
  }
}
