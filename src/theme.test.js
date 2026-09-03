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
// `:root[data-theme="dark"]` selector, dark after it (no token is redefined
// further down the stylesheet). The selector is matched at the start of a
// line so a mention of it in a comment can't split the file in the wrong
// place.
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

// Two tokens exist *because* of a contrast number, and their comments in
// index.css say so: --input-border is the edge of a field, which WCAG 1.4.11
// puts at 3:1 against everything it touches, and --error-text is running text
// at 4.5:1. Both have very little headroom in dark (--input-border on
// --surface is 3.09), so a nudge of either color — or of the fill behind it —
// can drop below the floor without looking any different. These recompute the
// ratios from the tokens themselves rather than trusting the comments.
describe("the tokens hold the contrast their comments promise", () => {
  // WCAG relative luminance: sRGB channel → linear, weighted 0.2126/0.7152/
  // 0.0722; the ratio is (lighter + 0.05) / (darker + 0.05).
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

// DESIGN.md's frontmatter is the designer-facing copy of the palette — the one
// place that restates every token by hand, for whoever designs the next piece
// of UI — and nothing else keeps it honest. `foo-dark` is the dark block's
// `--foo`; `foo` is the light block's. The `row-*` entries are skipped (they
// are the four puzzle pastels from ROW_COLORS in App.jsx, not CSS tokens at
// all) and so are the two `backdrop` values, which are rgba() rather than hex.
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
