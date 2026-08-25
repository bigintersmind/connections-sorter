// The "Share this site" link: what gets handed to the share sheet or the
// clipboard, and the marker it carries. Pure and framework-free so the URL
// shape is unit-tested (src/share.test.js); the Web Share / clipboard calls
// themselves live in App.jsx and are verified by hand.

// The canonical origin, not location.origin: a link shared from a preview
// deployment or localhost should still point people at the real site. Keep
// in step with the canonical <link> and og:url in index.html.
export const SITE_URL = "https://connections-sorter.com/";

// A visit that arrives through a shared link carries this so it can be told
// apart in server-side analytics (if any are ever turned on) — a plain UTM
// pair because every analytics tool already understands one. It is dropped
// from the address bar on load (see main.jsx) so it never lingers and never
// rides along in a re-share.
export const SHARE_MARKER = ["utm_source", "share"];

// The share payload. `text` is what shows up where the target renders prose
// (Messages, Mail); targets that unfurl the URL show the og: card instead.
export function sharePayload() {
  const url = new URL(SITE_URL);
  url.searchParams.set(...SHARE_MARKER);
  return {
    title: "Connections Sorter",
    text: "A scratchpad for NYT Connections — sort and lock the day's words before you commit your guesses.",
    url: url.toString(),
  };
}

// Given the current href, return the href with the share marker removed, or
// null when there is nothing to strip (the common case — one string compare
// away from a no-op, so it's cheap to call on every load). Other query
// parameters and the hash are left exactly as they were.
export function withoutShareMarker(href) {
  const url = new URL(href);
  const [key, value] = SHARE_MARKER;
  if (url.searchParams.get(key) !== value) return null;
  url.searchParams.delete(key);
  return url.toString();
}
