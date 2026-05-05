# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server at http://localhost:5173 (predev mirrors Tesseract assets)
npm run build    # Production build → ./dist (prebuild mirrors Tesseract assets)
npm run lint     # ESLint over .js/.jsx
npm run preview  # Serve the built ./dist locally
```

There is no test runner configured. Lint is the only automated check.

## Architecture

Single-page React 19 + Vite app. Almost all logic lives in `src/App.jsx` — the file contains the root component, the upload screen, the OCR pipeline, and an inline `styles` object. There is no router, no state library, no CSS framework. State persists to `localStorage` under `connections-puzzle`.

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
