import type { InputHTMLAttributes } from "react";

/**
 * The app ships inside the system WKWebView, which applies macOS's "Correct
 * spelling automatically" / "Capitalize words automatically" text services to
 * any editable field that doesn't explicitly opt out — same as Safari. The
 * fields this constant targets (project/branch search boxes, branch names,
 * naming patterns, host names) hold identifiers, never prose, so a
 * correction pass is never wanted there: `agetor` silently becomes `actor`,
 * `feat/` gets capitalized to `Feat/`, and so on. Prose fields (task Title,
 * Prompt) deliberately do NOT spread this — the user is typing sentences
 * there and autocorrect is helpful, not hostile.
 *
 * Each attribute defeats a distinct WebKit service, so all four are needed
 * together rather than any one alone: `autocorrect="off"` is the explicit
 * switch (Safari on macOS has honoured it since 14.1); `spellcheck={false}`
 * removes the red-underline markers *and* the correction pass that rides on
 * spell checking; `autocapitalize="off"` defeats the separate
 * capitalize-words service, which isn't gated by either of the above; and
 * `autocomplete="off"` keeps form autofill from popping a suggestion list
 * over what's usually a popover.
 *
 * One shared constant, spread (`{...IDENTIFIER_INPUT_PROPS}`) at each site,
 * exists so a future identifier input adopts the full set in one line
 * instead of re-deriving it — several call sites had already drifted to a
 * partial (`spellCheck`-only) opt-out before this constant existed.
 *
 * One exception to the "just spread it" pattern: an input that also carries
 * `list="…"` (backed by a `<datalist>`) spreads this constant and then sets
 * `autoComplete={undefined}` right after it, because `autocomplete="off"`
 * can suppress datalist suggestions in some engines — React omits
 * `undefined` props entirely, so the datalist keeps working while the other
 * three correction attributes still apply.
 */
export const IDENTIFIER_INPUT_PROPS = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
} as const satisfies InputHTMLAttributes<HTMLInputElement>;
