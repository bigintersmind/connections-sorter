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

// The pre-paint script can't import this module, so it repeats the key and
// the two colors by hand. These pin the copies to the originals.
describe("index.html and index.css agree with theme.js", () => {
  const html = read("../index.html");
  const css = read("./index.css");

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
