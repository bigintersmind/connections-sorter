// The Appearance preference — System / Light / Dark — and how it resolves to
// the scheme the page actually paints. Pure and framework-free so the rules
// are unit-tested (src/theme.test.js). The DOM side lives in App.jsx's
// useTheme (the data-theme attribute on <html>, the theme-color meta,
// localStorage, the matchMedia listener), and the same rule is inlined in
// index.html so the very first frame is already the right scheme.

// Its own localStorage key, separate from the board store: the pre-paint
// script in index.html reads it before any bundle has loaded, so it has to be
// a bare string it can compare directly, not a field inside the board JSON.
export const THEME_KEY = "connections-theme";

// The control's options, in display order.
export const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// Page background per resolved scheme — what the theme-color meta advertises
// to the browser chrome. Must match --bg in index.css and the pre-paint
// colors in index.html; theme.test.js checks all three agree.
export const THEME_COLORS = { light: "#f1efe5", dark: "#131210" };

// The stored value → a preference. Anything that isn't one of the two
// overrides (missing, corrupt, a value a future build might write) means
// "follow the system", which is always a safe answer.
export function parseThemePreference(raw) {
  return raw === "light" || raw === "dark" ? raw : "system";
}

// A preference → what to store, or null for "remove the key": following the
// system is the absence of an override, not a third stored value.
export function serializeThemePreference(pref) {
  return pref === "light" || pref === "dark" ? pref : null;
}

// The scheme to paint. An explicit preference wins; otherwise the OS decides.
export function resolveTheme(pref, systemPrefersDark) {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersDark ? "dark" : "light";
}
