import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitTileFonts } from "./fitTileFont.js";
import {
  ArrowUpIcon,
  CheckIcon,
  CircleIcon,
  CloseIcon,
  ExternalIcon,
  MoreIcon,
} from "./icons.jsx";
import {
  DRAG_LIFT_SCALE,
  DROP_TARGET_SCALE,
  dropTargetIndex,
  isTileInPlay,
  passedDragThreshold,
  SETTLE_GLIDE_MS,
  SETTLE_MS,
  settleTransforms,
  shouldCancelPointerPress,
  toPageRect,
} from "./dragSwap.js";
import { SITE_URL, sharePayload } from "./share.js";
import {
  THEME_COLORS,
  THEME_KEY,
  THEME_OPTIONS,
  parseThemePreference,
  resolveTheme,
  serializeThemePreference,
} from "./theme.js";
import { windowDates } from "../shared/puzzleDates.js";
import {
  CUSTOM_KEY,
  activate,
  decideLaunch,
  emptyStore,
  parseStore,
  placeFetched,
  resetActive,
  serializeStore,
  setCustom,
  switcherEntries,
  todayET,
  updateActive,
} from "./savedPuzzle.js";

const ROW_COLORS = [
  { name: "Yellow", bg: "#f9df6d", text: "#1a1a1a", glow: "rgba(249,223,109,0.6)" },
  { name: "Green", bg: "#a0c35a", text: "#1a1a1a", glow: "rgba(160,195,90,0.6)" },
  { name: "Blue", bg: "#b0c4ef", text: "#1a1a1a", glow: "rgba(176,196,239,0.6)" },
  { name: "Purple", bg: "#ba81c5", text: "#1a1a1a", glow: "rgba(186,129,197,0.6)" },
];

const STORAGE_KEY = "connections-puzzle";

const OFFICIAL_GAME_URL = "https://www.nytimes.com/games/connections";

// Abort reason for a load the app itself replaced (the player tapped another
// day, or switched to a saved one), so it can be told apart from a timeout or a
// real failure — a superseded request must stay silent.
const SUPERSEDED = "superseded";

const FETCH_TIMEOUT_MS = 9000;

// Phones, and Safari and Chrome on macOS, have a native share sheet; Firefox
// and Chrome on Linux don't, and get the clipboard instead. Decided once —
// it's a platform property, not something that changes mid-session.
const CAN_NATIVE_SHARE = typeof navigator !== "undefined" && typeof navigator.share === "function";

// Stable empty fallbacks for a board-less render. Module constants rather than
// fresh literals so effect dependency arrays don't see a "new" value every
// render while the board is loading.
const NO_TILES = [];
const NO_LOCKS = [false, false, false, false];
const NO_LABELS = ["", "", "", ""];

function parseTiles(text) {
  if (!text) return null;
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length === 16) {
      return parsed.map(w => String(w).toUpperCase().trim());
    }
  } catch {
    // fall through to delimiter parsing
  }
  const words = text
    .split(/[,\n]+/)
    .map(w => w.replace(/["[\]{}]/g, "").trim().toUpperCase())
    .filter(Boolean);
  if (words.length === 16) return words;
  return null;
}

// Read the saved store, or null. All shape knowledge — including migrating the
// older two-slot and flat saves — lives in savedPuzzle.js; the try/catch here
// only covers localStorage itself being unavailable (private mode, storage
// disabled).
//
// "Save existed but didn't parse" is not the same as "no save": treating it as
// no-save is the designed recovery, but the first successful persist then
// overwrites the main key, making "my board vanished" undebuggable. Keep the
// evidence under a side key and leave a console trace.
function loadSaved(todayISO) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const store = parseStore(raw, todayISO);
    if (raw != null && !store) {
      console.warn(`connections: discarding unreadable save (${raw.length} chars), kept at ${STORAGE_KEY}.bad`);
      try {
        localStorage.setItem(`${STORAGE_KEY}.bad`, raw);
      } catch {
        // best effort — the warning above still fired
      }
    }
    return store;
  } catch {
    return null;
  }
}

// Possessive day name for the loading and failure lines: "today's" /
// "yesterday's" / "Thursday's". Only ever called with a date key — the custom
// board is never fetched, so it never appears in one of these messages.
function possessiveDay(key, todayISO) {
  // Which day this is comes from the same function that labels the segments —
  // asked with no store, since only the label matters — so a message and the
  // segment it refers to can't disagree.
  const label = switcherEntries(null, todayISO).find((e) => e.key === key)?.label;
  if (label === "Today") return "today's";
  if (label === "Yesterday") return "yesterday's";
  // The remaining segment is labelled "Thu" because four of them have to fit a
  // 320px phone; in a sentence it gets spelled out.
  const [y, m, d] = key.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${weekday}'s`;
}

// The Appearance preference. <html data-theme> always holds the *resolved*
// scheme: the pre-paint script in index.html stamps it before the first frame,
// and this hook owns it from then on — re-stamping when the preference changes
// and, while following the system, when the OS flips (sunset with the tab
// open). The theme-color meta rides along so the browser chrome matches. The
// rules themselves are in theme.js; this is only the DOM and storage glue.
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function readThemePreference() {
  try {
    return parseThemePreference(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function useTheme() {
  const [pref, setPref] = useState(readThemePreference);

  useEffect(() => {
    const query = window.matchMedia(DARK_SCHEME_QUERY);
    const apply = () => {
      const resolved = resolveTheme(pref, query.matches);
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", THEME_COLORS[resolved]);
    };
    apply();
    // Listening even under an override costs nothing and keeps one code path:
    // resolveTheme ignores the OS unless the preference is "system".
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [pref]);

  const choose = useCallback((next) => {
    setPref(next);
    try {
      const stored = serializeThemePreference(next);
      if (stored) localStorage.setItem(THEME_KEY, stored);
      else localStorage.removeItem(THEME_KEY);
    } catch {
      // Storage unavailable: the choice still holds for this visit.
    }
  }, []);

  return [pref, choose];
}

export default function ConnectionsOrganizer() {
  // The save and the launch decision are taken once, at mount — a re-render
  // after ET midnight must not re-decide and yank a board mid-play. (A tab left
  // open across midnight is handled by the visibilitychange effect below, which
  // only re-labels the switcher.)
  const [{ initialStore, launch }] = useState(() => {
    const todayISO = todayET();
    const saved = loadSaved(todayISO);
    return { initialStore: saved ?? emptyStore(), launch: decideLaunch(saved, todayISO) };
  });

  // The one source of truth for the board: tiles, locks and labels are DERIVED
  // from the active board below, never mirrored into their own state. Every
  // play action writes through the store (updateActive/resetActive), so
  // switching days can't strand half of a board's state behind.
  const [store, setStore] = useState(initialStore);
  // The ET date the switcher labels itself against. Refreshed on refocus so a
  // tab left open overnight re-labels ("Today" becomes "Yesterday") — see the
  // visibilitychange effect. Activations never read this: they call todayET()
  // themselves, so a stamp can't be written from a stale render.
  const [today, setToday] = useState(todayET);
  const [screen, setScreen] = useState("board");
  // The launch fetch blanks the board area until it settles. On a new day the
  // store may still point at YESTERDAY's board (its key survived, only
  // activeDate went stale); showing it while today loads would look like the
  // app opened on the wrong puzzle. Cleared by the first landing — after that,
  // switching days keeps the outgoing board on screen instead of blanking.
  const [launching, setLaunching] = useState(launch === "fetch-today");
  // Key of the day currently being fetched (drives the segment spinner), or
  // null.
  const [fetchingKey, setFetchingKey] = useState(null);
  // { key, message } for the last failed load. Rendered as a one-line notice
  // when a board is on screen, or inside the empty state when there is none.
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [flashRow, setFlashRow] = useState(null);
  const [swapAnim, setSwapAnim] = useState(null);
  // The drag in progress, or null. Only set once the press has cleared
  // DRAG_THRESHOLD_PX — a press that hasn't is still a tap and renders like
  // one. { from, dx, dy, over }: the tile being carried, how far it has
  // travelled from the press, and the tile it would land on (null when the
  // release point wouldn't swap anything). The bookkeeping that doesn't need a
  // render — pointer id, press origin, the measured tile boxes — lives in
  // dragRef instead.
  const [drag, setDrag] = useState(null);
  // The settle after a committed drop, or null. The swap is already in the
  // store by the time this is set — this is only what the two tiles LOOK like
  // on the way to their new cells. { from, over, seeds, phase }: the two
  // indices that traded, the pair of transforms from settleTransforms, and
  // which of the three phases is on screen.
  //
  // Phase one ("seeded", one frame) renders both tiles at the seeds, wearing
  // the looks they had on the last held frame, with the transition off — the
  // commit frame is then a pure re-seat and nothing moves. Phase two
  // ("gliding", SETTLE_GLIDE_MS) drops both, and .tile's transitions carry
  // each tile to rest; the tiles keep only their lift so they ride above the
  // neighbours they cross, and the displaced one — which is crossing cells
  // that aren't its own for exactly this span — stops taking presses meant
  // for them (.tile-crossing). Phase three ("landed", the rest of SETTLE_MS)
  // is the lift alone, held while the box-shadows finish fading, with both
  // tiles at rest and pressable again. Then this clears to null.
  const [settle, setSettle] = useState(null);
  const [manualText, setManualText] = useState("");
  const [manualError, setManualError] = useState(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [themePref, chooseTheme] = useTheme();
  // Outcome of the last "Share this site" tap that ended on the clipboard
  // path: "copied" | "failed" | null. Shown as the item's hint; cleared
  // whenever the sheet closes so the next open starts fresh.
  const [shareStatus, setShareStatus] = useState(null);
  const autoLoadedRef = useRef(false);
  const fetchAbortRef = useRef(null);
  // The live press, from pointerdown to pointerup: { pointerId, key, from,
  // startX, startY, rects }. `key` is the board the press started on, so the
  // swap it ends in takes the same same-day guard a tap swap does. `rects` is
  // null until the press clears the drag threshold and doubles as the "this
  // is a drag now" flag.
  const dragRef = useRef(null);
  // Set for one task after a drag ends, to swallow the click that follows it.
  const suppressClickRef = useRef(false);
  // The settle's pending callbacks — the frame that unseeds it, and the one
  // timeout slot its two later phase steps share (only ever one is pending) —
  // so whatever is scheduled can be called off if the board goes away under
  // it.
  const settleTimersRef = useRef({ raf: 0, timeout: 0 });
  const tileRefs = useRef([]);
  const gridRef = useRef(null);
  const segsRef = useRef(null);
  const overflowRef = useRef(null);
  const manualItemRef = useRef(null);
  const howRef = useRef(null);

  const activeKey = store.active;
  const activeBoard = activeKey ? store.boards[activeKey] ?? null : null;
  const board = launching ? null : activeBoard;
  const tiles = board?.tiles ?? NO_TILES;
  const lockedRows = board?.lockedRows ?? NO_LOCKS;
  const labels = board?.labels ?? NO_LABELS;
  const entries = switcherEntries(store, today);

  // Shrink-to-fit every tile's font once the board is on screen and whenever
  // the words change. `screen` is a dep so tiles get fit on the way back from
  // manual entry; `activeKey` because a day switch replaces the board.
  useLayoutEffect(() => {
    // fitAll reads the live tileRefs, so a late call after a re-render is
    // harmless (unmounted tiles are null and skipped).
    const fitAll = () => fitTileFonts(tileRefs.current);
    fitAll();

    // Libre Franklin is self-hosted and loads async. index.html preloads the
    // latin subset so it's normally in before the first render, but on a cold
    // cache the pass above can still measure the fallback face, whose metrics
    // differ. Ask for the faces the board's words need — the tile text picks
    // up latin-ext when a word has an accent — and re-fit once they're in.
    // fonts.load over fonts.ready because it names the faces: ready can
    // resolve before a load the next layout is about to start, and it's the
    // layout that starts one. A rejected load (the file failed to arrive)
    // means the fallback is what's on screen, so the sizes already fitted to
    // it are the right ones — nothing to do.
    const first = tileRefs.current.find(Boolean);
    if (first && document.fonts?.load) {
      const { fontWeight, fontFamily } = getComputedStyle(first);
      document.fonts.load(`${fontWeight} 1em ${fontFamily}`, tiles.join(" ")).then(fitAll, () => {});
    }

    // Re-fit when the tiles change size: rotation, a window drag, a scrollbar
    // appearing. A ResizeObserver rather than the resize event because it
    // fires only when the grid's box actually changed, once per frame, after
    // layout and before paint — so the geometry reads inside fitTileFonts
    // are free and the new sizes land in the same frame, with no throttle
    // of our own. (Its first notification, on observe, is a redundant pass;
    // fitTileFonts skips the writes when nothing changed.)
    const observer = new ResizeObserver(fitAll);
    if (gridRef.current) observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, [tiles, screen, activeKey]);

  // Persist the whole store on every change. Writing through serializeStore
  // means a migrated save is rewritten in the v2 shape on its first persist —
  // the migration is this effect doing its normal job. An empty store is worth
  // writing too: it's what a cleared board looks like.
  useEffect(() => {
    // Serialized outside the try so the catch below covers only localStorage
    // being unavailable, never a bug in the serializer.
    const payload = serializeStore(store);
    try {
      localStorage.setItem(STORAGE_KEY, payload);
    } catch (err) {
      // Storage unavailable or full (private mode, quota): the session keeps
      // working but nothing survives a reload — leave the only diagnostic
      // trace a "my board vanished" report will ever have.
      console.warn("connections: couldn't persist the board:", err?.name ?? err);
    }
  }, [store]);

  // A tab left open overnight comes back with yesterday's board still mounted.
  // Nothing is fetched and nothing moves: we just re-read the ET date so the
  // switcher re-labels itself (the board the player is on slides from "Today"
  // to "Yesterday", and a "Today" segment appears alongside it). Both
  // visibilitychange (tab switch, phone unlock) and window focus (clicking
  // back into an already-visible window) count as "coming back"; a tab that
  // stays visible and focused across midnight is left alone until the player
  // touches the switcher (see loadDay). setToday with an unchanged value is a
  // no-op in React, so this is free on every other refocus.
  useEffect(() => {
    const relabel = () => {
      if (document.visibilityState === "visible") setToday(todayET());
    };
    document.addEventListener("visibilitychange", relabel);
    window.addEventListener("focus", relabel);
    return () => {
      document.removeEventListener("visibilitychange", relabel);
      window.removeEventListener("focus", relabel);
    };
  }, []);

  // The switcher is sized to fit every segment down to 320px, but it scrolls
  // rather than collide if a font ever blows that budget (see .segs in
  // index.css) — in which case the day you just switched to has to be the one
  // you can see. Deliberately not scrollIntoView: that also moves Chrome's
  // sequential-focus starting point, so the first Tab of a fresh load would
  // land *after* Today. Nudging scrollLeft has no such side effect. The
  // "nearest" arithmetic below is self-limiting — when the pill fits, the
  // active segment is already inside it and neither branch runs.
  useEffect(() => {
    const segs = segsRef.current;
    const active = segs?.querySelector('[aria-pressed="true"]');
    if (!segs || !active) return;
    const s = segs.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.left < s.left) segs.scrollLeft += a.left - s.left;
    else if (a.right > s.right) segs.scrollLeft += a.right - s.right;
  }, [activeKey]);

  // Call off whatever the settle still has pending. Cheap to call when there
  // is nothing scheduled: both ids start at 0, which cancelAnimationFrame and
  // clearTimeout ignore.
  const clearSettleTimers = useCallback(() => {
    cancelAnimationFrame(settleTimersRef.current.raf);
    clearTimeout(settleTimersRef.current.timeout);
    settleTimersRef.current = { raf: 0, timeout: 0 };
  }, []);

  // A press doesn't outlive the grid it was measured against. The grid is
  // keyed on activeKey and isn't rendered at all on the manual-entry screen,
  // so a fetch landing mid-drag (or a switch away) remounts every tile under
  // the finger. Nothing tells the handlers: the pointerup goes to the removed
  // element (a finger's up is bound to its touchstart target, and for a mouse
  // the capture is simply gone), and NO pointercancel fires for a removed
  // capture. commitSwap's same-day guard isn't enough on its own — it protects
  // the store write, not the press in dragRef or the `drag` state that renders
  // a tile as carried, and left alone those would paint the NEW tile at that
  // index translated, ringed and showing the other day's word until the next
  // press. A layout effect so the stale transform never reaches the screen.
  // A settle in flight goes the same way and for the same reason: its seeds
  // are inline transforms measured against the OLD board, and the tile that
  // takes that index on the new one would wear them.
  useLayoutEffect(() => () => {
    dragRef.current = null;
    setDrag(null);
    clearSettleTimers();
    setSettle(null);
  }, [activeKey, screen, clearSettleTimers]);

  // Cancel an in-flight load so a slow request can't complete later and yank
  // the player onto a day they've since navigated away from.
  const abortInFlight = useCallback(() => {
    fetchAbortRef.current?.abort(SUPERSEDED);
  }, []);

  // Everything that becomes true the moment a board lands on screen, from any
  // path: the launch blank is over, a stale failure message is gone, and no
  // tile stays picked up from the board we just left.
  const landed = useCallback(() => {
    setLaunching(false);
    setLoadError(null);
    setSelected(null);
  }, []);

  // Show a day. A day whose board is saved switches instantly with no network
  // — the outgoing board keeps its play state, so switching back is lossless.
  // A day with no board is fetched in place: the current board stays on screen
  // (only the tapped segment shows it's working) until the words arrive.
  // `key` always comes from switcherEntries, so it's either a date inside the
  // loadable window or CUSTOM_KEY — and Custom only ever appears once its
  // board exists, i.e. on the instant path.
  const loadDay = useCallback(
    async (key) => {
      // The one place a continuously-visible tab learns that ET midnight has
      // passed: the player is touching the switcher, so re-labelling now can't
      // interrupt anything. If the day they tapped has since aged out of the
      // window, the Worker would refuse it (out_of_range) — re-label and let
      // them pick again from the days that exist rather than show an error
      // for a segment that shouldn't be there.
      const now = todayET();
      if (now !== today) {
        setToday(now);
        if (key !== CUSTOM_KEY && !windowDates(now).includes(key)) return;
      }
      if (Object.hasOwn(store.boards, key)) {
        abortInFlight();
        // Re-checked inside the updater because a fetch that landed in the same
        // batch may have adopted the custom board into a dated one, taking this
        // key with it; activate() throws on a missing board.
        setStore((s) => (Object.hasOwn(s.boards, key) ? activate(s, key, todayET()) : s));
        landed();
        return;
      }

      abortInFlight();
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      setFetchingKey(key);
      const timeout = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
      try {
        // Today goes without a ?date= param: a client clock a few minutes ahead
        // of the server would otherwise ask for a date the Worker reads as the
        // future and rejects. The response carries the server-resolved date
        // either way, and that — never the client clock — is what the board is
        // filed under.
        const url =
          key === todayET() ? "/api/puzzle" : `/api/puzzle?date=${encodeURIComponent(key)}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("fetch_failed");
        const data = await res.json();
        // Shape AND element type: placeFetched rejects anything that isn't 16
        // strings (it treats a bad call as a programming error), so a malformed
        // response has to be caught here, as bad_data.
        const words =
          Array.isArray(data?.words) &&
          data.words.length === 16 &&
          data.words.every((w) => typeof w === "string")
            ? data.words
            : null;
        if (!words) throw new Error("bad_data");
        const date =
          typeof data?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.date)
            ? data.date
            : key;
        // A resolved fetch never rejects, so the catch below can't guard this:
        // if the player tapped another day while this request was in flight,
        // its signal is aborted and the words are dropped rather than yanking
        // them off the board they chose.
        if (controller.signal.aborted) return;
        // The Worker already returns clean, uppercased words; they're passed
        // through verbatim so accented tiles ("EL NIÑO") aren't mangled.
        setStore((s) => placeFetched(s, { date, words }, todayET()));
        landed();
      } catch (err) {
        // A load the app itself replaced must not flash a self-inflicted error.
        if (controller.signal.reason === SUPERSEDED) return;
        // Every other failure gets a console trace. The try block contains
        // commit logic too, so this catch can see a programming error — without
        // a log it would masquerade as a network failure and Retry would loop
        // undiagnosably.
        console.error(
          "connections: puzzle load failed:",
          controller.signal.aborted ? controller.signal.reason : err,
        );
        // Where this renders depends on whether a board is on screen: a
        // one-line notice under the header, or the empty state's message. Both
        // read from the same state and offer the same Retry.
        setLoadError({
          key,
          message: `Couldn't load ${possessiveDay(key, todayET())} puzzle`,
        });
      } finally {
        clearTimeout(timeout);
        // Only the live request clears the shared fetching state. A superseded
        // request (its controller already replaced in the ref by a newer load)
        // must not stop the newer one's spinner.
        if (fetchAbortRef.current === controller) {
          fetchAbortRef.current = null;
          setFetchingKey(null);
        }
      }
    },
    [store.boards, today, abortInFlight, landed],
  );

  // Act on the launch decision exactly once. "resume" needs no network at all —
  // the board is already in the store. todayET() is read here rather than the
  // `today` state so the fetch and the stamp agree even if this mount straddles
  // ET midnight.
  useEffect(() => {
    if (launch === "resume" || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    loadDay(todayET());
  }, [launch, loadDay]);

  // The one place two tiles trade positions, shared by tap-to-swap and
  // drag-to-swap so both take the same same-day guard: a swap belongs to the
  // board it was started on, and by the time it commits the player may have
  // switched days (the tap path waits out a 200ms animation first).
  const commitSwap = useCallback((a, b, key) => {
    setStore((s) => {
      if (s.active !== key) return s;
      const next = [...s.boards[key].tiles];
      [next[a], next[b]] = [next[b], next[a]];
      return updateActive(s, { tiles: next });
    });
  }, []);

  const handleTap = useCallback((index) => {
    // A drag just ended: pointer capture retargets its trailing click to the
    // tile the drag started on, and a drag is not a tap — it has already
    // committed (or deliberately cancelled) its own swap.
    if (suppressClickRef.current) return;
    // A swap is in flight for 200ms; a tap during it would queue a second swap
    // against positions that are about to change. Ignore it.
    if (swapAnim) return;
    const row = Math.floor(index / 4);
    if (lockedRows[row]) return;
    if (selected === null) {
      setSelected(index);
    } else if (selected === index) {
      setSelected(null);
    } else {
      const selectedRow = Math.floor(selected / 4);
      if (lockedRows[selectedRow]) { setSelected(index); return; }
      setSwapAnim({ a: selected, b: index });
      setTimeout(() => {
        commitSwap(selected, index, activeKey);
        setSwapAnim(null);
        setSelected(null);
      }, 200);
    }
  }, [selected, lockedRows, activeKey, swapAnim, commitSwap]);

  // Drag-to-swap. Pointer Events rather than HTML5 drag-and-drop, which never
  // fires for a finger; `setPointerCapture` from the press rather than from
  // the threshold, because in between the pointer can already have left the
  // tile and an uncaptured move over a sibling would never come back here.
  // Capture leaves the tap path alone: a press that never moves still ends in
  // a click on the tile it started on.
  const handleTilePointerDown = useCallback((index, e) => {
    // Primary button only — a right- or middle-click press isn't a drag.
    // (Touch and pen both report button 0.)
    if (e.button !== 0) return;
    // A tap swap is animating for 200ms; a drag started against positions
    // that are about to change would land on the wrong tiles. Same bail as
    // handleTap's.
    if (swapAnim) return;
    // First pointer wins. A second finger (or a resting palm) landing on a
    // tile while one is already down is ignored rather than replacing the
    // press, which would strand the first finger's tile mid-air. That is all
    // this guarantees: the refused contact's pointerdown returns before
    // setting anything, so nothing here suppresses a click for it — Chrome
    // and Safari don't synthesize a tap for a contact that lands while
    // another is down, and that is the browser's doing, not ours. A press
    // from the SAME pointer id is taken over instead: one pointer can't go
    // down twice without coming up, so its earlier press can only be an
    // orphan whose release never reached the tile (see cancelPress).
    if (dragRef.current && dragRef.current.pointerId !== e.pointerId) return;
    if (!isTileInPlay(index, lockedRows)) return;
    dragRef.current = {
      pointerId: e.pointerId,
      key: activeKey,
      from: index,
      startX: e.clientX + window.scrollX,
      startY: e.clientY + window.scrollY,
      rects: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [swapAnim, lockedRows, activeKey]);

  const handleTilePointerMove = useCallback((e) => {
    const press = dragRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    const x = e.clientX + window.scrollX;
    const y = e.clientY + window.scrollY;
    if (!press.rects) {
      if (!passedDragThreshold(x - press.startX, y - press.startY)) return;
      // Measure every tile once, on the frame the drag starts. Nothing moves
      // for the rest of it — the carried tile rides on a transform, which
      // doesn't touch layout, and the ResizeObserver that drives the font fit
      // stays quiet for the same reason — so re-reading per move would only
      // buy a forced layout a frame. Page coordinates (see toPageRect) so a
      // scroll partway through can't desync them.
      //
      // The box read is the CELL's (the .reveal around the tile — the same
      // box, since the tile fills it border-box), never the tile's: a tile
      // can be mid-transform when this runs — the :active scale of the press
      // itself, a hover lift, or the settle of a drop 100ms ago still gliding
      // across the board — and a rect read through that would put the tile
      // somewhere it isn't and land a later drop on the wrong index.
      press.rects = tileRefs.current.map((el) =>
        el ? toPageRect(el.parentElement.getBoundingClientRect(), window.scrollX, window.scrollY) : null,
      );
    }
    setDrag({
      from: press.from,
      dx: x - press.startX,
      dy: y - press.startY,
      over: dropTargetIndex(press.rects, x, y, press.from, lockedRows),
    });
  }, [lockedRows]);

  const handleTilePointerUp = useCallback((e) => {
    const press = dragRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    // Never crossed the threshold, so this was a tap all along: leave it to
    // the click that's about to follow.
    if (!press.rects) return;

    // Swallow that click instead — on a timeout rather than by consuming the
    // next one, which would otherwise eat a later Enter on a tile (a keyboard
    // click fires no pointer events, so there's nothing to tell them apart by
    // at the moment it arrives).
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);

    const x = e.clientX + window.scrollX;
    const y = e.clientY + window.scrollY;
    const over = dropTargetIndex(press.rects, x, y, press.from, lockedRows);
    // Released on nothing that can take it — off the board, back on the tile
    // it came from, on a locked row, or with its own row locked under it
    // while it was in the air. The tile returns to its place; no swap, and a
    // tile picked up earlier by tap stays picked up.
    if (over === null) return;
    commitSwap(press.from, over, press.key);
    // Seed the settle in the SAME handler as the swap, so React batches the
    // two into one commit: the frame that swaps the words is the frame that
    // puts each tile back where its new word already was, and the player sees
    // nothing move. The pointer's travel comes off this event rather than off
    // `drag`, which can be a frame behind the finger.
    //
    // Only when the swap will actually land: commitSwap drops it when the
    // player has changed days under the drag (its updater checks s.active),
    // and a settle for a swap that never happened would slide the wrong words
    // about. Belt-and-braces in practice — a day change remounts the grid and
    // the [activeKey, screen] layout effect has already thrown the press away.
    //
    // And not under reduced motion. index.css turns .tile's transition off
    // there, so a seed would have nothing to ease from: this commit already
    // lands both tiles at rest in their new cells with the right words, which
    // is what that preference asks for, and seeding would only hold the held
    // picture on screen for one frame more.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (press.key === activeKey && !reduceMotion) {
      setSettle({
        from: press.from,
        over,
        seeds: settleTransforms(press.rects, press.from, over, x - press.startX, y - press.startY),
        phase: "seeded",
      });
    }
    // The drag wins over a pending tap. A tile selected by tap and then left
    // alone while a different pair was dragged is a stale pick-up: the board
    // under it has changed, so clear it rather than let the next tap swap
    // against a position the player didn't choose.
    setSelected(null);
  }, [lockedRows, commitSwap, activeKey]);

  // Run the settle, a phase at a time: unseed on the next frame, hold the
  // glide, then end it.
  //
  // The requestAnimationFrame is what makes the seeds a real starting point
  // rather than a value the browser never saw. React flushes an update made
  // from a frame callback in a later task — after the seeded frame has been
  // through style and paint — so when the seeds come off, the transition's
  // before-change style is the seed and .tile's `transform 0.15s` has
  // somewhere to travel from. (If a browser ever flushed it sooner, the tiles
  // would snap; the fix would be to force the seeded style into being with a
  // getBoundingClientRect() on one of the two tiles before unseeding.)
  //
  // A press landing during the settle simply wins — the settle is cosmetic,
  // the store is already right, and the rects a new drag measures are the
  // cells', which a gliding tile doesn't move (handleTilePointerMove). Nor
  // does the glide take the press any more: the displaced tile is lifted over
  // cells that aren't its own, so index.css drops it out of hit-testing for
  // the two phases it is in transit (.tile-crossing) and the press falls
  // through to the tile resting under the finger. Which is why "landed" is a
  // phase of its own — the lift outlasts the glide by 170ms while the
  // box-shadows fade, and grabbing the tile that has just come to rest in the
  // vacated cell has to work from the moment it gets there. (#24)
  //
  // Every step is guarded on identity: the cleanup cancels whatever is
  // pending whenever `settle` changes, so an older step can't advance a newer
  // settle — but say so in the updater rather than rely on it.
  useLayoutEffect(() => {
    if (!settle) return undefined;
    if (settle.phase === "seeded") {
      settleTimersRef.current.raf = requestAnimationFrame(() => {
        setSettle((s) => (s === settle ? { ...s, phase: "gliding" } : s));
      });
    } else if (settle.phase === "gliding") {
      settleTimersRef.current.timeout = setTimeout(() => {
        setSettle((s) => (s === settle ? { ...s, phase: "landed" } : s));
      }, SETTLE_GLIDE_MS);
    } else {
      settleTimersRef.current.timeout = setTimeout(() => {
        setSettle((s) => (s === settle ? null : s));
      }, SETTLE_MS - SETTLE_GLIDE_MS);
    }
    return clearSettleTimers;
  }, [settle, clearSettleTimers]);

  // The press ended without a release the tile gets to see. Serves two
  // signals: pointercancel — the system took the pointer away, a pan or an
  // edge swipe the browser claimed for itself — which reaches here through
  // the pointer-id guard below, and window blur, which carries no pointer
  // event and so cancels unconditionally. No click follows either, so
  // there's nothing to swallow. Neither fires when the tile is removed from
  // under a captured pointer; the layout effect on activeKey/screen above
  // covers that.
  const cancelPress = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDrag(null);
  }, []);

  // A refused second contact can still cancel on the tile it landed on (for
  // example, a locked tile the browser claims for scrolling). It must not end
  // the first pointer's live press.
  const handleTilePointerCancel = useCallback((e) => {
    const press = dragRef.current;
    if (!press || !shouldCancelPointerPress(press.pointerId, e.pointerId)) return;
    cancelPress();
  }, [cancelPress]);

  // Window blur is a REQUIRED cancel signal, not a redundant one. A mouse drag
  // interrupted by Alt-Tab or a system dialog is released in another app, and
  // no pointerup or pointercancel ever reaches the tile — drag libraries cancel
  // on blur for exactly this reason. Left alone, that press would stay live:
  // first-pointer-wins would refuse every later drag, the tile would float
  // where it was left, and with a mouse — whose pointer id never changes — the
  // next plain click's pointerup would match the stale press and replay it as
  // a swap against rects measured before the interruption.
  useEffect(() => {
    window.addEventListener("blur", cancelPress);
    return () => window.removeEventListener("blur", cancelPress);
  }, [cancelPress]);

  const toggleLock = useCallback((rowIdx) => {
    if (!lockedRows[rowIdx]) {
      setFlashRow(rowIdx);
      setTimeout(() => setFlashRow(null), 600);
    }
    setStore((s) => {
      const active = s.active && s.boards[s.active];
      if (!active) return s;
      const next = [...active.lockedRows];
      next[rowIdx] = !next[rowIdx];
      return updateActive(s, { lockedRows: next });
    });
  }, [lockedRows]);

  const updateLabel = useCallback((rowIdx, val) => {
    setStore((s) => {
      const active = s.active && s.boards[s.active];
      if (!active) return s;
      const next = [...active.labels];
      next[rowIdx] = val;
      return updateActive(s, { labels: next });
    });
  }, []);

  const resetBoard = useCallback(() => {
    setStore(resetActive);
    setSelected(null);
  }, []);

  const shuffleUnlocked = useCallback(() => {
    setStore((s) => {
      const active = s.active && s.boards[s.active];
      if (!active) return s;
      const next = [...active.tiles];
      const unlocked = [];
      for (let i = 0; i < 16; i++) {
        if (!active.lockedRows[Math.floor(i / 4)]) unlocked.push(i);
      }
      for (let i = unlocked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[unlocked[i]], next[unlocked[j]]] = [next[unlocked[j]], next[unlocked[i]]];
      }
      return updateActive(s, { tiles: next });
    });
    setSelected(null);
  }, []);

  const openOverflow = useCallback(() => {
    setOverflowOpen(true);
    overflowRef.current?.showModal();
    // showModal() focuses the first focusable item, which is the System
    // segment of the Appearance row — so Enter straight after opening would
    // change the preference. Land on the first list item instead.
    manualItemRef.current?.focus();
  }, []);

  // Native <dialog> owns dismissal (Escape and backdrop both fire `close`,
  // which resets aria-expanded via onClose). Closing from an item that also
  // navigates away — "Enter words manually" unmounts the dialog in the same
  // flush — would lose that event, so the state is reset here too.
  const closeOverflow = useCallback(() => {
    setOverflowOpen(false);
    setShareStatus(null);
    overflowRef.current?.close();
  }, []);

  // Native share sheet where there is one, clipboard elsewhere. Dismissing the
  // sheet rejects with AbortError and means "never mind", so the menu stays
  // put; any other rejection falls through to the clipboard so the tap still
  // yields a link. Nothing leaves the device except through the target the
  // player picks in the sheet — the privacy note in "how this works" holds.
  const shareSite = useCallback(async () => {
    const payload = sharePayload();
    if (CAN_NATIVE_SHARE) {
      try {
        await navigator.share(payload);
        closeOverflow();
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(payload.url);
      setShareStatus("copied");
    } catch {
      // Insecure context, denied permission, or no clipboard API at all:
      // show the address so the player can still pass it on by hand.
      setShareStatus("failed");
    }
  }, [closeOverflow]);

  // A click that lands on the dialog element itself (rather than its padded
  // inner box) came from the backdrop — the platform gives ::backdrop no node
  // of its own, so this is the standard way to close on an outside tap.
  const onDialogClick = useCallback((event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }, []);

  if (screen === "manual") {
    return (
      // The whole screen is the form, so the container itself is the landmark.
      <main style={styles.container}>
        <div style={styles.header}>
          <h1 id="manual-heading" style={styles.title}>Enter 16 Words</h1>
          <p id="manual-subtitle" style={styles.subtitle}>One per line, or comma-separated</p>
        </div>
        <textarea
          style={styles.textarea}
          rows={10}
          placeholder={"CHEESE\nMAGIC WAND\nSOCKET\nDONKEY\nGREEN CHEESE\nECLIPSE\nTHIMBLE\nEASY ANSWER\nTIDE\nPANACEA\nBOOT\nWEREWOLF\nPLAYING CARD\nIRON\nTOP HAT\nSILVER BULLET"}
          value={manualText}
          onChange={(e) => { setManualText(e.target.value); setManualError(null); }}
          // The heading names the field and the subtitle states its format;
          // the count error joins the description only while it exists.
          aria-labelledby="manual-heading"
          aria-describedby={manualError ? "manual-subtitle manual-error" : "manual-subtitle"}
          aria-invalid={Boolean(manualError)}
          autoFocus
        />
        <div style={styles.btnRow}>
          <button
            className="btn btn-secondary"
            style={styles.btnSecondary}
            onClick={() => { setScreen("board"); setManualError(null); }}
          >
            Back
          </button>
          <button className="btn btn-primary" style={styles.btnPrimary} onClick={() => {
            const parsed = parseTiles(manualText);
            if (parsed) {
              // Typed words replace the single custom board and become the
              // board on screen. todayET() at call time: the stamp is what ages
              // this board out of the window later.
              abortInFlight();
              setStore((s) => setCustom(s, parsed, todayET()));
              landed();
              setScreen("board");
            } else {
              const count = manualText.split(/[,\n]+/).map(w => w.trim()).filter(Boolean).length;
              setManualError("Found " + count + " words — need exactly 16.");
            }
          }}>Load Puzzle</button>
        </div>
        {manualError && (
          <p id="manual-error" role="alert" style={styles.error}>
            {manualError}
          </p>
        )}
      </main>
    );
  }

  const loadingDay = fetchingKey ? possessiveDay(fetchingKey, today) : null;

  return (
    <div style={styles.container}>
      {/* The board and everything that acts on it. The footer and the
          two sheets sit outside the landmark. */}
      <main>
        {/* The board is the whole app, so its name lives in the document title
            and here for assistive tech rather than taking up a header row. */}
        <h1 className="sr-only">Connections Sorter</h1>

        <div style={styles.boardHeader}>
          {/* Segment styling (including the four-segment dense variant) lives in
              index.css: inline styles can't express a modifier class, and the
              dense padding is what keeps four segments on one row at 320px. */}
          <div
            ref={segsRef}
            className={entries.length > 3 ? "segs segs-dense" : "segs"}
            role="group"
            aria-label="Puzzle day"
          >
            {entries.map((entry) => {
              const isActive = activeKey === entry.key && !launching;
              const isLoading = fetchingKey === entry.key;
              const locks = entry.lockedCount === 1 ? "1 group locked" : `${entry.lockedCount} groups locked`;
              // The weekday segments are labelled with the head of their own date
              // text ("Fri" / "Fri, Aug 14"), so prefixing there would announce
              // "Fri, Fri, Aug 14". Only prefix when the label adds something.
              const spoken = entry.dateText.startsWith(entry.label)
                ? entry.dateText
                : `${entry.label}, ${entry.dateText}`;
              return (
                <button
                  key={entry.key}
                  className="seg"
                  aria-pressed={isActive}
                  aria-label={entry.lockedCount > 0 ? `${spoken}, ${locks}` : spoken}
                  onClick={() => loadDay(entry.key)}
                >
                  {entry.label}
                  {/* The dot marks days you have a board on but aren't looking
                      at — the resume affordance. On the active segment it would
                      only restate the fill. */}
                  {isLoading ? (
                    <span className="seg-spin" aria-hidden="true" />
                  ) : entry.started && !isActive ? (
                    <span className="seg-dot" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div style={styles.headerActions}>
            <button
              className="btn small-btn"
              onClick={shuffleUnlocked}
              disabled={!board}
            >
              Shuffle
            </button>
            <button
              className="btn small-btn icon-btn"
              onClick={openOverflow}
              aria-label="More options"
              aria-haspopup="dialog"
              aria-expanded={overflowOpen}
            >
              <MoreIcon />
            </button>
          </div>
        </div>

        {/* A failed switch keeps the current board and says so in one line. With
            no board on screen the same failure renders inside the empty state
            below instead. Not a live region itself: it arrives already
            populated, which is exactly the case a live region doesn't announce
            — the standing sr-only status below speaks it instead. */}
        {board && loadError && (
          <div className="notice" style={styles.notice}>
            <span>{loadError.message}</span>
            <button
              className="ghost-btn ghost-btn-action"
              onClick={() => loadDay(loadError.key)}
              disabled={fetchingKey !== null}
            >
              Retry
            </button>
            <button
              className="ghost-btn ghost-btn-end"
              onClick={() => setLoadError(null)}
              aria-label="Dismiss"
            >
              <CloseIcon />
            </button>
          </div>
        )}

        {board ? (
          // Keyed by the active board so switching days replays the staggered
          // entrance instead of swapping words in place.
          <div key={activeKey} ref={gridRef} style={styles.grid}>
            {[0, 1, 2, 3].map(rowIdx => {
              const locked = lockedRows[rowIdx];
              const flashing = flashRow === rowIdx;
              const color = ROW_COLORS[rowIdx];

              return (
                // Each row is a lock toggle, a label field and four tiles; the
                // group names it so a screen reader knows which row it's in.
                <div key={rowIdx} role="group" aria-label={`${color.name} row`}>
                  <div style={styles.rowControl}>
                    <button
                      className="btn"
                      style={{
                        ...styles.lockBtn,
                        background: locked ? color.bg : "transparent",
                        color: locked ? color.text : "var(--text-muted)",
                        borderColor: locked ? color.bg : "var(--border-strong)",
                        fontWeight: locked ? 800 : 600,
                      }}
                      aria-pressed={locked}
                      aria-label={`Lock ${color.name} row`}
                      onClick={() => toggleLock(rowIdx)}
                    >
                      {/* The icon restates aria-pressed, and the aria-label
                          above already names the row, so it stays hidden. */}
                      {locked ? (
                        <CheckIcon className="icon-before" />
                      ) : (
                        <CircleIcon className="icon-before" />
                      )}
                      {color.name}
                    </button>
                    <input
                      className="label-input"
                      style={{
                        ...styles.labelInput,
                        borderColor: locked ? `${color.bg}aa` : "var(--input-border)",
                        background: locked ? `${color.bg}22` : "var(--input-bg)",
                        // Once locked, the row is settled — let its label recede so
                        // the lock button + colored tiles carry the row.
                        color: locked ? "var(--text-soft)" : "var(--text)",
                      }}
                      placeholder="Category label…"
                      aria-label={`${color.name} row label`}
                      value={labels[rowIdx]}
                      onChange={(e) => updateLabel(rowIdx, e.target.value)}
                    />
                  </div>

                  <div style={styles.tileRow}>
                    {[0, 1, 2, 3].map(colIdx => {
                      const idx = rowIdx * 4 + colIdx;
                      const isSelected = selected === idx;
                      const isSwapping = swapAnim && (swapAnim.a === idx || swapAnim.b === idx);
                      const isDragging = drag?.from === idx;
                      const isDropTarget = drag?.over === idx;
                      // The two tiles of a dropped swap, on their way to their
                      // new cells: the one that took the carried word and the
                      // one that took the target's. `isSeeded` is true only for
                      // the single re-seat frame that starts the glide;
                      // `isCrossing` covers that frame and the glide after it
                      // — the span the displaced tile spends lifted over cells
                      // that aren't its own, where index.css drops it out of
                      // hit-testing so a press meant for one of them reaches
                      // the tile resting underneath.
                      const isArriving = settle?.over === idx;
                      const isDisplaced = settle?.from === idx;
                      const isSettling = isArriving || isDisplaced;
                      const isSeeded = isSettling && settle.phase === "seeded";
                      const isCrossing = isDisplaced && settle.phase !== "landed";
                      const word = tiles[idx] || "";
                      // Cascade the entrance top-left → bottom-right, capped so the
                      // last tile doesn't lag noticeably behind the first.
                      const revealDelay = Math.min(idx * 22, 330);

                      // Precedence mirrors the original: locked fill wins over the
                      // selected (picked-up) state; flashing only deepens a locked
                      // tile's glow. A carried tile reads as picked up, because it
                      // is — the fill a tap gives, on a ring of its own (below).
                      // A drop target keeps its resting fill and takes only a
                      // ring, so it reads as "here", not as a second thing
                      // selected. The settle's seed frame borrows both: for
                      // the one re-seat frame after a drop, each of the two
                      // tiles wears the look the tile whose word it just took
                      // was wearing, so that frame changes nothing on screen.
                      // Colors flow through CSS
                      // vars so the board tracks the light/dark theme
                      // automatically.
                      let bg, fg, borderColor, boxShadow;
                      if (locked) {
                        bg = color.bg;
                        fg = color.text;
                        borderColor = "transparent";
                        boxShadow = flashing
                          ? `0 0 0 1px ${color.bg}, 0 8px 26px ${color.glow}, 0 0 32px ${color.glow}`
                          : `0 2px 8px ${color.glow}`;
                      } else if (isDragging || (isSeeded && isArriving)) {
                        // The seed frame wears the last held frame's looks as
                        // well as its positions: the arriving tile stands in
                        // for the one that was under the finger, so it takes
                        // the carried treatment and lets .tile's color
                        // transitions fade it back to resting over the glide.
                        // Sharing the branch is safe because nothing can come
                        // between it and the drop-target branch on the seed
                        // frame: setSelected(null) is batched with the seed,
                        // so `selected` is already null there.
                        bg = "var(--selected-bg)";
                        fg = "var(--selected-text)";
                        borderColor = "transparent";
                        // Same picked-up fill as a tap selection, but ringed in
                        // the CONTRASTING token rather than in its own color:
                        // the tile it's hovering is ringed in --selected-ring,
                        // and two touching rings of one color read as a single
                        // dark blob. This one cuts the carried tile out of
                        // whatever it's over.
                        boxShadow = "0 0 0 2.5px var(--selected-text), var(--selected-shadow)";
                      } else if (isSelected) {
                        bg = "var(--selected-bg)";
                        fg = "var(--selected-text)";
                        borderColor = "transparent";
                        boxShadow = "0 0 0 2.5px var(--selected-ring), var(--selected-shadow)";
                      } else if (isDropTarget || (isSeeded && isDisplaced)) {
                        // …and the displaced tile stands in for the drop
                        // target, ring and all.
                        bg = "var(--tile-bg)";
                        fg = "var(--tile-text)";
                        borderColor = "transparent";
                        boxShadow = "0 0 0 3px var(--selected-ring), var(--tile-shadow)";
                      } else {
                        bg = "var(--tile-bg)";
                        fg = "var(--tile-text)";
                        borderColor = "var(--tile-border)";
                        boxShadow = "var(--tile-shadow)";
                      }
                      // Selected tiles lift (you "pick them up"); a dragged tile
                      // follows the pointer; the partner tile tucks during the
                      // swap. Resting and locked tiles get no inline transform
                      // so the CSS `.tile:hover` lift can apply (an inline
                      // transform would always win over it).
                      //
                      // The two drag scales are a pair, and swapping them round
                      // would cost the drop-target ring: carry the tile at the
                      // finger's centre and it lands exactly over the target, so
                      // the ring only reads if the target's ringed box stays
                      // wider than the tile riding on top of it. 1.06 + a 3px
                      // ring reaches 5.4px past a resting edge — a clear halo
                      // around the 1.04 tile, and still inside the 6px grid gap,
                      // so it never crowds the neighbours.
                      //
                      // A settling tile's seed outranks all of it for one
                      // frame; once it drops, the tile has no inline transform
                      // at all and .tile's 0.15s transition takes it home.
                      const liftTransform = isDragging
                        ? `translate(${drag.dx}px, ${drag.dy}px) scale(${DRAG_LIFT_SCALE})`
                        : isSelected
                        ? "scale(1.05)"
                        : isSwapping
                        ? "scale(0.9)"
                        : isDropTarget
                        ? `scale(${DROP_TARGET_SCALE})`
                        : undefined;
                      const transform = isSeeded
                        ? (isArriving ? settle.seeds.arriving : settle.seeds.displaced)
                        : liftTransform;

                      return (
                        <div
                          key={idx}
                          className="reveal"
                          style={{ ...styles.tileCell, animationDelay: `${revealDelay}ms` }}
                        >
                          <button
                            className={[
                              "tile",
                              flashing && "tile-pop",
                              isDragging && "tile-dragging",
                              isSettling && "tile-settling",
                              isSeeded && "tile-seeded",
                              isCrossing && "tile-crossing",
                              isArriving && "tile-arriving",
                            ].filter(Boolean).join(" ")}
                            ref={el => (tileRefs.current[idx] = el)}
                            // Still just the tap state: a drag is a gesture in
                            // flight, not a toggle, and it clears itself on
                            // release, so it must not claim to be pressed.
                            aria-pressed={isSelected}
                            // A locked row's tiles ignore taps (handleTap returns
                            // early) and can neither be dragged nor take a drop
                            // (isTileInPlay). aria-disabled rather than disabled:
                            // the words still have to be readable from the
                            // keyboard.
                            aria-disabled={locked}
                            onClick={() => handleTap(idx)}
                            onPointerDown={(e) => handleTilePointerDown(idx, e)}
                            onPointerMove={handleTilePointerMove}
                            onPointerUp={handleTilePointerUp}
                            onPointerCancel={handleTilePointerCancel}
                            style={{
                              ...styles.tile,
                              background: bg,
                              color: fg,
                              borderColor,
                              // fontSize is owned by fitTileFonts (measured
                              // against the tile), not React, so it isn't
                              // reset on re-render.
                              transform,
                              boxShadow,
                            }}
                          >
                            {word}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          // No board on screen: the launch fetch is still running, or it failed
          // and this is the only thing the app can offer. Same footprint as the
          // grid so the header doesn't jump when the words arrive.
          <div style={styles.emptyWrap}>
            {/* A retry from here puts the spinner back, so the failure message
                never sits above a button that looks like it did nothing. */}
            {loadError && !fetchingKey ? (
              <>
                <p style={styles.emptyText} role="status">{loadError.message}.</p>
                <button
                  className="btn small-btn"
                  onClick={() => loadDay(loadError.key)}
                >
                  Retry
                </button>
                <button
                  className="ghost-btn ghost-btn-link"
                  onClick={() => setScreen("manual")}
                >
                  or enter the words yourself
                </button>
              </>
            ) : (
              <>
                <div style={styles.spinner} aria-hidden="true" />
                <p style={styles.emptyText} role="status">
                  Loading {loadingDay ?? "today's"} puzzle…
                </p>
              </>
            )}
          </div>
        )}

        {/* The whole spoken account of a day switch, from one element that is
            always mounted: a live region has to be in the DOM before its text
            arrives, or the arrival isn't announced. It alternates
            loading → error → loading, so a retry that fails again still reads
            as a change (the text flips to "Loading…" first) rather than an
            unchanged string. The visible cues it stands in for are both
            silent: the segment spinner is aria-hidden and the notice arrives
            pre-populated. The board-less state has its own visible
            role="status", so this element exists only while a board does and
            the two can't double up. */}
        {board && (
          <p className="sr-only" role="status">
            {loadingDay
              ? `Loading ${loadingDay} puzzle…`
              : loadError
                ? loadError.message
                : ""}
          </p>
        )}

        {/* Always rendered, for the same reason: the hint flips to the swap
            instruction the moment a tile is picked up, and that flip is only
            announced if the region was already there. */}
        <p style={styles.boardHint} aria-live="polite">
          {!board ? (
            ""
          ) : selected !== null ? (
            <>
              {/* The arrow points up at the picked-up tile on screen and is
                  decoration only — the sentence reads the same without it, so
                  it stays hidden. */}
              <ArrowUpIcon className="icon-before" />
              Tap another tile to swap
            </>
          ) : (
            "Tap a tile to select, then another to swap"
          )}
        </p>
      </main>

      <footer style={styles.footer}>
        Connections Sorter is an independent helper, not affiliated with The New
        York Times ·{" "}
        <a
          className="footer-link"
          style={styles.footerLink}
          href={OFFICIAL_GAME_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Play the official game
          <ExternalIcon className="icon-after" />
        </a>
      </footer>

      {/* Everything that isn't sorting tiles. A native <dialog> so Escape, the
          backdrop, focus trapping and inertness come from the platform rather
          than from hand-rolled key handlers. */}
      <dialog
        ref={overflowRef}
        className="sheet"
        aria-label="More options"
        onClick={onDialogClick}
        onClose={() => { setOverflowOpen(false); setShareStatus(null); }}
      >
        <div className="sheet-body">
          {/* A setting, not an action, so it leads the sheet as a control strip
              rather than sitting among the list rows: the sheet stays open and
              the board behind it flips at once, which is the feedback. Same
              aria-pressed pattern as the day switcher. */}
          <div className="sheet-row">
            <span id="appearance-label">Appearance</span>
            <div className="segs" role="group" aria-labelledby="appearance-label">
              {THEME_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className="seg"
                  aria-pressed={themePref === value}
                  onClick={() => chooseTheme(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button
            ref={manualItemRef}
            className="sheet-item"
            onClick={() => { closeOverflow(); setScreen("manual"); }}
          >
            Enter words manually
          </button>
          <button
            className="sheet-item"
            onClick={() => { closeOverflow(); howRef.current?.showModal(); }}
          >
            How this works
          </button>
          <button className="sheet-item" onClick={shareSite}>
            Share this site
            {/* aria-live so "Link copied" is announced without moving focus. */}
            <span className="sheet-hint" aria-live="polite">
              {shareStatus === "copied"
                ? "Link copied"
                : shareStatus === "failed"
                  ? `Couldn't copy — the address is ${new URL(SITE_URL).host}`
                  : CAN_NATIVE_SHARE
                    ? "Send a link to a friend"
                    : "Copy a link to send to a friend"}
            </span>
          </button>
          <a
            className="sheet-item"
            href={OFFICIAL_GAME_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeOverflow}
          >
            Play the official game
            <ExternalIcon className="icon-after" />
          </a>
          {/* Destructive, so it comes last and in its own group: a visible band
              rather than another hairline, which also keeps a thumb aimed at
              Cancel from landing on it (Reset has no confirm step). */}
          <hr className="sheet-gap" />
          <button
            className="sheet-item sheet-item-danger"
            onClick={() => { closeOverflow(); resetBoard(); }}
            disabled={!board}
          >
            Reset board
            <span className="sheet-hint">Clears locks and labels</span>
          </button>
        </div>
        <button className="sheet-close" onClick={closeOverflow}>Cancel</button>
      </dialog>

      <dialog
        ref={howRef}
        className="sheet"
        aria-labelledby="how-heading"
        onClick={onDialogClick}
      >
        <div className="sheet-body sheet-prose">
          <div style={styles.colorDots} aria-hidden="true">
            {ROW_COLORS.map((c, i) => (
              <span key={i} style={{ ...styles.dot, background: c.bg }} />
            ))}
          </div>
          <h2 id="how-heading" style={styles.howHeading}>How this works</h2>
          <ol style={styles.howList}>
            <li>Today's words load automatically. Switch to yesterday's or the day before from the header.</li>
            <li>Tap two tiles to swap them, or drag one onto another. Group words you think share a category into the same row.</li>
            <li>Lock rows you're confident in, then enter your guesses on the official NYT game.</li>
          </ol>
          <p style={styles.howNote}>
            Nothing leaves your device except the request for the day's words.
          </p>
        </div>
        <button className="sheet-close" onClick={() => howRef.current?.close()}>Close</button>
      </dialog>
    </div>
  );
}

const styles = {
  container: {
    // min-height and the safe-area insets live on #root (index.css).
    background: "transparent",
    fontFamily: "var(--font)",
    color: "var(--text)",
    padding: "12px 10px",
    maxWidth: 500,
    margin: "0 auto",
    boxSizing: "border-box",
  },
  // The manual screen's heading block (the board screen has no title row).
  header: {
    textAlign: "center",
    paddingTop: 12,
    paddingBottom: 0,
  },
  colorDots: {
    display: "flex",
    gap: 6,
    marginBottom: 12,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    display: "inline-block",
  },
  title: {
    fontSize: "var(--fs-xl)",
    fontWeight: 800,
    color: "var(--text)",
    margin: 0,
    letterSpacing: "-0.6px",
  },
  subtitle: {
    fontSize: "var(--fs-sm)",
    color: "var(--text-muted)",
    marginTop: 4,
    fontWeight: 500,
  },
  boardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    // The gap is a floor, not a spacing: space-between pushes the switcher and
    // the buttons apart at any width with room to spare, so this only bites at
    // 320px with four segments, where every pixel goes to the switcher (see
    // the 320px budget under `.segs` in index.css).
    gap: 6,
    marginBottom: 10,
    paddingTop: 2,
  },
  headerActions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
  },
  // One-line load failure under the header, when a board is still on screen.
  notice: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    // Both spacings are set by the shared focus ring (3px at a 2px offset, so
    // it reaches 5px past the button it's on): 8px of gap keeps Retry's ring
    // clear of the end of the message beside it with 3px of air (at 6 it
    // cleared by a single pixel and read as touching), and 6px of vertical
    // padding keeps it off the bar's own border. Neither is optical — the
    // Retry and dismiss buttons inside are 32px target boxes with no border
    // or fill, so their own height already carries the padding the bar would
    // otherwise need.
    gap: 8,
    padding: "6px 12px",
    marginBottom: 12,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-md)",
    boxShadow: "var(--card-shadow)",
    fontSize: "var(--fs-sm)",
    color: "var(--text-soft)",
  },
  // Its Retry and dismiss buttons, and the empty state's link, are .ghost-btn
  // and its modifiers in index.css.
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  // Stands in for the grid, at roughly its height, so the header and footer
  // don't jump when the words land.
  emptyWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    minHeight: "clamp(280px, 52vh, 460px)",
    textAlign: "center",
  },
  emptyText: {
    fontSize: "var(--fs-md)",
    color: "var(--text-muted)",
    margin: 0,
  },
  spinner: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    border: "3px solid var(--border)",
    borderTopColor: "var(--text)",
    animation: "spin 0.8s linear infinite",
  },
  rowControl: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  lockBtn: {
    fontSize: "var(--fs-xs)",
    // A target-size floor that doesn't depend on the font's line box, shared
    // with the label input beside it so the row reads as one line. The
    // line-height (the tile's) keeps the floor in charge: at the font's
    // normal leading a 12px label plus the padding and border overruns 30,
    // and every row would grow with it.
    lineHeight: 1.15,
    minHeight: 30,
    padding: "7px 10px",
    borderRadius: "var(--r-sm)",
    border: "1px solid",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "var(--font)",
    fontWeight: 600,
  },
  labelInput: {
    flex: 1,
    fontSize: "var(--fs-sm)",
    minHeight: 30,
    padding: "6px 10px",
    border: "1px solid",
    borderRadius: "var(--r-sm)",
    fontFamily: "var(--font)",
    color: "var(--text)",
  },
  tileRow: {
    display: "grid",
    // minmax(0, 1fr), not 1fr: a 1fr track's min size is its content's
    // min-content, so an unbreakable long word (PENNSYLVANIA) would blow the
    // column wider than its share and push the grid past the viewport. Capping
    // at 0 keeps all four columns equal and lets the word overflow its cell,
    // which is exactly what fitTileFonts measures and shrinks to fit.
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 6,
  },
  tileCell: {
    aspectRatio: "1",
  },
  tile: {
    width: "100%",
    height: "100%",
    border: "1.5px solid transparent",
    borderRadius: "var(--r-md)",
    // cursor lives in index.css (.tile): a locked row's tiles need a variant,
    // and an inline value would win over it.
    fontWeight: 700,
    fontFamily: "var(--font)",
    textTransform: "uppercase",
    letterSpacing: "0.3px",
    lineHeight: 1.15,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    // Horizontal padding keeps words off the box edges (matching the official
    // app). It's part of clientWidth, so fitTileFonts shrinks long words a touch
    // more to respect this margin rather than letting them run to the side.
    // Tuned empirically: more than this tips a two-word tile into wrapping on a
    // narrow (~375px) phone.
    padding: "5px 5px",
    WebkitTapHighlightColor: "transparent",
    // Wrap only at spaces — never split a word. Single words that are too wide
    // are shrunk to fit by fitTileFonts instead of being broken mid-string.
    overflowWrap: "normal",
    wordBreak: "normal",
    hyphens: "none",
    // A word still too wide at the MIN_TILE_FONT floor would otherwise spill out
    // of its rounded box into the neighboring tile; clip it at the edge so an
    // unavoidable overflow degrades cleanly instead of looking like a bug.
    overflow: "hidden",
  },
  boardHint: {
    textAlign: "center",
    fontSize: "var(--fs-sm)",
    color: "var(--text-muted)",
    marginTop: 16,
  },
  footer: {
    textAlign: "center",
    fontSize: "var(--fs-xs)",
    color: "var(--text-muted)",
    lineHeight: 1.5,
    margin: "18px auto 0",
    maxWidth: 340,
  },
  footerLink: {
    color: "var(--text-muted)",
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  howHeading: {
    // Between --fs-lg and --fs-xl on purpose: a dialog heading, not a page
    // title, and 15 reads as a row.
    fontSize: 17,
    fontWeight: 800,
    color: "var(--text)",
    margin: "0 0 8px",
    letterSpacing: "-0.3px",
  },
  howList: {
    fontSize: "var(--fs-md)",
    color: "var(--text-soft)",
    lineHeight: 1.5,
    margin: 0,
    paddingLeft: 20,
  },
  howNote: {
    fontSize: "var(--fs-sm)",
    color: "var(--text-muted)",
    lineHeight: 1.45,
    margin: "14px 0 0",
  },
  error: {
    color: "var(--error-text)",
    fontSize: "var(--fs-sm)",
    textAlign: "center",
    marginTop: 10,
    padding: "7px 12px",
    background: "var(--error-bg)",
    borderRadius: "var(--r-md)",
  },
  textarea: {
    width: "100%",
    padding: 14,
    fontSize: "var(--fs-md)",
    fontFamily: "var(--font)",
    border: "1px solid var(--input-border)",
    borderRadius: "var(--r-md)",
    background: "var(--input-bg)",
    color: "var(--text)",
    boxSizing: "border-box",
    resize: "vertical",
    marginTop: 16,
  },
  btnRow: {
    display: "flex",
    gap: 10,
    marginTop: 12,
  },
  // The manual screen's two buttons. Their colors — fill, text, edge — live in
  // index.css (.btn-primary / .btn-secondary), not here: an inline `background`
  // or `border` outranks the class's :hover rule (the primary's fill and Back's
  // edge both did), which is how both hovers came to change nothing. Layout
  // stays inline.
  btnPrimary: {
    flex: 1,
    padding: "13px 20px",
    fontSize: "var(--fs-lg)",
    fontWeight: 700,
    borderRadius: "var(--r-md)",
    cursor: "pointer",
    fontFamily: "var(--font)",
  },
  btnSecondary: {
    flex: 1,
    padding: "13px 20px",
    fontSize: "var(--fs-lg)",
    fontWeight: 600,
    borderRadius: "var(--r-md)",
    cursor: "pointer",
    fontFamily: "var(--font)",
  },
};
