---
name: Connections Sorter
description: A warm-paper scratchpad for the NYT Connections puzzle, set in the Franklin the Times uses, where the four puzzle pastels are the only colour.
colors:
  bg: "#f1efe5"
  bg-2: "#faf8f1"
  surface: "#ffffff"
  tile-bg: "#ffffff"
  tile-text: "#1b1813"
  tile-border: "#e7e3d6"
  text: "#1b1813"
  text-soft: "#565347"
  text-muted: "#6c695b"
  text-faint: "#918d7c"
  border: "#e6e2d5"
  border-strong: "#d6d1c1"
  input-border: "#8a8677"
  input-bg: "#ffffff"
  selected-bg: "#29251e"
  selected-text: "#fbfaf4"
  selected-ring: "#29251e"
  primary: "#221f18"
  primary-text: "#fbfaf4"
  primary-hover: "#36322a"
  focus-ring: "#1b1813"
  error-bg: "#fbf1ef"
  error-text: "#b53f33"
  backdrop: "rgba(28, 25, 18, 0.34)"
  bg-dark: "#131210"
  bg-2-dark: "#1c1a15"
  surface-dark: "#211f19"
  tile-bg-dark: "#2b2820"
  tile-text-dark: "#f2f0e6"
  tile-border-dark: "#393528"
  text-dark: "#f2f0e6"
  text-soft-dark: "#c4c1b4"
  text-muted-dark: "#9a978a"
  text-faint-dark: "#807d6f"
  border-dark: "#322f27"
  border-strong-dark: "#433f33"
  input-border-dark: "#706b5a"
  input-bg-dark: "#1b1914"
  selected-bg-dark: "#f2f0e6"
  selected-text-dark: "#1b1813"
  selected-ring-dark: "#f2f0e6"
  primary-dark: "#f2f0e6"
  primary-text-dark: "#1b1813"
  primary-hover-dark: "#ffffff"
  focus-ring-dark: "#f2f0e6"
  error-bg-dark: "#2a1d1a"
  error-text-dark: "#f0a89e"
  backdrop-dark: "rgba(0, 0, 0, 0.62)"
  row-yellow: "#f9df6d"
  row-green: "#a0c35a"
  row-blue: "#b0c4ef"
  row-purple: "#ba81c5"
  row-text: "#1a1a1a"
typography:
  title:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 800
    letterSpacing: "-0.6px"
  headline:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 800
    letterSpacing: "-0.3px"
  body:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  label-regular:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  caption:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  tile:
    fontFamily: "'Libre Franklin Variable', 'Libre Franklin', 'Franklin Gothic Medium', 'Helvetica Neue', Arial, sans-serif"
    fontSize: "measured: 8px to 20px, see src/fitTileFont.js"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.3px"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
  sheet-top: "18px"
components:
  tile:
    backgroundColor: "{colors.tile-bg}"
    textColor: "{colors.tile-text}"
    typography: "{typography.tile}"
    rounded: "{rounded.md}"
    padding: "5px 5px"
  tile-selected:
    backgroundColor: "{colors.selected-bg}"
    textColor: "{colors.selected-text}"
    rounded: "{rounded.md}"
  segment:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
    height: "30px"
  segment-selected:
    backgroundColor: "{colors.selected-bg}"
    textColor: "{colors.selected-text}"
    rounded: "{rounded.pill}"
  button-small:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    height: "36px"
  button-small-hover:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  button-ghost:
    textColor: "{colors.text-muted}"
    typography: "{typography.label-regular}"
    padding: "4px 6px"
    size: "32px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.md}"
    padding: "13px 20px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "13px 20px"
  button-secondary-hover:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  input-label:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text}"
    typography: "{typography.label-regular}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "30px"
  sheet-item:
    textColor: "{colors.text}"
    padding: "14px 20px"
  notice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-soft}"
    typography: "{typography.label-regular}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
---

# Design System: Connections Sorter

This is the design reference: what the interface looks like, why, and the rules that keep new UI on the same page. The engineering side of the same split — where each token is read, which pieces are styled inline versus in the stylesheet, and the accessibility contracts a change must not undo — lives in `CLAUDE.md`. Every value quoted here can be found in `src/index.css` (tokens and the class-styled pieces), the `styles` object at the bottom of `src/App.jsx` (the inline pieces), and `src/icons.jsx`. The tokens are the source of truth; the prose says how to apply them.

## Overview

**Creative North Star: "The Newsprint Scratchpad"**

A Connections puzzle is a page from the paper, and this app is the scrap of it you work on before you commit an answer. The page is warm, not white: a soft overhead glow on unbleached paper with a whisper of grain, ink-dark text, and hairline rules. The type is Libre Franklin, the open Franklin Gothic the Times sets its own games in, so the words on the tiles look the way the puzzle looks. Almost everything is one neutral ramp; the only real colour is the puzzle's own four pastels, which appear exactly when a row is locked and nowhere else. Dark mode is the same page after lights-out — the same ramp, inverted, with a heavier drop under anything lifted so it still reads as lifted against near-black.

The interface is an **Operate** surface: a 4×4 board you rearrange with taps and drags, a one-line header, and everything rarely needed folded behind one overflow button. Density is calm rather than tight. Controls sit on explicit target-size floors so the header holds one row all the way down to 320 px, and state is carried by fill and ring rather than by decoration.

**Key Characteristics:**
- One neutral ramp does all the work; the four puzzle pastels are the only chromatic colour and are the puzzle's identity, so they are never themed.
- Paper, not a flat fill: a fixed radial glow from `--bg-2` into `--bg` plus a 3.5 % noise overlay give the page depth without asking for attention.
- Libre Franklin at 600–800 for anything you tap, 400–500 for anything you read; uppercase only on the tiles.
- Depth is state: resting surfaces carry a hairline and a faint shadow, and only a picked-up, dragged, or targeted tile earns a ring and a real drop.
- Motion is short (120–450 ms), one purpose per animation, and every entrance is filled so reduced motion can drop it losslessly.

## Colors

A single warm-neutral ramp in two schemes, plus the four puzzle pastels that sit outside the theme.

### Primary
- **Ink** (`--primary`, `#221f18` light / `#f2f0e6` dark): the one filled button, "Load Puzzle" on the manual screen, and its hover a step lighter (`--primary-hover`). Ink is also the picked-up state — `--selected-bg` (`#29251e` / `#f2f0e6`) fills a selected or carried tile and the pressed day segment, with `--selected-text` on top and `--selected-ring` for the ring around a drop target.

### Secondary
- **The puzzle pastels** — Yellow `#f9df6d`, Green `#a0c35a`, Blue `#b0c4ef`, Purple `#ba81c5`, always with near-black `#1a1a1a` text (`ROW_COLORS` in `src/App.jsx`): a locked row's tiles and its lock chip, and nothing else. They are the same in both schemes on purpose; each carries a matching `glow` at 60 % alpha for the lock flash.

### Neutral
- **Paper** (`--bg`, `#f1efe5` / `#131210`) is the page, and **Paper light** (`--bg-2`, `#faf8f1` / `#1c1a15`) is the top of the page glow and the fill a bordered button or a sheet row takes on hover.
- **Card** (`--surface`, `#ffffff` / `#211f19`) is every raised thing — the notice bar, the small buttons, the day-switcher pill, the sheet — and **Tile** (`--tile-bg`, `#ffffff` / `#2b2820`) is the resting tile, with its own `--tile-text` and `--tile-border`.
- **Text ramp** — `--text` (`#1b1813` / `#f2f0e6`) for anything you act on or must read; `--text-soft` (`#565347` / `#c4c1b4`) for explanatory copy and the notice's message; `--text-muted` (`#6c695b` / `#9a978a`) for hints, placeholders, the footer, unpressed segments and the "Cancel" row; `--text-faint` (`#918d7c` / `#807d6f`) for the saved-day dot, disabled labels and a hover edge only.
- **Rules** — `--border` (`#e6e2d5` / `#322f27`) is the hairline between sheet rows and around cards; `--border-strong` (`#d6d1c1` / `#433f33`) is the edge of a bordered button and an unlocked lock chip. Neither is a field's edge.
- **Field edge** (`--input-border`, `#8a8677` / `#706b5a`): the category-label inputs and the manual-entry textarea. It sits at 3.16:1 against the light page and 3.65:1 against the field's white fill, 3.51:1 against the dark page and 3.29:1 against the dark field, so the boundary of a thing you can type in passes WCAG 1.4.11 in both schemes.
- **Semantic** — `--error-text` on `--error-bg` (`#b53f33` on `#fbf1ef` light, 5.08:1; `#f0a89e` on `#2a1d1a` dark) for the manual screen's validation box and the sheet's Reset row; `--focus-ring` (`#1b1813` / `#f2f0e6`) for the one focus treatment; `--backdrop` behind the dialogs.

### Named Rules
**The Token Rule.** Every colour in the app is a `var(--token)` with a light and a dark value. The only hex literals in `App.jsx` are the four pastels and their text, and the only ones in `index.html` are copies of `--bg` and the three text tokens that the pre-paint fallback needs before the stylesheet loads — `src/theme.test.js` pins every copy to its token.

**The Faint Rule.** `--text-faint` is below 4.5:1 everywhere in light and on `--surface` in dark, and only just clears the line on the dark page (4.53:1), so it is decoration and disabled states only: the saved-day dot, a disabled chip, a hover edge. Running text, hints, placeholders and the footer stop at `--text-muted`.

**The Pastels Are Not Yours Rule.** Yellow, green, blue and purple mean "this row is locked." They are not available as accents, badges or highlights, and they do not change with the theme.

## Typography

**Display / Body / Label Font:** Libre Franklin Variable (self-hosted via `@fontsource-variable/libre-franklin`), falling back to Libre Franklin, Franklin Gothic Medium, Helvetica Neue, Arial, sans-serif.

**Character:** One family at every size, set antialiased. The heavy end (700–800, tightened by a fraction of a pixel) reads as the puzzle's own headline voice on the tiles and the two headings; the light end (400–500) is the quiet copy around them. Nothing is set in a second face, and nothing uses the fallback glyph range — the six icons are inline SVG precisely so that no character comes from a system font.

### Hierarchy
- **Title** (800, `--fs-xl` 20 px, letter-spacing −0.6 px): "Enter 16 Words" on the manual screen. The board has no title row at all; its name lives in a visually hidden heading.
- **Headline** (800, 17 px, letter-spacing −0.3 px): the "How this works" dialog heading — deliberately between `--fs-lg` and `--fs-xl`, because 15 reads as a row and 20 as a page title.
- **Body** (400, `--fs-md` 14 px, line-height 1.5): the explainer list, the empty-state message, the textarea, and the sheet's "Cancel" row at 600.
- **Label** (600, `--fs-sm` 13 px): the working size — Shuffle, the category-label inputs (400), the board hint (400), the notice bar (400), the manual subtitle (500), the error box, the "how this works" note. The three ghost buttons use it at 700 for Retry and 400 for the rest.
- **Caption** (`--fs-xs` 12 px): the sheet's hint lines at 500 and the footer at 400 with line-height 1.5; the lock chips use the same size at 600, rising to 800 when locked.
- **Tile** (700, uppercase, letter-spacing 0.3 px, line-height 1.15): the sixteen words. The size is not a token — `src/fitTileFont.js` measures each word on a canvas and sets 8–20 px per tile so multi-word entries wrap at spaces and a single long word shrinks rather than breaking. On a 390 px phone every tile is 14 px; a 500 px board gets 18.5.
- **Sheet rows** (600, `--fs-lg` 15 px): every action in the overflow sheet and the Appearance row; the manual screen's two buttons take the same size at 700 (Primary) and 600 (Secondary).

### Named Rules
**The Five Steps Rule.** Type sizes are `--fs-xs` 12, `--fs-sm` 13, `--fs-md` 14, `--fs-lg` 15 and `--fs-xl` 20. The deliberate literals — pills and circles aside, which are `999px` and `50%` by definition — are the tile word (measured), the day switcher's 13 / 12 / 11.5 px segments (a 320 px budget tuned to the half-pixel in #15 — retune all of them together or not at all), and the 17 px dialog heading. Anything new picks a step.

**The Weight Carries the Verb Rule.** If it reads as a *button*, it is 600 or heavier; if you only read it, it is 500 or lighter. The ghost buttons are the deliberate quiet exception (400, bar Retry's 700), and links and fields are not buttons — the footer link and the category-label inputs stay at 400 too. The lock chip going from 600 to 800 is the whole visual of "locked."

## Layout

A single centred column, `maxWidth: 500` with `12px 10px` of padding, on a page that is `min-height: 100dvh`. Safe-area insets (`env(safe-area-inset-*)`) are paid on `#root`, never on the column, so a notched phone in landscape keeps its full board width.

The board is four rows, `gap: 14` between them. Each row is a control line — the lock chip and the flex-filling label input, `gap: 8`, `marginBottom: 6` — above a `repeat(4, minmax(0, 1fr))` grid of square tiles with `gap: 6`. The `minmax(0, 1fr)` is load-bearing: a long unbreakable word must overflow its cell (and be shrunk to fit) rather than widen its column past the viewport.

The header is one row at every width: the day-switcher pill on the left, Shuffle and the overflow trigger on the right, `justifyContent: space-between` with a 6 px floor. At 320 px the budget is exact — 300 px of content minus 96 px of buttons and the gap leaves the pill 198 px, and four segments at 11.5 px need 194 of it — so `@media (max-width: 380px)` tightens segment padding, drops the saved-day dots when there are four segments, and shrinks the two buttons to `6px 8px`. If a fallback font ever overruns that, the pill scrolls horizontally rather than wrapping the header.

Below the board: the hint line at `marginTop: 16`, then a `maxWidth: 340` footer at `18px auto 0`. The empty state stands in at `clamp(280px, 52vh, 460px)` so the header and footer do not jump when the words land.

The overflow menu and the explainer are native `<dialog>`s. Under 600 px they are a full-width bottom sheet whose last row also pays `env(safe-area-inset-bottom)`; from 600 px they are a centred card at `max-width: 340px`. Sheet rows are `14px 20px`, the Appearance control strip `12px 20px`, and prose `20px 20px 18px`.

There is no spacing scale as such. The recurring values are 6 (tile gap, header gap), 8 (row control gap), 10 (side padding, button row gap), 12 (top padding, card margins), 14 (row gap, textarea padding) and 20 (sheet insets); new spacing should reuse one of those.

## Elevation & Depth

A hybrid: the page itself has depth (the fixed radial glow from `--bg-2` at the top into `--bg` by 55 %, and `body::before` laying a 140 px fractal-noise tile at 3.5 % opacity over everything), surfaces above it are separated by a hairline plus a faint shadow, and only a change of state earns a real lift.

### Shadow Vocabulary
- **Tile at rest** (`--tile-shadow`: `0 1px 2px rgba(40, 37, 26, 0.06), 0 3px 10px rgba(40, 37, 26, 0.05)` light; `0 1px 2px rgba(0, 0, 0, 0.45), 0 3px 12px rgba(0, 0, 0, 0.35)` dark): every unlocked tile, with `--tile-border` as its hairline.
- **Card** (`--card-shadow`: `0 1px 2px rgba(40, 37, 26, 0.04), 0 4px 16px rgba(40, 37, 26, 0.05)`): the notice bar.
- **Card, raised** (`--card-shadow-hover`: `0 4px 10px rgba(40, 37, 26, 0.09), 0 14px 30px rgba(40, 37, 26, 0.10)`): the sheet and the explainer dialog, over `--backdrop`.
- **Picked up** (`--selected-shadow`: `0 10px 24px rgba(0, 0, 0, 0.18)` light, `0 13px 30px rgba(0, 0, 0, 0.62)` dark): under a selected or carried tile, always paired with a 2.5 px ring. Dark is deliberately heavier so the lift survives a near-black board.
- **Locked glow**: a locked tile carries `0 2px 8px` of its row's `glow`, flaring to `0 0 0 1px` of the pastel plus `0 8px 26px` and `0 0 32px` of glow for the 600 ms of the lock flash.

### Named Rules
**The Lift Is State Rule.** Surfaces at rest get a hairline and the faint tile or card shadow. A ring and a real drop mean one of exactly three things: this tile is picked up (`--selected-ring`, 2.5 px), this tile is being carried (ringed in `--selected-text` so it cuts out of whatever it crosses), or this tile is where the carried one will land (`--selected-ring`, 3 px, on the resting fill). Hover on a mouse is a 2 px rise with no ring.

## Shapes

Rounded, never round, except where a thing is a pill. Three radii cover the UI: `--r-sm` 8 px for the compact controls (Shuffle, the overflow trigger, the lock chips, the label inputs), `--r-md` 12 px for the tiles, the notice bar, the error box, the textarea and the manual screen's two buttons, and `--r-lg` 16 px for the sheet as a centred card. The day switcher and each segment are `999px` pills; the saved-day dot, the spinner and the four colour dots are circles. The one literal is the bottom sheet's `18px 18px 0 0` top corners, because 16 reads visibly tighter on a full-width edge.

Tiles keep a `1.5px solid transparent` border in every state so a ring can replace a hairline without moving the word. Icons are drawn on a 16-unit grid at a 1.75 stroke with round caps and joins, `1em` square, sunk `-0.125em` under the baseline.

## Components

### Tiles
Sixteen square buttons, `--tile-bg` with `--tile-border` and `--tile-shadow`, the word in the Tile type. State precedence: **locked** (the row's pastel, its dark text, no border, a soft glow) wins over **carried** (`--selected-bg` and `--selected-text`, a 2.5 px ring in `--selected-text`, `--selected-shadow`, following the pointer at `scale(1.04)`), then **picked up** (the same fill on a 2.5 px `--selected-ring`), then **drop target** (resting fill, a 3 px `--selected-ring`), then **resting**. A mouse hover lifts a resting tile `translateY(-2px)`; a press scales it to `0.97`; a locked tile does neither and shows a default cursor. Locking a row plays `lockPop` (0.45 s, overshoot to 1.07) while the glow flares. The board arrives with `tileIn` (0.42 s, `cubic-bezier(0.2, 0.7, 0.2, 1)`), each tile delayed `min(index × 22, 330)` ms so the grid cascades top-left to bottom-right.

### Lock chip and label input
The chip is a 30 px-floor button at `--fs-xs` 600, `7px 10px`, `--r-sm`, `line-height 1.15`. Unlocked it is transparent with `--text-muted` text and a `--border-strong` edge behind a ring icon; locked it fills with the row's pastel, its text goes to 800 and the icon becomes a check. The field beside it is `--fs-sm` on `--input-bg` with a `--input-border` edge (`--r-sm`, `6px 10px`, 30 px floor), and once the row is locked it recedes: the pastel at 13 % alpha (`22`) behind `--text-soft` text, with the pastel at 67 % alpha (`aa`) as its edge.

### Day switcher (segmented control)
A `--surface` pill with a `--border` hairline, 2 px of padding and 2 px between segments; each segment is a 30 px-floor pill at 13 px 600 in `--text-muted`, the pressed one filled `--selected-bg` with `--selected-text`. A day with a saved board shows a 5 px `--text-faint` dot; a day being fetched shows a 9 px spinner in the same slot so nothing shifts. The same classes build the System / Light / Dark row in the sheet, where the pill takes `--bg` so it stays inset against the sheet's surface.

### Small buttons
Shuffle, the overflow trigger and the empty state's Retry: `--surface` with a `--border-strong` edge, `--r-sm`, `7px 12px` on a 36 px floor (the switcher pill's height, so the header reads as one row), `--fs-sm` 600. The icon variant is `7px 10px` at `--fs-lg` with `line-height: 1`. Hover (pointer devices only) tints the fill to `--bg-2` and darkens the edge to `--text-faint`; press nudges `translateY(1px)`; disabled greys the text to `--text-faint`.

### Ghost buttons
The notice's Retry and dismiss, and the empty state's "or enter the words yourself": no border, no fill, an invisible `32 × 32` target box, `--fs-sm` in `--text-muted`, `4px 6px`. Modifiers: `-link` underlines; `-action` (Retry) goes to 700 in `--text`, underlined, no-wrap; `-end` pushes to the far end of the bar. Hover turns the text to `--text`; disabled fades to 50 %.

### Primary and secondary buttons
The manual screen's pair, `flex: 1` each, `13px 20px`, `--fs-lg`, `--r-md`. Primary is `--primary` with `--primary-text` at 700, hovering to `--primary-hover`. Secondary is `--surface` with a `--border-strong` edge at 600, hovering like a small button. Their colours live in the stylesheet, not inline, because an inline background would outrank the hover.

### Notice bar
One line under the header when a day fails to load while a board is still on screen: `--surface`, `--border` hairline, `--card-shadow`, `--r-md`, `6px 12px` with an 8 px gap so Retry's focus ring clears the message, `--fs-sm` in `--text-soft`. It slides in over 0.3 s from 6 px above. It is deliberately not a live region; a visually hidden status line speaks for it.

### Overflow sheet
A native `<dialog>` on `--surface` under `--backdrop`, entering over 0.22 s from 16 px below. Rows are full-width, left-aligned, `--fs-lg` 600 in `--text`, separated by `--border` hairlines; a hint under a row is `--fs-xs` 500 in `--text-muted`. The Appearance strip leads; Reset comes last in its own group behind an 8 px band of `--bg` between two hairlines and is set in `--error-text`; Cancel is the closing row at `--fs-md` in `--text-muted`. Hover tints a row to `--bg-2`.

### Icons
Six inline SVGs in `src/icons.jsx` — more, close, check, circle, arrow-up, external — each `aria-hidden`, `1em` square, in `currentColor`, with `.icon-before` / `.icon-after` adding a 0.3 em gap to the label beside them. They are decoration next to a visible label or an `aria-label`; the state they hint at is always also on the element as `aria-pressed`.

### Focus
One ring for everything: `3px solid var(--focus-ring)` at a 2 px offset on any focused button, link or field. It tucks inside two things that would otherwise spill: segments (offset −1 px, inside the pill's padding) and sheet rows (offset −3 px, since a full-width row's outset ring hangs off both sides of the dialog).

### Motion
Every transition and keyframe lives in `index.css`. Buttons ease `transform` in 0.12 s and colour, background, border, shadow and opacity in 0.2 s; tiles ease transform in 0.15 s and shadow in 0.3 s; segments in 0.18 s. A carried tile drops its transition so it can keep up with the finger. Under `prefers-reduced-motion: reduce` the three entrances and the lock pop are set to `animation: none` and the four transitions to `none`, one selector each; the two spinners keep turning, because a small rotating ring is the only sign a fetch is in flight and is not vestibular motion.

## Do's and Don'ts

### Do:
- **Do** take every colour from a token and add a light and a dark value when you add one; `src/theme.test.js` fails if `index.html`'s copies drift.
- **Do** pick sizes from the five type steps and the three radii, and comment the reason wherever a literal is genuinely needed.
- **Do** put a `min-height` (30 px for row controls, 36 px for header buttons, 32 × 32 for ghost buttons) on any new control rather than padding it up to size.
- **Do** put hover, focus, media queries, keyframes and transitions in `index.css` behind a `className`; gate hover behind `(hover: hover)`, and decide per animation what reduced motion drops.
- **Do** carry state on `aria-pressed` / `aria-disabled` and hide the icon that restates it; keep the ring-and-drop treatment for picked-up, carried and drop-target tiles only.

### Don't:
- **Don't** use the four pastels for anything but a locked row, and don't theme them.
- **Don't** set running text, hints, placeholders or the footer in `--text-faint`; stop at `--text-muted`.
- **Don't** give a field `--border` or `--border-strong` as its edge — that is what `--input-border` is for — and never put an inline `outline: none` on one.
- **Don't** add a text glyph (⋯ ✕ ✓ ○ ↑ ↗ or any other) as an icon; draw it in `src/icons.jsx`.
- **Don't** change the day switcher's 13 / 12 / 11.5 px segment sizes, or the tile word's size, without re-measuring a 320 px header with four segments on every weekday.
- **Don't** call `scrollIntoView()` on mount or on a day switch, and don't add a second live region for it — the accessibility contracts in `CLAUDE.md` say why.
