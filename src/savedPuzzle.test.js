// Unit tests for the saved-puzzle store (src/savedPuzzle.js).
//
// This module owns the persisted board schema — the two-slot {current,
// previous} shape under the "connections-puzzle" localStorage key — and all
// reasoning about it: legacy migration, malformed-data rejection, metadata
// stamping, and the board-header date label. The contracts locked down here
// are load-bearing for the returning-user landing feature (connections-41d):
//
//   1. A legacy {tiles, lockedRows, labels} blob parses as a current board
//      with source "unknown" — that exact string is how launch recognizes a
//      pre-metadata save, which it settles by fetching today's words and
//      comparing (decideLaunch "fetch-compare" → applyLegacyDaily).
//   2. Malformed data (junk JSON, wrong tile count) parses to "no save",
//      never a half-valid board.
//   3. parse(serialize(store)) round-trips losslessly, so persisting and
//      resuming can never drift apart.
//   4. dateLabel is pure calendar math on ISO strings (caller supplies
//      "today" in ET) — DST-safe, no hidden clock reads.
//
// Pure module, plain Node — no jsdom, mirroring worker/puzzle.test.js.

import { describe, expect, it } from "vitest";
import {
  applyDailySwap,
  applyLegacyDaily,
  boardSummary,
  dateLabel,
  decideLaunch,
  isStaleDaily,
  makeBoard,
  parseStore,
  sameWordSet,
  serializeStore,
  swapBoards,
  todayET,
  weekdayLong,
} from "./savedPuzzle.js";

// 16 distinct words, the way every real save has them: normalized uppercase.
const TILES = Array.from({ length: 16 }, (_, i) => `WORD${i}`);

// A pre-metadata save, exactly as the app wrote it before this module existed.
const legacyBlob = (extra = {}) =>
  JSON.stringify({
    tiles: TILES,
    lockedRows: [true, false, false, false],
    labels: ["fruit", "", "", ""],
    ...extra,
  });

describe("parseStore — legacy migration", () => {
  it("parses a legacy flat blob as a current board with unknown provenance", () => {
    const store = parseStore(legacyBlob());
    expect(store).toEqual({
      current: {
        tiles: TILES,
        lockedRows: [true, false, false, false],
        labels: ["fruit", "", "", ""],
        source: "unknown",
        chosenExplicitly: false,
      },
      previous: null,
    });
    // No date key at all — downstream slices treat "no trusted date" as exempt.
    expect("date" in store.current).toBe(false);
  });

  it("defaults missing or corrupt lockedRows/labels instead of dropping the save", () => {
    // The old loadSaved was lenient here (`data.lockedRows || defaults`);
    // tiles are the save, locks/labels are recoverable decoration.
    const bare = parseStore(JSON.stringify({ tiles: TILES }));
    expect(bare.current.lockedRows).toEqual([false, false, false, false]);
    expect(bare.current.labels).toEqual(["", "", "", ""]);

    const corrupt = parseStore(legacyBlob({ lockedRows: [true], labels: "x" }));
    expect(corrupt.current.tiles).toEqual(TILES);
    expect(corrupt.current.lockedRows).toEqual([false, false, false, false]);
    expect(corrupt.current.labels).toEqual(["", "", "", ""]);
  });
});

// A fully-stamped daily board in the new shape.
const dailyBoard = (overrides = {}) => ({
  tiles: TILES,
  lockedRows: [false, true, false, false],
  labels: ["", "trees", "", ""],
  date: "2026-06-09",
  source: "daily",
  chosenExplicitly: false,
  ...overrides,
});

describe("parseStore — two-slot shape", () => {
  it("parses a current daily board with its metadata intact", () => {
    const store = parseStore(JSON.stringify({ current: dailyBoard() }));
    expect(store).toEqual({ current: dailyBoard(), previous: null });
  });

  it("parses both slots when a previous board exists", () => {
    const prev = dailyBoard({ date: "2026-06-08", chosenExplicitly: true });
    const store = parseStore(JSON.stringify({ current: dailyBoard(), previous: prev }));
    expect(store.previous).toEqual(prev);
  });

  it("keeps the current board when only the previous slot is corrupt", () => {
    const store = parseStore(
      JSON.stringify({ current: dailyBoard(), previous: { tiles: ["JUST", "FOUR"] } }),
    );
    expect(store.current).toEqual(dailyBoard());
    expect(store.previous).toBe(null);
  });

  it("treats a corrupt current board as no save even if previous is fine", () => {
    expect(
      parseStore(JSON.stringify({ current: { tiles: [] }, previous: dailyBoard() })),
    ).toBe(null);
  });

  it("degrades unrecognized metadata softly instead of dropping the board", () => {
    const store = parseStore(
      JSON.stringify({
        current: dailyBoard({ source: "telepathy", chosenExplicitly: "yes", date: "June 9" }),
      }),
    );
    expect(store.current.source).toBe("unknown");
    expect(store.current.chosenExplicitly).toBe(false);
    expect("date" in store.current).toBe(false);
  });
});

describe("parseStore — malformed data is no save", () => {
  it("rejects missing, junk, and non-object payloads", () => {
    expect(parseStore(null)).toBe(null);
    expect(parseStore("")).toBe(null);
    expect(parseStore("{not json")).toBe(null);
    expect(parseStore("42")).toBe(null);
    expect(parseStore('"tiles"')).toBe(null);
    expect(parseStore("null")).toBe(null);
  });

  it("rejects a board with the wrong tile count or non-string tiles", () => {
    expect(parseStore(JSON.stringify({ tiles: TILES.slice(0, 15) }))).toBe(null);
    expect(parseStore(JSON.stringify({ tiles: "sixteen words" }))).toBe(null);
    expect(parseStore(legacyBlob({ tiles: [...TILES.slice(0, 15), 16] }))).toBe(null);
  });
});

describe("serializeStore", () => {
  it("round-trips a two-slot store through parse losslessly", () => {
    const store = {
      current: dailyBoard(),
      previous: dailyBoard({ date: "2026-06-08", chosenExplicitly: true }),
    };
    expect(parseStore(serializeStore(store))).toEqual(store);
  });

  it("round-trips a migrated legacy save into the two-slot shape", () => {
    // The exact path an existing user's save takes on first launch after this
    // ships: legacy blob → parse → persist effect serializes → next launch
    // parses the new shape. Provenance must survive as "unknown".
    const migrated = parseStore(legacyBlob());
    const reloaded = parseStore(serializeStore(migrated));
    expect(reloaded).toEqual(migrated);
    expect(JSON.parse(serializeStore(migrated)).current.source).toBe("unknown");
  });

  it("serializes a store with no previous board", () => {
    const store = parseStore(serializeStore({ current: dailyBoard(), previous: null }));
    expect(store.previous).toBe(null);
  });

  it("refuses to serialize an invalid current board", () => {
    expect(() => serializeStore({ current: { tiles: ["nope"] }, previous: null })).toThrow();
  });
});

describe("makeBoard", () => {
  it("builds a fresh daily board stamped with the server date", () => {
    // The auto-load / "Today's Puzzle" card path: server-resolved date,
    // not chosen explicitly.
    expect(makeBoard(TILES, { date: "2026-06-09", source: "daily" })).toEqual({
      tiles: TILES,
      lockedRows: [false, false, false, false],
      labels: ["", "", "", ""],
      date: "2026-06-09",
      source: "daily",
      chosenExplicitly: false,
    });
  });

  it("marks a past-date chip load as chosen explicitly", () => {
    const board = makeBoard(TILES, {
      date: "2026-06-05",
      source: "daily",
      chosenExplicitly: true,
    });
    expect(board.chosenExplicitly).toBe(true);
  });

  it("builds dateless boards for ocr/manual/demo sources", () => {
    for (const source of ["ocr", "manual", "demo"]) {
      const board = makeBoard(TILES, { source });
      expect(board.source).toBe(source);
      expect("date" in board).toBe(false);
      expect(board.chosenExplicitly).toBe(false);
    }
  });
});

describe("decideLaunch", () => {
  const TODAY = "2026-06-09";

  it("fetches today when there is no save", () => {
    expect(decideLaunch(null, TODAY)).toBe("fetch-today");
  });

  it("swaps a stale auto-loaded daily board for today's puzzle", () => {
    const saved = { current: dailyBoard({ date: "2026-06-08" }), previous: null };
    expect(decideLaunch(saved, TODAY)).toBe("fetch-swap");
  });

  it("resumes silently when the daily board is already today's", () => {
    const saved = { current: dailyBoard({ date: TODAY }), previous: null };
    expect(decideLaunch(saved, TODAY)).toBe("resume");
  });

  it("never swaps out a stale board the player chose explicitly", () => {
    const saved = {
      current: dailyBoard({ date: "2026-06-05", chosenExplicitly: true }),
      previous: null,
    };
    expect(decideLaunch(saved, TODAY)).toBe("resume");
  });

  it("resumes ocr/manual/demo boards silently — no trusted date, no nagging", () => {
    for (const source of ["ocr", "manual", "demo"]) {
      const saved = { current: makeBoard(TILES, { source }), previous: null };
      expect(decideLaunch(saved, TODAY)).toBe("resume");
    }
  });

  it("fetch-compares a legacy unknown-provenance board against today's words", () => {
    // The pre-metadata save can't prove what it is; the fetch settles it via
    // applyLegacyDaily. This branch is what reaches the bouncing cohort —
    // users whose save never gets rewritten because they leave before
    // loading anything new.
    expect(decideLaunch(parseStore(legacyBlob()), TODAY)).toBe("fetch-compare");
  });

  it("resumes a legacy board re-entered via resume — exempt, never re-compared", () => {
    const { current } = parseStore(legacyBlob());
    const resumed = { current: { ...current, chosenExplicitly: true }, previous: null };
    expect(decideLaunch(resumed, TODAY)).toBe("resume");
  });

  it("resumes rather than swaps when staleness can't be proven", () => {
    // A daily board missing its date, or dated in the future (client clock
    // skew), can't be shown to be stale — never yank those.
    const dateless = { ...dailyBoard() };
    delete dateless.date;
    expect(decideLaunch({ current: dateless, previous: null }, TODAY)).toBe("resume");
    const future = { current: dailyBoard({ date: "2026-06-10" }), previous: null };
    expect(decideLaunch(future, TODAY)).toBe("resume");
  });
});

describe("isStaleDaily", () => {
  // The predicate behind both the launch fetch-swap and the refocus banner
  // (a tab left open overnight): a non-exempt daily provably dated before
  // today is the only board the app ever offers to replace.
  const TODAY = "2026-06-09";

  it("flags a non-exempt daily board dated before today", () => {
    expect(isStaleDaily(dailyBoard({ date: "2026-06-08" }), TODAY)).toBe(true);
  });

  it("does not flag today's board, nor across-midnight until the date advances", () => {
    const board = dailyBoard({ date: TODAY });
    expect(isStaleDaily(board, TODAY)).toBe(false);
    // The same board after ET midnight — the refocus check goes live.
    expect(isStaleDaily(board, "2026-06-10")).toBe(true);
  });

  it("never flags exempt boards — chip-chosen, resumed, or untrusted sources", () => {
    expect(isStaleDaily(dailyBoard({ date: "2026-06-05", chosenExplicitly: true }), TODAY)).toBe(false);
    for (const source of ["ocr", "manual", "demo"]) {
      expect(isStaleDaily(makeBoard(TILES, { source }), TODAY)).toBe(false);
    }
    expect(isStaleDaily(parseStore(legacyBlob()).current, TODAY)).toBe(false);
  });

  it("can't prove staleness without a date, or against clock skew", () => {
    const dateless = { ...dailyBoard() };
    delete dateless.date;
    expect(isStaleDaily(dateless, TODAY)).toBe(false);
    expect(isStaleDaily(dailyBoard({ date: "2026-06-10" }), TODAY)).toBe(false);
  });

  it("works on the app's metadata slice — no tiles required", () => {
    // The refocus listener passes boardMeta ({date, source, chosenExplicitly}),
    // not a full board.
    expect(isStaleDaily({ date: "2026-06-08", source: "daily", chosenExplicitly: false }, TODAY)).toBe(true);
  });
});

describe("swapBoards", () => {
  // Today's board (auto-loaded, some sorting done) on screen; yesterday's
  // half-played board waiting in the previous slot.
  const todays = dailyBoard({ date: "2026-06-09" });
  const yesterdays = dailyBoard({
    tiles: [...TILES].reverse(),
    date: "2026-06-08",
    lockedRows: [true, true, false, false],
    labels: ["fish", "birds", "", ""],
  });

  it("swaps losslessly and marks the re-entered board chosen-explicitly", () => {
    const next = swapBoards({ current: todays, previous: yesterdays }, "2026-06-09");
    // The resumed board comes back exactly as it was, now exempt from
    // future auto-swaps; the outgoing board's own metadata is untouched.
    expect(next.current).toEqual({ ...yesterdays, chosenExplicitly: true });
    expect(next.previous).toEqual(todays);
  });

  it("is reversible — swapping back restores today's board and its progress", () => {
    const there = swapBoards({ current: todays, previous: yesterdays }, "2026-06-09");
    const back = swapBoards(there, "2026-06-09");
    // Today's board returns intact but NOT exempt: re-entering today's
    // puzzle isn't a choice of an old board, and exempting it would freeze
    // the player on it tomorrow — the stale-board bounce all over again.
    expect(back.current).toEqual({ ...todays, chosenExplicitly: false });
    expect(back.previous).toEqual({ ...yesterdays, chosenExplicitly: true });
  });

  it("still auto-swaps tomorrow after a resume round-trip ends on today's board", () => {
    const there = swapBoards({ current: todays, previous: yesterdays }, "2026-06-09");
    const back = swapBoards(there, "2026-06-09");
    expect(decideLaunch({ current: back.current, previous: back.previous }, "2026-06-10")).toBe(
      "fetch-swap",
    );
  });

  it("re-entering a dateless board still marks it chosen-explicitly", () => {
    // A dateless board (ocr/manual/demo) re-entered via resume is marked
    // chosen-explicitly like any other non-today board; its source already
    // exempts it, so the flag is belt and suspenders.
    const manual = makeBoard(TILES, { source: "manual" });
    const next = swapBoards({ current: todays, previous: manual }, "2026-06-09");
    expect(next.current.chosenExplicitly).toBe(true);
  });

  it("throws when there is no previous board to swap to", () => {
    expect(() => swapBoards({ current: todays, previous: null })).toThrow();
  });
});

describe("applyDailySwap", () => {
  const FRESH_WORDS = Array.from({ length: 16 }, (_, i) => `NEW${i}`);

  it("moves the stale board to previous and makes the fetched puzzle current", () => {
    const stale = dailyBoard({ date: "2026-06-08", lockedRows: [true, false, false, false] });
    const next = applyDailySwap(
      { current: stale, previous: null },
      { words: FRESH_WORDS, date: "2026-06-09" },
    );
    // Today's board starts fresh and swappable; the old board is preserved
    // exactly, locks and all.
    expect(next.current).toEqual(
      makeBoard(FRESH_WORDS, { date: "2026-06-09", source: "daily" }),
    );
    expect(next.previous).toEqual(stale);
  });

  it("keeps only one previous slot — an older previous board is dropped", () => {
    const stale = dailyBoard({ date: "2026-06-08" });
    const ancient = dailyBoard({ date: "2026-06-01" });
    const next = applyDailySwap(
      { current: stale, previous: ancient },
      { words: FRESH_WORDS, date: "2026-06-09" },
    );
    expect(next.previous).toEqual(stale);
  });
});

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
    const decomposed = "EL NIN\u0303O"; // NFD, as an escape so no editor can re-compose it
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

describe("applyLegacyDaily", () => {
  const TODAY = "2026-06-09";

  it("stamps a matching board in place — progress intact, now today's daily", () => {
    // The bouncing-cohort happy path: their legacy board (locked row, label)
    // holds today's words in whatever order they've sorted them into.
    const saved = parseStore(legacyBlob());
    const { matched, store } = applyLegacyDaily(saved, {
      words: [...TILES].reverse(),
      date: TODAY,
    });
    expect(matched).toBe(true);
    expect(store.current).toEqual({ ...saved.current, date: TODAY, source: "daily" });
    // Still not chosen-explicitly: tomorrow this board auto-swaps like any
    // other auto-loaded daily.
    expect(store.current.chosenExplicitly).toBe(false);
    expect(store.previous).toBe(null);
  });

  it("after the stamp the board is today's: resumes today, swaps tomorrow", () => {
    const { store } = applyLegacyDaily(parseStore(legacyBlob()), {
      words: TILES,
      date: TODAY,
    });
    const reloaded = parseStore(serializeStore(store));
    expect(decideLaunch(reloaded, TODAY)).toBe("resume");
    expect(decideLaunch(reloaded, "2026-06-10")).toBe("fetch-swap");
  });

  it("swaps a non-matching board out like any stale daily", () => {
    const saved = parseStore(legacyBlob());
    const todaysWords = Array.from({ length: 16 }, (_, i) => `NEW${i}`);
    const { matched, store } = applyLegacyDaily(saved, { words: todaysWords, date: TODAY });
    expect(matched).toBe(false);
    expect(store.current).toEqual(makeBoard(todaysWords, { date: TODAY, source: "daily" }));
    // The old board is recoverable via resume with its progress intact.
    expect(store.previous).toEqual(saved.current);
  });

  it("leaves a matching board unstamped when the response carries no date", () => {
    // A dateless "daily" board could never be proven stale by decideLaunch —
    // stamping would freeze the user on it forever. Staying "unknown" means
    // the next launch simply re-compares.
    const saved = parseStore(legacyBlob());
    const { matched, store } = applyLegacyDaily(saved, { words: TILES });
    expect(matched).toBe(true);
    expect(store.current).toEqual(saved.current);
    expect(decideLaunch(store, TODAY)).toBe("fetch-compare");
  });

  it("an untouched store re-decides fetch-compare after a persist round-trip", () => {
    // The fetch-failure retry contract. The failure branch never reaches
    // this function — the app resumes the board untouched — so what must
    // hold is that the unmodified store, persisted and reloaded, still
    // decides fetch-compare.
    const saved = parseStore(legacyBlob());
    expect(decideLaunch(parseStore(serializeStore(saved)), TODAY)).toBe("fetch-compare");
  });

  it("leaves a matching board unstamped when the response date isn't ISO", () => {
    // Same freeze-forever guard as the dateless case, for a malformed date.
    const saved = parseStore(legacyBlob());
    const { matched, store } = applyLegacyDaily(saved, { words: TILES, date: "June 9" });
    expect(matched).toBe(true);
    expect("date" in store.current).toBe(false);
    expect(decideLaunch(store, TODAY)).toBe("fetch-compare");
  });
});

describe("dateLabel", () => {
  it("returns null when the board has no date", () => {
    expect(dateLabel(undefined, "2026-06-09")).toBe(null);
    expect(dateLabel(null, "2026-06-09")).toBe(null);
  });

  it("labels a board dated today as 'Today'", () => {
    expect(dateLabel("2026-06-09", "2026-06-09")).toBe("Today");
  });

  it("labels an older board with abbreviated weekday + date", () => {
    // The PRD's own example: Friday June 5 2026 → "Fri, Jun 5".
    expect(dateLabel("2026-06-05", "2026-06-09")).toBe("Fri, Jun 5");
    // Connections launch day, a known Monday.
    expect(dateLabel("2023-06-12", "2026-06-09")).toBe("Mon, Jun 12");
  });

  it("flips from 'Today' to a dated label across the ET midnight boundary", () => {
    // Same board, one tick after ET midnight: todayISO advances a day and the
    // label must immediately stop claiming "Today".
    expect(dateLabel("2026-06-09", "2026-06-10")).toBe("Tue, Jun 9");
  });

  it("returns null rather than throwing for a malformed date string", () => {
    // In-memory boardMeta can carry a date the persist normalizer never saw;
    // Intl.format throws a RangeError on an invalid Date, which here would be
    // an uncaught render crash. Total beats throwing.
    expect(dateLabel("garbage", "2026-06-09")).toBe(null);
    expect(dateLabel("June 9", "2026-06-09")).toBe(null);
    expect(dateLabel(42, "2026-06-09")).toBe(null);
  });
});

describe("weekdayLong", () => {
  it("names the weekday for the resume notice, DST-safe", () => {
    // Friday June 5 2026 — same calendar math as dateLabel, so a local-zone
    // regression would shift this for any user west of UTC.
    expect(weekdayLong("2026-06-05")).toBe("Friday");
    expect(weekdayLong("2023-06-12")).toBe("Monday"); // Connections launch day
  });

  it("returns null for missing or malformed dates — the notice falls back to generic copy", () => {
    expect(weekdayLong(undefined)).toBe(null);
    expect(weekdayLong(null)).toBe(null);
    expect(weekdayLong("garbage")).toBe(null);
  });
});

describe("todayET", () => {
  // Mirrors worker/puzzle.test.js — the two implementations must agree, or
  // the client could decide a board is stale while the worker still serves
  // yesterday's puzzle (or vice versa).
  it("rolls over at midnight Eastern, not UTC, during EDT", () => {
    expect(todayET(new Date("2026-05-28T03:00:00Z"))).toBe("2026-05-27"); // 23:00 EDT
    expect(todayET(new Date("2026-05-28T05:00:00Z"))).toBe("2026-05-28"); // 01:00 EDT
  });

  it("rolls over at midnight Eastern, not UTC, during EST", () => {
    expect(todayET(new Date("2026-01-15T04:00:00Z"))).toBe("2026-01-14"); // 23:00 EST
    expect(todayET(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-15"); // 01:00 EST
  });
});

describe("boardSummary", () => {
  it("joins the date label and locked-group progress for the resume card", () => {
    const board = dailyBoard({ date: "2026-06-08", lockedRows: [true, true, false, false] });
    expect(boardSummary(board, "2026-06-09")).toBe("Mon, Jun 8 · 2 groups locked");
  });

  it("labels a previous board dated today as Today — the swapped-back case", () => {
    // After resuming yesterday's board, the menu card offers today's board
    // back; its one default lock also pins the singular form.
    expect(boardSummary(dailyBoard(), "2026-06-09")).toBe("Today · 1 group locked");
  });

  it("shows just the date when nothing is locked", () => {
    const board = dailyBoard({ lockedRows: [false, false, false, false] });
    expect(boardSummary(board, "2026-06-10")).toBe("Tue, Jun 9");
  });

  it("treats a malformed date like no date instead of throwing", () => {
    expect(boardSummary({ ...dailyBoard(), date: "garbage" }, "2026-06-09")).toBe(
      "1 group locked",
    );
  });

  it("never renders an empty line — progress alone, or a generic nudge", () => {
    // A dateless board (ocr/manual/demo/legacy) still summarizes its locks;
    // with nothing at all, the card gets a friendly fallback.
    const legacy = parseStore(legacyBlob()).current;
    expect(boardSummary(legacy, "2026-06-09")).toBe("1 group locked");
    expect(boardSummary(makeBoard(TILES, { source: "manual" }), "2026-06-09")).toBe(
      "Pick up where you left off",
    );
  });
});
