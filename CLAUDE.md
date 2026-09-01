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

Vitest covers five pure modules — `worker/puzzle.js` (the puzzle fetch/transform + date-window logic, via an injectable `fetchImpl`), `shared/puzzleDates.js` (today-in-ET, add-days, and the 3-day window constants, shared by the Worker and the client so the two can't drift), `src/fitTileFont.js` (the tile shrink-to-fit loop, fed stub elements), `src/savedPuzzle.js` (the per-day saved-board store: schema + migration, the launch rule, day switching, adopt-on-match, and switcher entries), and `src/share.js` (the "Share this site" URL and the load-time strip of its `utm_source=share` marker) — so no jsdom is needed. The App component (day switcher, overflow menu, failure states) is verified **by hand in the browser**, not under jsdom; the worker handler and the Vite dev middleware are uncovered too. Lint still runs over everything; `**/*.test.js` gets Vitest globals in `eslint.config.js`.

## Architecture

Single-page React 19 + Vite app. Two screens, both in `src/App.jsx` — the **board**, which is the home screen, and **manual word entry**, reachable only from the overflow menu or the fetch-failure state — plus an inline `styles` object. Pure, framework-free helpers are extracted so they can be unit-tested without a DOM: `src/fitTileFont.js` (tile shrink-to-fit), `src/savedPuzzle.js` (the per-day saved-board store, launch decision, and switcher labels), `src/share.js` (the share link), and `shared/puzzleDates.js` (the ET date math the Worker and the client both read). There is no router, no state library, no CSS framework. State persists to `localStorage` under `connections-puzzle`.

### Theming (light/dark — the inline-styles + CSS-vars split)

The `styles` object in `App.jsx` is still inline, but **every color is a `var(--token)`**, never a literal — the only intentional hex literals are `ROW_COLORS` (the four Connections tile colors, which are the puzzle's identity and are *not* themed; their text stays dark because all four are light pastels). The tokens live in `src/index.css` under `:root`, with a `@media (prefers-color-scheme: dark)` block that re-points the same variables. So **dark mode is automatic and has no React state** — the OS scheme flips the CSS vars and the whole UI follows. Inline styles can't do `:hover`/`:focus-visible`/`@media`/keyframes or modifier classes, so those (tile hover lifts, the shared focus ring, the `tileIn` staggered board reveal, `lockPop`, `spin`, `sheetIn`, `prefers-reduced-motion`) live in `index.css` and attach via `className` — and three pieces are styled *entirely* there because their layout depends on exactly those things: the day switcher (`.segs`/`.seg`, with a dense modifier for the fourth segment and a narrow-viewport media query), the overflow/how-this-works `<dialog>` (`.sheet`, a bottom sheet under 600px and a centered card above, plus `::backdrop`), and the compact header buttons (`.small-btn`/`.icon-btn`, which the same media query shrinks). When adding UI: use a token (add light+dark values if it's a new one), not a hex; add a `className` for any hover/focus/animation/media query. `index.html` carries the light/dark `theme-color` metas and paints the page background pre-hydration to avoid a flash.

Type is **self-hosted Libre Franklin** (the open Franklin Gothic NYT itself uses) via `@fontsource-variable/libre-franklin`, imported in `main.jsx` and bundled by Vite — no Google Fonts request (keeps the privacy-forward, own-origin posture). Don't switch it to a CDN `<link>`; the `--font` token already lists the fallback stack.

### Accessibility contracts

The board is operated by keyboard and screen reader as much as by touch, and the fixes from the 2026-08-31 audit (#10) are easy to undo by accident:

- **Never call `scrollIntoView()` on mount or on a day switch.** Chrome moves its sequential-focus starting point to the scrolled element, so the first Tab of a fresh load would land *after* Today. The switcher nudges `scrollLeft` instead (the `activeKey` effect in `App.jsx`).
- **One live region speaks for a day switch**: the always-mounted `.sr-only` `role="status"` `<p>` in the board view alternates `Loading …` / the failure message. The visible notice bar is deliberately *not* a live region (it arrives pre-populated, which isn't announced), and the hint `<p>` is always rendered (empty without a board) for the same reason — a live region has to exist before its text changes.
- **Toggles expose state, not glyphs**: tiles and lock buttons carry `aria-pressed`; the ○ / ✓ / ↑ glyphs sit in `aria-hidden` spans. Tiles in a locked row are `aria-disabled` (still focusable so the words stay readable), not `disabled`; `.tile[aria-disabled="true"]` in `index.css` owns their cursor and suppresses the hover lift.
- **`--text-faint` is decoration and disabled states only** (it's below 4.5:1); running text, hints, placeholders and the footer use `--text-muted`. Never put an inline `outline: none` on a field — the shared `:focus-visible` ring in `index.css` is the only focus treatment, and an inline value would beat it.

### Landing, day switcher, and the per-day store

The board is the home screen — there is no menu. The header carries a segmented switcher for today plus the two prior days (`RECENT_WINDOW_DAYS = 2` in `shared/puzzleDates.js`, enforced server-side too, so a hand-crafted `?date=` can't reach further back than the switcher offers); everything rarely needed (Reset, manual entry, "how this works", "share this site", the official-game link) sits behind one overflow button. Share uses the native share sheet where `navigator.share` exists and the clipboard elsewhere; the shared URL carries `?utm_source=share`, which `main.jsx` strips with `replaceState` before the first render. Tapping a day whose board is saved switches instantly with no network; a day with no saved board fetches in place, leaving the current board on screen until the words arrive.

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
