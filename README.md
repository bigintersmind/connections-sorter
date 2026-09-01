# Connections Sorter

A scratchpad for working through the [NYT Connections](https://www.nytimes.com/games/connections) puzzle. Live at [connections-sorter.com](https://connections-sorter.com).

The official game lets you guess but not rearrange. Connections Sorter gives you a 4×4 board you can shuffle, group, and lock in candidate categories — useful if you're the kind of solver who loses track of which tiles you'd grouped together once you start moving them around in your head.

It does **not** check answers, save scores, or replay the official game. Bring your guesses back to NYT to actually submit them.

## Use it

The app opens straight onto today's puzzle — the words load automatically, no setup. A switcher in the board header offers Today, Yesterday, and the day before; each day keeps its own progress, so switching between them is one tap and never costs you anything.

On the board:

- Tap two tiles to swap them
- Tap a colored row label to lock it in once you're confident in that grouping
- Optionally type a category guess into each row's label field
- Shuffle randomizes any unlocked rows

Behind the overflow button (⋯) in the header:

- **Appearance** — System / Light / Dark, remembered on this device
- **Enter words manually** — type or paste the 16 words yourself, one per line or comma-separated (the fallback if the day's words can't be fetched)
- **How this works** — a short explainer
- **Share this site** — sends a link through your device's share sheet, or copies it
- **Play the official game** — a link back to NYT
- **Reset board** — clears your locks and labels for the day you're on

Each day's board persists to `localStorage` separately, so you can close the tab and pick up where you left off.

## Privacy

Nothing you do on the board leaves your device. The only network request is to this app's own `/api/puzzle` proxy, which fetches the day's puzzle from NYT server-side and returns just the 16 words — never the answer groupings. No signup, no accounts, no tracking scripts.

## Development

```bash
npm install
npm run dev          # local dev at http://localhost:5173
npm run dev -- --host # also expose on the LAN for phone testing
npm run build        # production build into ./dist
npm run lint
```

Stack: React 19 + Vite 8, inline styles backed by CSS custom-property tokens (light/dark), and a Cloudflare Worker proxy for the daily words.

## License

[MIT](./LICENSE)
