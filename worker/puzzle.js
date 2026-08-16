// Shared NYT Connections puzzle fetch + transform.
//
// Used by BOTH the Cloudflare Worker (worker/index.js, in production and
// `wrangler dev`) and the Vite dev middleware (vite.config.js, in `npm run
// dev`) so /api/puzzle behaves identically everywhere. It depends only on web
// platform globals common to both the Workers runtime and Node — `fetch`,
// `Intl`, `Date`, `console` — so it can be imported from either side.
//
// The load-bearing contract: this returns ONLY the 16 words, in board-position
// (display) order — NYT's own scrambled layout. It deliberately DISCARDS the
// category titles and groupings so the puzzle's answer key never leaves the
// server. The app stays a word loader, not a solver/answer site.

import { earliestAllowedDate, isIsoDate, todayET } from "../shared/puzzleDates.js";

// The launch date, the window size, and the ET/DST date math live in
// shared/puzzleDates.js so the client's day switcher and this gate can't
// drift. Re-exported here because worker/index.js, vite.config.js and this
// module's tests have always sourced them from "the puzzle module".
export { PUZZLE_LAUNCH_DATE, RECENT_WINDOW_DAYS, addDays, todayET } from "../shared/puzzleDates.js";

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

// Resolve + validate a requested date against the allowed window. Returns
// { date } on success or { error } describing the rejection. The server is the
// source of truth here so a hand-crafted URL can't turn the proxy into an
// archive scraper.
export function resolvePuzzleDate(requested, now = new Date()) {
  const today = todayET(now);
  if (requested == null || requested === "") return { date: today };
  if (!isIsoDate(requested)) return { error: "bad_date" };
  if (requested > today) return { error: "future" };
  if (requested < earliestAllowedDate(today)) return { error: "out_of_range" };
  return { date: requested };
}

// Fetch the day's puzzle and reduce it to 16 words in board-position order.
// `fetchImpl` is injectable for tests; defaults to the platform fetch.
export async function fetchPuzzleWords(date, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(nytEndpoint(date), { headers: { Accept: "application/json" } });
  } catch (err) {
    console.error(`[puzzle] upstream unreachable for ${date}: ${err?.message ?? err}`);
    throw new PuzzleError("upstream_unreachable", 502);
  }
  if (res.status === 404) {
    // Within our enforced window a 404 is unexpected (puzzle pulled, or the
    // endpoint path changed) — worth a breadcrumb, but it's a soft failure.
    console.warn(`[puzzle] upstream 404 for ${date}`);
    throw new PuzzleError("not_found", 404);
  }
  if (!res.ok) {
    console.error(`[puzzle] unexpected upstream status ${res.status} for ${date}`);
    throw new PuzzleError("upstream_error", 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    console.error(`[puzzle] upstream returned non-JSON for ${date}`);
    throw new PuzzleError("upstream_error", 502);
  }

  const words = extractWords(data);
  if (!words) {
    // A permanent NYT schema change breaks this feature for 100% of users and
    // is otherwise indistinguishable from a transient blip. Emit a distinct
    // code plus a non-sensitive shape fingerprint (never the words) so it's
    // visible in `wrangler tail` / the dev terminal and can be alerted on.
    console.error(`[puzzle] schema mismatch for ${date}: ${fingerprint(data)}`);
    throw new PuzzleError("schema_mismatch", 502);
  }

  return {
    date: typeof data.print_date === "string" ? data.print_date : date,
    words,
  };
}

// Describe an unexpected payload's shape (top-level keys + category/card
// counts) without leaking the puzzle content itself.
function fingerprint(data) {
  if (!data || typeof data !== "object") return `type=${typeof data}`;
  const cats = Array.isArray(data.categories) ? data.categories : null;
  const cards = cats
    ? cats.reduce((n, c) => n + (Array.isArray(c?.cards) ? c.cards.length : 0), 0)
    : null;
  return JSON.stringify({
    keys: Object.keys(data),
    categories: cats ? cats.length : typeof data.categories,
    cards,
  });
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
