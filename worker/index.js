// Cloudflare Worker entry. Routes GET /api/puzzle to the NYT proxy and delegates
// everything else to static assets (with the SPA fallback configured in
// wrangler.jsonc). wrangler.jsonc sets `run_worker_first: ["/api/*"]` so this
// handler always sees API requests instead of them being served as assets.
//
// The endpoint exists because NYT's puzzle JSON sends no Access-Control-Allow-
// Origin header, so the browser can't fetch it cross-origin. We fetch it
// server-side, strip the answer groupings, and return only the 16 words.
import { fetchPuzzleWords, resolvePuzzleDate, PuzzleError } from "./puzzle.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/puzzle") {
      return handlePuzzle(request, url, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handlePuzzle(request, url, ctx) {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const resolved = resolvePuzzleDate(url.searchParams.get("date"));
  if (resolved.error) {
    return json({ error: resolved.error }, 400);
  }
  const { date } = resolved;

  // The puzzle changes once per day, so edge-cache the transformed result.
  // Only successful responses are cached (a transient upstream failure must
  // not get stuck), and the key is by date, not the full request URL.
  const cache = caches.default;
  const cacheKey = new Request(`https://puzzle-cache.local/${date}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const payload = await fetchPuzzleWords(date);
    const response = json(payload, 200, { "Cache-Control": "public, max-age=3600" });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    const status = err instanceof PuzzleError ? err.status : 502;
    const code = err instanceof PuzzleError ? err.code : "upstream_error";
    return json({ error: code }, status);
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
