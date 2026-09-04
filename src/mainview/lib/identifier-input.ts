import type { InputHTMLAttributes } from "react";

/**
 * The app ships inside the system WKWebView, which applies macOS's "Correct
 * spelling automatically" / "Capitalize words automatically" text services to
 * any editable field that doesn't explicitly opt out — same as Safari. Two
 * kinds of field never want that pass, and both spread this constant:
 *
 *  - **Identifier inputs** — project paths, branch/tag/ref names, naming
 *    patterns, host names, harness slugs and binary paths, GitHub logins,
 *    label names, team slugs, issue numbers, hex colours. The value has to
 *    match something exactly: `agetor` silently becoming `actor`, or `feat/`
 *    getting capitalized to `Feat/`, breaks the lookup or the remote call.
 *  - **Search / filter boxes** — every box whose text is *matched against*
 *    existing content rather than composed: the picker popovers, the Kanban
 *    and Worktrees filter bars (including their free-text boxes), the
 *    Extensions picker, the GitHub item search, the transcript search. A
 *    "corrected" query just finds nothing; there is no prose to improve.
 *
 * Composition fields deliberately do NOT spread it — the task Title and
 * Prompt, GitHub titles / descriptions / release notes, prompt names — the
 * user is writing sentences there and autocorrect is helpful, not hostile.
 * `type="password"` inputs never autocorrect, so they don't need it either.
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
 * One shared constant, spread (`{...IDENTIFIER_INPUT_PROPS}`) as the FIRST
 * prop at each site so an explicit local prop always wins, exists so a
 * future input adopts the full set in one line instead of re-deriving it —
 * several call sites had already drifted to a partial (`spellCheck`-only)
 * opt-out before this constant existed.
 *
 * One exception to "just spread it": an input that also carries `list="…"`
 * (backed by a `<datalist>`) spreads this constant and then sets
 * `autoComplete={undefined}` right after it. Per the HTML spec `autocomplete`
 * shouldn't gate datalist suggestions, but engines have differed (Firefox
 * historically hid them under `autocomplete="off"`), and the behaviour in
 * the app's WKWebView hasn't been verified either way — so the override
 * keeps the datalist exactly as it behaved before this constant existed
 * (React omits `undefined` props), at the cost of autofill staying on for
 * those three inputs. Once someone confirms the datalist still drops down
 * with `autocomplete="off"` in the packaged app, delete the overrides and
 * this paragraph.
 */
export const IDENTIFIER_INPUT_PROPS = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
} as const satisfies InputHTMLAttributes<HTMLInputElement>;
