// Saved-puzzle store: the persisted board schema and all reasoning about it.
//
// Owns the two-slot shape written under the "connections-puzzle" localStorage
// key — { current, previous? } — where each board carries the play state
// (tiles, lockedRows, labels) plus provenance metadata (date, source,
// chosenExplicitly). Pure and framework-free so it can be unit-tested without
// a DOM, like worker/puzzle.js; the app component stays a thin wiring layer.

// Parse the raw localStorage string into { current, previous } — or null for
// anything unusable (no save, junk JSON, malformed boards), exactly like the
// old loadSaved treated bad data. A legacy flat { tiles, lockedRows, labels }
// blob becomes a current board with source "unknown" — that exact string is
// the contract later slices use to recognize a pre-metadata save.
export function parseStore(raw) {
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  // Presence of `current` discriminates the two-slot shape from a legacy flat
  // blob. A corrupt current slot is no save; a corrupt previous slot is
  // dropped alone — never take the user's live board down with it.
  if ("current" in data) {
    const current = normalizeBoard(data.current);
    if (!current) return null;
    return { current, previous: normalizeBoard(data.previous) };
  }
  // Legacy flat blob: normalizing it directly yields exactly the migration
  // contract — source "unknown", chosenExplicitly false, no date.
  const current = normalizeBoard(data);
  if (!current) return null;
  return { current, previous: null };
}

// The exemption rule shared by every auto-swap/banner slice: a board the
// player chose explicitly (past-date chip, or re-entered via resume), or one
// with no trusted date (ocr/manual/demo), is never swapped out or nagged.
export function isExempt(board) {
  return (
    board.chosenExplicitly === true ||
    board.source === "ocr" ||
    board.source === "manual" ||
    board.source === "demo"
  );
}

// What the app should do at page load, given the parsed save (or null) and
// today's ET date:
//   "fetch-today" — no save; fetch and land on today's board (existing flow).
//   "fetch-swap"  — current board is a non-exempt daily provably dated before
//                   today: fetch today, move the old board to the previous
//                   slot, offer resume.
//   "resume"      — everything else, including legacy "unknown" saves (the
//                   word-compare upgrade is connections-m80's) and boards
//                   whose staleness can't be proven (no date, future date).
export function decideLaunch(saved, todayISO) {
  if (!saved) return "fetch-today";
  const { current } = saved;
  if (
    !isExempt(current) &&
    current.source === "daily" &&
    current.date &&
    current.date < todayISO
  ) {
    return "fetch-swap";
  }
  return "resume";
}

// Apply a successful daily fetch on the "fetch-swap" launch path: the stale
// board moves to the previous slot (intact — this is what makes the resume
// notice lossless) and the fetched puzzle becomes a fresh, swappable current.
// One previous slot only, never an archive: any older previous is dropped.
export function applyDailySwap(saved, { words, date }) {
  return {
    current: makeBoard(words, { date, source: "daily", chosenExplicitly: false }),
    previous: saved.current,
  };
}

// Lossless swap of current ↔ previous. The re-entered board is marked
// chosen-explicitly — resuming is a deliberate choice, so it's exempt from
// future auto-swaps — while the outgoing board keeps its own metadata
// unchanged, making the swap fully reversible.
export function swapBoards({ current, previous }) {
  if (!previous) throw new TypeError("swapBoards: no previous board");
  return {
    current: { ...previous, chosenExplicitly: true },
    previous: current,
  };
}

// Build a fresh board (no locks, no labels) from 16 words plus provenance:
// `date` (daily boards only — the Worker's server-resolved print date, never
// the client clock), `source`, and `chosenExplicitly` (true only for
// past-date chip loads; auto-load and the "Today's Puzzle" card pass false).
export function makeBoard(tiles, { date, source, chosenExplicitly = false }) {
  const board = normalizeBoard({ tiles, date, source, chosenExplicitly });
  if (!board) throw new TypeError("makeBoard: invalid tiles");
  return board;
}

// Serialize { current, previous } for localStorage. Boards pass through the
// same normalizer as parse, so whatever this writes is guaranteed to read
// back equal — persist and resume can't drift. An invalid current board is a
// programming error, not user data: throw rather than silently write garbage.
export function serializeStore({ current, previous = null }) {
  const board = normalizeBoard(current);
  if (!board) throw new TypeError("serializeStore: invalid current board");
  const prev = normalizeBoard(previous);
  return JSON.stringify(prev ? { current: board, previous: prev } : { current: board });
}

const SOURCES = new Set(["daily", "ocr", "manual", "demo", "unknown"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Validate one board into canonical form, or null if it isn't one. Tiles are
// the save — invalid tiles reject the board. Everything else degrades softly:
// bad locks/labels reset, an unrecognized source becomes "unknown", a
// non-boolean chosenExplicitly becomes false, a non-ISO date is dropped.
function normalizeBoard(b) {
  if (!b || typeof b !== "object" || !isTiles(b.tiles)) return null;
  const board = {
    tiles: b.tiles,
    lockedRows: lockedRowsOrDefault(b.lockedRows),
    labels: labelsOrDefault(b.labels),
    source: SOURCES.has(b.source) ? b.source : "unknown",
    chosenExplicitly: b.chosenExplicitly === true,
  };
  if (typeof b.date === "string" && ISO_DATE.test(b.date)) board.date = b.date;
  return board;
}

// Exactly 16 strings — every writer in the app (worker fetch, OCR, manual
// parse, demo) produces strings, so anything else is corruption, not a board.
function isTiles(tiles) {
  return Array.isArray(tiles) && tiles.length === 16 && tiles.every((t) => typeof t === "string");
}

// Locks and labels are recoverable decoration: a corrupt value falls back to
// defaults rather than discarding the user's 16 words with it.
function lockedRowsOrDefault(v) {
  return Array.isArray(v) && v.length === 4 && v.every((b) => typeof b === "boolean")
    ? v
    : [false, false, false, false];
}

function labelsOrDefault(v) {
  return Array.isArray(v) && v.length === 4 && v.every((s) => typeof s === "string")
    ? v
    : ["", "", "", ""];
}

// Board-header label for a dated board. `todayISO` is supplied by the caller
// (todayET() in the app) so this stays pure calendar math — no clock reads.
export function dateLabel(dateISO, todayISO) {
  if (!dateISO) return null;
  if (dateISO === todayISO) return "Today";
  // Format from the ISO parts in UTC — never `new Date(dateISO)` through the
  // local zone, which would shift the calendar day for some users (the same
  // DST-safe trick the menu's recent-date chips use).
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
