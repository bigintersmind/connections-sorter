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
//   "fetch-today"   — no save; fetch and land on today's board (existing flow).
//   "fetch-swap"    — current board is a non-exempt daily provably dated before
//                     today: fetch today, move the old board to the previous
//                     slot, offer resume.
//   "fetch-compare" — non-exempt pre-metadata save: fetch today and settle what
//                     the board is by word comparison (applyLegacyDaily). Fetch
//                     failure resumes it untouched and unstamped, so this
//                     decision simply repeats next launch.
//   "resume"        — everything else, including boards whose staleness can't
//                     be proven (no date, future date).
export function decideLaunch(saved, todayISO) {
  if (!saved) return "fetch-today";
  const { current } = saved;
  if (isExempt(current)) return "resume";
  if (current.source === "unknown") return "fetch-compare";
  if (current.source === "daily" && current.date && current.date < todayISO) {
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

// Resolve a legacy (pre-metadata) save against the day's fetched puzzle — the
// "fetch-compare" launch path. This is what reaches the bouncing cohort: their
// save never gets rewritten because they leave before loading anything new, so
// only a word comparison can tell whether their board is already today's.
// Matching words mean it is: keep it in place, progress intact, and stamp
// provenance (server date, source "daily", still swappable tomorrow).
// Different words mean it's genuinely stale: the standard daily swap, old
// board to the previous slot. Returns { matched, store } so the app knows
// whether to keep the board on screen or load the new one with the notice.
export function applyLegacyDaily(saved, { words, date }) {
  if (!sameWordSet(saved.current.tiles, words)) {
    return { matched: false, store: applyDailySwap(saved, { words, date }) };
  }
  // No trusted server date → don't stamp: a dateless "daily" board can never
  // be proven stale by decideLaunch, which would freeze the user on this
  // board forever. Staying "unknown" just re-compares on the next launch.
  if (typeof date !== "string" || !ISO_DATE.test(date)) {
    return { matched: true, store: { current: saved.current, previous: saved.previous ?? null } };
  }
  return {
    matched: true,
    store: {
      current: { ...saved.current, date, source: "daily" },
      previous: saved.previous ?? null,
    },
  };
}

// Order-insensitive comparison of two tile lists — the heart of the legacy
// migration, where tile order means nothing (sorting tiles is what the app is
// for). Words are canonicalized first: Unicode-composed (so "EL NIÑO" saved
// as a precomposed Ñ matches one built from N + combining tilde), whitespace
// collapsed, uppercased. Compared as sorted arrays, not Sets, so duplicate
// words must match in count too.
export function sameWordSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const ca = a.map(canonicalWord).sort();
  const cb = b.map(canonicalWord).sort();
  return ca.every((word, i) => word === cb[i]);
}

function canonicalWord(word) {
  return String(word).normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase();
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
