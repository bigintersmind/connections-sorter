import { useState, useCallback, useEffect, useRef } from "react";
import {
  CLIPBOARD_ERROR_MESSAGES,
  extractClipboardImage,
  hasClipboardReadSupport,
} from "./clipboardImage.js";

const ROW_COLORS = [
  { name: "Yellow", bg: "#f9df6d", text: "#1a1a1a", glow: "rgba(249,223,109,0.6)" },
  { name: "Green", bg: "#a0c35a", text: "#1a1a1a", glow: "rgba(160,195,90,0.6)" },
  { name: "Blue", bg: "#b0c4ef", text: "#1a1a1a", glow: "rgba(176,196,239,0.6)" },
  { name: "Purple", bg: "#ba81c5", text: "#1a1a1a", glow: "rgba(186,129,197,0.6)" },
];

const STORAGE_KEY = "connections-puzzle";

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
  const [screen, setScreen] = useState(saved ? "board" : "menu");
  const [tiles, setTiles] = useState(saved?.tiles ?? []);
  const [selected, setSelected] = useState(null);
  const [lockedRows, setLockedRows] = useState(saved?.lockedRows ?? [false, false, false, false]);
  const [flashRow, setFlashRow] = useState(null);
  const [labels, setLabels] = useState(saved?.labels ?? ["", "", "", ""]);
  const [manualText, setManualText] = useState("");
  const [error, setError] = useState(null);
  const [swapAnim, setSwapAnim] = useState(null);

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

  if (screen === "menu") {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.colorDots}>
            {ROW_COLORS.map((c, i) => (
              <span key={i} style={{ ...styles.dot, background: c.bg }} />
            ))}
          </div>
          <h1 style={styles.title}>Connections Sorter</h1>
          <p style={styles.subtitle}>A Connections companion</p>
        </div>

        <div style={styles.menuCards}>
          <button style={styles.menuCard} onClick={() => setScreen("upload")}>
            <div style={styles.menuCardInner}>
              <span style={styles.menuIcon}>📷</span>
              <div>
                <span style={styles.menuLabel}>Upload Screenshot</span>
                <span style={styles.menuDesc}>Read words from a puzzle image</span>
              </div>
            </div>
          </button>
          <button style={styles.menuCard} onClick={() => setScreen("manual")}>
            <div style={styles.menuCardInner}>
              <span style={styles.menuIcon}>✏️</span>
              <div>
                <span style={styles.menuLabel}>Enter Words</span>
                <span style={styles.menuDesc}>Type or paste 16 words</span>
              </div>
            </div>
          </button>
        </div>

        <p style={styles.hint}>
          Tap two tiles to swap • Lock rows when confident
        </p>
      </div>
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
          <button style={styles.btnSecondary} onClick={() => { setScreen("menu"); setError(null); }}>Back</button>
          <button style={styles.btnPrimary} onClick={() => {
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
        <button style={styles.backBtn} onClick={() => setScreen("menu")}>← Menu</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.smallBtn} onClick={shuffleUnlocked}>Shuffle</button>
          <button style={styles.smallBtn} onClick={resetBoard}>Reset</button>
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
                  style={{
                    ...styles.lockBtn,
                    background: locked ? color.bg : "transparent",
                    color: locked ? color.text : "#999",
                    borderColor: locked ? color.bg : "#d5d5cc",
                    fontWeight: locked ? 800 : 600,
                  }}
                  onClick={() => toggleLock(rowIdx)}
                >
                  {locked ? "✓ " + color.name : "○ " + color.name}
                </button>
                <input
                  style={{
                    ...styles.labelInput,
                    borderColor: locked ? `${color.bg}88` : "#e5e5dd",
                    background: locked ? `${color.bg}18` : "#fff",
                  }}
                  placeholder="Category label..."
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
                  const fontSize = word.length > 12 ? 10.5 : word.length > 8 ? 12 : 13.5;

                  return (
                    <button
                      key={idx}
                      onClick={() => handleTap(idx)}
                      style={{
                        ...styles.tile,
                        background: locked
                          ? color.bg
                          : isSelected ? "#2a2a2a" : "#efefe6",
                        color: locked
                          ? color.text
                          : isSelected ? "#fff" : "#1a1a1a",
                        fontSize,
                        transform: isSelected ? "scale(0.94)" : isSwapping ? "scale(0.88)" : "scale(1)",
                        boxShadow: flashing
                          ? `0 0 24px ${color.glow}, 0 0 48px ${color.glow}`
                          : isSelected
                          ? "0 0 0 2.5px #2a2a2a, 0 4px 14px rgba(0,0,0,0.25)"
                          : locked
                          ? `0 1px 4px ${color.glow}`
                          : "0 1px 3px rgba(0,0,0,0.06)",
                        animation: flashing ? "flashPulse 0.3s ease-in-out 2" : "none",
                      }}
                    >
                      {word}
                    </button>
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

      <style>{`
        @keyframes flashPulse {
          0% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.04); filter: brightness(1.15); }
          100% { transform: scale(1); filter: brightness(1); }
        }
      `}</style>
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
    } catch {
      setError(CLIPBOARD_ERROR_MESSAGES.error);
    }
  };

  // Desktop Cmd/Ctrl+V path. iOS Safari only fires `paste` inside editable
  // elements, so this listener is effectively desktop-only — that's expected.
  useEffect(() => {
    const handlePaste = async (event) => {
      if (running) return;
      try {
        const result = await extractClipboardImage(event.clipboardData?.items);
        if (result.kind === "ok") {
          pickFile(result.blob);
        } else {
          setError(CLIPBOARD_ERROR_MESSAGES[result.kind]);
        }
      } catch {
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
            style={styles.dropzone}
            onClick={() => inputRef.current?.click()}
          >
            <span style={{ fontSize: 32 }}>📷</span>
            <span style={styles.menuLabel}>Choose an image</span>
            <span style={styles.menuDesc}>PNG or JPG of your Connections grid</span>
          </button>
          {clipboardSupported && (
            <button
              style={styles.dropzone}
              onClick={pasteFromClipboard}
              disabled={running}
            >
              <span style={{ fontSize: 32 }}>📋</span>
              <span style={styles.menuLabel}>Paste from clipboard</span>
              <span style={styles.menuDesc}>From a screenshot you copied</span>
            </button>
          )}
        </div>
      ) : (
        <div style={styles.previewWrap}>
          <img src={previewUrl} alt="Puzzle preview" style={styles.previewImg} />
          <button
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
        <button style={styles.btnSecondary} onClick={onCancel} disabled={running}>Back</button>
        <button
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
    background: "#fafaf5",
    fontFamily: "'Franklin Gothic Medium', 'DIN Condensed', 'Helvetica Neue', sans-serif",
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
    fontSize: 26,
    fontWeight: 800,
    color: "#1a1a1a",
    margin: 0,
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: 13.5,
    color: "#999",
    marginTop: 4,
    fontWeight: 400,
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
    background: "#fff",
    border: "1.5px solid #e5e5dd",
    borderRadius: 14,
    cursor: "pointer",
    textAlign: "left",
    transition: "all 0.15s",
    WebkitTapHighlightColor: "transparent",
  },
  menuCardInner: {
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  menuIcon: {
    fontSize: 24,
  },
  menuLabel: {
    display: "block",
    fontSize: 16,
    fontWeight: 700,
    color: "#1a1a1a",
  },
  menuDesc: {
    display: "block",
    fontSize: 13,
    color: "#999",
    marginTop: 1,
  },
  hint: {
    textAlign: "center",
    fontSize: 12.5,
    color: "#bbb",
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
    background: "#fff",
    border: "2px dashed #d5d5cc",
    borderRadius: 14,
    cursor: "pointer",
    fontFamily: "inherit",
    WebkitTapHighlightColor: "transparent",
  },
  previewWrap: {
    display: "flex",
    flexDirection: "column",
    marginTop: 16,
    padding: 12,
    background: "#fff",
    border: "1.5px solid #e5e5dd",
    borderRadius: 14,
  },
  previewImg: {
    width: "100%",
    maxHeight: 320,
    objectFit: "contain",
    borderRadius: 8,
    background: "#f5f5ee",
  },
  progressWrap: {
    marginTop: 14,
  },
  progressBar: {
    width: "100%",
    height: 8,
    background: "#eee9d8",
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "#1a1a1a",
    transition: "width 0.2s ease",
  },
  progressLabel: {
    textAlign: "center",
    fontSize: 12,
    color: "#777",
    marginTop: 6,
  },
  error: {
    color: "#c44",
    fontSize: 13,
    textAlign: "center",
    marginTop: 10,
    padding: "6px 10px",
    background: "#fff5f5",
    borderRadius: 8,
  },
  textarea: {
    width: "100%",
    padding: 14,
    fontSize: 14,
    fontFamily: "inherit",
    border: "1.5px solid #ddd",
    borderRadius: 12,
    background: "#fff",
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
    background: "#1a1a1a",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  btnSecondary: {
    flex: 1,
    padding: "13px 20px",
    fontSize: 15,
    fontWeight: 600,
    background: "#fff",
    color: "#1a1a1a",
    border: "1.5px solid #ddd",
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  boardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  backBtn: {
    background: "none",
    border: "none",
    fontSize: 15,
    color: "#555",
    cursor: "pointer",
    padding: "6px 0",
    fontFamily: "inherit",
  },
  smallBtn: {
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    background: "#fff",
    color: "#1a1a1a",
    border: "1.5px solid #ddd",
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  rowControl: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
    marginTop: 8,
  },
  lockBtn: {
    fontSize: 11,
    padding: "3px 9px",
    borderRadius: 6,
    border: "1.5px solid",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
    transition: "all 0.2s",
  },
  labelInput: {
    flex: 1,
    fontSize: 12,
    padding: "3px 8px",
    border: "1px solid",
    borderRadius: 6,
    outline: "none",
    fontFamily: "inherit",
    color: "#555",
    transition: "all 0.2s",
  },
  tileRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 5,
  },
  tile: {
    aspectRatio: "1",
    border: "none",
    borderRadius: 9,
    cursor: "pointer",
    fontWeight: 700,
    fontFamily: "'Franklin Gothic Medium', 'DIN Condensed', 'Helvetica Neue', sans-serif",
    textTransform: "uppercase",
    letterSpacing: "0.2px",
    lineHeight: 1.15,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "5px 3px",
    transition: "transform 0.15s, background 0.2s, box-shadow 0.3s",
    WebkitTapHighlightColor: "transparent",
    wordBreak: "break-word",
  },
  boardHint: {
    textAlign: "center",
    fontSize: 12,
    color: "#bbb",
    marginTop: 14,
  },
};
