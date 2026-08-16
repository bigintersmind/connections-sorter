// Saved-puzzle store: the persisted board schema and all reasoning about it.
//
// Owns the v2 per-day shape written under the "connections-puzzle" localStorage
// key — { version, boards, active, activeDate } — where `boards` maps a key to
// one board's play state (tiles, lockedRows, labels) plus its provenance
// (source, date). A key is either a puzzle date in ISO form (that day's board)
// or CUSTOM_KEY, the single slot for words the player typed in themselves. On
// top of the schema this module owns every decision that depends on it: the
// launch rule, day switching, the adopt-on-match merge, window pruning, and
// the switcher's labels. Pure and framework-free so it can be unit-tested
// without a DOM, like worker/puzzle.js; the app component stays a thin wiring
// layer. Date arithmetic and the window size come from shared/puzzleDates.js,
// the same module the Worker's date gate uses.
//
// `activeDate` is the ET date the active board was *activated* on (switched to
// or created), never "last touched". The launch rule is "same ET day → resume,
// new ET day → open Today"; under a last-touched stamp, a player who poked at
// Friday's board on Saturday would be resumed onto Friday's board on Sunday —
// exactly the stale-board landing this store exists to prevent.

import { earliestAllowedDate, isIsoDate, todayET, windowDates } from "../shared/puzzleDates.js";

// Re-exported so app code has one import for "everything about the saved
// board", and so there stays exactly one todayET implementation.
export { todayET };

export const STORE_VERSION = 2;

// The one non-date key: words the player typed in (manual entry, or the
// fallback when a fetch fails). Only ever one — a second typed board replaces
// the first.
export const CUSTOM_KEY = "custom";

// "unknown" exists only for boards migrated from a save that predates
// provenance metadata; nothing writes it going forward.
const SOURCES = new Set(["daily", "manual", "unknown"]);

// The pre-v2 vocabulary, kept only so migration can read old saves.
const LEGACY_SOURCES = new Set(["daily", "ocr", "manual", "demo", "unknown"]);

export function emptyStore() {
  return { version: STORE_VERSION, boards: {}, active: null, activeDate: null };
}

// Parse the raw localStorage string into a v2 store — or null when there is
// nothing to read at all (no save, junk JSON, a non-object). A readable save
// with no surviving boards — an empty v2 store, a week-old save whose days
// have all aged out — is a *valid empty store*, not a bad one: the app
// persists an empty store whenever no board is on screen, so treating it as
// unreadable would raise a false corruption warning on every reload.
// `todayISO` is required because migration has to date boards that never
// carried a date, and because parsing always prunes: a save that's been
// sitting for a week must not resurrect boards the switcher can no longer
// show.
export function parseStore(raw, todayISO) {
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  // Three shapes have been written under this key. `boards`/version 2 is the
  // current one; `current` is the two-slot shape; a bare `tiles` blob is the
  // original pre-metadata save.
  let store;
  if (data.version === STORE_VERSION || "boards" in data) store = normalizeStore(data);
  else if ("current" in data) store = migrateTwoSlot(data, todayISO);
  else store = migrateFlat(data, todayISO);

  return pruneStore(store, todayISO);
}

// Serialize a store for localStorage. Every board goes through the same
// validator parse uses, so whatever this writes is guaranteed to read back
// equal — persist and resume can't drift. Total by design: this runs inside a
// persist effect on every keystroke-ish state change, so a malformed board
// drops out quietly rather than throwing mid-render (the loud guards live on
// the writers — placeFetched/setCustom/updateActive — where a bad value is a
// programming error, not accumulated user data).
export function serializeStore(store) {
  return JSON.stringify(normalizeStore(store));
}

// Drop everything outside the loadable window: daily boards older than the
// floor (they're no longer reachable from the switcher, so they'd be dead
// weight the player can't see) and daily boards dated after today (client
// clock skew). Custom boards age out by the date they were entered. A dropped
// active board leaves nothing on screen, so the launch rule falls back to
// opening Today.
export function pruneStore(store, todayISO) {
  const earliest = earliestAllowedDate(todayISO);
  const boards = {};
  for (const [key, board] of Object.entries(store.boards)) {
    if (key === CUSTOM_KEY) {
      if (board.date < earliest) continue;
    } else if (key < earliest || key > todayISO) {
      continue;
    }
    boards[key] = board;
  }
  const active = store.active && Object.hasOwn(boards, store.active) ? store.active : null;
  return {
    version: STORE_VERSION,
    boards,
    active,
    activeDate: active ? store.activeDate : null,
  };
}

// What the app should do at page load:
//   "resume"      — the board the player was last on, on this same ET day.
//   "fetch-today" — everything else: no save, a board from a previous day, or
//                   an active key whose board didn't survive pruning.
// One rule, no exemptions: a new ET day always opens Today, and the previous
// day's board is still one tap away in the switcher rather than being
// something the app has to reason about.
export function decideLaunch(store, todayISO) {
  if (!hasBoard(store, store?.active)) return "fetch-today";
  return store.activeDate === todayISO ? "resume" : "fetch-today";
}

// Switch to a board that already exists — the instant, no-network half of the
// switcher. Immutable: the outgoing board keeps its play state untouched, so
// switching back is lossless in both directions. A missing key is a
// programming error (the UI only offers keys it got from switcherEntries).
export function activate(store, key, todayISO) {
  if (!hasBoard(store, key)) throw new TypeError(`activate: no board for "${key}"`);
  return { ...store, active: key, activeDate: todayISO };
}

// Place a successful fetch for `date` and switch to it. Three cases:
//   - a board for that date already exists → leave it exactly as it is (the
//     fetch was only needed to find that out; never overwrite progress);
//   - adopt-on-match: the custom board holds the same 16 words, so it IS this
//     day's puzzle — typed during an outage, or a pre-metadata save. Its
//     progress becomes the day's board and the custom slot is cleared, so the
//     player doesn't end up with a duplicate board and a stray Custom segment;
//   - otherwise a fresh board from the fetched words, in NYT's board order.
// The argument checks are programming-error guards (the app validates the
// network response before calling), same posture as the old makeBoard.
export function placeFetched(store, { date, words }, todayISO) {
  if (!isIsoDate(date)) throw new TypeError("placeFetched: date must be YYYY-MM-DD");
  if (!isTiles(words)) throw new TypeError("placeFetched: words must be 16 strings");

  let next = store;
  if (!hasBoard(store, date)) {
    const boards = { ...store.boards };
    const custom = boards[CUSTOM_KEY];
    if (custom && sameWordSet(custom.tiles, words)) {
      boards[date] = { ...custom, source: "daily", date };
      delete boards[CUSTOM_KEY];
    } else {
      boards[date] = freshBoard(words, "daily", date);
    }
    next = { ...store, boards };
  }
  return activate(next, date, todayISO);
}

// Create or replace the custom board from typed words and switch to it. It is
// stamped with today's ET date, which is what ages it out of the window later
// — a typed board is not tied to any puzzle date, so its own age is all we
// have to expire it by.
export function setCustom(store, words, todayISO) {
  if (!isTiles(words)) throw new TypeError("setCustom: words must be 16 strings");
  if (!isIsoDate(todayISO)) throw new TypeError("setCustom: todayISO must be YYYY-MM-DD");
  const boards = { ...store.boards, [CUSTOM_KEY]: freshBoard(words, "manual", todayISO) };
  return activate({ ...store, boards }, CUSTOM_KEY, todayISO);
}

// Apply play state (any subset of tiles/lockedRows/labels) to the active
// board. Returns the SAME store object when there is no active board or
// nothing actually changed, so the app's persist effect can skip a write by
// identity instead of diffing. Never touches activeDate: playing a board is
// not activating it (see the header comment).
export function updateActive(store, patch) {
  const key = store?.active;
  if (!hasBoard(store, key)) return store;
  const board = store.boards[key];

  const next = { ...board };
  let changed = false;
  if (patch.tiles !== undefined) {
    if (!isTiles(patch.tiles)) throw new TypeError("updateActive: tiles must be 16 strings");
    if (!sameValues(board.tiles, patch.tiles)) {
      next.tiles = patch.tiles;
      changed = true;
    }
  }
  if (patch.lockedRows !== undefined) {
    if (!isLockedRows(patch.lockedRows)) {
      throw new TypeError("updateActive: lockedRows must be 4 booleans");
    }
    if (!sameValues(board.lockedRows, patch.lockedRows)) {
      next.lockedRows = patch.lockedRows;
      changed = true;
    }
  }
  if (patch.labels !== undefined) {
    if (!isLabels(patch.labels)) throw new TypeError("updateActive: labels must be 4 strings");
    if (!sameValues(board.labels, patch.labels)) {
      next.labels = patch.labels;
      changed = true;
    }
  }
  if (!changed) return store;
  return { ...store, boards: { ...store.boards, [key]: next } };
}

// Clear the active board's locks and labels, keeping its tiles where the
// player left them (Reset unlocks the puzzle, it doesn't re-deal it). Same
// same-object-when-nothing-changes rule as updateActive.
export function resetActive(store) {
  return updateActive(store, { lockedRows: noLocks(), labels: noLabels() });
}

// The day switcher's segments, left to right: today and the two prior days,
// then Custom if a typed board exists. Segments render for days with no saved
// board too (tapping one fetches it), so `started`/`lockedCount` are what the
// progress marker reads. Tolerates a null store so the switcher can render
// before the first load resolves.
export function switcherEntries(store, todayISO) {
  const entries = windowDates(todayISO).map((date, index) => ({
    key: date,
    label: index === 0 ? "Today" : index === 1 ? "Yesterday" : formatISO(date, WEEKDAY_SHORT),
    dateText: formatISO(date, DATE_TEXT),
    ...progressOf(store, date),
  }));
  if (hasBoard(store, CUSTOM_KEY)) {
    entries.push({
      key: CUSTOM_KEY,
      label: "Custom",
      dateText: "Your words",
      ...progressOf(store, CUSTOM_KEY),
    });
  }
  return entries;
}

// Order-insensitive comparison of two tile lists — the heart of adopt-on-match,
// where tile order means nothing (sorting tiles is what the app is for). Words
// are canonicalized first: Unicode-composed (so "EL NIÑO" saved as a
// precomposed Ñ matches one built from N + combining tilde), whitespace
// collapsed, uppercased. Compared as sorted arrays, not Sets, so duplicate
// words must match in count too.
export function sameWordSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const ca = a.map(canonicalWord).sort();
  const cb = b.map(canonicalWord).sort();
  return ca.every((word, i) => word === cb[i]);
}

// ---- internals -----------------------------------------------------------

const WEEKDAY_SHORT = { weekday: "short" };
const DATE_TEXT = { weekday: "short", month: "short", day: "numeric" };

// Format an ISO date via Intl in UTC — never `new Date(iso)` read through the
// local zone, which shifts the calendar day for anyone west of UTC and would
// mislabel the switcher's segments for a whole evening.
function formatISO(dateISO, options) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

// `Object.hasOwn`, not a truthiness check: `store.boards["constructor"]` is
// truthy on a plain object, and `active` can be any string from a hand-edited
// save.
function hasBoard(store, key) {
  return Boolean(
    store && store.boards && typeof key === "string" && Object.hasOwn(store.boards, key),
  );
}

function progressOf(store, key) {
  if (!hasBoard(store, key)) return { started: false, lockedCount: 0 };
  return { started: true, lockedCount: store.boards[key].lockedRows.filter(Boolean).length };
}

function freshBoard(tiles, source, date) {
  return { tiles, lockedRows: noLocks(), labels: noLabels(), source, date };
}

// Validate a whole store into canonical form. Shared by parse and serialize so
// the two can't drift, and lenient per board: one corrupt entry is dropped
// alone, never taking the rest of the player's days down with it.
function normalizeStore(data) {
  if (!data || typeof data !== "object") return emptyStore();
  const source = data.boards && typeof data.boards === "object" ? data.boards : {};
  const boards = {};
  for (const [key, value] of Object.entries(source)) {
    const board = normalizeBoard(key, value);
    if (board) boards[key] = board;
  }
  const active =
    typeof data.active === "string" && Object.hasOwn(boards, data.active) ? data.active : null;
  return {
    version: STORE_VERSION,
    boards,
    active,
    // Meaningless without an active board, and a non-ISO stamp would make the
    // launch comparison unfalsifiable — drop both rather than trust them.
    activeDate: active && isIsoDate(data.activeDate) ? data.activeDate : null,
  };
}

// Validate one keyed board, or null if it isn't one. Tiles are the save —
// invalid tiles reject the board. Locks and labels are recoverable decoration
// and reset to defaults instead. The key decides the rest: a daily board takes
// its date FROM its key (the two can never drift), while the custom board
// carries the ET date it was typed on, which is the only thing that can age it
// out — a custom board without one would live forever, so it's rejected.
function normalizeBoard(key, b) {
  const isDailyKey = isIsoDate(key);
  if (!isDailyKey && key !== CUSTOM_KEY) return null;
  if (!b || typeof b !== "object" || !isTiles(b.tiles)) return null;
  const date = isDailyKey ? key : isIsoDate(b.date) ? b.date : null;
  if (!date) return null;
  return {
    tiles: b.tiles,
    lockedRows: isLockedRows(b.lockedRows) ? b.lockedRows : noLocks(),
    labels: isLabels(b.labels) ? b.labels : noLabels(),
    source: SOURCES.has(b.source) ? b.source : "unknown",
    date,
  };
}

// Migrate the two-slot { current, previous } shape. Each slot lands under its
// own key — a dated daily board under its date, anything else (ocr/manual/demo,
// or a daily that never recorded a date) in the custom slot — so both boards
// survive with their progress intact. `current` goes first, so it wins any
// collision and it is what the store reopens on.
function migrateTwoSlot(data, todayISO) {
  const store = emptyStore();
  for (const [slot, isCurrent] of [
    [data.current, true],
    [data.previous, false],
  ]) {
    const board = readLegacyBoard(slot);
    if (!board) continue;
    const asDaily = board.source === "daily" && board.date !== null;
    const key = asDaily ? board.date : CUSTOM_KEY;
    if (!Object.hasOwn(store.boards, key)) {
      store.boards[key] = {
        tiles: board.tiles,
        lockedRows: board.lockedRows,
        labels: board.labels,
        // ocr/demo/manual all become "manual" (words the player supplied, no
        // puzzle date); a board that never recorded where it came from stays
        // "unknown" rather than being given a provenance it didn't have.
        // Neither value changes behavior — adopt-on-match goes by words alone.
        source: asDaily ? "daily" : board.source === "unknown" ? "unknown" : "manual",
        date: asDaily ? board.date : todayISO,
      };
    }
    if (isCurrent) {
      store.active = key;
      // Only a daily board dated today proves the player was on today's
      // puzzle; anything else opens Today on this first launch, with the old
      // board preserved under its own key one tap away.
      store.activeDate = asDaily && board.date === todayISO ? todayISO : null;
    }
  }
  return store;
}

// Migrate the original flat { tiles, lockedRows, labels } blob. It carries no
// provenance at all, so it becomes the custom board and the app opens Today —
// and if its words turn out to be today's puzzle, adopt-on-match folds it into
// today's board on the first fetch, progress and all.
function migrateFlat(data, todayISO) {
  const store = emptyStore();
  const board = readLegacyBoard(data);
  if (board) {
    store.boards[CUSTOM_KEY] = {
      tiles: board.tiles,
      lockedRows: board.lockedRows,
      labels: board.labels,
      source: "unknown",
      date: todayISO,
    };
  }
  return store;
}

// Read a board out of a pre-v2 save, where provenance lived on the board
// itself rather than in the key. Returns the old fields verbatim (the caller
// maps them into the new shape) or null if the tiles aren't a board.
function readLegacyBoard(b) {
  if (!b || typeof b !== "object" || !isTiles(b.tiles)) return null;
  return {
    tiles: b.tiles,
    lockedRows: isLockedRows(b.lockedRows) ? b.lockedRows : noLocks(),
    labels: isLabels(b.labels) ? b.labels : noLabels(),
    source: LEGACY_SOURCES.has(b.source) ? b.source : "unknown",
    date: isIsoDate(b.date) ? b.date : null,
  };
}

// Exactly 16 strings — every writer (worker fetch, manual entry) produces
// strings, so anything else is corruption, not a board.
function isTiles(tiles) {
  return Array.isArray(tiles) && tiles.length === 16 && tiles.every((t) => typeof t === "string");
}

function isLockedRows(v) {
  return Array.isArray(v) && v.length === 4 && v.every((b) => typeof b === "boolean");
}

function isLabels(v) {
  return Array.isArray(v) && v.length === 4 && v.every((s) => typeof s === "string");
}

const noLocks = () => [false, false, false, false];
const noLabels = () => ["", "", "", ""];

// Element-wise comparison of two same-shaped arrays, so updateActive can tell
// a real change from a re-render handing back identical values.
const sameValues = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function canonicalWord(word) {
  return String(word).normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase();
}
