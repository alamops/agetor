# Plan — Theme selector (Auto / Dark / Light) + Light theme

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Source | `/implement` — "increment the Theme in Settings → General (Auto default, uses system; Dark as-is; Light new) and implement the Light theme" |
| Config | AGENTS_CONFIG.yml (v1, `balanced` preset) |
| Branch | `fix/light-auto-theme` (reset onto `origin/main` @ `ce9a842`) |
| Base SHA | `ce9a842` |

## 1. Objective & success criteria

Add a **Theme** setting to Settings → General with three values — **Auto** (default, follows the OS), **Dark** (today's look, unchanged), **Light** (new) — and deliver a genuine light visual pass so the app is fully usable in light mode.

Done when:
1. Settings → General shows a 3-way Theme picker; the choice persists across restarts.
2. `Auto` follows the OS at launch **and** live-reacts when macOS flips appearance while the app is open.
3. Switching theme repaints immediately — no reload, no restart.
4. **No flash of the wrong theme on launch**, including the splash screen.
5. Nothing in the app is unreadable or visibly untuned in light mode — including the terminal (xterm), toasts (sonner), the update/tmux banners, DiffDialog, and GitHubDialog.
6. `bun run typecheck` green, `bun test` green, Playwright e2e green.
7. `CLAUDE.md`'s dark-only UI convention is updated to describe the new reality.

Non-goals: no per-window/per-task theme; no custom user palettes; no high-contrast/accessibility mode beyond fixing contrast; no restyling of the app icon or splash logo art.

## 2. Context & constraints (grounded findings from Phase 1)

**The token layer is already theme-ready.** `src/mainview/index.css:6-24` defines a complete light palette in `:root`; `index.css:27-45` overrides it in `.dark`. `tailwind.config.js:3` is `darkMode: "class"`. The only reason light mode doesn't exist is that `src/mainview/index.html:2` hardcodes `<html lang="en" class="dark">`. Every token pair (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`) is present symmetrically in both blocks — no missing pairs.

**Persistence needs no migration.** `src/bun/db.ts:445-471` exposes a generic key-value `preferences` store (table created in `migrations/011_preferences.sql`), served by `GET /preferences` and `PUT /preferences/:key` (`src/bun/server.ts:2527-2542`) and wrapped client-side by `api.listPreferences()` / `api.setPreference()` (`src/mainview/lib/api.ts:1023-1027`). Existing keys are opaque strings (`defaultHarness`, `lastModel:<agent>`, …). A `theme` key slots straight in.

**Flash-of-wrong-theme is guaranteed without a boot-time hook.** `src/mainview/App.tsx:219-235` does not fetch `/preferences` at boot; `SettingsDialog` fetches it only on open. The webview has **zero** `localStorage`/`sessionStorage` usage. Meanwhile `src/bun/index.ts:427-434` already builds the window URL as `${url}#api=${API_PORT}&token=${API_TOKEN}` — so the Bun process, which reads the DB before creating the window, is the natural place to resolve the theme and hand it to the webview synchronously. `index.html:7-20` also hardcodes a `#splash { background: #000 }` with a comment noting it mirrors the `.dark --background` token.

**Blast radius is smaller and more concentrated than the dark-only history suggests** (census over `src/mainview/`, re-checked against the `ce9a842` delta — only 2 new literal hits landed in the 5 commits pulled in):
- **Zero** `zinc/slate/gray/neutral/stone` utility classes. All chrome, surfaces, and the 13 `ui/` primitives already run on semantic tokens.
- **219** literal palette-class occurrences, but ~150 flow through **5 choke-point maps**: `FILE_STATUS_META` (`GitHubDialog.tsx:452`, and a twin at `DiffDialog.tsx:25`), `workflowRunClass` (`GitHubDialog.tsx:5190`), `checkClass` (`:6771`), `commitStatusClass` (`:6782`), `MERGE_TONE_CLASS` (`:6789`).
- Distribution: `GitHubDialog.tsx` 131, `UpdateBanner`+`TmuxMissingBanner` 26, `DiffDialog` 15, `SettingsDialog`+badge idiom 17, `RunPanel` 10, `WorktreesDialog` 7, `TaskCard`/`App`/misc 7.
- Most frequent: `text-rose-400` ×77, `text-emerald-400` ×32, `text-amber-400` ×12, `text-sky-400` ×10, `text-amber-500` ×10.

**Three true breakages** (not merely low-contrast):
- `UpdateBanner.tsx:64-93` and `TmuxMissingBanner.tsx:36-59` use `text-emerald-100` / `text-amber-100` / `-200` — near-white text, effectively invisible on a light background.
- `TerminalView.tsx:12-18` hardcodes `XTERM_THEME` as raw hex (`#09090b` bg, `#e4e4e7` fg). xterm renders to its own canvas and **cannot** read CSS variables — it needs a parallel light object and a live re-apply on theme change. `TerminalView.tsx:272` also pins the container to `bg-[#09090b]`, and `:109,:112` emit `\x1b[90m` (bright-black) reconnect text.
- `ui/sonner.tsx:14-19` passes `theme="dark"` literally, with a comment explicitly flagging it as the blocker for a light mode.

**Already-correct spots to preserve:** `ui/dialog.tsx:152`'s `bg-black/60` modal scrim is intentional in both themes; `TaskCard.tsx:152`'s `bg-amber-500 text-amber-950` chip is background-independent; `GitHubDialog`'s `labelSwatch` renders user-supplied GitHub label hex and must stay literal; `RunPanel.tsx:4322` already ships a `text-green-600 dark:text-green-400` pair — a template for the conversion, currently dead code.

**Undefined-token trap (verified, from fleet knowledge).** Tailwind emits *nothing* for a semantic class whose token isn't in both `tailwind.config.js` and `index.css` — e.g. `bg-popover` compiles to zero CSS in this repo and renders transparent. This is why token definition must land *before* any conversion, in the same wave-1 task. `GitHubDialog.tsx` reportedly already carries a latent instance of this bug (`bg-popover`/`text-popover-foreground`); fix it while converting that file.

**Spike verdict — Playwright is FEASIBLE** (proven end-to-end, not assumed). `origin/main` ships `scripts/dev-headless.sh` (from `94b1f2d`) which starts Vite on :5173 plus `src/bun/headless.ts` — the real Bun API and orchestrator with no Electrobun window — and prints `http://localhost:5173/#api=4318&token=<token>`, persisting the token to `$AGETOR_DATA_DIR/headless-dev/token`. `API_TOKEN` is env-settable via `AGETOR_API_TOKEN` (`src/bun/api-config.ts`), and `ALLOWED_ORIGINS` (`server.ts:434-435`) already whitelists `http://localhost:5173`. The spike drove Chromium against a live board (5 real tasks), toggled the `dark` class, and captured correctly-rethemed light and dark screenshots. Caveats it surfaced: navigate by `localhost`, not `127.0.0.1` (Vite binds IPv6 here); two native-only routes return 501 headless (harmless for theme work); pin `AGETOR_API_TOKEN` for determinism rather than scraping the token file; Chromium ≠ WKWebView for pixel-perfect font rendering, so assert **computed colors**, not pixel diffs.

**Test seam.** No DOM/testing-library harness exists and none is being added. The repo's convention is to extract pure logic into `src/mainview/lib/*.ts` and unit-test it with `bun test` (~20 such files; `settings-dialog-view.test.ts` is the closest analogue). Bun-side route tests set `AGETOR_DATA_DIR` to an `mkdtemp` dir and a unique `AGETOR_API_PORT` *before* dynamically importing `db.ts`/`server.ts` (`project-settings-endpoint.test.ts:1-30` is the template).

## 3. Approach & key decisions

**D1 — Theme resolves in the Bun process and rides the boot URL hash.** `src/bun/index.ts` reads `preferences.get("theme")` before constructing the `BrowserWindow` and appends `&theme=<pref>` to the existing hash. A small blocking `<script>` in `index.html`'s `<head>` — placed *before* the splash `<style>` — parses it, resolves `auto` via `matchMedia`, and sets the `dark` class plus `color-scheme` on `<html>` before first paint. *Chosen over* localStorage (would introduce the repo's first client-side store and a second source of truth that can drift from SQLite) and over applying in React (guarantees a visible dark flash on every light-mode launch). Fits the existing `#api=…&token=…` house pattern exactly. **Rests on read evidence, not a spike** — verify the hash survives both the `views://` bundled path and the Vite dev path during implementation.

**D2 — `auto` is resolved on the client, not baked server-side.** Bun passes the *preference* (`auto`/`dark`/`light`), never the resolved value, so the webview owns `matchMedia` and can live-react to an OS appearance change without a restart. Setting `color-scheme` on `<html>` additionally fixes native scrollbars and form controls, which no CSS variable reaches.

**D3 — Four new semantic status tokens: `--success`, `--warning`, `--info`, `--danger`.** Each gets a light+dark pair in `index.css` and an entry in `tailwind.config.js`, mirroring the existing token shape (`hsl(var(--x))`, which the repo already proves works with opacity modifiers like `bg-destructive/10`). `--danger` is added *alongside* `--destructive` rather than reusing it: `--destructive` is a **surface** color (dark red `0 62.8% 30.6%` in dark mode, used for `bg-destructive` buttons) and is too dark to serve as error *text* on a dark background — which is exactly why the codebase reached for `text-rose-400` 77 times instead. Conflating them would regress dark mode.

**D4 — Convert all ~219 literals, not just the breakages** (your call in Phase 2). The 5 choke-point maps make ~150 of them a small edit, and tokenizing now means future components are theme-correct by default instead of accruing more debt.

**D5 — One shared `ThemeProvider` context**, created in wave 1 so every wave-2 consumer (Settings, terminal, toasts) can import it without prop-drilling through `App.tsx`. Optimistic local update on change, then `PUT /preferences/theme` — matching how `onPickDefault`/`onPickTmuxSource` already behave (`SettingsDialog.tsx:213-246`), since preference changes are not broadcast over SSE.

**D6 — Segmented 3-button picker**, reusing the `grid-cols-3` + `variant={active ? "default" : "outline"}` idiom already used for the harness-type choice (`SettingsDialog.tsx:790-815`), rather than a `Select`. Same file, same visual language, and it's already the house pattern for a fixed 3-way enum.

**D7 — Playwright asserts computed colors, not screenshot pixel-diffs.** Chromium's font rendering differs from WKWebView, so pixel baselines would be flaky and would fail against the app users actually run. Screenshots are captured as human-reviewable artifacts; the *assertions* read `getComputedStyle` and the `dark` class.

## 4. Work breakdown — implementation tasks

### T1 — Foundation: tokens, types, theme module, boot path *(wave 1, blocks everything)*
**Owns:** `src/shared/types.ts`, `src/mainview/index.css`, `tailwind.config.js`, `src/mainview/lib/theme.ts` *(new)*, `src/mainview/components/theme-provider.tsx` *(new)*, `src/mainview/index.html`, `src/bun/index.ts`
**Goal:** every downstream task can rely on the tokens, the types, and a mounted theme context existing.
- `ThemePreference = "auto" | "dark" | "light"` and `ResolvedTheme = "dark" | "light"` in `src/shared/types.ts`, plus a `THEME_PREFERENCES` list for the UI.
- Add `--success{,-foreground}`, `--warning{,-foreground}`, `--info{,-foreground}`, `--danger{,-foreground}` to **both** `:root` and `.dark` in `index.css`, and the matching entries in `tailwind.config.js`. Both files, same task — a token in one but not the other silently emits no CSS.
- `lib/theme.ts` — pure, no DOM: `parseThemePreference(v: unknown): ThemePreference` (defaults `auto`), `resolveTheme(pref, systemPrefersDark): ResolvedTheme`, `readThemeFromHash(hash: string): ThemePreference`.
- `theme-provider.tsx` — context exposing `{ preference, resolved, setPreference }`; seeds from the hash, subscribes to `matchMedia("(prefers-color-scheme: dark)")` only while `preference === "auto"`, applies the `dark` class + `color-scheme` to `<html>`, and persists via `api.setPreference("theme", …)` optimistically.
- `index.html` — blocking inline `<script>` in `<head>` before the splash `<style>`; replace the hardcoded `#splash { background: #000 }` with theme-conditional rules (`html.dark #splash {…}` / `html:not(.dark) #splash {…}`) so the splash matches.
- `src/bun/index.ts` — read `preferences.get("theme")`, append `&theme=<pref>` to the window URL hash. Must work for both the `views://` bundled URL and the `http://localhost:5173` dev URL.
**Acceptance:** `bun run typecheck` green; launching with `theme` unset behaves exactly as today (dark); manually setting the DB key to `light` launches light with no dark flash.

### T2 — Theme picker in Settings → General + App wiring *(wave 2)*
**Owns:** `src/mainview/App.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`
**Goal:** the user-facing control, and the provider mounted at the app root.
- Mount `<ThemeProvider>` in `App.tsx` around the tree; reconcile `preference` from `/preferences` on boot (the hash is authoritative at launch; this only catches out-of-band DB edits).
- Add a **Theme** row to `GeneralSection` (`SettingsDialog.tsx:545`) using the `grid-cols-3` segmented-button idiom from `:790-815`, matching the surrounding `<section className="space-y-1">` → `<label className="text-xs text-muted-foreground">` → control → `<p className="text-[11px] text-muted-foreground">` help-text structure. Help text should say Auto follows the system appearance.
- Convert this file's ~10 literal colors (the `bg-amber-500/15` "experimental" pill idiom, `text-amber-500` validation warnings) and `App.tsx:730`'s `bg-emerald-500`/`bg-red-500` availability dot onto the new tokens.
**Acceptance:** picker renders in General, reflects the persisted value, switching repaints instantly, survives restart.

### T3 — GitHubDialog conversion *(wave 2)*
**Owns:** `src/mainview/components/kanban/GitHubDialog.tsx`
**Goal:** the single largest surface (131 hits) tokenized.
- Convert the 4 choke-point maps (`FILE_STATUS_META:452`, `workflowRunClass:5190`, `checkClass:6771`, `commitStatusClass:6782`, `MERGE_TONE_CLASS:6789`) and the ~90 duplicated inline `text-rose-400` / `text-emerald-400` spans.
- Also fix the latent **undefined-token** bug: replace any `bg-popover`/`text-popover-foreground` with the house convention `border border-border bg-card text-card-foreground`.
- **Leave `labelSwatch` and its inline `style={{ backgroundColor }}` alone** — those render user-supplied GitHub label hex and are correct in both themes.
**Acceptance:** zero `rose|emerald|amber|sky` literals remain except intentional exclusions; no visual change in dark mode.

### T4 — Diff, run panel, worktrees conversion *(wave 2)*
**Owns:** `src/mainview/components/kanban/DiffDialog.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/worktrees/WorktreesDialog.tsx`
**Goal:** diff add/del/hunk coloring and status text tokenized.
- `DiffDialog.tsx:25-28` twin of `FILE_STATUS_META`; the row backgrounds at `:894-896,:911-912`; counters at `:634-635,:820`.
- `RunPanel.tsx` — the emerald "agent live" ping dots (`:3220-3221,:3705-3706`), the amber warning box (`:5300-5302`), and `:4322`'s stale `text-green-600 dark:text-green-400` pair (replace with the token; the `dark:` variant becomes unnecessary).
- `WorktreesDialog.tsx` status text (7 hits).
- Do **not** touch `src/mainview/lib/diff-rows.ts` — it carries no colors and needs none.
**Acceptance:** diff rows legible in both themes; dark mode visually unchanged.

### T5 — Banners and badge idiom *(wave 2)*
**Owns:** `src/mainview/components/updater/UpdateBanner.tsx`, `src/mainview/components/tmux/TmuxMissingBanner.tsx`, `src/mainview/components/tmux/TmuxInstallDialog.tsx`, `src/mainview/components/settings/GitHubSetupDialog.tsx`, `src/mainview/components/kanban/BranchPicker.tsx`, `src/mainview/components/kanban/AttachmentChips.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/ResolveConflictsDialog.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`
**Goal:** kill the two genuine BREAKS and normalize the repeated warning-badge idiom.
- The `-100`/`-200` near-white text tones in both banners **must not survive** — they are the invisible-on-light cases.
- `TaskCard.tsx:152`'s `bg-amber-500 text-amber-950` chip is background-independent; keep it unless the token version is a clean equivalent. `TaskCard.tsx:76`'s `ring-amber-500/60` awaiting-pulse should move to `--warning`.
**Acceptance:** both banners legible on white and on near-black.

### T6 — Terminal (xterm) and toasts *(wave 2)*
**Owns:** `src/mainview/components/kanban/TerminalView.tsx`, `src/mainview/components/ui/sonner.tsx`
**Goal:** the two surfaces CSS cannot reach.
- Split `XTERM_THEME` into dark/light objects; select via `useTheme()`; **re-apply on theme change** (`term.options.theme = …`) so an open terminal repaints without remount. Update the `bg-[#09090b]` container (`:272`) to a token. Reconsider the `\x1b[90m` reconnect text (`:109,:112`) — bright-black is poor on light.
- `sonner.tsx` — replace the hardcoded `theme="dark"` with the resolved theme, and delete the now-stale "Dark-only … swap this for next-themes" comment at `:14-19`.
**Acceptance:** terminal and toasts both follow the active theme, including a live switch with a terminal tab open.

### T7 — Docs *(wave 2)*
**Owns:** `CLAUDE.md`
**Goal:** the UI-conventions section currently says dark is "the only currently supported theme" and "don't add a theme toggle without also adding a light visual pass." Rewrite it to describe the shipped model: the three preferences, where the boot resolution happens, the status-token set, and the rule that new components must use semantic tokens rather than literal palette classes.

## 5. Work breakdown — test tasks

### T8 — Pure-logic unit tests *(wave 3)*
**Owns:** `src/mainview/lib/theme.test.ts` *(new)*
`parseThemePreference` (valid values, garbage → `auto`, `undefined` → `auto`); `resolveTheme` across all 3 × 2 combinations; `readThemeFromHash` (present, absent, malformed, and alongside `api`/`token` params). Matches the `bun:test` idiom of `settings-dialog-view.test.ts`.

### T9 — Bun-side boot + persistence tests *(wave 3)*
**Owns:** `src/bun/theme-preference.test.ts` *(new)*
`PUT /preferences/theme` → `GET /preferences` round-trip; rejection of a non-string body; the default when the key is absent. Uses the `mkdtemp` + `AGETOR_DATA_DIR` + unique `AGETOR_API_PORT` + dynamic-import boilerplate from `project-settings-endpoint.test.ts:1-30`. If T1 extracts the hash-building into a testable helper, cover it here too.

### T10 — Playwright e2e harness *(wave 3)*
**Owns:** `playwright.config.ts` *(new)*, `e2e/theme.spec.ts` *(new)*, `package.json` (devDep + script)
**Applies because** this is a user-visible flow crossing the UI→API→DB boundary, and the spike proved it runs. Recipe (from the spike):
1. `webServer` runs `AGETOR_DATA_DIR="$HOME/.agetor-dev" AGETOR_API_PORT=4318 AGETOR_API_TOKEN=<pinned> scripts/dev-headless.sh start`, teardown `… stop`.
2. `page.goto("http://localhost:5173/#api=4318&token=" + token)` — **`localhost`, not `127.0.0.1`**.
3. Wait on real rendered content, not a fixed sleep.
Specs: default launch resolves a theme without a flash; selecting Light in Settings → General flips `<html>`'s class and the computed `background-color`, and persists across a reload; selecting Dark restores; Auto tracks the emulated OS preference via `page.emulateMedia({ colorScheme })`. Capture light/dark screenshots as artifacts. **Assert computed colors and classes — never pixel diffs** (Chromium ≠ WKWebView).

## 6. Execution waves

- **Wave 1** — T1 alone. Tokens, types, provider, and boot path must exist before anything imports them.
- **Wave 2** — T2, T3, T4, T5, T6, T7 in parallel. File sets verified disjoint; every file appears in exactly one task.
- **Wave 3** — T8, T9, T10 in parallel (Phase 6). Disjoint; only T10 touches `package.json`.
- **Then** — Phase 5 review on the wave-1+2 diff, Phase 7 test run (unit + e2e), Phase 8 fixes, plus a manual `bun run dev:hmr` screenshot pass over the main surfaces in both themes.

## 7. Blast radius & risks

| Risk | Mitigation |
| --- | --- |
| **Undefined-token silence** — a semantic class whose token is missing from `index.css` *or* `tailwind.config.js` compiles to nothing and renders transparent. Historically slipped review here. | Both files land together in T1, before any consumer. Review step: grep every new `bg-*`/`text-*` token against `index.css`. |
| **Dark-mode regression** — the visible risk of touching 219 call sites is breaking the theme that works today. | Every new token's dark value must reproduce the literal it replaces (`--danger` dark ≈ `rose-400`, `--success` dark ≈ `emerald-400`, …). Dark screenshots compared before/after. |
| **Boot hash doesn't survive one of the two URL paths** (`views://` vs Vite dev). D1 rests on reading, not a spike. | T1 verifies both paths explicitly; the e2e suite exercises the dev path, manual launch exercises the bundled path. |
| Splash still flashes black in light mode | Splash rules become theme-conditional in the same inline block that sets the class. |
| xterm doesn't repaint on live theme switch | T6 must re-assign `term.options.theme`, not only pick at mount. Explicit acceptance criterion. |
| Playwright flakiness in CI | Assert computed colors, not pixels; pin `AGETOR_API_TOKEN`; wait on content, not sleeps. CI needs `playwright install chromium`. |
| `~/.agetor-dev` vs `~/.agetor` | All dev/e2e runs pin `AGETOR_DATA_DIR="$HOME/.agetor-dev"`. Never the real data dir. |
| Merge conflicts with `origin/main` | Branch was reset to `ce9a842` at plan time; land promptly. |

Rollback: the feature is additive. Reverting the branch restores hardcoded `class="dark"`. There is no migration and no schema change, so a rolled-back build simply ignores an orphaned `theme` row in `preferences`.

## 8. Open questions / assumptions

- **Assumed** the light palette already in `:root` (`index.css:6-24`) is a good starting point and needs only the new status tokens, not a redesign. If it looks wrong once rendered, tuning those values is in scope for Phase 8.
- **Assumed** no native window `backgroundColor` change is needed — `src/bun/index.ts:427-434` passes none today, and the splash covers the pre-paint window. Revisit only if a light-mode launch shows a dark frame.
- **Deferred:** whether the `--success/--warning/--info/--danger` tokens should also be applied to the CLI/TUI (`src/cli/`). Out of scope — this is a webview theme.
- **Open:** whether Playwright should run in CI or stay a local command. Plan adds the harness and a script; wiring it into a CI workflow is not included.
