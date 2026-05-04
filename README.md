# Connections Sorter

A scratchpad for working through the [NYT Connections](https://www.nytimes.com/games/connections) puzzle. Live at [connections-sorter.com](https://connections-sorter.com).

The official game lets you guess but not rearrange. Connections Sorter gives you a 4×4 board you can shuffle, group, and lock in candidate categories — useful if you're the kind of solver who loses track of which tiles you'd grouped together once you start moving them around in your head.

It does **not** check answers, save scores, or replay the official game. Bring your guesses back to NYT to actually submit them.

## Use it

Two ways to load a puzzle:

- **Upload a screenshot** — drop in an image of the puzzle and Tesseract.js OCR (running entirely in your browser) extracts the 16 tile words. Edit the result if anything looks off, then load the board.
- **Type or paste 16 words** — one per line, or comma-separated. Useful if you have the words from somewhere other than a screenshot.

On the board:

- Tap two tiles to swap them
- Tap a colored row label to lock it in once you're confident in that grouping
- Optionally type a category guess into each row's label field
- Reset clears your locks and labels; Shuffle randomizes any unlocked rows

State persists to `localStorage`, so you can close the tab and pick up where you left off.

## Privacy

OCR runs in the browser — your screenshots never leave your device. The first OCR run downloads ~10MB of language data from the Tesseract CDN; subsequent runs are cached.

## Development

```bash
npm install
npm run dev          # local dev at http://localhost:5173
npm run dev -- --host # also expose on the LAN for phone testing
npm run build        # production build into ./dist
npm run lint
```

Stack: React 19 + Vite 8, inline styles, [tesseract.js](https://github.com/naptha/tesseract.js) for OCR (lazy-loaded so it only ships if used).

## License

[MIT](./LICENSE)
