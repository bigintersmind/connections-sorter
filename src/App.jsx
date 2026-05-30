import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  CLIPBOARD_ERROR_MESSAGES,
  extractClipboardImage,
  hasClipboardReadSupport,
} from "./clipboardImage.js";
import { fitTileFont } from "./fitTileFont.js";

const ROW_COLORS = [
  { name: "Yellow", bg: "#f9df6d", text: "#1a1a1a", glow: "rgba(249,223,109,0.6)" },
  { name: "Green", bg: "#a0c35a", text: "#1a1a1a", glow: "rgba(160,195,90,0.6)" },
  { name: "Blue", bg: "#b0c4ef", text: "#1a1a1a", glow: "rgba(176,196,239,0.6)" },
  { name: "Purple", bg: "#ba81c5", text: "#1a1a1a", glow: "rgba(186,129,197,0.6)" },
];

// Hand-crafted sample used by the "Try Demo Puzzle" button on the menu.
// Categories are intentionally legible so the visual structure (color rows,
// lockable groups) lands faster than the wordplay would.
const DEMO_PUZZLE_WORDS = [
  "LEMON", "LIME", "ORANGE", "GRAPEFRUIT",
  "YACHT", "CANOE", "KAYAK", "FERRY",
  "RUN", "LEAP", "DASH", "SPRINT",
  "ROCK", "RUBBER", "JAZZ", "BROADWAY",
];

function shuffled(arr) {
  const next = [...arr];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

const STORAGE_KEY = "connections-puzzle";

const OFFICIAL_GAME_URL = "https://www.nytimes.com/games/connections";

// Abort reason for a user-initiated cancel (Skip, or starting another load),
// so it can be told apart from a timeout/failure abort.
const SKIP_REASON = "user-skip";

// Daily-puzzle date helpers. These build the chip labels client-side; the
// Worker (worker/puzzle.js) is the source of truth for which dates are
// actually loadable, so a stale clock here just shows a wrong label, never a
// wrong puzzle.
const PUZZLE_LAUNCH_DATE = "2023-06-12";
const RECENT_WINDOW_DAYS = 6; // today + this many prior days

function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

// Calendar arithmetic on a YYYY-MM-DD string, DST-safe (operates in UTC).
function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// Today + recent days (down to launch), each with a short chip label.
function buildRecentDates() {
  const today = todayET();
  const out = [];
  for (let i = 0; i <= RECENT_WINDOW_DAYS; i++) {
    const date = addDays(today, -i);
    if (date < PUZZLE_LAUNCH_DATE) break;
    let label;
    if (i === 0) label = "Today";
    else if (i === 1) label = "Yesterday";
    else {
      const [y, m, d] = date.split("-").map(Number);
      label = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(y, m - 1, d)));
    }
    out.push({ date, label });
  }
  return out;
}

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

function normalizeTileText(s) {
  return s.replace(/[^A-Za-z'\-.& ]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

// Fallback: dump raw OCR text into one-line-per-entry candidates. Loses
// per-tile alignment but gives the user something to clean up if spatial
// reconstruction fails.
function extractWordsFromOcr(rawText) {
  const seen = new Set();
  const out = [];
  for (const line of rawText.split("\n")) {
    const cleaned = normalizeTileText(line);
    if (cleaned.length < 2) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

// Walk Tesseract's nested block→para→line→word tree into a flat word list.
function gatherWords(blocks) {
  const out = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          if (word.bbox && word.text) out.push(word);
        }
      }
    }
  }
  return out;
}

// 1D k-means with deterministic even-spaced init. Returns an array of
// cluster indices (parallel to `values`), with cluster 0 = lowest center.
function kmeans1d(values, k) {
  if (values.length === 0) return [];
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  let centers = Array.from({ length: k }, (_, i) => min + (max - min) * (i + 0.5) / k);
  const assignments = new Array(values.length).fill(0);
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(values[i] - centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;
    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < values.length; i++) {
      sums[assignments[i]] += values[i];
      counts[assignments[i]] += 1;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) centers[c] = sums[c] / counts[c];
    }
  }
  // Re-rank so cluster 0 is the smallest center (top row / left column).
  const order = centers.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
  const remap = new Array(k);
  for (let i = 0; i < k; i++) remap[order[i]] = i;
  return assignments.map(a => remap[a]);
}

// True iff every letter in the text is uppercase. Connections tiles are
// rendered ALL CAPS; UI chrome ("Create four groups of four!", "Mistakes
// Remaining:") is title/sentence case, so this drops chrome cleanly.
function isAllCapsLetters(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

// Spatially reconstruct 16 tiles from OCR word bboxes. Filters out non-tile
// text (title, footer, mistakes counter) by case — tile text is uppercase,
// chrome is not — then clusters the survivors into a 4×4 grid. Returns 16
// strings (some may be empty if OCR missed a tile) or null if reconstruction
// can't get a confident 4×4.
function reconstructTilesFromBboxes(words) {
  if (words.length < 8) return null;

  const tileWords = words.filter(w => isAllCapsLetters(w.text));
  if (tileWords.length < 8) return null;

  const yCenters = tileWords.map(w => (w.bbox.y0 + w.bbox.y1) / 2);
  const rowAssign = kmeans1d(yCenters, 4);

  const cells = Array.from({ length: 16 }, () => []);
  for (let r = 0; r < 4; r++) {
    const rowWords = tileWords.filter((_, i) => rowAssign[i] === r);
    if (rowWords.length === 0) continue;
    const xCenters = rowWords.map(w => (w.bbox.x0 + w.bbox.x1) / 2);
    const colAssign = kmeans1d(xCenters, 4);
    for (let i = 0; i < rowWords.length; i++) {
      cells[r * 4 + colAssign[i]].push(rowWords[i]);
    }
  }

  // At least 8 of 16 cells must have content for us to trust the layout.
  const populated = cells.filter(c => c.length > 0).length;
  if (populated < 8) return null;

  return cells.map(cell => {
    if (cell.length === 0) return "";
    cell.sort((a, b) => {
      const aMid = (a.bbox.y0 + a.bbox.y1) / 2;
      const bMid = (b.bbox.y0 + b.bbox.y1) / 2;
      const lineH = Math.max(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0);
      // If words are on different physical lines (wrap), top-to-bottom wins.
      if (Math.abs(aMid - bMid) > lineH * 0.5) return aMid - bMid;
      return a.bbox.x0 - b.bbox.x0;
    });
    return normalizeTileText(cell.map(w => w.text).join(" "));
  });
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tiles) || data.tiles.length !== 16) return null;
    return {
      tiles: data.tiles,
      lockedRows: data.lockedRows || [false, false, false, false],
      labels: data.labels || ["", "", "", ""],
    };
  } catch {
    return null;
  }
}

export default function ConnectionsOrganizer() {
  const saved = useState(loadSaved)[0];
  const [screen, setScreen] = useState(saved ? "board" : "loading");
  const [tiles, setTiles] = useState(saved?.tiles ?? []);
  const [selected, setSelected] = useState(null);
  const [lockedRows, setLockedRows] = useState(saved?.lockedRows ?? [false, false, false, false]);
  const [flashRow, setFlashRow] = useState(null);
  const [labels, setLabels] = useState(saved?.labels ?? ["", "", "", ""]);
  const [manualText, setManualText] = useState("");
  const [error, setError] = useState(null);
  const [swapAnim, setSwapAnim] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const autoLoadedRef = useRef(false);
  const fetchAbortRef = useRef(null);
  const tileRefs = useRef([]);

  // Shrink-to-fit every tile's font once the board is on screen and whenever
  // the words change. `screen` is a dep so tiles get fit when we first land on
  // the board (navigating menu→board doesn't touch `tiles`). Re-fits on resize
  // (which also fires on device rotation) so words stay whole at any width.
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
  }, [tiles, screen]);

  // Persist on changes
  useEffect(() => {
    if (tiles.length === 16) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ tiles, lockedRows, labels }));
      } catch {
        // storage unavailable — silent
      }
    }
  }, [tiles, lockedRows, labels]);

  const loadPuzzle = useCallback((words) => {
    setTiles(words);
    setLockedRows([false, false, false, false]);
    setLabels(["", "", "", ""]);
    setSelected(null);
    setError(null);
    setScreen("board");
  }, []);

  // Fetch the day's 16 words from our same-origin Worker proxy (which strips
  // the answer groupings server-side) and drop them onto the board. Any
  // failure or timeout falls back to the menu so OCR/manual stay available —
  // it never blocks the user with a blank board or hard error.
  const loadToday = useCallback(async (date) => {
    // Cancel any in-flight load (tapping another day, or Skip) so a stale
    // request can't later yank the user onto the board. SKIP_REASON marks it
    // as user-initiated so the catch below stays silent.
    fetchAbortRef.current?.abort(SKIP_REASON);
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setFetching(true);
    setFetchError(null);
    const timeout = setTimeout(() => controller.abort("timeout"), 9000);
    try {
      const url = date ? `/api/puzzle?date=${encodeURIComponent(date)}` : "/api/puzzle";
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error("fetch_failed");
      const data = await res.json();
      const words = Array.isArray(data?.words) ? data.words : null;
      if (!words || words.length !== 16) throw new Error("bad_data");
      // The Worker already returns clean, uppercased words; pass them through
      // verbatim so accented tiles (e.g. "EL NIÑO") aren't mangled by the
      // OCR/manual-entry normalizer.
      //
      // Only commit if this request is still live. A resolved fetch never
      // rejects, so the catch below can't guard this path: if the user hit
      // Skip or started another load while the fetch/parse was in flight, the
      // signal is aborted (Skip, supersede, and timeout all set it), and
      // dropping the words here stops an already-settled request from yanking
      // the user onto the board they navigated away from.
      if (!controller.signal.aborted) loadPuzzle(words);
    } catch {
      // A user-initiated cancel must not flash a self-inflicted error or pull
      // the user off the screen they chose. A timeout or real failure still
      // falls back to the menu.
      if (controller.signal.reason === SKIP_REASON) return;
      setFetchError("Couldn't load that puzzle automatically — upload a screenshot or enter the words instead.");
      setScreen("menu");
    } finally {
      clearTimeout(timeout);
      // Only the live request clears the shared fetching state. A superseded
      // request (its controller already replaced in the ref by a newer load)
      // must not flip "Loading…" off while that newer request is still in
      // flight. A skipped/timed-out request keeps the ref, so it still clears.
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
        setFetching(false);
      }
    }
  }, [loadPuzzle]);

  // Cancel an in-flight today-load so a slow request can't complete later and
  // hijack the screen the user has since chosen (Skip, Upload, Enter, Demo).
  const cancelPendingFetch = useCallback(() => {
    fetchAbortRef.current?.abort(SKIP_REASON);
  }, []);

  // Auto-load today's words on first visit when there's no saved puzzle to
  // resume. A saved puzzle takes precedence (resume on the board); the menu's
  // "Today's Puzzle" card is the manual path in that case.
  useEffect(() => {
    if (saved || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    loadToday();
  }, [saved, loadToday]);

  const handleTap = useCallback((index) => {
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
        setTiles(prev => {
          const next = [...prev];
          [next[selected], next[index]] = [next[index], next[selected]];
          return next;
        });
        setSwapAnim(null);
        setSelected(null);
      }, 200);
    }
  }, [selected, lockedRows]);

  const toggleLock = useCallback((rowIdx) => {
    if (!lockedRows[rowIdx]) {
      setFlashRow(rowIdx);
      setTimeout(() => setFlashRow(null), 600);
    }
    setLockedRows(prev => {
      const next = [...prev];
      next[rowIdx] = !next[rowIdx];
      return next;
    });
  }, [lockedRows]);

  const updateLabel = useCallback((rowIdx, val) => {
    setLabels(prev => {
      const next = [...prev];
      next[rowIdx] = val;
      return next;
    });
  }, []);

  const resetBoard = useCallback(() => {
    setLockedRows([false, false, false, false]);
    setLabels(["", "", "", ""]);
    setSelected(null);
  }, []);

  const shuffleUnlocked = useCallback(() => {
    setTiles(prev => {
      const next = [...prev];
      const unlocked = [];
      for (let i = 0; i < 16; i++) {
        if (!lockedRows[Math.floor(i / 4)]) unlocked.push(i);
      }
      for (let i = unlocked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[unlocked[i]], next[unlocked[j]]] = [next[unlocked[j]], next[unlocked[i]]];
      }
      return next;
    });
    setSelected(null);
  }, [lockedRows]);

  if (screen === "loading") {
    return (
      <main style={styles.container}>
        <header style={styles.header}>
          <div style={styles.colorDots} aria-hidden="true">
            {ROW_COLORS.map((c, i) => (
              <span key={i} style={{ ...styles.dot, background: c.bg }} />
            ))}
          </div>
          <h1 style={styles.title}>Connections Sorter</h1>
        </header>
        <div style={styles.loadingWrap}>
          <div style={styles.spinner} aria-hidden="true" />
          <p style={styles.loadingText} role="status">Loading today's puzzle…</p>
          <button
            className="ghost-btn"
            style={styles.linkBtn}
            onClick={() => {
              autoLoadedRef.current = true;
              cancelPendingFetch();
              setScreen("menu");
            }}
          >
            Skip — start another way
          </button>
        </div>
      </main>
    );
  }

  if (screen === "menu") {
    return (
      <main style={styles.container}>
        <header style={styles.header}>
          <div style={styles.colorDots} aria-hidden="true">
            {ROW_COLORS.map((c, i) => (
              <span key={i} style={{ ...styles.dot, background: c.bg }} />
            ))}
          </div>
          <h1 style={styles.title}>Connections Sorter</h1>
          <p style={styles.tagline}>
            A scratchpad for the NYT Connections puzzle. Group your guesses
            into rows, then lock them in before you submit.
          </p>
        </header>

        <div style={styles.previewGrid} aria-hidden="true">
          {ROW_COLORS.map((c, rowIdx) => (
            <div key={rowIdx} style={styles.previewRow}>
              {[0, 1, 2, 3].map(colIdx => (
                <div
                  key={colIdx}
                  style={{ ...styles.previewTile, background: c.bg }}
                />
              ))}
            </div>
          ))}
        </div>

        <nav style={styles.menuCards} aria-label="Start a puzzle">
          <button
            className="menu-card"
            style={{ ...styles.menuCard, ...styles.menuCardPrimary }}
            onClick={() => loadToday()}
            disabled={fetching}
            aria-label="Load today's Connections puzzle words"
          >
            <div style={styles.menuCardInner}>
              <span style={styles.menuIcon} aria-hidden="true">📅</span>
              <div>
                <span style={{ ...styles.menuLabel, color: "var(--primary-text)" }}>
                  {fetching ? "Loading…" : "Today's Puzzle"}
                </span>
                <span style={{ ...styles.menuDesc, color: "var(--primary-text-muted)" }}>
                  Load today's 16 words automatically
                </span>
              </div>
            </div>
          </button>

          <div style={styles.chipRow} role="group" aria-label="Load a recent puzzle">
            {buildRecentDates().slice(1).map(({ date, label }) => (
              <button
                key={date}
                className="chip"
                style={styles.chip}
                onClick={() => loadToday(date)}
                disabled={fetching}
              >
                {label}
              </button>
            ))}
          </div>

          {fetchError && <p style={styles.error}>{fetchError}</p>}

          <button
            className="menu-card"
            style={styles.menuCard}
            onClick={() => { cancelPendingFetch(); setScreen("upload"); }}
            aria-label="Upload a screenshot of a Connections puzzle"
          >
            <div style={styles.menuCardInner}>
              <span style={styles.menuIcon} aria-hidden="true">📷</span>
              <div>
                <span style={styles.menuLabel}>Upload Screenshot</span>
                <span style={styles.menuDesc}>Read words from a puzzle image</span>
              </div>
            </div>
          </button>
          <button
            className="menu-card"
            style={styles.menuCard}
            onClick={() => { cancelPendingFetch(); setScreen("manual"); }}
            aria-label="Type or paste the sixteen puzzle words"
          >
            <div style={styles.menuCardInner}>
              <span style={styles.menuIcon} aria-hidden="true">✏️</span>
              <div>
                <span style={styles.menuLabel}>Enter Words</span>
                <span style={styles.menuDesc}>Type or paste 16 words</span>
              </div>
            </div>
          </button>
          <button
            className="menu-card"
            style={styles.menuCard}
            onClick={() => { cancelPendingFetch(); loadPuzzle(shuffled(DEMO_PUZZLE_WORDS)); }}
            aria-label="Try a sample puzzle to see how the app works"
          >
            <div style={styles.menuCardInner}>
              <span style={styles.menuIcon} aria-hidden="true">🎯</span>
              <div>
                <span style={styles.menuLabel}>Try Demo Puzzle</span>
                <span style={styles.menuDesc}>See how it works with a sample</span>
              </div>
            </div>
          </button>
        </nav>

        <section style={styles.howItWorks} aria-labelledby="how-heading">
          <h2 id="how-heading" style={styles.howHeading}>How it works</h2>
          <ol style={styles.howList}>
            <li>Today's words load automatically — or upload a screenshot, type them, or try the demo.</li>
            <li>Tap two tiles to swap them. Group words you think share a category into the same row.</li>
            <li>Lock rows you're confident in, then enter your guesses on the official NYT game.</li>
          </ol>
        </section>

        <footer style={styles.disclaimer}>
          <a
            href={OFFICIAL_GAME_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.officialLink}
          >
            Play the official NYT Connections ↗
          </a>
          <p style={styles.disclaimerText}>
            An independent helper — not affiliated with, endorsed by, or sponsored by
            The New York Times.
          </p>
        </footer>
      </main>
    );
  }

  if (screen === "upload") {
    return (
      <UploadScreen
        onCancel={() => setScreen("menu")}
        onWords={(text) => {
          setManualText(text);
          setError(null);
          setScreen("manual");
        }}
      />
    );
  }

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
          onChange={(e) => { setManualText(e.target.value); setError(null); }}
          autoFocus
        />
        <div style={styles.btnRow}>
          <button className="btn btn-secondary" style={styles.btnSecondary} onClick={() => { setScreen("menu"); setError(null); }}>Back</button>
          <button className="btn btn-primary" style={styles.btnPrimary} onClick={() => {
            const parsed = parseTiles(manualText);
            if (parsed) {
              loadPuzzle(parsed);
            } else {
              const count = manualText.split(/[,\n]+/).map(w => w.trim()).filter(Boolean).length;
              setError("Found " + count + " words — need exactly 16.");
            }
          }}>Load Puzzle</button>
        </div>
        {error && <p style={styles.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.boardHeader}>
        <button className="ghost-btn" style={styles.backBtn} onClick={() => setScreen("menu")}>← Menu</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small-btn" style={styles.smallBtn} onClick={shuffleUnlocked}>Shuffle</button>
          <button className="btn small-btn" style={styles.smallBtn} onClick={resetBoard}>Reset</button>
        </div>
      </div>

      <div style={styles.grid}>
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

      <p style={styles.boardHint}>
        {selected !== null
          ? "↑ Tap another tile to swap"
          : "Tap a tile to select, then another to swap"}
      </p>
    </div>
  );
}

function UploadScreen({ onCancel, onWords }) {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState(null);
  const [clipboardSupported] = useState(hasClipboardReadSupport);
  const inputRef = useRef(null);

  // Revoke object URL when the preview changes or unmounts
  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const pickFile = useCallback((f) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setError(null);
  }, []);

  const pasteFromClipboard = async () => {
    if (running) return;
    try {
      const items = await navigator.clipboard.read();
      const result = await extractClipboardImage(items);
      if (result.kind === "ok") {
        pickFile(result.blob);
      } else {
        setError(CLIPBOARD_ERROR_MESSAGES[result.kind]);
      }
    } catch (err) {
      console.warn("clipboard paste:", err);
      setError(CLIPBOARD_ERROR_MESSAGES.error);
    }
  };

  // Window-level Cmd/Ctrl+V handler for the desktop keyboard shortcut. The
  // on-screen "Paste from clipboard" button goes through `pasteFromClipboard`
  // above (using `navigator.clipboard.read()`), which is the path iOS uses —
  // iOS Safari won't fire `paste` on window unless an editable element is
  // focused. We also bail if the user is pasting *into* an editable element so
  // we don't hijack a real text paste.
  useEffect(() => {
    const handlePaste = async (event) => {
      if (running) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]")
      ) {
        return;
      }
      try {
        const result = await extractClipboardImage(event.clipboardData?.items);
        if (result.kind === "ok") {
          pickFile(result.blob);
        } else {
          setError(CLIPBOARD_ERROR_MESSAGES[result.kind]);
        }
      } catch (err) {
        console.warn("clipboard paste:", err);
        setError(CLIPBOARD_ERROR_MESSAGES.error);
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [running, pickFile]);

  const runOcr = async () => {
    if (!file) return;
    setRunning(true);
    setProgress(0);
    setStage("Loading OCR engine…");
    setError(null);
    let worker;
    try {
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker("eng", 1, {
        // Self-host worker, core WASM, and language data — the defaults fetch
        // from jsDelivr/tessdata, which can fail in production with opaque
        // NetworkError inside the blob worker. See scripts/copy-tesseract-assets.mjs.
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract",
        langPath: "/tesseract",
        logger: (m) => {
          if (m.status === "recognizing text") {
            setStage("Reading text…");
            setProgress(Math.round(m.progress * 100));
          } else if (m.status) {
            setStage(m.status[0].toUpperCase() + m.status.slice(1) + "…");
          }
        },
      });
      // Allow both cases so Tesseract isn't fighting its own model — we
      // uppercase in post. Period and ampersand are needed for tiles like
      // "CHUCK E." and "AT&T"; digits are excluded so footers like
      // "3 mistakes remaining" don't pollute the output.
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '-.&",
        preserve_interword_spaces: "1",
      });
      const { data } = await worker.recognize(file, {}, { text: true, blocks: true });
      const tiles = reconstructTilesFromBboxes(gatherWords(data.blocks));
      const lines = tiles ?? extractWordsFromOcr(data.text);
      if (lines.length === 0) {
        setError("No words detected. Try a clearer crop of just the puzzle grid.");
        return;
      }
      onWords(lines.join("\n"));
    } catch (e) {
      setError("OCR failed: " + (e?.message || "unknown error"));
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch { /* ignore */ }
      }
      setRunning(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={{ ...styles.header, paddingTop: 12, paddingBottom: 0 }}>
        <h1 style={{ ...styles.title, fontSize: 20 }}>Upload Screenshot</h1>
        <p style={styles.subtitle}>Crop tightly to the 4×4 grid for best results</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      {!previewUrl ? (
        <div style={styles.dropzoneStack}>
          <button
            className="menu-card"
            style={styles.dropzone}
            onClick={() => inputRef.current?.click()}
          >
            <span style={{ fontSize: 32, lineHeight: 1 }}>📷</span>
            <span style={styles.menuLabel}>Choose an image</span>
            <span style={styles.menuDesc}>PNG or JPG of your Connections grid</span>
          </button>
          {clipboardSupported && (
            <button
              className="menu-card"
              style={styles.dropzone}
              onClick={pasteFromClipboard}
              disabled={running}
            >
              <span style={{ fontSize: 32, lineHeight: 1 }}>📋</span>
              <span style={styles.menuLabel}>Paste from clipboard</span>
              <span style={styles.menuDesc}>From a screenshot you copied</span>
            </button>
          )}
        </div>
      ) : (
        <div style={styles.previewWrap}>
          <img src={previewUrl} alt="Puzzle preview" style={styles.previewImg} />
          <button
            className="btn small-btn"
            style={{ ...styles.smallBtn, alignSelf: "center", marginTop: 8 }}
            onClick={() => inputRef.current?.click()}
            disabled={running}
          >
            Choose a different image
          </button>
        </div>
      )}

      {running && (
        <div style={styles.progressWrap}>
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: progress + "%" }} />
          </div>
          <p style={styles.progressLabel}>{stage} {progress > 0 && progress + "%"}</p>
        </div>
      )}

      <div style={styles.btnRow}>
        <button className="btn btn-secondary" style={styles.btnSecondary} onClick={onCancel} disabled={running}>Back</button>
        <button
          className="btn btn-primary"
          style={{ ...styles.btnPrimary, opacity: file && !running ? 1 : 0.5 }}
          onClick={runOcr}
          disabled={!file || running}
        >
          {running ? "Reading…" : "Extract Words"}
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <p style={styles.hint}>
        OCR runs entirely in your browser — no images leave your device.
      </p>
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
    justifyContent: "center",
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
  tagline: {
    fontSize: 15,
    color: "var(--text-soft)",
    margin: "10px auto 0",
    fontWeight: 500,
    lineHeight: 1.45,
    maxWidth: 380,
  },
  previewGrid: {
    display: "grid",
    gridTemplateRows: "repeat(4, 1fr)",
    gap: 6,
    width: "min(260px, 80%)",
    margin: "22px auto 0",
    padding: 10,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    boxShadow: "var(--card-shadow)",
  },
  previewRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 6,
  },
  previewTile: {
    aspectRatio: "1 / 1",
    borderRadius: 8,
  },
  howItWorks: {
    marginTop: 28,
    padding: "16px 18px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    boxShadow: "var(--card-shadow)",
  },
  howHeading: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--text-muted)",
    letterSpacing: "1px",
    textTransform: "uppercase",
    margin: 0,
  },
  howList: {
    fontSize: 14,
    color: "var(--text-soft)",
    lineHeight: 1.5,
    margin: "10px 0 0",
    paddingLeft: 22,
  },
  menuCards: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginTop: 28,
  },
  menuCard: {
    display: "flex",
    padding: "16px 18px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    cursor: "pointer",
    textAlign: "left",
    boxShadow: "var(--card-shadow)",
    fontFamily: "var(--font)",
    color: "var(--text)",
    WebkitTapHighlightColor: "transparent",
  },
  menuCardInner: {
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  menuIcon: {
    fontSize: 24,
    lineHeight: 1,
  },
  menuLabel: {
    display: "block",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--text)",
  },
  menuDesc: {
    display: "block",
    fontSize: 13,
    color: "var(--text-muted)",
    marginTop: 1,
  },
  menuCardPrimary: {
    background: "var(--primary)",
    border: "1px solid var(--primary)",
    // The auto-load default path — give it a little extra height and lift so it
    // sits above the secondary cards rather than reading as one of a flat list.
    padding: "19px 18px",
    boxShadow: "0 3px 8px rgba(40, 37, 26, 0.10), 0 12px 28px rgba(40, 37, 26, 0.14)",
  },
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginTop: -4,
  },
  chip: {
    padding: "6px 13px",
    fontSize: 12.5,
    fontWeight: 600,
    background: "var(--surface)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    cursor: "pointer",
    fontFamily: "var(--font)",
    WebkitTapHighlightColor: "transparent",
  },
  loadingWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
    marginTop: 64,
  },
  spinner: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    border: "3px solid var(--border)",
    borderTopColor: "var(--text)",
    animation: "spin 0.8s linear infinite",
  },
  loadingText: {
    fontSize: 14,
    color: "var(--text-muted)",
    margin: 0,
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
  disclaimer: {
    textAlign: "center",
    marginTop: 24,
  },
  officialLink: {
    display: "inline-block",
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--text-muted)",
    textDecoration: "none",
  },
  disclaimerText: {
    fontSize: 11.5,
    color: "var(--text-faint)",
    lineHeight: 1.45,
    margin: "8px auto 0",
    maxWidth: 320,
  },
  hint: {
    textAlign: "center",
    fontSize: 12.5,
    color: "var(--text-faint)",
    marginTop: 32,
  },
  dropzoneStack: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginTop: 16,
  },
  dropzone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    padding: "32px 18px",
    background: "var(--surface)",
    border: "2px dashed var(--border-strong)",
    borderRadius: 16,
    cursor: "pointer",
    fontFamily: "var(--font)",
    color: "var(--text)",
    boxShadow: "var(--card-shadow)",
    WebkitTapHighlightColor: "transparent",
  },
  previewWrap: {
    display: "flex",
    flexDirection: "column",
    marginTop: 16,
    padding: 12,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    boxShadow: "var(--card-shadow)",
  },
  previewImg: {
    width: "100%",
    maxHeight: 320,
    objectFit: "contain",
    borderRadius: 10,
    background: "var(--bg)",
  },
  progressWrap: {
    marginTop: 14,
  },
  progressBar: {
    width: "100%",
    height: 8,
    background: "var(--border)",
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "var(--text)",
    transition: "width 0.2s ease",
  },
  progressLabel: {
    textAlign: "center",
    fontSize: 12,
    color: "var(--text-muted)",
    marginTop: 6,
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
  boardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    paddingTop: 4,
  },
  backBtn: {
    background: "none",
    border: "none",
    fontSize: 15,
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "6px 0",
    fontFamily: "var(--font)",
    fontWeight: 600,
  },
  smallBtn: {
    padding: "7px 14px",
    fontSize: 12.5,
    fontWeight: 600,
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: 9,
    cursor: "pointer",
    fontFamily: "var(--font)",
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
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
};
