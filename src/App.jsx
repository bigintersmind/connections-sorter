import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitTileFont } from "./fitTileFont.js";
import { SITE_URL, sharePayload } from "./share.js";
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
  const [manualText, setManualText] = useState("");
  const [manualError, setManualError] = useState(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Outcome of the last "Share this site" tap that ended on the clipboard
  // path: "copied" | "failed" | null. Shown as the item's hint; cleared
  // whenever the sheet closes so the next open starts fresh.
  const [shareStatus, setShareStatus] = useState(null);
  const autoLoadedRef = useRef(false);
  const fetchAbortRef = useRef(null);
  const tileRefs = useRef([]);
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
  // Re-fits on resize (which also fires on device rotation) so words stay whole
  // at any width.
  useLayoutEffect(() => {
    const fitAll = () => {
      for (const el of tileRefs.current) {
        if (el) fitTileFont(el);
      }
    };
    fitAll();
    // Libre Franklin is self-hosted and loads async, so the pre-paint pass above
    // can measure the fallback font, whose metrics differ. Re-fit once the real
    // font lands so a long word isn't frozen at a fallback-measured size.
    // `fonts.ready` resolves immediately when fonts are already in, so this is
    // one extra pass at most; fitAll reads the live tileRefs, so a late resolve
    // after a re-render is harmless (unmounted tiles are null and skipped).
    document.fonts?.ready.then(fitAll);
    window.addEventListener("resize", fitAll);
    return () => window.removeEventListener("resize", fitAll);
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
  // you can see.
  useEffect(() => {
    segsRef.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

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

  const handleTap = useCallback((index) => {
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
        setStore((s) => {
          // The swap commits after the animation, by which time the player may
          // have switched days — apply it to the board it was started on, or
          // not at all.
          if (s.active !== activeKey) return s;
          const next = [...s.boards[activeKey].tiles];
          [next[selected], next[index]] = [next[index], next[selected]];
          return updateActive(s, { tiles: next });
        });
        setSwapAnim(null);
        setSelected(null);
      }, 200);
    }
  }, [selected, lockedRows, activeKey, swapAnim]);

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
    // showModal() focuses the first focusable item, which is Reset — making a
    // destructive action the keyboard default (Enter, Enter). Land on the
    // first harmless item instead; the PRD pins Reset at the top of the list.
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
      <div style={styles.container}>
        <div style={{ ...styles.header, paddingTop: 12, paddingBottom: 0 }}>
          <h1 style={{ ...styles.title, fontSize: 20 }}>Enter 16 Words</h1>
          <p style={styles.subtitle}>One per line, or comma-separated</p>
        </div>
        <textarea
          style={styles.textarea}
          rows={10}
          placeholder={"CHEESE\nMAGIC WAND\nSOCKET\nDONKEY\nGREEN CHEESE\nECLIPSE\nTHIMBLE\nEASY ANSWER\nTIDE\nPANACEA\nBOOT\nWEREWOLF\nPLAYING CARD\nIRON\nTOP HAT\nSILVER BULLET"}
          value={manualText}
          onChange={(e) => { setManualText(e.target.value); setManualError(null); }}
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
        {manualError && <p style={styles.error}>{manualError}</p>}
      </div>
    );
  }

  const loadingDay = fetchingKey ? possessiveDay(fetchingKey, today) : null;

  return (
    <div style={styles.container}>
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
            ⋯
          </button>
        </div>
      </div>

      {/* A failed switch keeps the current board and says so in one line. With
          no board on screen the same failure renders inside the empty state
          below instead. */}
      {board && loadError && (
        <div className="notice" style={styles.notice} role="status">
          <span>{loadError.message}</span>
          <button
            className="ghost-btn"
            style={styles.noticeAction}
            onClick={() => loadDay(loadError.key)}
            disabled={fetchingKey !== null}
          >
            Retry
          </button>
          <button
            className="ghost-btn"
            style={styles.noticeDismiss}
            onClick={() => setLoadError(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {board ? (
        // Keyed by the active board so switching days replays the staggered
        // entrance instead of swapping words in place.
        <div key={activeKey} style={styles.grid}>
          {[0, 1, 2, 3].map(rowIdx => {
            const locked = lockedRows[rowIdx];
            const flashing = flashRow === rowIdx;
            const color = ROW_COLORS[rowIdx];

            return (
              <div key={rowIdx}>
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
                    onClick={() => toggleLock(rowIdx)}
                  >
                    {locked ? "✓ " + color.name : "○ " + color.name}
                  </button>
                  <input
                    style={{
                      ...styles.labelInput,
                      borderColor: locked ? `${color.bg}aa` : "var(--border)",
                      background: locked ? `${color.bg}22` : "var(--input-bg)",
                      // Once locked, the row is settled — let its label recede so
                      // the lock button + colored tiles carry the row.
                      color: locked ? "var(--text-soft)" : "var(--text)",
                      opacity: locked ? 0.75 : 1,
                    }}
                    placeholder="Category label…"
                    value={labels[rowIdx]}
                    onChange={(e) => updateLabel(rowIdx, e.target.value)}
                  />
                </div>

                <div style={styles.tileRow}>
                  {[0, 1, 2, 3].map(colIdx => {
                    const idx = rowIdx * 4 + colIdx;
                    const isSelected = selected === idx;
                    const isSwapping = swapAnim && (swapAnim.a === idx || swapAnim.b === idx);
                    const word = tiles[idx] || "";
                    // Cascade the entrance top-left → bottom-right, capped so the
                    // last tile doesn't lag noticeably behind the first.
                    const revealDelay = Math.min(idx * 22, 330);

                    // Precedence mirrors the original: locked fill wins over the
                    // selected (picked-up) state; flashing only deepens a locked
                    // tile's glow. Colors flow through CSS vars so the board
                    // tracks the light/dark theme automatically.
                    let bg, fg, borderColor, boxShadow;
                    if (locked) {
                      bg = color.bg;
                      fg = color.text;
                      borderColor = "transparent";
                      boxShadow = flashing
                        ? `0 0 0 1px ${color.bg}, 0 8px 26px ${color.glow}, 0 0 32px ${color.glow}`
                        : `0 2px 8px ${color.glow}`;
                    } else if (isSelected) {
                      bg = "var(--selected-bg)";
                      fg = "var(--selected-text)";
                      borderColor = "transparent";
                      boxShadow = "0 0 0 2.5px var(--selected-ring), var(--selected-shadow)";
                    } else {
                      bg = "var(--tile-bg)";
                      fg = "var(--tile-text)";
                      borderColor = "var(--tile-border)";
                      boxShadow = "var(--tile-shadow)";
                    }
                    // Selected tiles lift (you "pick them up"); the partner tile
                    // tucks during the swap. Resting and locked tiles get no
                    // inline transform so the CSS `.tile:hover` lift can apply
                    // (an inline transform would always win over it).
                    const liftTransform = isSelected
                      ? "scale(1.05)"
                      : isSwapping
                      ? "scale(0.9)"
                      : undefined;

                    return (
                      <div
                        key={idx}
                        className="reveal"
                        style={{ ...styles.tileCell, animationDelay: `${revealDelay}ms` }}
                      >
                        <button
                          className="tile"
                          ref={el => (tileRefs.current[idx] = el)}
                          onClick={() => handleTap(idx)}
                          style={{
                            ...styles.tile,
                            background: bg,
                            color: fg,
                            borderColor,
                            // fontSize is owned by fitTileFont (DOM-measured),
                            // not React, so it isn't reset on re-render.
                            transform: liftTransform,
                            boxShadow,
                            animation: flashing ? "lockPop 0.45s ease" : "none",
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
                className="ghost-btn"
                style={styles.linkBtn}
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

      {board && (
        <p style={styles.boardHint}>
          {selected !== null
            ? "↑ Tap another tile to swap"
            : "Tap a tile to select, then another to swap"}
        </p>
      )}

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
          Play the official game ↗
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
          <button
            className="sheet-item sheet-item-danger"
            onClick={() => { closeOverflow(); resetBoard(); }}
            disabled={!board}
          >
            Reset board
            <span className="sheet-hint">Clears locks and labels</span>
          </button>
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
            Play the official NYT Connections ↗
          </a>
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
            <li>Tap two tiles to swap them. Group words you think share a category into the same row.</li>
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
    minHeight: "100vh",
    background: "transparent",
    fontFamily: "var(--font)",
    color: "var(--text)",
    padding: "12px 10px",
    maxWidth: 500,
    margin: "0 auto",
    boxSizing: "border-box",
  },
  header: {
    textAlign: "center",
    paddingTop: 28,
    paddingBottom: 8,
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
    fontSize: 27,
    fontWeight: 800,
    color: "var(--text)",
    margin: 0,
    letterSpacing: "-0.6px",
  },
  subtitle: {
    fontSize: 13.5,
    color: "var(--text-muted)",
    marginTop: 4,
    fontWeight: 500,
  },
  boardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
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
    gap: 2,
    padding: "8px 12px",
    marginBottom: 12,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--card-shadow)",
    fontSize: 13,
    color: "var(--text-soft)",
  },
  noticeAction: {
    background: "none",
    border: "none",
    padding: "4px 6px",
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text)",
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: "var(--font)",
    whiteSpace: "nowrap",
  },
  noticeDismiss: {
    background: "none",
    border: "none",
    padding: "4px 8px",
    marginLeft: "auto",
    fontSize: 13,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontFamily: "var(--font)",
    lineHeight: 1,
  },
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
    fontSize: 14,
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
  linkBtn: {
    background: "none",
    border: "none",
    fontSize: 13,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontFamily: "var(--font)",
    textDecoration: "underline",
    padding: 6,
  },
  rowControl: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  lockBtn: {
    fontSize: 11.5,
    padding: "4px 10px",
    borderRadius: 7,
    border: "1px solid",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "var(--font)",
    fontWeight: 600,
    transition: "all 0.2s",
  },
  labelInput: {
    flex: 1,
    fontSize: 12.5,
    padding: "5px 10px",
    border: "1px solid",
    borderRadius: 7,
    outline: "none",
    fontFamily: "var(--font)",
    color: "var(--text)",
    transition: "all 0.2s",
  },
  tileRow: {
    display: "grid",
    // minmax(0, 1fr), not 1fr: a 1fr track's min size is its content's
    // min-content, so an unbreakable long word (PENNSYLVANIA) would blow the
    // column wider than its share and push the grid past the viewport. Capping
    // at 0 keeps all four columns equal and lets the word overflow its cell,
    // which is exactly what fitTileFont measures and shrinks to fit.
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
    borderRadius: 11,
    cursor: "pointer",
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
    // app). It's part of clientWidth, so fitTileFont shrinks long words a touch
    // more to respect this margin rather than letting them run to the side.
    // Tuned empirically: more than this tips a two-word tile into wrapping on a
    // narrow (~375px) phone.
    padding: "5px 5px",
    WebkitTapHighlightColor: "transparent",
    // Wrap only at spaces — never split a word. Single words that are too wide
    // are shrunk to fit by fitTileFont instead of being broken mid-string.
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
    fontSize: 12.5,
    color: "var(--text-faint)",
    marginTop: 16,
  },
  footer: {
    textAlign: "center",
    fontSize: 12,
    color: "var(--text-faint)",
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
    fontSize: 17,
    fontWeight: 800,
    color: "var(--text)",
    margin: "0 0 8px",
    letterSpacing: "-0.3px",
  },
  howList: {
    fontSize: 14,
    color: "var(--text-soft)",
    lineHeight: 1.5,
    margin: 0,
    paddingLeft: 20,
  },
  howNote: {
    fontSize: 12.5,
    color: "var(--text-faint)",
    lineHeight: 1.45,
    margin: "14px 0 0",
  },
  error: {
    color: "var(--error-text)",
    fontSize: 13,
    textAlign: "center",
    marginTop: 10,
    padding: "7px 12px",
    background: "var(--error-bg)",
    borderRadius: 10,
  },
  textarea: {
    width: "100%",
    padding: 14,
    fontSize: 14,
    fontFamily: "var(--font)",
    border: "1px solid var(--border-strong)",
    borderRadius: 14,
    background: "var(--input-bg)",
    color: "var(--text)",
    boxSizing: "border-box",
    resize: "vertical",
    outline: "none",
    marginTop: 16,
  },
  btnRow: {
    display: "flex",
    gap: 10,
    marginTop: 12,
  },
  btnPrimary: {
    flex: 1,
    padding: "13px 20px",
    fontSize: 15,
    fontWeight: 700,
    background: "var(--primary)",
    color: "var(--primary-text)",
    border: "none",
    borderRadius: 12,
    cursor: "pointer",
    fontFamily: "var(--font)",
  },
  btnSecondary: {
    flex: 1,
    padding: "13px 20px",
    fontSize: 15,
    fontWeight: 600,
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: 12,
    cursor: "pointer",
    fontFamily: "var(--font)",
  },
};
