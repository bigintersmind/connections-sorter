// Unit tests for share.js — the "Share this site" link (src/share.js).
//
// The share sheet and clipboard are platform APIs verified in the browser; what
// can drift silently is the URL shape: the marker riding along in a re-share,
// or the load-time strip eating a query parameter that isn't ours. Runs as
// plain Node, like fitTileFont.test.js.

import { describe, expect, it } from "vitest";
import { SITE_URL, SHARE_MARKER, sharePayload, withoutShareMarker } from "./share.js";

describe("sharePayload", () => {
  it("points at the canonical site with the share marker set", () => {
    const { url, title, text } = sharePayload();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(SITE_URL);
    expect(parsed.searchParams.get(SHARE_MARKER[0])).toBe(SHARE_MARKER[1]);
    expect([...parsed.searchParams]).toHaveLength(1);
    expect(title).toBe("Connections Sorter");
    expect(text).toMatch(/Connections/);
  });

  it("round-trips: stripping the marker from the shared URL yields the bare site", () => {
    expect(withoutShareMarker(sharePayload().url)).toBe(SITE_URL);
  });
});

describe("withoutShareMarker", () => {
  it("returns null when there is nothing to strip", () => {
    expect(withoutShareMarker("https://connections-sorter.com/")).toBeNull();
    expect(withoutShareMarker("http://localhost:5173/?date=2026-08-24#x")).toBeNull();
  });

  it("returns null when utm_source is present but isn't ours", () => {
    expect(withoutShareMarker("https://connections-sorter.com/?utm_source=newsletter")).toBeNull();
  });

  it("removes only the marker, keeping other params and the hash", () => {
    expect(
      withoutShareMarker("https://connections-sorter.com/?a=1&utm_source=share&b=2#frag"),
    ).toBe("https://connections-sorter.com/?a=1&b=2#frag");
  });

  it("leaves no dangling '?' when the marker was the only parameter", () => {
    expect(withoutShareMarker("https://connections-sorter.com/?utm_source=share")).toBe(
      "https://connections-sorter.com/",
    );
  });

  it("works on whatever origin the page is actually served from", () => {
    expect(withoutShareMarker("http://localhost:5173/?utm_source=share")).toBe(
      "http://localhost:5173/",
    );
  });
});
