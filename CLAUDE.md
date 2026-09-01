# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # Production build → ./dist
npm run lint     # ESLint over .js/.jsx
npm test         # Vitest (run once) — the pure-module suites listed below
npm run preview  # Serve the built ./dist locally
```

Vitest covers seven pure modules — `worker/puzzle.js` (the puzzle fetch/transform + date-window logic, via an injectable `fetchImpl`), `shared/puzzleDates.js` (today-in-ET, add-days, and the 3-day window constants, shared by the Worker and the client so the two can't drift), `src/fitTileFont.js` (the tile shrink-to-fit rule — `fitTileFontSize`, fed a stub measurer, plus the tile-width-dependent cap; the canvas-and-DOM shim `fitTileFonts` around it is browser-only), `src/savedPuzzle.js` (the per-day saved-board store: schema + migration, the launch rule, day switching, adopt-on-match, and switcher entries), `src/share.js` (the "Share this site" URL and the load-time strip of its `utm_source=share` marker), `src/dragSwap.js` (the drag-to-swap rules — the press-to-drag threshold, the page-coordinate rect shift, and the hit test that says which tile a release lands on, locked rows excluded), and `src/theme.js` (the Appearance preference: parse/serialize the stored value, resolve system/light/dark against the OS, plus a drift check that `index.html`'s pre-paint script and `index.css`'s tokens use the same key and colors) — so no jsdom is needed. The App component (day switcher, overflow menu, failure states) is verified **by hand in the browser**, not under jsdom; the worker handler and the Vite dev middleware are uncovered too. Lint still runs over everything; `**/*.test.js` gets Vitest globals in `eslint.config.js`.

## Architecture

Single-page React 19 + Vite app. Two screens, both in `src/App.jsx` — the **board**, which is the home screen, and **manual word entry**, reachable only from the overflow menu or the fetch-failure state — plus an inline `styles` object. Pure, framework-free helpers are extracted so they can be unit-tested without a DOM: `src/fitTileFont.js` (tile shrink-to-fit — see below), `src/savedPuzzle.js` (the per-day saved-board store, launch decision, and switcher labels), `src/share.js` (the share link), `src/dragSwap.js` (the drag-to-swap threshold and hit test — see below), `src/theme.js` (the appearance preference), and `shared/puzzleDates.js` (the ET date math the Worker and the client both read). There is no router, no state library, no CSS framework. Board state persists to `localStorage` under `connections-puzzle`; the appearance preference under `connections-theme`.

### Theming (light/dark — the inline-styles + CSS-vars split)

The `styles` object in `App.jsx` is still inline, but **every color is a `var(--token)`**, never a literal — the only intentional hex literals are `ROW_COLORS` (the four Connections tile colors, which are the puzzle's identity and are *not* themed; their text stays dark because all four are light pastels). The tokens live in `src/index.css` under `:root`, with a `:root[data-theme="dark"]` block that re-points the same variables — there is deliberately **no `prefers-color-scheme` media query in the stylesheet**. `<html data-theme>` always holds the *resolved* scheme: a pre-paint inline script in `index.html` stamps it from the saved Appearance preference (`localStorage` key `connections-theme`, `light` or `dark`; absent = follow the OS) or, failing that, from `matchMedia`, so the first frame is already the right color; `useTheme` in `App.jsx` then owns it — re-stamping on a preference change and, while following the system, on OS flips — and keeps the single `theme-color` meta in step. The rules (`parseThemePreference`, `resolveTheme`, `THEME_COLORS`) live in `src/theme.js`; because the pre-paint script has to inline them, `theme.test.js` also checks that `index.html` and `index.css` agree with the module on the key and the two background colors. The control itself is the System / Light / Dark row in the overflow sheet (`.sheet-row`, reusing `.segs`/`.seg`). So dark mode still needs no per-component state — flipping one attribute flips the whole UI. Inline styles can't do `:hover`/`:focus-visible`/`@media`/keyframes or modifier classes, so those (tile hover lifts, the shared focus ring, the `tileIn` staggered board reveal, `lockPop`, `spin`, `sheetIn`, `prefers-reduced-motion`) live in `index.css` and attach via `className` — and three pieces are styled *entirely* there because their layout depends on exactly those things: the day switcher (`.segs`/`.seg`, with a dense modifier for the fourth segment and a narrow-viewport media query), the overflow/how-this-works `<dialog>` (`.sheet`, a bottom sheet under 600px and a centered card above, plus `::backdrop`), and the compact header buttons (`.small-btn`/`.icon-btn`, which the same media query shrinks). When adding UI: use a token (add light+dark values if it's a new one), not a hex; add a `className` for any hover/focus/animation/media query. `index.html` carries a single JS-managed `theme-color` meta and paints the page background pre-hydration (keyed on the same `data-theme`) to avoid a flash.

Type is **self-hosted Libre Franklin** (the open Franklin Gothic NYT itself uses) via `@fontsource-variable/libre-franklin`, imported in `main.jsx` and bundled by Vite — no Google Fonts request (keeps the privacy-forward, own-origin posture). Don't switch it to a CDN `<link>`; the `--font` token already lists the fallback stack. The latin subset is **preloaded** by the `preloadTileFont` plugin in `vite.config.js`, which injects `<link rel="preload" as="font" crossorigin>` for the hashed woff2 at build time (and the node_modules path in dev) — a tag in `index.html` can't know the hash. Latin-ext stays lazy behind its `unicode-range`. Chrome logs a "preloaded but not used" warning on *repeat* visits when the font comes from cache; it's Chrome's accounting, not a double download (verified: one request per navigation either way).

### Tile text sizing (`src/fitTileFont.js`)

Tile words never break mid-string (matching the official app): multi-word entries wrap at spaces, a single word that's too wide shrinks. The sizing is **arithmetic on a canvas, not a DOM loop**: `fitTileFonts(tiles)` reads every tile's geometry first, measures the words on one shared 2D context in the tile's own computed font (weight, family, letter-spacing, uppercase — canvas and DOM widths agree to 0.05px), and writes each tile's `fontSize` once — so a pass forces at most one layout, and none when it runs after layout. Don't reintroduce a write-then-read loop; the old one forced 192 layouts per pass. The wrap simulation is greedy at spaces only (the browser can also break after a hyphen; not modelling that only errs small). The cap is `tileFontCap(tileWidth)`: 14px on a phone, growing at 0.16× the tile's width on the half-pixel grid up to 20px, so a 500px desktop board gets 18px tiles — a 390px phone stays at exactly 14. The floor is 8px, as before, and the 4px overhang tolerance is calibrated to what the old `scrollWidth` rule accepted (see the comment on `TOLERANCE`). `App.jsx` runs a pass in `useLayoutEffect` (pre-paint), again when `document.fonts.load()` resolves for the board's words (so a fallback-measured fit is corrected — and *not* re-fitted when the font fails, because the fallback is then what's on screen), and from a **`ResizeObserver` on the grid** rather than the `resize` event: it fires only when the tiles' box changes, once per frame, after layout, so no throttle is needed.

### Swapping tiles (tap and drag — `src/dragSwap.js`)

Two tiles trade places by tap-tap or by drag, and both go through the single `commitSwap(a, b, key)` in `App.jsx` — so both take the same same-day guard (a swap belongs to the board it was started on; the tap path waits out its 200ms animation first, by which time the player may have switched days). A locked row is settled: its tiles can't be tapped, dragged, or dropped onto (`isTileInPlay`), and `dropTargetIndex` re-checks *both* ends at release, so a drag whose source row was locked under it (the lock button is reachable while a tile is held: keyboard Space, a second finger) cancels with no swap, as handleTap does for a picked-up tile.

The drag is **Pointer Events, never HTML5 drag-and-drop** (which never fires for a finger). Things that are easy to break:

- **`setPointerCapture` happens on `pointerdown`, not at the threshold.** Between the press and the 7px threshold the pointer can already have left the tile, and an uncaptured move over a sibling never comes back to the source tile's handler.
- **A press ends when the grid it was measured against goes away, and nothing tells the handlers.** The grid is keyed on `activeKey` and unmounts on the manual-entry screen; when a fetch lands mid-drag the capturing tile is removed, its `pointerup` goes with it, and **no `pointercancel` fires for a removed capture**. The `useLayoutEffect` on `[activeKey, screen]` clears `dragRef` and `drag` itself; `commitSwap`'s same-day guard only protects the store write (the press carries `key`, the board it started on, so the drag path takes that guard the way the tap path does).
- **First pointer wins, and an orphaned press self-heals.** `handleTilePointerDown` refuses a press from a *different* pointer while one is live, so a second finger or a resting palm can't replace `dragRef` and strand the first tile mid-air. That is all it guarantees: the refused contact's `pointerdown` returns before setting anything, so nothing here suppresses a click for it — Chrome and Safari don't synthesize a tap for a contact that lands while another is down, which is browser behaviour, not this code's. A press from the *same* pointer id takes over, because one pointer can't go down twice without an up, so its earlier press must be an orphan. Multi-tile drags are out of scope.
- **`window` blur is a required cancel signal, not a redundant one.** A mouse drag interrupted by Alt-Tab or a system dialog is released in another app, and no `pointerup`/`pointercancel` ever reaches the tile. Without the blur listener that press stays live: every later drag refused, the tile left floating, and — a mouse's pointer id never changes — the next plain click's `pointerup` matches the stale press and replays it as a swap against the old rects. `cancelPress` is where both cancels end up, but the tile's `pointercancel` reaches it only through the pointer-id guard (`handleTilePointerCancel`) — a refused second contact can still cancel on the tile it landed on, and that must not end the first pointer's press — while blur invokes it unconditionally, having no pointer event to compare against; `lostpointercapture` is deliberately *not* wired, because a touch landing on the word span inside the button can move capture from span to button at `pointerdown`, and whether that fires a spurious `lostpointercapture` was not verifiable on real touch hardware.
- **Capture retargets the trailing `click` to the source tile, so a completed drag must swallow it** — `suppressClickRef`, cleared on a `setTimeout(0)` rather than consumed by the next click, because a keyboard Enter fires a click with no pointer events and would otherwise eat the flag.
- **Below `DRAG_THRESHOLD_PX` a press is still a tap** — that's what keeps tap-to-swap, the `:active` scale and the hover lift exactly as they were.
- **Tile rects are measured once, on the frame the drag starts,** in *page* coordinates (`toPageRect`): nothing moves during a drag (the carried tile rides on a transform, so no layout and no `ResizeObserver` pass), and page coordinates survive a scroll partway through. Don't re-measure per move — that buys a forced layout a frame.
- **`.tile:not([aria-disabled="true"]) { touch-action: none; }`** in `index.css`. A drag has to win over the browser's pan gesture and there's no taking a pan back once it starts, so panning is declined up front on exactly the tiles that can be dragged; the board is sized to fit the viewport and locked rows still pan.
- **A completed drag beats a pending tap**: the drag commits and then clears `selected`, because a tile picked up earlier by tap is a stale pick-up once the board under it has moved. A *cancelled* drag (off the board, back on the source, onto a locked tile) changes nothing at all — no swap, no selection change.
- **`aria-pressed` stays the tap state.** A drag is a gesture in flight, not a toggle; the carried tile borrows the selected *look* (same tokens) but must not claim to be pressed.
- **Lifting the carried tile takes a z-index on the CELL** (`.reveal:has(.tile-dragging)`), not just on the tile. `.reveal`'s entrance animates opacity and transform with a `both` fill, so every cell keeps a stacking context of its own for good, and a z-index inside one only sorts against that cell.
- **The carried tile's 1.04 and the drop target's 1.06 + 3px ring are a matched pair.** Grab a tile by its centre and it lands exactly over the target, so the ring reads only while the target's ringed box stays wider than the tile on top of it (5.4px past a resting edge — a clear halo, still inside the 6px grid gap). The carried tile is ringed in `--selected-text`, the *contrasting* token, for the same reason: ringed in `--selected-ring` like the target, the two merge into one dark blob.

### Accessibility contracts

The board is operated by keyboard and screen reader as much as by touch, and the fixes from the 2026-08-31 audit (#10, #11) are easy to undo by accident:

- **Never call `scrollIntoView()` on mount or on a day switch.** Chrome moves its sequential-focus starting point to the scrolled element, so the first Tab of a fresh load would land *after* Today. The switcher nudges `scrollLeft` instead (the `activeKey` effect in `App.jsx`).
- **One live region speaks for a day switch**: the always-mounted `.sr-only` `role="status"` `<p>` in the board view alternates `Loading …` / the failure message. The visible notice bar is deliberately *not* a live region (it arrives pre-populated, which isn't announced), and the hint `<p>` is always rendered (empty without a board) for the same reason — a live region has to exist before its text changes.
- **Toggles expose state, not glyphs**: tiles and lock buttons carry `aria-pressed`; the ○ / ✓ / ↑ glyphs sit in `aria-hidden` spans. Tiles in a locked row are `aria-disabled` (still focusable so the words stay readable), not `disabled`; `.tile[aria-disabled="true"]` in `index.css` owns their cursor and suppresses the hover lift.
- **`--text-faint` is decoration and disabled states only** (it's below 4.5:1); running text, hints, placeholders and the footer use `--text-muted`. Never put an inline `outline: none` on a field — the shared `:focus-visible` ring in `index.css` is the only focus treatment, and an inline value would beat it.
- **Reduced motion is opted out per animation, never with a blanket `*` kill** (#12). The two spinners (`.seg-spin` and the inline `styles.spinner`) deliberately keep turning under `prefers-reduced-motion: reduce`: with a board on screen the segment spinner is the only sign a fetch is in flight, and a small rotating ring is not vestibular-trigger motion. The entrances and `lockPop` (the `.tile-pop` class, toggled by `flashing`) get `animation: none`. Every `transition` lives in `index.css` — never inline — so the media block can reach it; the old blanket rule hid the fact that inline transitions can't be opted out.
- **Target-size floors are explicit `min-height`s, not padding**: `.seg` 30 px, `.small-btn` 36 px (the day-switcher pill's height, so the header reads as one row at every width), `.ghost-btn` 32 × 32, `lockBtn`/`labelInput` 30 inline. The 320 px header budget noted in `.segs` is a *width* constraint — height is free there, width is not. Safe-area insets (`env(safe-area-inset-*)`) and the `100dvh` min-height live on `#root`, never on the centered container (which would trade board width for the inset in landscape on a notched phone), plus `.sheet-close` in the bottom-sheet variant only.

### Landing, day switcher, and the per-day store

The board is the home screen — there is no menu. The header carries a segmented switcher for today plus the two prior days (`RECENT_WINDOW_DAYS = 2` in `shared/puzzleDates.js`, enforced server-side too, so a hand-crafted `?date=` can't reach further back than the switcher offers); everything rarely needed sits behind one overflow button, in this order: the Appearance row (a control strip, so it leads rather than sitting among the list rows), manual entry, "how this works", "share this site", the official-game link (same "Play the official game" label as the footer), and Reset — last, in its own group behind a `.sheet-gap` band, because it's destructive and has no confirm step. Opening the sheet moves focus to the first *list* item, not the first focusable (the System segment), so Enter on open can't change a setting. Share uses the native share sheet where `navigator.share` exists and the clipboard elsewhere; the shared URL carries `?utm_source=share`, which `main.jsx` strips with `replaceState` before the first render. Tapping a day whose board is saved switches instantly with no network; a day with no saved board fetches in place, leaving the current board on screen until the words arrive.

The store under `connections-puzzle` is v2 — one board per day rather than a slot pair:

```js
{ version: 2, boards: { [dateISO | 'custom']: board }, active, activeDate }
```

`activeDate` is the ET date the active board was *activated*, deliberately not when it was last touched, which collapses the launch rule to one sentence: **same ET day as the last activation → resume; otherwise open Today** (so a returning user always lands on Today, with the old board still reachable under its own day). Boards outside the window are pruned on parse, and the older two-slot and flat saves migrate once (dated boards to their dates, anything else to `custom`). Adopt-on-match promotes a custom board whose words are set-equal to a freshly fetched day's into that day's board, so words typed by hand during an outage keep their progress. All of this lives in `src/savedPuzzle.js` (pure, tested); `App.jsx` is just the wiring layer.

### Daily words (the Cloudflare Worker proxy)

`src/App.jsx` auto-loads the current day's puzzle on launch by fetching `GET /api/puzzle` (optionally `?date=YYYY-MM-DD`, accepted only for today and the two prior days — the same window the switcher offers). The endpoint exists because NYT's puzzle JSON sends no CORS header, so the browser can't read it directly:

- **Production**: `worker/index.js` is the Worker entry. `wrangler.jsonc` sets `run_worker_first: ["/api/*"]` so the handler — not the SPA asset fallback — sees the request. It fetches NYT server-side, strips the answer groupings down to the 16 words, and edge-caches the transformed result per date.
- **Dev**: `vite.config.js`'s `devPuzzleApi` middleware serves the same `/api/puzzle` route during `npm run dev` using the *same* `worker/puzzle.js` functions, so the flow works locally without `wrangler dev`.
- `worker/puzzle.js` owns the fetch/transform + date-resolution logic (`fetchPuzzleWords`, `resolvePuzzleDate`, `PuzzleError`), reading the window and ET date math from `shared/puzzleDates.js`; both are under Vitest.

Keep the answer groupings out of the response: the app is a word *loader*, not a solver.

## Deployment

Hosted on Cloudflare Workers + Static Assets (see `wrangler.jsonc`). `not_found_handling: "single-page-application"` means unknown paths fall back to `index.html`. The deployed asset set is whatever ends up in `./dist`.

Deploys happen through Cloudflare's GitHub integration on push to `main` — there is no local wrangler credential on this machine, so `npx wrangler deploy` fails without `CLOUDFLARE_API_TOKEN`. To ship: commit and `git push`; Cloudflare builds and deploys automatically.

`npm run build` runs Vite 8 with its default `baseline-widely-available` target and no `browserslist`, so Lightning CSS rewrites `max-width`/`min-width` queries to range syntax (`(width<=380px)`) and drops a `vh` line that precedes `dvh`. That's expected, not a regression; if the support floor ever has to reach older Safari, set `build.cssTarget` in `vite.config.js` rather than hand-editing the output.

## Agent skills

### Issue tracker

GitHub Issues on this repo, accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, plus `prd`, `bug`, `enhancement`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

### AFK loop

Installed at `ralph/`. Run `./ralph/afk.sh <N>` to loop on `ready-for-agent` tickets, or `./ralph/once.sh` for a single iteration. Worktree-isolated on the `ralph` branch.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var


## Issue tracking

Work is tracked as **GitHub Issues** on `bigintersmind/connections-sorter`, driven through the `gh` CLI. `docs/agents/issue-tracker.md` has the conventions the skills follow and `docs/agents/triage-labels.md` the label vocabulary (`needs-triage` → `ready-for-agent` / `ready-for-human` → closed).

### Quick Reference

```bash
gh issue list --label ready-for-agent   # Find available agent work
gh issue view <n> --comments            # View an issue and its agent brief
gh issue comment <n> --body "..."       # Post a note
gh issue close <n> --comment "..."      # Complete work
```

### Rules

- Use GitHub Issues for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Durable project knowledge belongs in this file, not in a per-machine memory store — it's checked in, so every session and AFK worktree sees it
- Tickets before 2026-08-30 lived in bd (beads); commit messages prefixed `connections-xxx:` refer to those IDs. The archive is in git history: `git show bdac894:.beads/issues.jsonl`

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
