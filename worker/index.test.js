// Unit tests for the Cloudflare Worker entry (worker/index.js) — the layer
// between a request and the fetch/transform in worker/puzzle.js, which has its
// own suite. What this file locks down:
//
//   1. Routing: only /api/puzzle reaches the handler; every other path goes to
//      the static assets (and the SPA fallback behind them) untouched.
//   2. The error contract the client reads: 405 for a non-GET, 400 with the
//      date gate's code, a PuzzleError's own status/code, 502 for anything
//      else.
//   3. The edge cache: keyed by the RESOLVED date, not the request URL (so
//      `/api/puzzle` and `?date=<today>` share one entry), and holding only
//      200s — a transient upstream failure must not be served for an hour.
//   4. Parity with the Vite dev middleware (vite.config.js), which re-states
//      the same mapping by hand for `npm run dev`: same input, same status and
//      body, so the two copies can't drift without a failing test.
//
// fetchPuzzleWords is mocked (the date gate and PuzzleError stay real); the
// Workers globals the handler touches — caches.default, ctx.waitUntil,
// env.ASSETS — are hand-rolled, so this runs as plain Node with no Workers
// pool.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, RECENT_WINDOW_DAYS } from "../shared/puzzleDates.js";
import viteConfig from "../vite.config.js";
import worker from "./index.js";
import { fetchPuzzleWords, PuzzleError } from "./puzzle.js";

// Replaces the fetch for both importers — this file's worker/index.js and
// vite.config.js resolve "the puzzle module" to the same file.
vi.mock("./puzzle.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPuzzleWords: vi.fn(),
}));

// ---- fixtures ------------------------------------------------------------

// A fixed clock (only Date is faked), so "today" and the window can't move
// under a test that runs across midnight ET. todayET(NOW) === TODAY.
const NOW = new Date("2026-10-14T16:00:00Z");
const TODAY = "2026-10-14";
const YESTERDAY = addDays(TODAY, -1);
const TOMORROW = addDays(TODAY, 1);
const PAST_WINDOW = addDays(TODAY, -(RECENT_WINDOW_DAYS + 1));

const PAYLOAD = {
  date: TODAY,
  words: Array.from({ length: 16 }, (_, i) => `WORD${i + 1}`),
};

const JSON_TYPE = "application/json; charset=utf-8";

// ---- Workers stand-ins ---------------------------------------------------

// caches.default, backed by a Map keyed on the key's URL. Like the real
// cache, put reads the response's body — so a handler that cached the
// response it returned, instead of a clone, would hand the client a spent
// body.
function makeCache() {
  const entries = new Map();
  const urlOf = (key) => (typeof key === "string" ? key : key.url);
  return {
    entries,
    match: vi.fn(async (key) => {
      const hit = entries.get(urlOf(key));
      return hit && new Response(hit.body, { status: hit.status, headers: hit.headers });
    }),
    put: vi.fn(async (key, response) => {
      entries.set(urlOf(key), {
        status: response.status,
        headers: [...response.headers],
        body: await response.text(),
      });
    }),
  };
}

let cache, env, ctx, devMiddleware;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  cache = makeCache();
  vi.stubGlobal("caches", { default: cache });
  env = { ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
  // waitUntil keeps the promise so a test can let the cache write land.
  ctx = { pending: [], waitUntil: vi.fn((promise) => ctx.pending.push(promise)) };
  fetchPuzzleWords.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  devMiddleware = devPuzzleMiddleware();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- callers -------------------------------------------------------------

// One request through the Worker, with its waitUntil work settled.
async function callWorker(path, { method = "GET" } = {}) {
  const request = new Request(`https://connections.test${path}`, { method });
  const response = await worker.fetch(request, env, ctx);
  await Promise.all(ctx.pending);
  return response;
}

// The dev-server middleware the `dev-puzzle-api` plugin registers.
function devPuzzleMiddleware() {
  const plugin = viteConfig.plugins.flat().find((p) => p?.name === "dev-puzzle-api");
  let middleware;
  plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn) } });
  return middleware;
}

// One request through the dev middleware, as Node's req/res would carry it.
async function callDev(path, { method = "GET" } = {}) {
  const headers = {};
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader: (name, value) => (headers[name.toLowerCase()] = value),
    end(body) {
      this.body = body;
    },
  };
  const next = vi.fn();
  await devMiddleware({ url: path, method }, res, next);
  return { res, headers, next };
}

// Status, type and parsed body: what the client reads, from either side.
async function workerOutcome(path, opts) {
  const response = await callWorker(path, opts);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: await response.json(),
  };
}

async function devOutcome(path, opts) {
  const { res, headers, next } = await callDev(path, opts);
  expect(next).not.toHaveBeenCalled();
  return { status: res.statusCode, type: headers["content-type"], body: JSON.parse(res.body) };
}

// ---- routing -------------------------------------------------------------

describe("routing", () => {
  it.each([
    ["the page", "/", "GET"],
    ["a built asset", "/assets/index-abc123.js", "GET"],
    ["another /api path", "/api/other", "GET"],
    ["a non-GET off the API route", "/", "POST"],
  ])("hands %s to the static assets untouched", async (_, path, method) => {
    const request = new Request(`https://connections.test${path}`, { method });
    const assetResponse = new Response("asset");
    env.ASSETS.fetch.mockResolvedValueOnce(assetResponse);

    const response = await worker.fetch(request, env, ctx);

    expect(env.ASSETS.fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(response).toBe(assetResponse);
    expect(fetchPuzzleWords).not.toHaveBeenCalled();
  });

  it("sends /api/puzzle, with or without a query, to the handler", async () => {
    fetchPuzzleWords.mockResolvedValue(PAYLOAD);

    expect((await callWorker("/api/puzzle")).status).toBe(200);
    expect((await callWorker(`/api/puzzle?date=${YESTERDAY}`)).status).toBe(200);

    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(fetchPuzzleWords).toHaveBeenCalledTimes(2);
  });
});

// ---- the handler ---------------------------------------------------------

describe("GET /api/puzzle", () => {
  it("returns today's words, JSON, cacheable for an hour", async () => {
    fetchPuzzleWords.mockResolvedValueOnce(PAYLOAD);

    const response = await callWorker("/api/puzzle");

    expect(fetchPuzzleWords).toHaveBeenCalledExactlyOnceWith(TODAY);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.json()).toEqual(PAYLOAD);
  });

  it("fetches the requested in-window day", async () => {
    fetchPuzzleWords.mockResolvedValueOnce({ ...PAYLOAD, date: YESTERDAY });

    await callWorker(`/api/puzzle?date=${YESTERDAY}`);

    expect(fetchPuzzleWords).toHaveBeenCalledExactlyOnceWith(YESTERDAY);
  });

  it.each(["POST", "PUT", "DELETE"])(
    "refuses %s with 405, before the cache or upstream",
    async (method) => {
      const response = await callWorker("/api/puzzle", { method });

      expect(response.status).toBe(405);
      expect(response.headers.get("content-type")).toBe(JSON_TYPE);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
      expect(cache.match).not.toHaveBeenCalled();
      expect(fetchPuzzleWords).not.toHaveBeenCalled();
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["bad_date", "not-a-date"],
    ["future", TOMORROW],
    ["out_of_range", PAST_WINDOW],
  ])("rejects a date the gate calls %s with 400", async (code, date) => {
    const response = await callWorker(`/api/puzzle?date=${date}`);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await response.json()).toEqual({ error: code });
    expect(cache.match).not.toHaveBeenCalled();
    expect(fetchPuzzleWords).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404],
    ["upstream_unreachable", 502],
    ["schema_mismatch", 502],
  ])("passes a PuzzleError's %s / %i straight through", async (code, status) => {
    fetchPuzzleWords.mockRejectedValueOnce(new PuzzleError(code, status));

    const response = await callWorker("/api/puzzle");

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await response.json()).toEqual({ error: code });
    // puzzle.js logs these where they happen; the handler adds nothing.
    expect(console.error).not.toHaveBeenCalled();
  });

  it("maps anything else thrown to 502 upstream_error, and logs it", async () => {
    fetchPuzzleWords.mockRejectedValueOnce(new TypeError("boom"));

    const response = await callWorker("/api/puzzle");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_error" });
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error.mock.calls[0][0]).toContain(TODAY);
    expect(console.error.mock.calls[0][0]).toContain("boom");
  });
});

// ---- the edge cache ------------------------------------------------------

describe("edge cache", () => {
  it("serves a repeat of the same date from the cache, whatever the URL said", async () => {
    fetchPuzzleWords.mockResolvedValue(PAYLOAD);

    await callWorker("/api/puzzle");
    const hit = await callWorker(`/api/puzzle?date=${TODAY}&utm_source=share`);

    expect(fetchPuzzleWords).toHaveBeenCalledOnce();
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toBe(JSON_TYPE);
    expect(hit.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await hit.json()).toEqual(PAYLOAD);
  });

  it("keeps each date apart", async () => {
    fetchPuzzleWords.mockResolvedValue(PAYLOAD);

    await callWorker("/api/puzzle");
    await callWorker(`/api/puzzle?date=${YESTERDAY}`);

    expect(fetchPuzzleWords.mock.calls).toEqual([[TODAY], [YESTERDAY]]);
    expect(cache.entries.size).toBe(2);
  });

  it("writes through waitUntil, and still hands the client a readable body", async () => {
    fetchPuzzleWords.mockResolvedValueOnce(PAYLOAD);

    const response = await callWorker("/api/puzzle");

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    // The fake put has read its copy by now; the client's must be untouched.
    expect(await response.json()).toEqual(PAYLOAD);
  });

  it.each([
    ["an upstream 502", new PuzzleError("upstream_error", 502)],
    ["an upstream 404", new PuzzleError("not_found", 404)],
    ["an unexpected throw", new TypeError("boom")],
  ])("never caches %s, so the next request tries upstream again", async (_, error) => {
    fetchPuzzleWords.mockRejectedValueOnce(error).mockResolvedValueOnce(PAYLOAD);

    const failed = await callWorker("/api/puzzle");
    expect(failed.status).not.toBe(200);
    expect(cache.put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();

    const retried = await callWorker("/api/puzzle");
    expect(fetchPuzzleWords).toHaveBeenCalledTimes(2);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(PAYLOAD);
  });
});

// ---- parity with the Vite dev middleware ---------------------------------

describe("the dev middleware answers as the Worker does", () => {
  it.each([
    ["a non-GET", "/api/puzzle", { method: "POST" }, undefined],
    ["a malformed date", "/api/puzzle?date=not-a-date", {}, undefined],
    ["a future date", `/api/puzzle?date=${TOMORROW}`, {}, undefined],
    ["a date past the window", `/api/puzzle?date=${PAST_WINDOW}`, {}, undefined],
    ["a PuzzleError", "/api/puzzle", {}, () => Promise.reject(new PuzzleError("not_found", 404))],
    ["a 502 PuzzleError", "/api/puzzle", {}, () => Promise.reject(new PuzzleError("schema_mismatch", 502))],
    ["an unexpected throw", "/api/puzzle", {}, () => Promise.reject(new TypeError("boom"))],
    ["a successful fetch", `/api/puzzle?date=${YESTERDAY}`, {}, () => Promise.resolve(PAYLOAD)],
  ])("for %s", async (_, path, opts, fetchImpl) => {
    if (fetchImpl) fetchPuzzleWords.mockImplementation(fetchImpl);

    const prod = await workerOutcome(path, opts);
    const dev = await devOutcome(path, opts);

    expect(dev).toEqual(prod);
    // Both sides asked upstream for the same day — or neither did.
    const calls = fetchPuzzleWords.mock.calls;
    expect(calls).toHaveLength(fetchImpl ? 2 : 0);
    if (fetchImpl) expect(calls[1]).toEqual(calls[0]);
  });

  it("leaves every other path to the rest of the dev server", async () => {
    const { res, next } = await callDev("/api/other");

    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeUndefined();
    expect(fetchPuzzleWords).not.toHaveBeenCalled();
  });
});
