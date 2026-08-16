// Unit tests for the saved-puzzle store (src/savedPuzzle.js).
//
// This module owns the persisted board schema — the v2 per-day shape under the
// "connections-puzzle" localStorage key — and every decision that depends on
// it. The contracts locked down here are load-bearing for the board-is-the-home
// -screen redesign (connections-qdx):
//
//   1. Switching days is lossless in both directions: each day keeps its own
//      locks and labels, and nothing but the player ever overwrites a board.
//   2. The launch rule is one sentence — same ET day resumes the board the
//      player was on, a new ET day opens Today — and the ET day boundary
//      (including across DST) is what flips it, never the UTC one.
//   3. Migration from either older save shape is lossless: every board that
//      can be placed keeps its progress, under its date or as Custom.
//   4. Malformed data degrades per board, never per store: one corrupt entry
//      can't take the player's other days down with it.
//   5. parse(serialize(store)) round-trips, so persist and resume can't drift.
//   6. Adopt-on-match folds a typed board into the day whose words it holds,
//      so the outage fallback and pre-metadata saves have a way home.
//
// Pure module, plain Node — no jsdom, mirroring worker/puzzle.test.js. Dates
// are fixed ISO strings; the only clock reads go through todayET(now).

import { describe, expect, it } from "vitest";
import { todayET as sharedTodayET } from "../shared/puzzleDates.js";
import {
  CUSTOM_KEY,
  STORE_VERSION,
  activate,
  decideLaunch,
  emptyStore,
  parseStore,
  placeFetched,
  pruneStore,
  resetActive,
  sameWordSet,
  serializeStore,
  setCustom,
  switcherEntries,
  todayET,
  updateActive,
} from "./savedPuzzle.js";

// A Sunday, so the three switcher days span a weekend: Sun 16th, Sat 15th,
// Fri 14th. TOO_OLD is the first day outside the window.
const TODAY = "2026-08-16";
const YESTERDAY = "2026-08-15";
const DAY_BEFORE = "2026-08-14";
const TOO_OLD = "2026-08-13";

// 16 distinct words, the way every real save has them: normalized uppercase.
const TILES = Array.from({ length: 16 }, (_, i) => `WORD${i}`);
const OTHER_TILES = Array.from({ length: 16 }, (_, i) => `NEW${i}`);

const NO_LOCKS = [false, false, false, false];
const NO_LABELS = ["", "", "", ""];

const board = (over = {}) => ({
  tiles: TILES,
  lockedRows: NO_LOCKS,
  labels: NO_LABELS,
  source: "daily",
  ...over,
});

// A board with progress on it — the thing every losslessness test is about.
const played = (over = {}) =>
  board({ lockedRows: [true, false, true, false], labels: ["fish", "", "birds", ""], ...over });

const daily = (date, over = {}) => board({ source: "daily", date, ...over });
const custom = (date = TODAY, over = {}) => board({ source: "manual", date, ...over });

const storeOf = (boards, active = null, activeDate = null) => ({
  version: STORE_VERSION,
  boards,
  active,
  activeDate,
});

// Freeze a store (and its boards) so any accidental mutation throws in ESM's
// strict mode instead of silently corrupting the caller's state.
function deepFreeze(store) {
  Object.values(store.boards).forEach((b) => {
    Object.values(b).forEach((v) => Array.isArray(v) && Object.freeze(v));
    Object.freeze(b);
  });
  Object.freeze(store.boards);
  return Object.freeze(store);
}

// ---- shape ---------------------------------------------------------------

describe("emptyStore", () => {
  it("is a versioned store with nothing in it and nothing on screen", () => {
    expect(emptyStore()).toEqual({ version: 2, boards: {}, active: null, activeDate: null });
    expect(STORE_VERSION).toBe(2);
    expect(CUSTOM_KEY).toBe("custom");
  });

  it("hands out a fresh object each time — no shared mutable singleton", () => {
    expect(emptyStore()).not.toBe(emptyStore());
  });
});

// ---- parseStore: the current shape ---------------------------------------

describe("parseStore — v2 shape", () => {
  const full = storeOf(
    {
      [TODAY]: daily(TODAY),
      [YESTERDAY]: played({ date: YESTERDAY }),
      [CUSTOM_KEY]: custom(DAY_BEFORE, { labels: ["mine", "", "", ""] }),
    },
    YESTERDAY,
    TODAY,
  );

  it("round-trips a full store — three boards, progress, and what's on screen", () => {
    expect(parseStore(serializeStore(full), TODAY)).toEqual(full);
  });

  it("drops one corrupt board without taking the rest of the store down", () => {
    // Contract #4: a player with a week of boards must not lose Today because
    // some other day's entry got mangled.
    const raw = JSON.stringify(
      storeOf(
        {
          [TODAY]: daily(TODAY),
          [YESTERDAY]: { tiles: ["JUST", "FOUR", "WORDS", "HERE"] },
          [CUSTOM_KEY]: custom(),
        },
        TODAY,
        TODAY,
      ),
    );
    const store = parseStore(raw, TODAY);
    expect(Object.keys(store.boards).sort()).toEqual([TODAY, CUSTOM_KEY].sort());
    expect(store.active).toBe(TODAY);
  });

  it("drops boards filed under a key that is neither a date nor 'custom'", () => {
    const raw = JSON.stringify(
      storeOf({ [TODAY]: daily(TODAY), yesterday: daily(YESTERDAY), "": daily(TODAY) }, TODAY, TODAY),
    );
    expect(Object.keys(parseStore(raw, TODAY).boards)).toEqual([TODAY]);
  });

  it("takes a daily board's date from its key, so the two can never drift", () => {
    const raw = JSON.stringify(storeOf({ [YESTERDAY]: daily("1999-01-01") }, YESTERDAY, TODAY));
    expect(parseStore(raw, TODAY).boards[YESTERDAY].date).toBe(YESTERDAY);
  });

  it("drops a custom board with no usable date — it could never age out", () => {
    // The custom board isn't tied to a puzzle date, so the date it was typed
    // on is the only thing that expires it. Without one it would sit in the
    // switcher forever; every writer stamps it, so this is corruption.
    const noDate = custom();
    delete noDate.date;
    expect(parseStore(JSON.stringify(storeOf({ [CUSTOM_KEY]: noDate })), TODAY)).toEqual(
      emptyStore(),
    );
    const badDate = custom("last Tuesday");
    expect(parseStore(JSON.stringify(storeOf({ [CUSTOM_KEY]: badDate })), TODAY)).toEqual(
      emptyStore(),
    );
  });

  it("defaults corrupt locks/labels and an unrecognized source instead of dropping the board", () => {
    // Tiles are the save; locks, labels, and provenance are recoverable.
    const raw = JSON.stringify(
      storeOf({ [TODAY]: daily(TODAY, { lockedRows: [true], labels: "x", source: "telepathy" }) }),
    );
    expect(parseStore(raw, TODAY).boards[TODAY]).toEqual({
      tiles: TILES,
      lockedRows: NO_LOCKS,
      labels: NO_LABELS,
      source: "unknown",
      date: TODAY,
    });
  });

  it("keeps active only when its board survived, and activeDate only when ISO", () => {
    const dangling = JSON.stringify(storeOf({ [TODAY]: daily(TODAY) }, YESTERDAY, TODAY));
    expect(parseStore(dangling, TODAY)).toEqual(storeOf({ [TODAY]: daily(TODAY) }));

    const badStamp = JSON.stringify(storeOf({ [TODAY]: daily(TODAY) }, TODAY, "yesterday-ish"));
    expect(parseStore(badStamp, TODAY).activeDate).toBe(null);
  });

  it("prunes on the way in — a save left for a week can't resurrect old boards", () => {
    const stale = JSON.stringify(
      storeOf({ [TODAY]: daily(TODAY), [TOO_OLD]: daily(TOO_OLD) }, TOO_OLD, TOO_OLD),
    );
    const store = parseStore(stale, TODAY);
    expect(Object.keys(store.boards)).toEqual([TODAY]);
    expect(store.active).toBe(null);
    expect(decideLaunch(store, TODAY)).toBe("fetch-today");
  });
});

describe("parseStore — nothing usable is no save", () => {
  it("rejects missing, junk, and non-object payloads", () => {
    expect(parseStore(null, TODAY)).toBe(null);
    expect(parseStore("", TODAY)).toBe(null);
    expect(parseStore("{not json", TODAY)).toBe(null);
    expect(parseStore("42", TODAY)).toBe(null);
    expect(parseStore('"tiles"', TODAY)).toBe(null);
    expect(parseStore("null", TODAY)).toBe(null);
    expect(parseStore("[]", TODAY)).toBe(null);
  });

  it("reads a well-formed save with no surviving boards as a valid empty store, not a bad one", () => {
    // The app persists an empty store whenever nothing is on screen (a launch
    // fetch that failed), and a week-old save prunes down to nothing. Neither
    // is corruption: returning null here would make the app stash them as
    // "unreadable" and warn on every reload.
    expect(parseStore(JSON.stringify(emptyStore()), TODAY)).toEqual(emptyStore());
    expect(parseStore(JSON.stringify(storeOf({ [TOO_OLD]: daily(TOO_OLD) })), TODAY)).toEqual(
      emptyStore(),
    );
    expect(parseStore(JSON.stringify({ version: 2, boards: "nope" }), TODAY)).toEqual(emptyStore());
  });

  it("drops boards with the wrong tile count or non-string tiles, leaving an empty store", () => {
    const bad = (tiles) => JSON.stringify(storeOf({ [TODAY]: daily(TODAY, { tiles }) }));
    expect(parseStore(bad(TILES.slice(0, 15)), TODAY)).toEqual(emptyStore());
    expect(parseStore(bad("sixteen words"), TODAY)).toEqual(emptyStore());
    expect(parseStore(bad([...TILES.slice(0, 15), 16]), TODAY)).toEqual(emptyStore());
  });
});

// ---- parseStore: migration -----------------------------------------------

// The two-slot shape this replaced: { current, previous }, provenance carried
// on the board rather than in a key.
const twoSlot = (current, previous) =>
  JSON.stringify(previous === undefined ? { current } : { current, previous });

const oldBoard = (over = {}) => ({
  tiles: TILES,
  lockedRows: [true, false, false, false],
  labels: ["fruit", "", "", ""],
  source: "daily",
  chosenExplicitly: false,
  ...over,
});

describe("parseStore — two-slot migration", () => {
  it("files both dated daily boards under their dates, progress intact", () => {
    const store = parseStore(
      twoSlot(oldBoard({ date: TODAY }), oldBoard({ date: YESTERDAY, tiles: OTHER_TILES })),
      TODAY,
    );
    expect(store.boards[TODAY]).toEqual({
      tiles: TILES,
      lockedRows: [true, false, false, false],
      labels: ["fruit", "", "", ""],
      source: "daily",
      date: TODAY,
    });
    expect(store.boards[YESTERDAY].tiles).toEqual(OTHER_TILES);
    // chosenExplicitly is gone from the schema — the new launch rule has no
    // exemptions to encode.
    expect("chosenExplicitly" in store.boards[TODAY]).toBe(false);
  });

  it("resumes only when the current board was provably today's", () => {
    const store = parseStore(twoSlot(oldBoard({ date: TODAY })), TODAY);
    expect(store.active).toBe(TODAY);
    expect(store.activeDate).toBe(TODAY);
    expect(decideLaunch(store, TODAY)).toBe("resume");
  });

  it("opens Today when the current board was yesterday's — but keeps that board", () => {
    // The returning-user case the redesign is built around: no auto-swap, no
    // notice, the old board just sits under Yesterday one tap away.
    const store = parseStore(twoSlot(oldBoard({ date: YESTERDAY })), TODAY);
    expect(store.active).toBe(YESTERDAY);
    expect(store.activeDate).toBe(null);
    expect(decideLaunch(store, TODAY)).toBe("fetch-today");
    expect(store.boards[YESTERDAY].lockedRows).toEqual([true, false, false, false]);
  });

  it("files ocr/manual/demo boards as Custom, dated today so they age out", () => {
    for (const source of ["ocr", "manual", "demo"]) {
      const store = parseStore(twoSlot(oldBoard({ source })), TODAY);
      expect(store.boards[CUSTOM_KEY]).toEqual({
        tiles: TILES,
        lockedRows: [true, false, false, false],
        labels: ["fruit", "", "", ""],
        source: "manual",
        date: TODAY,
      });
      expect(store.active).toBe(CUSTOM_KEY);
      expect(decideLaunch(store, TODAY)).toBe("fetch-today");
    }
  });

  it("keeps an unprovable board 'unknown' so adopt-on-match can still claim it", () => {
    const store = parseStore(twoSlot(oldBoard({ source: "unknown" })), TODAY);
    expect(store.boards[CUSTOM_KEY].source).toBe("unknown");
  });

  it("files a daily board that never recorded a date as Custom", () => {
    const dateless = oldBoard();
    delete dateless.date;
    const store = parseStore(twoSlot(dateless), TODAY);
    expect(Object.keys(store.boards)).toEqual([CUSTOM_KEY]);
    expect(store.boards[CUSTOM_KEY].source).toBe("manual");
  });

  it("lets current win a key collision with previous", () => {
    const store = parseStore(
      twoSlot(oldBoard({ date: TODAY }), oldBoard({ date: TODAY, tiles: OTHER_TILES })),
      TODAY,
    );
    expect(store.boards[TODAY].tiles).toEqual(TILES);
    expect(Object.keys(store.boards)).toEqual([TODAY]);
  });

  it("gives the one custom slot to current, not previous", () => {
    const store = parseStore(
      twoSlot(oldBoard({ source: "manual" }), oldBoard({ source: "ocr", tiles: OTHER_TILES })),
      TODAY,
    );
    expect(store.boards[CUSTOM_KEY].tiles).toEqual(TILES);
  });

  it("keeps a valid previous board when current is corrupt, with nothing on screen", () => {
    const store = parseStore(twoSlot({ tiles: [] }, oldBoard({ date: YESTERDAY })), TODAY);
    expect(Object.keys(store.boards)).toEqual([YESTERDAY]);
    expect(store.active).toBe(null);
    expect(decideLaunch(store, TODAY)).toBe("fetch-today");
  });

  it("prunes a migrated board that is already outside the window", () => {
    const store = parseStore(
      twoSlot(oldBoard({ date: TODAY }), oldBoard({ date: TOO_OLD })),
      TODAY,
    );
    expect(Object.keys(store.boards)).toEqual([TODAY]);
  });

  it("round-trips after migration — the new shape is what gets written back", () => {
    const migrated = parseStore(twoSlot(oldBoard({ date: TODAY })), TODAY);
    expect(parseStore(serializeStore(migrated), TODAY)).toEqual(migrated);
  });
});

describe("parseStore — flat legacy blob", () => {
  const legacyBlob = (extra = {}) =>
    JSON.stringify({
      tiles: TILES,
      lockedRows: [true, false, false, false],
      labels: ["fruit", "", "", ""],
      ...extra,
    });

  it("lands as Custom with unknown provenance and opens Today", () => {
    const store = parseStore(legacyBlob(), TODAY);
    expect(store.boards[CUSTOM_KEY]).toEqual({
      tiles: TILES,
      lockedRows: [true, false, false, false],
      labels: ["fruit", "", "", ""],
      source: "unknown",
      date: TODAY,
    });
    expect(store.active).toBe(null);
    expect(decideLaunch(store, TODAY)).toBe("fetch-today");
  });

  it("defaults missing locks/labels rather than dropping the save", () => {
    const store = parseStore(JSON.stringify({ tiles: TILES }), TODAY);
    expect(store.boards[CUSTOM_KEY].lockedRows).toEqual(NO_LOCKS);
    expect(store.boards[CUSTOM_KEY].labels).toEqual(NO_LABELS);
  });

  it("is reclaimed by adopt-on-match when it holds today's words", () => {
    // The whole point of routing it to Custom: the first fetch settles what it
    // actually was, and the player's progress comes with it.
    const store = parseStore(legacyBlob(), TODAY);
    const placed = placeFetched(store, { date: TODAY, words: [...TILES].reverse() }, TODAY);
    expect(placed.boards[TODAY].lockedRows).toEqual([true, false, false, false]);
    expect(placed.boards[CUSTOM_KEY]).toBeUndefined();
    expect(decideLaunch(placed, TODAY)).toBe("resume");
  });
});

// ---- serializeStore ------------------------------------------------------

describe("serializeStore", () => {
  it("normalizes on the way out — invalid boards and dangling active are dropped", () => {
    const messy = storeOf(
      { [TODAY]: daily(TODAY), [YESTERDAY]: { tiles: 3 }, nonsense: daily(TODAY) },
      YESTERDAY,
      TODAY,
    );
    expect(JSON.parse(serializeStore(messy))).toEqual(storeOf({ [TODAY]: daily(TODAY) }));
  });

  it("never throws on a missing or malformed store", () => {
    // It runs inside a persist effect; a crash here would take the app down
    // mid-play. An empty store is written instead.
    expect(JSON.parse(serializeStore(null))).toEqual(emptyStore());
    expect(JSON.parse(serializeStore({}))).toEqual(emptyStore());
  });

  it("writes the version stamp so the next parse knows the shape", () => {
    expect(JSON.parse(serializeStore(storeOf({ [TODAY]: daily(TODAY) }))).version).toBe(2);
  });
});

// ---- pruneStore ----------------------------------------------------------

describe("pruneStore", () => {
  it("keeps the window edge and drops the day past it", () => {
    const store = pruneStore(
      storeOf({
        [TODAY]: daily(TODAY),
        [YESTERDAY]: daily(YESTERDAY),
        [DAY_BEFORE]: daily(DAY_BEFORE),
        [TOO_OLD]: daily(TOO_OLD),
      }),
      TODAY,
    );
    expect(Object.keys(store.boards).sort()).toEqual([DAY_BEFORE, YESTERDAY, TODAY]);
  });

  it("drops a daily board dated after today (client clock skew)", () => {
    const tomorrow = "2026-08-17";
    const store = pruneStore(storeOf({ [tomorrow]: daily(tomorrow) }, tomorrow, TODAY), TODAY);
    expect(store.boards).toEqual({});
  });

  it("ages the custom board out by the date it was typed", () => {
    expect(pruneStore(storeOf({ [CUSTOM_KEY]: custom(DAY_BEFORE) }), TODAY).boards).toHaveProperty(
      CUSTOM_KEY,
    );
    expect(pruneStore(storeOf({ [CUSTOM_KEY]: custom(TOO_OLD) }), TODAY).boards).toEqual({});
  });

  it("clears active and its stamp when the active board is pruned away", () => {
    const store = pruneStore(
      storeOf({ [TODAY]: daily(TODAY), [TOO_OLD]: daily(TOO_OLD) }, TOO_OLD, TODAY),
      TODAY,
    );
    expect(store.active).toBe(null);
    expect(store.activeDate).toBe(null);
    expect(decideLaunch(store, TODAY)).toBe("fetch-today");
  });

  it("leaves the input store untouched", () => {
    const before = deepFreeze(storeOf({ [TODAY]: daily(TODAY), [TOO_OLD]: daily(TOO_OLD) }, TODAY, TODAY));
    pruneStore(before, TODAY);
    expect(Object.keys(before.boards).sort()).toEqual([TOO_OLD, TODAY].sort());
  });
});

// ---- decideLaunch --------------------------------------------------------

describe("decideLaunch", () => {
  it("opens Today when there is no save", () => {
    expect(decideLaunch(null, TODAY)).toBe("fetch-today");
    expect(decideLaunch(emptyStore(), TODAY)).toBe("fetch-today");
  });

  it("resumes the board the player was on earlier the same ET day", () => {
    expect(decideLaunch(storeOf({ [TODAY]: daily(TODAY) }, TODAY, TODAY), TODAY)).toBe("resume");
    // Including a past day's board — if they switched to it today, that's
    // where they were, and reopening it is not a stale landing.
    expect(decideLaunch(storeOf({ [YESTERDAY]: daily(YESTERDAY) }, YESTERDAY, TODAY), TODAY)).toBe(
      "resume",
    );
    expect(decideLaunch(storeOf({ [CUSTOM_KEY]: custom() }, CUSTOM_KEY, TODAY), TODAY)).toBe(
      "resume",
    );
  });

  it("opens Today on a new ET day, whatever the board was", () => {
    expect(decideLaunch(storeOf({ [YESTERDAY]: daily(YESTERDAY) }, YESTERDAY, YESTERDAY), TODAY)).toBe(
      "fetch-today",
    );
    // Yesterday's session ended on yesterday's *today* board — still a new day.
    expect(decideLaunch(storeOf({ [YESTERDAY]: daily(YESTERDAY) }, YESTERDAY, YESTERDAY), TODAY)).toBe(
      "fetch-today",
    );
  });

  it("opens Today when the stamp is missing or the active board isn't there", () => {
    expect(decideLaunch(storeOf({ [TODAY]: daily(TODAY) }, TODAY, null), TODAY)).toBe("fetch-today");
    expect(decideLaunch(storeOf({ [TODAY]: daily(TODAY) }, YESTERDAY, TODAY), TODAY)).toBe(
      "fetch-today",
    );
    // A hand-edited save can point `active` at anything; an inherited property
    // name must not read as a board.
    expect(decideLaunch(storeOf({ [TODAY]: daily(TODAY) }, "constructor", TODAY), TODAY)).toBe(
      "fetch-today",
    );
  });

  it("flips at midnight Eastern, not midnight UTC", () => {
    // Stamped at 20:00 ET on Jan 14 (01:00 UTC Jan 15). The UTC day has
    // already turned over; the ET one hasn't, so the board still resumes.
    const stamped = todayET(new Date("2026-01-15T01:00:00Z"));
    const store = storeOf({ [stamped]: daily(stamped) }, stamped, stamped);
    expect(stamped).toBe("2026-01-14");
    expect(decideLaunch(store, todayET(new Date("2026-01-15T04:59:00Z")))).toBe("resume");
    expect(decideLaunch(store, todayET(new Date("2026-01-15T05:00:00Z")))).toBe("fetch-today");
  });

  it("follows the ET boundary as it shifts across spring-forward", () => {
    // Stamped mid-morning on 2026-03-08, the day US DST begins. That night's
    // ET midnight is 04:00 UTC (EDT), an hour earlier in UTC than the
    // previous one — the decision must track the zone, not a fixed offset.
    const stamped = todayET(new Date("2026-03-08T14:00:00Z"));
    const store = storeOf({ [stamped]: daily(stamped) }, stamped, stamped);
    expect(stamped).toBe("2026-03-08");
    expect(decideLaunch(store, todayET(new Date("2026-03-09T03:59:00Z")))).toBe("resume");
    expect(decideLaunch(store, todayET(new Date("2026-03-09T04:00:00Z")))).toBe("fetch-today");
  });
});

// ---- activate ------------------------------------------------------------

describe("activate", () => {
  const twoDays = () =>
    storeOf(
      { [TODAY]: played({ date: TODAY }), [YESTERDAY]: daily(YESTERDAY, { labels: ["a", "b", "c", "d"] }) },
      TODAY,
      TODAY,
    );

  it("switches boards and stamps the day the switch happened", () => {
    const next = activate(twoDays(), YESTERDAY, TODAY);
    expect(next.active).toBe(YESTERDAY);
    expect(next.activeDate).toBe(TODAY);
  });

  it("is lossless in both directions — each day keeps its own progress", () => {
    // Contract #1: exploring another day never costs the player anything.
    const start = deepFreeze(twoDays());
    const there = activate(start, YESTERDAY, TODAY);
    const back = activate(there, TODAY, TODAY);
    expect(back.boards[TODAY]).toEqual(start.boards[TODAY]);
    expect(back.boards[YESTERDAY]).toEqual(start.boards[YESTERDAY]);
    expect(back.active).toBe(TODAY);
  });

  it("throws for a board that isn't there", () => {
    expect(() => activate(twoDays(), DAY_BEFORE, TODAY)).toThrow(TypeError);
    expect(() => activate(twoDays(), CUSTOM_KEY, TODAY)).toThrow(TypeError);
    expect(() => activate(twoDays(), "constructor", TODAY)).toThrow(TypeError);
  });

  it("leaves the input store untouched", () => {
    const before = deepFreeze(twoDays());
    const next = activate(before, YESTERDAY, TODAY);
    expect(before.active).toBe(TODAY);
    expect(next).not.toBe(before);
  });
});

// ---- placeFetched --------------------------------------------------------

describe("placeFetched", () => {
  it("creates a fresh board in the fetched order and switches to it", () => {
    const next = placeFetched(emptyStore(), { date: TODAY, words: TILES }, TODAY);
    expect(next.boards[TODAY]).toEqual({
      tiles: TILES,
      lockedRows: NO_LOCKS,
      labels: NO_LABELS,
      source: "daily",
      date: TODAY,
    });
    expect(next.active).toBe(TODAY);
    expect(next.activeDate).toBe(TODAY);
  });

  it("never overwrites a board that already exists — it just switches to it", () => {
    // Tapping a day the player has already played must not re-deal it, even
    // if a fetch happened to be in flight.
    const store = deepFreeze(storeOf({ [YESTERDAY]: played({ date: YESTERDAY }) }, null, null));
    const next = placeFetched(store, { date: YESTERDAY, words: OTHER_TILES }, TODAY);
    expect(next.boards[YESTERDAY]).toEqual(store.boards[YESTERDAY]);
    expect(next.active).toBe(YESTERDAY);
    expect(next.activeDate).toBe(TODAY);
  });

  it("adopts a matching custom board — progress moves to the day, Custom clears", () => {
    // Contract #6: words typed during an outage turn out to be that day's
    // puzzle. Order, case, spacing, and Unicode composition are all
    // irrelevant; the player's locks and labels are not.
    const typed = [" el  niño ", "café", ...TILES.slice(2)];
    const fetched = ["CAFÉ", "EL NIÑO", ...[...TILES.slice(2)].reverse()];
    const store = deepFreeze(
      storeOf({ [CUSTOM_KEY]: custom(TODAY, { tiles: typed, lockedRows: [true, true, false, false], labels: ["x", "y", "", ""] }) }, CUSTOM_KEY, TODAY),
    );
    const next = placeFetched(store, { date: TODAY, words: fetched }, TODAY);
    expect(next.boards[TODAY]).toEqual({
      tiles: typed, // the player's own arrangement survives, not the fetch order
      lockedRows: [true, true, false, false],
      labels: ["x", "y", "", ""],
      source: "daily",
      date: TODAY,
    });
    expect(CUSTOM_KEY in next.boards).toBe(false);
    expect(next.active).toBe(TODAY);
  });

  it("leaves a non-matching custom board alone — two boards, two segments", () => {
    const store = storeOf({ [CUSTOM_KEY]: played({ source: "manual", date: TODAY }) }, CUSTOM_KEY, TODAY);
    const next = placeFetched(store, { date: TODAY, words: OTHER_TILES }, TODAY);
    expect(next.boards[CUSTOM_KEY]).toEqual(store.boards[CUSTOM_KEY]);
    expect(next.boards[TODAY].tiles).toEqual(OTHER_TILES);
    expect(next.active).toBe(TODAY);
  });

  it("does not adopt into a day that already has a board", () => {
    const store = storeOf(
      { [TODAY]: played({ date: TODAY }), [CUSTOM_KEY]: custom(TODAY) },
      TODAY,
      TODAY,
    );
    const next = placeFetched(store, { date: TODAY, words: TILES }, TODAY);
    expect(next.boards[CUSTOM_KEY]).toBeDefined();
    expect(next.boards[TODAY]).toEqual(store.boards[TODAY]);
  });

  it("adopts across days too — yesterday's words typed during yesterday's outage", () => {
    const store = storeOf({ [CUSTOM_KEY]: played({ source: "manual", date: YESTERDAY }) }, CUSTOM_KEY, YESTERDAY);
    const next = placeFetched(store, { date: YESTERDAY, words: TILES }, TODAY);
    expect(next.boards[YESTERDAY].date).toBe(YESTERDAY);
    expect(next.boards[YESTERDAY].source).toBe("daily");
    expect(next.activeDate).toBe(TODAY);
  });

  it("rejects a malformed date or word list — the caller validates the response", () => {
    const store = emptyStore();
    expect(() => placeFetched(store, { date: "today", words: TILES }, TODAY)).toThrow(TypeError);
    expect(() => placeFetched(store, { date: TODAY, words: TILES.slice(0, 15) }, TODAY)).toThrow(
      TypeError,
    );
    expect(() => placeFetched(store, { date: TODAY, words: null }, TODAY)).toThrow(TypeError);
  });

  it("leaves the input store untouched", () => {
    const before = deepFreeze(storeOf({ [CUSTOM_KEY]: custom() }, CUSTOM_KEY, TODAY));
    placeFetched(before, { date: TODAY, words: TILES }, TODAY);
    expect(Object.keys(before.boards)).toEqual([CUSTOM_KEY]);
  });
});

// ---- setCustom -----------------------------------------------------------

describe("setCustom", () => {
  it("creates the custom board from typed words and switches to it", () => {
    const next = setCustom(emptyStore(), TILES, TODAY);
    expect(next.boards[CUSTOM_KEY]).toEqual({
      tiles: TILES,
      lockedRows: NO_LOCKS,
      labels: NO_LABELS,
      source: "manual",
      date: TODAY,
    });
    expect(next.active).toBe(CUSTOM_KEY);
    expect(next.activeDate).toBe(TODAY);
    expect(decideLaunch(next, TODAY)).toBe("resume");
  });

  it("replaces an existing custom board rather than accumulating them", () => {
    const first = setCustom(emptyStore(), TILES, YESTERDAY);
    const second = setCustom(first, OTHER_TILES, TODAY);
    expect(second.boards[CUSTOM_KEY].tiles).toEqual(OTHER_TILES);
    expect(second.boards[CUSTOM_KEY].date).toBe(TODAY);
    expect(Object.keys(second.boards)).toEqual([CUSTOM_KEY]);
  });

  it("leaves the daily boards alone", () => {
    const store = deepFreeze(storeOf({ [TODAY]: played({ date: TODAY }) }, TODAY, TODAY));
    const next = setCustom(store, OTHER_TILES, TODAY);
    expect(next.boards[TODAY]).toEqual(store.boards[TODAY]);
    expect(store.boards[CUSTOM_KEY]).toBeUndefined();
  });

  it("rejects a bad word list or a bad today", () => {
    // The date is what ages the board out; without a real one the board would
    // be dropped on the next parse, silently losing the words just typed.
    expect(() => setCustom(emptyStore(), TILES.slice(0, 15), TODAY)).toThrow(TypeError);
    expect(() => setCustom(emptyStore(), TILES, "today")).toThrow(TypeError);
  });

  it("survives a persist round-trip", () => {
    const next = setCustom(emptyStore(), TILES, TODAY);
    expect(parseStore(serializeStore(next), TODAY)).toEqual(next);
  });
});

// ---- updateActive / resetActive ------------------------------------------

describe("updateActive", () => {
  const start = () => storeOf({ [TODAY]: daily(TODAY), [YESTERDAY]: daily(YESTERDAY) }, TODAY, TODAY);

  it("applies play state to the active board only", () => {
    const shuffled = [...TILES].reverse();
    const next = updateActive(start(), {
      tiles: shuffled,
      lockedRows: [true, false, false, false],
      labels: ["fish", "", "", ""],
    });
    expect(next.boards[TODAY]).toEqual({
      tiles: shuffled,
      lockedRows: [true, false, false, false],
      labels: ["fish", "", "", ""],
      source: "daily",
      date: TODAY,
    });
    expect(next.boards[YESTERDAY]).toEqual(daily(YESTERDAY));
  });

  it("returns the SAME store when nothing changed — the persist effect can skip", () => {
    // Identity, not deep equality: the app's persist effect keys off it, so a
    // regression here means a localStorage write on every render.
    const store = start();
    expect(updateActive(store, {})).toBe(store);
    expect(updateActive(store, { tiles: TILES })).toBe(store);
    expect(updateActive(store, { tiles: [...TILES], lockedRows: [...NO_LOCKS] })).toBe(store);
  });

  it("returns the SAME store when there is no active board", () => {
    const store = storeOf({ [TODAY]: daily(TODAY) });
    expect(updateActive(store, { labels: ["a", "b", "c", "d"] })).toBe(store);
    const dangling = storeOf({ [TODAY]: daily(TODAY) }, YESTERDAY, TODAY);
    expect(updateActive(dangling, { labels: ["a", "b", "c", "d"] })).toBe(dangling);
    // Nothing loaded yet: the app's play handlers can fire before the launch
    // fetch resolves, and a no-op is the right answer, not a crash.
    expect(updateActive(null, { labels: ["a", "b", "c", "d"] })).toBe(null);
  });

  it("does not touch activeDate — playing a board is not activating it", () => {
    // Otherwise a board touched today would resume tomorrow, which is the
    // stale landing this whole store is designed to avoid.
    const store = storeOf({ [YESTERDAY]: daily(YESTERDAY) }, YESTERDAY, YESTERDAY);
    const next = updateActive(store, { lockedRows: [true, false, false, false] });
    expect(next.activeDate).toBe(YESTERDAY);
    expect(decideLaunch(next, TODAY)).toBe("fetch-today");
  });

  it("leaves the input store and its boards untouched", () => {
    const before = deepFreeze(start());
    const next = updateActive(before, { lockedRows: [true, true, true, true] });
    expect(before.boards[TODAY].lockedRows).toEqual(NO_LOCKS);
    expect(next.boards[YESTERDAY]).toBe(before.boards[YESTERDAY]);
  });

  it("rejects malformed play state instead of writing a board parse would drop", () => {
    const store = start();
    expect(() => updateActive(store, { tiles: TILES.slice(0, 15) })).toThrow(TypeError);
    expect(() => updateActive(store, { lockedRows: [true] })).toThrow(TypeError);
    expect(() => updateActive(store, { labels: "fish" })).toThrow(TypeError);
  });
});

describe("resetActive", () => {
  it("clears locks and labels but leaves the tiles where the player put them", () => {
    const sorted = [...TILES].reverse();
    const store = storeOf({ [TODAY]: played({ date: TODAY, tiles: sorted }) }, TODAY, TODAY);
    const next = resetActive(store);
    expect(next.boards[TODAY]).toEqual({
      tiles: sorted,
      lockedRows: NO_LOCKS,
      labels: NO_LABELS,
      source: "daily",
      date: TODAY,
    });
  });

  it("returns the SAME store when the board is already clear or nothing is active", () => {
    const clean = storeOf({ [TODAY]: daily(TODAY) }, TODAY, TODAY);
    expect(resetActive(clean)).toBe(clean);
    const nothing = emptyStore();
    expect(resetActive(nothing)).toBe(nothing);
  });

  it("resets only the active board", () => {
    const store = storeOf(
      { [TODAY]: played({ date: TODAY }), [YESTERDAY]: played({ date: YESTERDAY }) },
      TODAY,
      TODAY,
    );
    const next = resetActive(store);
    expect(next.boards[YESTERDAY]).toEqual(store.boards[YESTERDAY]);
  });
});

// ---- switcherEntries -----------------------------------------------------

describe("switcherEntries", () => {
  it("offers today and the two prior days, newest first", () => {
    expect(switcherEntries(emptyStore(), TODAY)).toEqual([
      { key: TODAY, label: "Today", dateText: "Sun, Aug 16", started: false, lockedCount: 0 },
      { key: YESTERDAY, label: "Yesterday", dateText: "Sat, Aug 15", started: false, lockedCount: 0 },
      { key: DAY_BEFORE, label: "Fri", dateText: "Fri, Aug 14", started: false, lockedCount: 0 },
    ]);
  });

  it("marks the days with saved progress and counts their locked groups", () => {
    const store = storeOf({
      [TODAY]: daily(TODAY),
      [DAY_BEFORE]: played({ date: DAY_BEFORE }),
    });
    const byKey = Object.fromEntries(switcherEntries(store, TODAY).map((e) => [e.key, e]));
    expect(byKey[TODAY]).toMatchObject({ started: true, lockedCount: 0 });
    expect(byKey[YESTERDAY]).toMatchObject({ started: false, lockedCount: 0 });
    expect(byKey[DAY_BEFORE]).toMatchObject({ started: true, lockedCount: 2 });
  });

  it("appends a Custom segment only while a typed board exists", () => {
    expect(switcherEntries(emptyStore(), TODAY).some((e) => e.key === CUSTOM_KEY)).toBe(false);
    const withCustom = switcherEntries(
      storeOf({ [CUSTOM_KEY]: played({ source: "manual", date: TODAY }) }, CUSTOM_KEY, TODAY),
      TODAY,
    );
    expect(withCustom.at(-1)).toEqual({
      key: CUSTOM_KEY,
      label: "Custom",
      dateText: "Your words",
      started: true,
      lockedCount: 2,
    });
  });

  it("labels the third day by weekday, correctly across a DST change", () => {
    // 2026-03-09 is the Monday after US DST begins; a local-zone date read
    // would name the Sunday segment "Sat" for anyone west of UTC.
    const entries = switcherEntries(emptyStore(), "2026-03-09");
    expect(entries.map((e) => e.label)).toEqual(["Today", "Yesterday", "Sat"]);
    expect(entries.map((e) => e.dateText)).toEqual(["Mon, Mar 9", "Sun, Mar 8", "Sat, Mar 7"]);
  });

  it("stops at launch day rather than offering a puzzle that never existed", () => {
    const entries = switcherEntries(emptyStore(), "2023-06-13");
    expect(entries.map((e) => e.key)).toEqual(["2023-06-13", "2023-06-12"]);
    expect(entries.map((e) => e.label)).toEqual(["Today", "Yesterday"]);
  });

  it("renders before the first load resolves — a null store is just unstarted days", () => {
    expect(switcherEntries(null, TODAY).every((e) => e.started === false)).toBe(true);
    expect(switcherEntries(null, TODAY)).toHaveLength(3);
  });

  it("only ever offers keys the store can activate", () => {
    // The UI taps straight through to activate(), which throws on a key that
    // isn't there — so every started entry must be activatable.
    const store = storeOf({ [YESTERDAY]: daily(YESTERDAY), [CUSTOM_KEY]: custom() }, null, null);
    for (const entry of switcherEntries(store, TODAY).filter((e) => e.started)) {
      expect(() => activate(store, entry.key, TODAY)).not.toThrow();
    }
  });
});

// ---- sameWordSet ---------------------------------------------------------

describe("sameWordSet", () => {
  it("matches regardless of tile order — sorting tiles is what the app does", () => {
    expect(sameWordSet(TILES, [...TILES].reverse())).toBe(true);
    expect(sameWordSet(TILES, TILES)).toBe(true);
  });

  it("rejects a near-miss — 15 of 16 words matching is a different puzzle", () => {
    expect(sameWordSet(TILES, [...TILES.slice(0, 15), "INTRUDER"])).toBe(false);
  });

  it("matches accented words across case and Unicode composition", () => {
    // "EL NIÑO" saved with a precomposed Ñ must equal one built from
    // N + combining tilde (NFD) — visually identical, different code points
    // — and canonicalization makes case and stray whitespace irrelevant.
    const composed = "EL NIÑO";
    const decomposed = "EL NIN\u0303O"; // NFD, escaped so no editor can re-compose it
    const rest = TILES.slice(1);
    expect(sameWordSet([composed, ...rest], [...rest, decomposed])).toBe(true);
    expect(sameWordSet(["el niño", ...rest], [composed, ...rest])).toBe(true);
    expect(sameWordSet([" EL  NIÑO ", ...rest], [composed, ...rest])).toBe(true);
  });

  it("counts duplicates — equal word sets with different multiplicity differ", () => {
    const fourteen = TILES.slice(0, 14);
    const twoTwins = ["TWIN", "TWIN", ...fourteen];
    const twoWordZeros = ["TWIN", fourteen[0], ...fourteen];
    expect(sameWordSet(twoTwins, twoWordZeros)).toBe(false);
  });

  it("rejects non-arrays and length mismatches outright", () => {
    expect(sameWordSet(TILES, TILES.slice(0, 15))).toBe(false);
    expect(sameWordSet(null, TILES)).toBe(false);
    expect(sameWordSet(TILES, undefined)).toBe(false);
  });
});

// ---- todayET -------------------------------------------------------------

describe("todayET", () => {
  it("is the shared implementation, re-exported for app convenience", () => {
    // Behavior (ET rollover, DST) is tested in shared/puzzleDates.test.js;
    // what matters here is that the client and the Worker can't drift.
    expect(todayET).toBe(sharedTodayET);
  });
});
