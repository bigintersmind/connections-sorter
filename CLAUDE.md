# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server at http://localhost:5173 (predev mirrors Tesseract assets)
npm run build    # Production build → ./dist (prebuild mirrors Tesseract assets)
npm run lint     # ESLint over .js/.jsx
npm test         # Vitest (run once) — the pure-module suites listed below
npm run preview  # Serve the built ./dist locally
```

Vitest covers three pure modules — `worker/puzzle.js` (the puzzle fetch/transform + date-window logic, via an injectable `fetchImpl`), `src/fitTileFont.js` (the tile shrink-to-fit loop, fed stub elements), and `src/savedPuzzle.js` (the persisted-board schema, launch decision, swap/stamp mechanics, and date labels) — so no jsdom is needed. The worker handler, the Vite dev middleware, and `src/App.jsx`'s async load logic are **not** yet covered. Lint still runs over everything; `**/*.test.js` gets Vitest globals in `eslint.config.js`.

## Architecture

Single-page React 19 + Vite app. Most logic lives in `src/App.jsx` — the root component, the upload screen, the OCR pipeline, and an inline `styles` object. Pure, framework-free helpers are extracted so they can be unit-tested without a DOM: `src/clipboardImage.js` (clipboard/paste MIME policy), `src/fitTileFont.js` (tile shrink-to-fit), and `src/savedPuzzle.js` (the saved-board store, launch decision, and date labels). There is no router, no state library, no CSS framework. State persists to `localStorage` under `connections-puzzle`.

### Theming (light/dark — the inline-styles + CSS-vars split)

The `styles` object in `App.jsx` is still inline, but **every color is a `var(--token)`**, never a literal — the only intentional hex literals are `ROW_COLORS` (the four Connections tile colors, which are the puzzle's identity and are *not* themed; their text stays dark because all four are light pastels). The tokens live in `src/index.css` under `:root`, with a `@media (prefers-color-scheme: dark)` block that re-points the same variables. So **dark mode is automatic and has no React state** — the OS scheme flips the CSS vars and the whole UI follows. Inline styles can't do `:hover`/`:focus-visible`/`@media`/keyframes, so those (card/tile hover lifts, the shared focus ring, the `tileIn` staggered board reveal, `lockPop`, `spin`, `prefers-reduced-motion`) live in `index.css` and attach via `className`. When adding UI: use a token (add light+dark values if it's a new one), not a hex; add a `className` for any hover/focus/animation. `index.html` carries the light/dark `theme-color` metas and paints the page background pre-hydration to avoid a flash.

Type is **self-hosted Libre Franklin** (the open Franklin Gothic NYT itself uses) via `@fontsource-variable/libre-franklin`, imported in `main.jsx` and bundled by Vite — no Google Fonts request (keeps the privacy-forward, own-origin posture). Don't switch it to a CDN `<link>`; the `--font` token already lists the fallback stack.

### OCR pipeline (the non-obvious part)

When a user uploads a screenshot, `UploadScreen.runOcr` lazy-imports `tesseract.js` (so it isn't in the initial bundle) and runs a multi-stage extraction:

1. **Recognize with bboxes**: Tesseract is configured with a letter+punctuation whitelist (no digits) and `oem=1` (LSTM-only). It returns both flat text and a nested `blocks → paragraphs → lines → words` tree, each word carrying a bbox.
2. **Filter chrome by case**: `isAllCapsLetters` drops UI text ("Create four groups of four!", "Mistakes Remaining: 3") because Connections tile text is rendered ALL CAPS while chrome is title/sentence case.
3. **Reconstruct the 4×4 grid**: `kmeans1d` clusters word y-centers into 4 rows, then x-centers within each row into 4 columns. `reconstructTilesFromBboxes` returns 16 strings (some may be empty) when at least 8 cells are populated.
4. **Fallback**: If bbox reconstruction fails confidence checks, `extractWordsFromOcr` dumps deduped uppercase lines from the raw text — alignment is lost but the user can clean it up on the manual entry screen.

If you change OCR behavior, remember the contract: output is always 16 lines (or fewer for the user to fix manually), uppercase, normalized via `normalizeTileText` (allows `A-Za-z'-.& `).

### Tesseract self-hosting (do not regress this)

Tesseract.js by default fetches `worker.min.js`, the core WASM, and `eng.traineddata.gz` from jsDelivr/tessdata at runtime. In production this failed with opaque `NetworkError` inside the blob worker. The fix:

- `scripts/copy-tesseract-assets.mjs` runs as `predev`/`prebuild` and mirrors all required assets into `public/tesseract/`. It only copies the LSTM variants (because we use `oem=1`) and downloads the language data once.
- `App.jsx` passes `workerPath`, `corePath`, and `langPath` pointing at `/tesseract/...` so everything is served from our own origin.

Don't remove the predev/prebuild scripts, don't switch to CDN paths, and don't add legacy (non-LSTM) core variants — they'd be dead weight.

### Daily words (the Cloudflare Worker proxy)

`src/App.jsx` auto-loads the current day's puzzle on launch by fetching `GET /api/puzzle` (optionally `?date=YYYY-MM-DD`). The endpoint exists because NYT's puzzle JSON sends no CORS header, so the browser can't read it directly:

- **Production**: `worker/index.js` is the Worker entry. `wrangler.jsonc` sets `run_worker_first: ["/api/*"]` so the handler — not the SPA asset fallback — sees the request. It fetches NYT server-side, strips the answer groupings down to the 16 words, and edge-caches the transformed result per date.
- **Dev**: `vite.config.js`'s `devPuzzleApi` middleware serves the same `/api/puzzle` route during `npm run dev` using the *same* `worker/puzzle.js` functions, so the flow works locally without `wrangler dev`.
- `worker/puzzle.js` owns the fetch/transform + date-window logic (`fetchPuzzleWords`, `resolvePuzzleDate`, `PuzzleError`) and is the part under Vitest.

Keep the answer groupings out of the response: the app is a word *loader*, not a solver.

## Deployment

Hosted on Cloudflare Workers + Static Assets (see `wrangler.jsonc`). `not_found_handling: "single-page-application"` means unknown paths fall back to `index.html`. The deployed asset set is whatever ends up in `./dist`, which includes `public/tesseract/*` after the build.

## Agent skills

### Issue tracker

bd (beads), accessed via the `bd` CLI. See `docs/agents/issue-tracker.md`.

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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
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
<!-- END BEADS INTEGRATION -->
