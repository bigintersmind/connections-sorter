// Shared NYT Connections puzzle fetch + transform.
//
// Used by BOTH the Cloudflare Worker (worker/index.js, in production and
// `wrangler dev`) and the Vite dev middleware (vite.config.js, in `npm run
// dev`) so /api/puzzle behaves identically everywhere. It depends only on web
// platform globals (fetch, Intl, Date) that exist in both the Workers runtime
// and Node, so it can be imported from either side.
//
// The load-bearing contract: this returns ONLY the 16 words, in board-position
// (display) order — NYT's own scrambled layout. It deliberately DISCARDS the
// category titles and groupings so the puzzle's answer key never leaves the
// server. The app stays a word loader, not a solver/answer site.

// First public NYT Connections puzzle. Requests before this 404 upstream.
export const PUZZLE_LAUNCH_DATE = "2023-06-12";
// Loadable window: today plus this many prior days. Keeps the feature a
// "recent puzzles" helper, not a browsable archive.
export const RECENT_WINDOW_DAYS = 6;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const nytEndpoint = (date) =>
  `https://www.nytimes.com/svc/connections/v2/${date}.json`;

export class PuzzleError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "PuzzleError";
    this.code = code;
    this.status = status;
  }
}

// Today's puzzle date (YYYY-MM-DD) in America/New_York. NYT daily puzzles roll
// over at midnight Eastern, and the endpoint's date path is the ET print_date.
export function todayET(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(now);
}

// Calendar arithmetic on a YYYY-MM-DD string, DST-safe (operates in UTC).
export function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// Resolve + validate a requested date against the allowed window. Returns
// { date } on success or { error } describing the rejection. The server is the
// source of truth here so a hand-crafted URL can't turn the proxy into an
// archive scraper.
export function resolvePuzzleDate(requested, now = new Date()) {
  const today = todayET(now);
  if (requested == null || requested === "") return { date: today };
  if (!ISO_DATE.test(requested)) return { error: "bad_date" };
  if (requested > today) return { error: "future" };
  const earliest = maxDate(addDays(today, -RECENT_WINDOW_DAYS), PUZZLE_LAUNCH_DATE);
  if (requested < earliest) return { error: "out_of_range" };
  return { date: requested };
}

function maxDate(a, b) {
  return a > b ? a : b;
}

// Fetch the day's puzzle and reduce it to 16 words in board-position order.
// `fetchImpl` is injectable for tests; defaults to the platform fetch.
export async function fetchPuzzleWords(date, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(nytEndpoint(date), { headers: { Accept: "application/json" } });
  } catch {
    throw new PuzzleError("upstream_unreachable", 502);
  }
  if (res.status === 404) throw new PuzzleError("not_found", 404);
  if (!res.ok) throw new PuzzleError("upstream_error", 502);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new PuzzleError("upstream_error", 502);
  }

  const words = extractWords(data);
  if (!words) throw new PuzzleError("upstream_error", 502);

  return {
    date: typeof data.print_date === "string" ? data.print_date : date,
    words,
  };
}

// Pull the 16 words out, ordered by board position, with all grouping/category
// data discarded. Returns null if the shape isn't what we expect (e.g. NYT
// changed the schema), so callers can fall back instead of serving garbage.
function extractWords(data) {
  const categories = Array.isArray(data?.categories) ? data.categories : null;
  if (!categories) return null;
  const cards = categories.flatMap((c) => (Array.isArray(c?.cards) ? c.cards : []));
  if (cards.length !== 16) return null;
  const ordered = cards
    .slice()
    .sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0))
    .map((c) => String(c?.content ?? "").toUpperCase().trim());
  if (ordered.some((w) => w.length === 0)) return null;
  return ordered;
}
