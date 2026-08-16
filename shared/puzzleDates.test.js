// Unit tests for the shared date helpers (shared/puzzleDates.js).
//
// This module is imported by both the server (worker/puzzle.js) and the client
// (src/savedPuzzle.js), and it used to exist as two hand-mirrored copies. The
// contracts locked down here are the ones a drift would break silently:
//
//   1. "Today" is the ET calendar day, not the UTC one — a puzzle rolls over
//      at midnight Eastern, so a UTC read serves yesterday's board to anyone
//      west of Greenwich for part of the evening.
//   2. Date arithmetic is UTC-based and therefore DST-proof: adding a day
//      across spring-forward must land on the next calendar day, not the same
//      one 23 hours later.
//   3. The window is exactly today + 2 prior days, floored at launch day —
//      the same number the switcher renders and the Worker enforces.
//
// Pure module, plain Node — no jsdom, mirroring worker/puzzle.test.js.

import { describe, expect, it } from "vitest";
import {
  ISO_DATE,
  PUZZLE_LAUNCH_DATE,
  RECENT_WINDOW_DAYS,
  addDays,
  earliestAllowedDate,
  isIsoDate,
  todayET,
  windowDates,
} from "./puzzleDates.js";

describe("window constants", () => {
  // Pinned because the boundary tests below assume these exact values, and
  // because the switcher, the store's pruning, and the Worker's date gate all
  // derive from them — a deliberate change should break a test, not silently
  // let the UI and the server disagree about which days exist.
  it("are the documented launch date and window size", () => {
    expect(PUZZLE_LAUNCH_DATE).toBe("2023-06-12");
    expect(RECENT_WINDOW_DAYS).toBe(2);
  });
});

describe("isIsoDate", () => {
  it("accepts a well-formed YYYY-MM-DD string", () => {
    expect(isIsoDate("2026-08-16")).toBe(true);
    expect(isIsoDate(PUZZLE_LAUNCH_DATE)).toBe(true);
  });

  it("rejects other shapes and non-strings without throwing", () => {
    // Every caller feeds this untrusted input (URL params, localStorage), so
    // being total on garbage is the point.
    expect(isIsoDate("2026-8-16")).toBe(false);
    expect(isIsoDate("08-16-2026")).toBe(false);
    expect(isIsoDate("garbage")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(20260816)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate({ toString: () => "2026-08-16" })).toBe(false);
  });

  it("is format-only — a calendar-impossible date still matches", () => {
    // Documented, not a bug: range checks (against today / the window floor)
    // are what reject "2026-13-40", and they do it by string comparison.
    expect(isIsoDate("2026-13-40")).toBe(true);
    expect(ISO_DATE.test("2026-13-40")).toBe(true);
  });
});

describe("todayET", () => {
  it("rolls over at midnight Eastern, not UTC (EDT / summer, -4)", () => {
    // 03:00 UTC on 2026-05-28 is still 2026-05-27 23:00 in New York.
    expect(todayET(new Date("2026-05-28T03:00:00Z"))).toBe("2026-05-27");
    // 05:00 UTC is 2026-05-28 01:00 in New York.
    expect(todayET(new Date("2026-05-28T05:00:00Z"))).toBe("2026-05-28");
  });

  it("rolls over at midnight Eastern (EST / winter, -5)", () => {
    expect(todayET(new Date("2026-01-15T04:00:00Z"))).toBe("2026-01-14");
    expect(todayET(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-15");
  });

  it("moves the rollover instant across spring-forward", () => {
    // US DST begins 2026-03-08. Midnight ET that morning is 05:00 UTC (still
    // EST); midnight ET the next morning is 04:00 UTC (EDT). A hardcoded
    // offset would be an hour wrong on one of these two days.
    expect(todayET(new Date("2026-03-08T04:59:00Z"))).toBe("2026-03-07");
    expect(todayET(new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(todayET(new Date("2026-03-09T03:59:00Z"))).toBe("2026-03-08");
    expect(todayET(new Date("2026-03-09T04:00:00Z"))).toBe("2026-03-09");
  });

  it("moves the rollover instant across fall-back", () => {
    // US DST ends 2026-11-01: midnight ET is 04:00 UTC that morning, 05:00
    // UTC the next.
    expect(todayET(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
    expect(todayET(new Date("2026-11-02T04:59:00Z"))).toBe("2026-11-01");
    expect(todayET(new Date("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("goes backwards across a month boundary", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("handles a leap day", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("is DST-safe — pure UTC arithmetic doesn't drift across spring-forward", () => {
    // US DST begins 2026-03-08 (a 23-hour local day). A local-time
    // implementation could land back on the same date here.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-03-09", -1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", -1)).toBe("2026-03-07");
  });

  it("is DST-safe across fall-back too (the 25-hour day)", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-11-02", -1)).toBe("2026-11-01");
  });

  it("returns its input for a zero delta", () => {
    expect(addDays("2026-08-16", 0)).toBe("2026-08-16");
  });
});

describe("earliestAllowedDate", () => {
  it("is today minus the window", () => {
    expect(earliestAllowedDate("2026-08-16")).toBe("2026-08-14");
  });

  it("is DST-safe across a spring-forward week", () => {
    expect(earliestAllowedDate("2026-03-09")).toBe("2026-03-07");
  });

  it("clamps to launch day when the window would reach before the first puzzle", () => {
    // Two days after launch, today - 2 is exactly launch day; one day after,
    // the rolling floor would be 2023-06-11, which never existed.
    expect(earliestAllowedDate("2023-06-14")).toBe("2023-06-12");
    expect(earliestAllowedDate("2023-06-13")).toBe(PUZZLE_LAUNCH_DATE);
    expect(earliestAllowedDate("2023-06-12")).toBe(PUZZLE_LAUNCH_DATE);
  });
});

describe("windowDates", () => {
  it("lists today and the two prior days, newest first", () => {
    expect(windowDates("2026-08-16")).toEqual(["2026-08-16", "2026-08-15", "2026-08-14"]);
  });

  it("crosses a month boundary", () => {
    expect(windowDates("2026-09-01")).toEqual(["2026-09-01", "2026-08-31", "2026-08-30"]);
  });

  it("is DST-safe — the switcher shows three distinct days across spring-forward", () => {
    // The week the switcher's weekday label would be wrong if this drifted.
    expect(windowDates("2026-03-09")).toEqual(["2026-03-09", "2026-03-08", "2026-03-07"]);
  });

  it("stops at launch day rather than offering a puzzle that never existed", () => {
    expect(windowDates("2023-06-13")).toEqual(["2023-06-13", "2023-06-12"]);
    expect(windowDates("2023-06-12")).toEqual(["2023-06-12"]);
  });

  it("agrees with earliestAllowedDate — the oldest entry is exactly the floor", () => {
    // The switcher (windowDates) and the store's pruning (earliestAllowedDate)
    // must never disagree, or a segment renders for a board pruning drops.
    for (const today of ["2026-08-16", "2026-03-09", "2023-06-13", "2023-06-12"]) {
      const dates = windowDates(today);
      expect(dates.at(-1)).toBe(earliestAllowedDate(today));
    }
  });
});
