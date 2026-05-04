#!/usr/bin/env node
// Mirrors Tesseract.js runtime assets into public/tesseract/ so the deployed
// site serves them from its own origin instead of fetching from a CDN.
import { copyFile, mkdir } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "tesseract");
const coreSrc = join(root, "node_modules", "tesseract.js-core");
const workerSrc = join(root, "node_modules", "tesseract.js", "dist", "worker.min.js");
const langUrl = "https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz";

// Only the LSTM variants — App.jsx calls createWorker with oem=1 (LSTM-only),
// so legacy variants would never be loaded.
const coreFiles = [
  "tesseract-core-lstm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-simd-lstm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
];

await mkdir(dest, { recursive: true });
await copyFile(workerSrc, join(dest, "worker.min.js"));
for (const f of coreFiles) {
  await copyFile(join(coreSrc, f), join(dest, f));
}

const langDest = join(dest, "eng.traineddata.gz");
if (!existsSync(langDest)) {
  console.log(`Downloading ${langUrl}…`);
  const res = await fetch(langUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download lang data: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(langDest));
}

console.log(`Tesseract assets ready in ${dest}`);
