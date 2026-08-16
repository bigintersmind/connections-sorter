// Shared puzzle-date arithmetic and the loadable window.
//
// Imported by BOTH sides of the app: the server (worker/puzzle.js, which the
// Cloudflare Worker and the Vite dev middleware run) and the client
// (src/savedPuzzle.js, which drives the day switcher and the saved-board
// store). These rules used to exist as two hand-mirrored copies, which is a
// standing correctness hazard: if they drift, the switcher offers a day the
// Worker refuses to serve, or the store keeps a board the Worker will never
// refill. One implementation, imported twice.
//
// Depends only on `Intl` and `Date`, so it runs unchanged in the Workers
// runtime, Node (tests), and the browser.

// First public NYT Connections puzzle. Requests before this 404 upstream.
export const PUZZLE_LAUNCH_DATE = "2023-06-12";

// Loadable window: today plus this many prior days — the three segments the
// board's day switcher shows. The Worker enforces the same number, so a
// hand-crafted ?date= can't reach further back than the UI offers. Keeps the
// feature a "recent puzzles" helper, not a browsable archive.
export const RECENT_WINDOW_DAYS = 2;

// Format-only check (a calendar-impossible "2026-13-40" passes); callers that
// care about range compare the string against a real bound.
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE.test(value);
}

// Today's puzzle date (YYYY-MM-DD) in America/New_York. NYT daily puzzles roll
// over at midnight Eastern, and the endpoint's date path is the ET print_date.
// `now` is the single clock seam in the whole app — injectable for tests, and
// the reason no other module reads the wall clock.
export function todayET(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(now);
}

// Calendar arithmetic on a YYYY-MM-DD string, DST-safe (operates in UTC, where
// every day is exactly 24 hours, so spring-forward can't drop a day).
export function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// The oldest date the app will load or keep: the rolling window's floor,
// clamped to launch day so the window can't reach before the first puzzle.
export function earliestAllowedDate(todayISO) {
  const rolling = addDays(todayISO, -RECENT_WINDOW_DAYS);
  return rolling > PUZZLE_LAUNCH_DATE ? rolling : PUZZLE_LAUNCH_DATE;
}

// The switcher's days, newest first: [today, today-1, today-2], truncated
// where the window would reach before launch day (only relevant to the first
// days of the archive, but it keeps the UI from offering a 404).
export function windowDates(todayISO) {
  const dates = [];
  for (let i = 0; i <= RECENT_WINDOW_DAYS; i++) {
    const date = addDays(todayISO, -i);
    if (date < PUZZLE_LAUNCH_DATE) break;
    dates.push(date);
  }
  return dates;
}
