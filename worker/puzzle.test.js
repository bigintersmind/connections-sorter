// Unit tests for the shared NYT Connections fetch + transform (worker/puzzle.js).
//
// This is the project's highest-value test surface: it's the single chokepoint
// where the day's puzzle is fetched, the answer key/groupings are stripped, and
// only the 16 board-order words are returned. The tests below exist to lock down
// the load-bearing contracts that a refactor would otherwise break SILENTLY (no
// crash, no lint error):
//
//   1. The answer key never reaches the client — output is only { date, words },
//      never categories/titles/positions.
//   2. Output is always exactly 16 non-empty, uppercased words in board
//      (position) order — or a clean PuzzleError, never a partial/garbage array.
//   3. The server enforces the date window, so a crafted ?date= can't turn the
//      proxy into an archive scraper.
//   7. schema_mismatch stays a distinct, content-free alerting signal.
//
// Everything here runs as plain Node — these are pure functions plus an async
// function with an injectable fetchImpl, so no jsdom / Workers runtime needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUZZLE_LAUNCH_DATE,
  RECENT_WINDOW_DAYS,
  PuzzleError,
  addDays,
  todayET,
  resolvePuzzleDate,
  fetchPuzzleWords,
} from "./puzzle.js";

// ---- helpers -------------------------------------------------------------

// A minimal stand-in for the Response fetchPuzzleWords consumes: it reads
// res.status, res.ok, and awaits res.json().
function mockResponse({ status = 200, body = {}, jsonThrows = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  };
}

// A fetchImpl that always resolves with the given mock response.
const respondWith = (opts) => () => Promise.resolve(mockResponse(opts));

// Build an NYT-shaped payload from a flat list of {content, position} cards,
// chunked into categories of four with throwaway group titles. The titles are
// deliberately distinctive so the privacy tests can prove they don't leak.
function payloadFromCards(cards, extra = {}) {
  const categories = [];
  for (let i = 0; i < cards.length; i += 4) {
    categories.push({ title: `SECRET_GROUP_${i / 4}`, cards: cards.slice(i, i + 4) });
  }
  return { categories, ...extra };
}

// Catch a rejection and return it, so we can assert on the thrown value's
// properties rather than just its message.
const catchError = (promise) => promise.then(() => undefined, (e) => e);

// Several failure paths log via console.error/warn. Silence them so the test
// output stays clean; individual tests that assert on log content re-spy.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---- constants -----------------------------------------------------------

describe("window constants", () => {
  // Pinned because the boundary tests below assume these exact values, and
  // because src/App.jsx duplicates them — a deliberate change should break a
  // test, not silently let the chips and the server disagree.
  it("are the documented launch date and window size", () => {
    expect(PUZZLE_LAUNCH_DATE).toBe("2023-06-12");
    expect(RECENT_WINDOW_DAYS).toBe(6);
  });
});

// ---- addDays -------------------------------------------------------------

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("goes backwards across a month boundary", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("handles a leap day", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("is DST-safe — pure UTC arithmetic doesn't drift across spring-forward", () => {
    // US DST begins 2026-03-08. A local-time implementation could land on the
    // wrong day here; UTC arithmetic stays exact.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-03-07", 7)).toBe("2026-03-14");
  });
});

// ---- todayET -------------------------------------------------------------

describe("todayET", () => {
  it("rolls over at midnight Eastern, not UTC (EDT / summer)", () => {
    // 03:00 UTC on 2026-05-28 is still 2026-05-27 23:00 in New York (EDT, -4).
    expect(todayET(new Date("2026-05-28T03:00:00Z"))).toBe("2026-05-27");
    // 05:00 UTC is 2026-05-28 01:00 in New York.
    expect(todayET(new Date("2026-05-28T05:00:00Z"))).toBe("2026-05-28");
  });

  it("rolls over at midnight Eastern (EST / winter, -5)", () => {
    expect(todayET(new Date("2026-01-15T04:00:00Z"))).toBe("2026-01-14");
    expect(todayET(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-15");
  });
});

// ---- resolvePuzzleDate (the date-window gate) ----------------------------

describe("resolvePuzzleDate", () => {
  // A fixed "now" well after launch so the rolling 7-day window is the active
  // floor. todayET(NOW) === "2026-05-28".
  const NOW = new Date("2026-05-28T16:00:00Z");

  it("defaults an empty request to today", () => {
    expect(resolvePuzzleDate(null, NOW)).toEqual({ date: "2026-05-28" });
    expect(resolvePuzzleDate("", NOW)).toEqual({ date: "2026-05-28" });
    expect(resolvePuzzleDate(undefined, NOW)).toEqual({ date: "2026-05-28" });
  });

  it("accepts today and the in-window past", () => {
    expect(resolvePuzzleDate("2026-05-28", NOW)).toEqual({ date: "2026-05-28" });
    expect(resolvePuzzleDate("2026-05-25", NOW)).toEqual({ date: "2026-05-25" });
  });

  it("accepts exactly the oldest in-window day (today - 6)", () => {
    expect(resolvePuzzleDate("2026-05-22", NOW)).toEqual({ date: "2026-05-22" });
  });

  it("rejects the day just past the window (today - 7) as out_of_range", () => {
    expect(resolvePuzzleDate("2026-05-21", NOW)).toEqual({ error: "out_of_range" });
  });

  it("rejects a future date", () => {
    expect(resolvePuzzleDate("2026-05-29", NOW)).toEqual({ error: "future" });
  });

  it("rejects a malformed date as bad_date", () => {
    expect(resolvePuzzleDate("2026-5-1", NOW)).toEqual({ error: "bad_date" });
    expect(resolvePuzzleDate("not-a-date", NOW)).toEqual({ error: "bad_date" });
    expect(resolvePuzzleDate("05-28-2026", NOW)).toEqual({ error: "bad_date" });
  });

  it("still rejects a format-valid but calendar-impossible date", () => {
    // The regex is format-only, so "2026-13-40" passes it; the range checks
    // then reject it (it string-compares greater than today → future). The
    // point: such input is never accepted, even though it slips past the regex.
    const result = resolvePuzzleDate("2026-13-40", NOW);
    expect(result.date).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it("clamps the floor to the launch date when the window reaches before it", () => {
    // Near launch, the rolling window (today - 6) would reach before NYT's
    // first puzzle, so PUZZLE_LAUNCH_DATE becomes the floor instead.
    const nearLaunch = new Date("2023-06-14T16:00:00Z"); // todayET === 2023-06-14
    expect(resolvePuzzleDate("2023-06-12", nearLaunch)).toEqual({ date: "2023-06-12" });
    expect(resolvePuzzleDate("2023-06-11", nearLaunch)).toEqual({ error: "out_of_range" });
    // 2023-06-08 is inside the rolling 6-day window but before launch.
    expect(resolvePuzzleDate("2023-06-08", nearLaunch)).toEqual({ error: "out_of_range" });
  });
});

// ---- fetchPuzzleWords: happy path + the privacy contract -----------------

describe("fetchPuzzleWords — transform", () => {
  it("returns exactly the 16 words in board (position) order", async () => {
    // Board order is WORD0..WORD15; hand the cards over reversed to prove the
    // sort, not the input order, decides the output.
    const board = Array.from({ length: 16 }, (_, i) => `WORD${i}`);
    const cards = board.map((content, position) => ({ content, position })).reverse();
    const result = await fetchPuzzleWords("2026-05-28", {
      fetchImpl: respondWith({ body: payloadFromCards(cards) }),
    });
    expect(result.words).toEqual(board);
  });

  it("uppercases and trims, preserving accented characters", async () => {
    // The client passes these through verbatim (no OCR normalizer), so this
    // transform is the only thing cleaning them — accents must survive.
    const cards = [
      { content: "  el niño  ", position: 0 },
      { content: "café", position: 1 },
      ...Array.from({ length: 14 }, (_, i) => ({ content: `w${i}`, position: i + 2 })),
    ];
    const result = await fetchPuzzleWords("2026-05-28", {
      fetchImpl: respondWith({ body: payloadFromCards(cards) }),
    });
    expect(result.words[0]).toBe("EL NIÑO");
    expect(result.words[1]).toBe("CAFÉ");
  });

  it("returns ONLY { date, words } — never the answer key or groupings", async () => {
    // Contract #1: the whole reason the server hop exists. Category titles,
    // positions, and groupings must not survive into the response.
    const cards = Array.from({ length: 16 }, (_, i) => ({ content: `WORD${i}`, position: i }));
    const result = await fetchPuzzleWords("2026-05-28", {
      fetchImpl: respondWith({ body: payloadFromCards(cards, { print_date: "2026-05-28" }) }),
    });
    expect(Object.keys(result).sort()).toEqual(["date", "words"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/SECRET_GROUP/); // category titles
    expect(serialized).not.toMatch(/position/);
    expect(serialized).not.toMatch(/categories/);
  });

  it("echoes upstream print_date when present", async () => {
    const cards = Array.from({ length: 16 }, (_, i) => ({ content: `WORD${i}`, position: i }));
    const result = await fetchPuzzleWords("2026-05-28", {
      fetchImpl: respondWith({ body: payloadFromCards(cards, { print_date: "2026-05-27" }) }),
    });
    expect(result.date).toBe("2026-05-27");
  });

  it("falls back to the requested date when print_date is missing or non-string", async () => {
    const cards = Array.from({ length: 16 }, (_, i) => ({ content: `WORD${i}`, position: i }));
    const missing = await fetchPuzzleWords("2026-05-28", {
      fetchImpl: respondWith({ body: payloadFromCards(cards) }),
    });
    expect(missing.date).toBe("2026-05-28");
    const nonString = await fetchPuzzleWords("2026-05-28", {
      fetchImpl: respondWith({ body: payloadFromCards(cards, { print_date: 20260528 }) }),
    });
    expect(nonString.date).toBe("2026-05-28");
  });
});

// ---- fetchPuzzleWords: failure taxonomy ----------------------------------

describe("fetchPuzzleWords — error mapping", () => {
  async function expectPuzzleError(promise, code, status) {
    const err = await catchError(promise);
    expect(err).toBeInstanceOf(PuzzleError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  }

  it("maps a network/transport failure to upstream_unreachable (502)", async () => {
    await expectPuzzleError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) }),
      "upstream_unreachable",
      502,
    );
  });

  it("maps a 404 to not_found (404)", async () => {
    await expectPuzzleError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: respondWith({ status: 404 }) }),
      "not_found",
      404,
    );
  });

  it("maps other non-ok statuses to upstream_error (502)", async () => {
    await expectPuzzleError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: respondWith({ status: 500 }) }),
      "upstream_error",
      502,
    );
    await expectPuzzleError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: respondWith({ status: 403 }) }),
      "upstream_error",
      502,
    );
  });

  it("maps a non-JSON body to upstream_error (502)", async () => {
    await expectPuzzleError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: respondWith({ jsonThrows: true }) }),
      "upstream_error",
      502,
    );
  });
});

// ---- fetchPuzzleWords: schema mismatch (clean failure, not garbage) ------

describe("fetchPuzzleWords — schema mismatch", () => {
  async function expectSchemaMismatch(body) {
    const err = await catchError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: respondWith({ body }) }),
    );
    expect(err).toBeInstanceOf(PuzzleError);
    expect(err.code).toBe("schema_mismatch");
    expect(err.status).toBe(502);
  }

  it("rejects when categories are missing entirely", async () => {
    await expectSchemaMismatch({ status: "OK" });
  });

  it("rejects when there aren't exactly 16 cards", async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ({ content: `WORD${i}`, position: i }));
    await expectSchemaMismatch(payloadFromCards(fifteen));
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ content: `WORD${i}`, position: i }));
    await expectSchemaMismatch(payloadFromCards(seventeen));
  });

  it("rejects when any word is empty after trimming, rather than serving a hole", async () => {
    const cards = Array.from({ length: 16 }, (_, i) => ({
      content: i === 7 ? "   " : `WORD${i}`,
      position: i,
    }));
    await expectSchemaMismatch(payloadFromCards(cards));
  });

  it("logs a content-free fingerprint on schema mismatch (never the words)", async () => {
    // Contract #7: schema_mismatch is the alerting breadcrumb for an NYT schema
    // change, and the diagnostic it logs must never leak puzzle content.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "TOPSECRETANSWERWORD";
    const cards = Array.from({ length: 15 }, (_, i) => ({
      content: i === 0 ? secret : `WORD${i}`,
      position: i,
    }));
    await catchError(
      fetchPuzzleWords("2026-05-28", { fetchImpl: respondWith({ body: payloadFromCards(cards) }) }),
    );
    const logged = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toMatch(/schema mismatch/i);
    expect(logged).not.toContain(secret);
  });
});
