// Unit tests for theme.js — the Appearance preference (src/theme.js).
//
// The DOM side (the data-theme attribute, the meta tag, matchMedia) is verified
// in the browser; what can drift silently is the rule itself and the three
// places that must agree on it — this module, the pre-paint script in
// index.html (which has to inline the rule), and the tokens in index.css. Runs
// as plain Node, like share.test.js.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  THEME_COLORS,
  THEME_KEY,
  THEME_OPTIONS,
  parseThemePreference,
  resolveTheme,
  serializeThemePreference,
} from "./theme.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("parseThemePreference", () => {
  it("accepts the two overrides", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("treats anything else as following the system", () => {
    for (const raw of [null, undefined, "", "system", "auto", "DARK", " dark", "{}", 0]) {
      expect(parseThemePreference(raw)).toBe("system");
    }
  });
});

describe("serializeThemePreference", () => {
  it("stores an override as itself and system as no key at all", () => {
    expect(serializeThemePreference("light")).toBe("light");
    expect(serializeThemePreference("dark")).toBe("dark");
    expect(serializeThemePreference("system")).toBeNull();
    expect(serializeThemePreference(undefined)).toBeNull();
  });

  it("round-trips every option through parse", () => {
    for (const { value } of THEME_OPTIONS) {
      expect(parseThemePreference(serializeThemePreference(value))).toBe(value);
    }
  });
});

describe("resolveTheme", () => {
  it("lets an explicit preference win over the OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("follows the OS when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("only ever yields a scheme that has a theme color", () => {
    for (const { value } of THEME_OPTIONS) {
      for (const osDark of [true, false]) {
        expect(Object.keys(THEME_COLORS)).toContain(resolveTheme(value, osDark));
      }
    }
  });
});

describe("THEME_OPTIONS", () => {
  it("offers System, Light and Dark in that order", () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(["system", "light", "dark"]);
    expect(THEME_OPTIONS.map((o) => o.label)).toEqual(["System", "Light", "Dark"]);
  });
});

// index.css holds the palette; index.html and DESIGN.md hold hand-copies of
// parts of it because neither can read a stylesheet. Everything below reads
// the files once and pins the copies to the tokens.
const css = read("./index.css");
const html = read("../index.html");
const design = read("../DESIGN.md");

// The tokens sit in two blocks of one file: light before the
// `:root[data-theme="dark"]` selector, dark after it. Only the forced-colours
// block at the end redefines any, and it points them at system colours, which
// this hex-only reader skips. The selector is matched at the start of a line
// so a mention of it in a comment can't split the file in the wrong place.
const darkAt = css.search(/^:root\[data-theme="dark"\]/m);
const blocks = { light: css.slice(0, darkAt), dark: css.slice(darkAt) };
const token = (scheme, name) =>
  blocks[scheme].match(new RegExp(`^\\s*${name}:\\s*(#[0-9a-f]{6})\\b`, "m"))?.[1];

// The pre-paint script can't import this module, so it repeats the key and
// the two colors by hand. These pin the copies to the originals.
describe("index.html and index.css agree with theme.js", () => {
  it("the pre-paint script reads the same storage key", () => {
    expect(html).toContain(`'${THEME_KEY}'`);
  });

  it("the pre-paint script and meta use the same two background colors", () => {
    expect(html).toContain(THEME_COLORS.light);
    expect(html).toContain(THEME_COLORS.dark);
  });

  it("index.css's --bg is those same colors in both schemes", () => {
    expect(css).toMatch(new RegExp(`--bg:\\s*${THEME_COLORS.light}\\b`));
    expect(css).toMatch(new RegExp(`--bg:\\s*${THEME_COLORS.dark}\\b`));
  });

  // The <style> block in index.html paints the page and the no-JS /
  // pre-hydration fallback with the same hexes the tokens hold, copied by hand
  // because nothing there can read the stylesheet. Each copy is pinned to its
  // token in the scheme it belongs to, so a token change that forgets the
  // mirror fails here instead of quietly leaving crawlers and no-JS visitors a
  // different grey — and, unlike the `toContain`/unanchored `toMatch` pair
  // above, reading each rule by selector catches the two schemes being swapped.
  describe("the fallback's colors are the tokens", () => {
    // `(?<![-\w])` so a `background-color:` (or any other `-color`) declaration
    // sitting before the one we want isn't read as it.
    const fallback = (selector, prop = "color") => {
      const sel = selector.replace(/[.[\]]/g, "\\$&");
      const rule = `^\\s*${sel}\\s*\\{[^}]*?(?<![-\\w])${prop}:\\s*(#[0-9a-f]{6})\\b`;
      return html.match(new RegExp(rule, "m"))?.[1];
    };
    const cases = [
      ["light", "body", "--bg", "background"],
      ["dark", ':root[data-theme="dark"] body', "--bg", "background"],
      ["light", ".seo-fallback", "--text", "color"],
      ["light", ".seo-fallback p", "--text-soft", "color"],
      ["light", ".seo-fallback .muted", "--text-muted", "color"],
      ["dark", ':root[data-theme="dark"] .seo-fallback', "--text", "color"],
      ["dark", ':root[data-theme="dark"] .seo-fallback p', "--text-soft", "color"],
      ["dark", ':root[data-theme="dark"] .seo-fallback .muted', "--text-muted", "color"],
    ];

    it.each(cases)("%s: `%s` is %s", (scheme, selector, name, prop) => {
      const expected = token(scheme, name);
      expect(expected, `${name} not found in the ${scheme} block`).toMatch(/^#/);
      expect(fallback(selector, prop), `no ${prop} rule for ${selector}`).toBe(expected);
    });
  });

  // Its two type sizes are copies too: steps from the scale in index.css, so
  // the fallback stays on the ramp DESIGN.md documents (#33).
  describe("the fallback's sizes are type steps", () => {
    const size = (selector) => {
      const sel = selector.replace(/[.[\]]/g, "\\$&");
      const rule = `^\\s*${sel}\\s*\\{[^}]*?(?<![-\\w])font-size:\\s*([\\d.]+px)`;
      return html.match(new RegExp(rule, "m"))?.[1];
    };
    const step = (name) => css.match(new RegExp(`^\\s*${name}:\\s*([\\d.]+px)`, "m"))?.[1];

    it.each([
      [".seo-fallback h1", "--fs-xl"],
      [".seo-fallback .muted", "--fs-md"],
    ])("`%s` is %s", (selector, name) => {
      expect(step(name), `${name} not found in index.css`).toMatch(/px$/);
      expect(size(selector), `${selector}'s font-size`).toBe(step(name));
    });
  });

  it("dark tokens are keyed on data-theme, never on the OS media query", () => {
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).not.toMatch(/@media\s*\(prefers-color-scheme/);
    expect(html).not.toMatch(/@media\s*\(prefers-color-scheme/);
  });

  it("there is exactly one theme-color meta, with no media attribute", () => {
    const metas = html.match(/<meta[^>]*name="theme-color"[^>]*>/g) ?? [];
    expect(metas).toHaveLength(1);
    expect(metas[0]).not.toMatch(/\bmedia=/);
  });
});

// WCAG relative luminance: sRGB channel → linear, weighted 0.2126/0.7152/
// 0.0722; the ratio is (lighter + 0.05) / (darker + 0.05). Shared by the two
// contrast blocks below.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

// Two tokens exist *because* of a contrast number, and their comments in
// index.css say so: --input-border is the edge of a field, which WCAG 1.4.11
// puts at 3:1 against everything it touches, and --error-text is running text
// at 4.5:1. Both have very little headroom in dark (--input-border on
// --surface is 3.09), so a nudge of either color — or of the fill behind it —
// can drop below the floor without looking any different. These recompute the
// ratios from the tokens themselves rather than trusting the comments. (The
// row name strip's --row-tint has a block of its own below: its fill is a
// mix, not a token.)
describe("the tokens hold the contrast their comments promise", () => {
  const cases = [
    ["--input-border", "--bg", 3],
    ["--input-border", "--input-bg", 3],
    ["--input-border", "--surface", 3],
    ["--error-text", "--error-bg", 4.5],
    ["--error-text", "--surface", 4.5],
  ].flatMap((row) => ["light", "dark"].map((scheme) => [scheme, ...row]));

  it.each(cases)("%s: %s on %s clears %s:1", (scheme, name, against, floor) => {
    const [fg, bg] = [token(scheme, name), token(scheme, against)];
    expect(fg, `${name} not found in the ${scheme} block`).toMatch(/^#/);
    expect(bg, `${against} not found in the ${scheme} block`).toMatch(/^#/);
    const ratio = contrast(fg, bg);
    const detail = `${name} on ${against} (${scheme}) is ${ratio.toFixed(2)}:1`;
    expect(ratio, detail).toBeGreaterThanOrEqual(floor);
  });
});

// The row name strips (.row-name in index.css). Unlocked, the colour name sits
// in --text-soft on the row's pastel mixed to --row-tint with transparent — a
// translucent fill over the page, which is a --bg-2 → --bg glow, so both ends
// count. Locked, it sits in the row's own text on the full pastel, as the
// locked padlock's icon does. Running text, so 4.5:1 throughout.
//
// The pastels and their text come from ROW_COLORS in App.jsx, the copy that
// renders. App.jsx renders JSX and isn't a Vitest module, so it's read as
// text, as dragSwap.test.js reads it; the scrape is anchored on the literal's
// own `const ROW_COLORS = [` and `];` lines, so a comment above it can't feed
// it. A ratio computed here is only as good as its match to the CSS, so the
// rules being modelled are pinned as well — the mix and the text color of the
// unlocked strip, the fill and text of the locked strip and padlock, and the
// --row-color / --row-text bridge App.jsx sets on each row. DESIGN.md's
// `row-*` copies, which the palette check further down skips, are pinned to
// ROW_COLORS here too.
const app = read("./App.jsx");
const rowColors = [
  ...(app.match(/^const ROW_COLORS = \[\n([\s\S]*?)^\];/m)?.[1] ?? "").matchAll(
    /name:\s*"(\w+)",\s*bg:\s*"(#[0-9a-f]{6})",\s*text:\s*"(#[0-9a-f]{6})"/g,
  ),
].map(([, name, bg, text]) => ({ name, bg, text }));

describe("the row name reads on its strip", () => {
  const tint = (scheme) => {
    const pct = blocks[scheme].match(/^\s*--row-tint:\s*(\d+(?:\.\d+)?)%/m)?.[1];
    return pct === undefined ? undefined : Number(pct) / 100;
  };

  // Source-over compositing of `fg` at `alpha` on an opaque `bg`, per sRGB
  // channel — what the browser does with the translucent strip.
  const over = (fg, alpha, bg) => {
    const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
    const mixed = [1, 3, 5].map((i) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha)));
    return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  // The it.each blocks below register nothing at all for an empty list, so a
  // scrape that stops matching would leave them green by absence. This is the
  // test that goes red instead.
  it("finds the four rows and both tints", () => {
    expect(rowColors, "ROW_COLORS entries scraped from App.jsx").toHaveLength(4);
    expect(tint("light"), "--row-tint not found in the light block").toBeGreaterThan(0);
    expect(tint("dark"), "--row-tint not found in the dark block").toBeGreaterThan(0);
  });

  const unlocked = ["light", "dark"].flatMap((scheme) =>
    rowColors.flatMap(({ name, bg }) => [
      ["--bg", scheme, name, bg],
      ["--bg-2", scheme, name, bg],
    ]),
  );

  it.each(unlocked)("over %s, %s: --text-soft on the %s tint clears 4.5:1", (page, scheme, name, bg) => {
    const [text, behind] = [token(scheme, "--text-soft"), token(scheme, page)];
    expect(text, `--text-soft not found in the ${scheme} block`).toMatch(/^#/);
    expect(behind, `${page} not found in the ${scheme} block`).toMatch(/^#/);
    const ratio = contrast(text, over(bg, tint(scheme), behind));
    const detail = `--text-soft on ${name} (${bg}) at --row-tint over ${page} (${scheme}) is ${ratio.toFixed(2)}:1`;
    expect(ratio, detail).toBeGreaterThanOrEqual(4.5);
  });

  const locked = rowColors.map(({ name, bg, text }) => [name, text, bg]);

  it.each(locked)("locked: %s's text %s on its full pastel %s clears 4.5:1", (name, text, bg) => {
    const ratio = contrast(text, bg);
    expect(ratio, `${name}'s text on its pastel is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  // `rule` reads one rule's body by its exact selector, anchored at the start
  // of a line so the reduced-motion block's indented `.row-name` and a mention
  // in a comment can't stand in for it; a rule that's gone reads as "", which
  // every assertion below fails on. `decl` takes a property only where it
  // starts a declaration, so `border-color:` is never read as `color:`.
  const rule = (sel) =>
    css.match(new RegExp(`^${sel.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
  const decl = (body, prop) =>
    body.match(new RegExp(`(?<![-\\w])${prop}:\\s*([^;]+);`))?.[1].replace(/\s+/g, " ").trim();

  it("models the rules index.css and App.jsx actually set", () => {
    const strip = rule(".row-name");
    expect(decl(strip, "background"), ".row-name's background").toBe(
      "color-mix(in srgb, var(--row-color) var(--row-tint), transparent)",
    );
    expect(decl(strip, "color"), ".row-name's color").toBe("var(--text-soft)");
    for (const sel of ['.row-line[aria-pressed="true"] .row-name', '.row-line[aria-pressed="true"] .row-lock']) {
      expect(decl(rule(sel), "background"), `${sel}'s background`).toBe("var(--row-color)");
      expect(decl(rule(sel), "color"), `${sel}'s color`).toBe("var(--row-text)");
    }
    expect(app, "App.jsx no longer sets --row-color / --row-text from ROW_COLORS").toContain(
      '"--row-color": color.bg, "--row-text": color.text',
    );
  });

  // DESIGN.md has one `row-text` for all four rows, because ROW_COLORS gives
  // every row the same near-black today. Each row's text is held to it, so a
  // row that ever takes a text of its own fails here until DESIGN.md says so.
  const designRow = (key) =>
    design.match(new RegExp(`^\\s+row-${key}:\\s*"(#[0-9a-f]{6})"`, "m"))?.[1];
  const copies = rowColors.map(({ name, bg, text }) => [name.toLowerCase(), name, bg, text]);

  it.each(copies)("DESIGN.md's row-%s and row-text are %s's pastel and text", (key, name, bg, text) => {
    expect(designRow(key), `DESIGN.md's row-${key} is not ROW_COLORS' ${name} bg`).toBe(bg);
    expect(designRow("text"), `DESIGN.md's row-text is not ROW_COLORS' ${name} text`).toBe(text);
  });
});

// DESIGN.md's frontmatter is the designer-facing copy of the palette — the one
// place that restates every token by hand, for whoever designs the next piece
// of UI — and nothing else keeps it honest. `foo-dark` is the dark block's
// `--foo`; `foo` is the light block's. The `row-*` entries are skipped here
// (they are the four puzzle pastels from ROW_COLORS in App.jsx, not CSS tokens
// at all — the row-name block above pins them to ROW_COLORS instead) and so
// are the two `backdrop` values, which are rgba() rather than hex.
describe("DESIGN.md's palette is index.css's tokens", () => {
  const block = design.match(/^colors:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
  const entries = [...block.matchAll(/^\s+([\w-]+):\s*"(#[0-9a-f]{6})"/gm)]
    .map(([, key, hex]) => [key, hex])
    .filter(([key]) => !key.startsWith("row-"));

  // Guards against a silent pass if the frontmatter is ever reshaped and the
  // scrape above stops finding anything (46 entries today).
  it("finds the palette to compare", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
  });

  it.each(entries)("%s is that token", (key, hex) => {
    const scheme = key.endsWith("-dark") ? "dark" : "light";
    const name = `--${scheme === "dark" ? key.slice(0, -"-dark".length) : key}`;
    expect(token(scheme, name), `DESIGN.md's ${key} is not ${name} in the ${scheme} block`).toBe(hex);
  });
});
