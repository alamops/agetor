# Plan — Cmd+/Cmd− global font-size (UI zoom) control

| Field | Value |
| --- | --- |
| Date | 2026-08-11 |
| Source | /implement task: "Cmd+ and Cmd- to control the font size in whole agetor. Consider the current size as the default one and also the smaller. Set an enough maximum" |
| Config | AGENTS_CONFIG.yml (balanced preset, v1 schema) |
| Branch | feature/cmd-cmd-font-size-controller |
| Base SHA | 43709c7d87388ecb926623670e9ef4cfc427f591 |
| Mode | **Autonomous** — the grill and plan-approval gates were self-resolved; every assumption is logged in §8 |

## 1. Objective & success criteria

Cmd+= / Cmd+− (Ctrl on non-Mac dev builds) scale the font size of the entire agetor webview; Cmd+0 resets. The current size (root 16px) is both the default and the **minimum**; the maximum is **170%**, stepped in 10% increments. The chosen size persists as a preference and is applied **before first paint** on the next launch (no size-jump flash), exactly like the theme preference. The xterm terminal panes scale too (separate explicit path — xterm renders to canvas, outside the CSS cascade).

Success = shortcut works from anywhere in the app (including with a terminal focused), value clamps at 100/170, persists across restarts flash-free, terminal text scales and re-fits, `bun run typecheck` + `bun test` + `bunx playwright test` green.

## 2. Context & constraints (investigation findings, with anchors)

- **No root font-size is set anywhere** — `src/mainview/index.css` has no `html {font-size}` rule; WKWebView default 16px is in effect. `tailwind.config.js` has no `fontSize`/`spacing` overrides, so the whole UI is Tailwind default rem-based → setting `document.documentElement.style.fontSize` scales everything proportionally.
- **Sole absolute-px exception**: `src/mainview/components/kanban/TerminalView.tsx:108` — xterm `fontSize: 12`, set once at construction. Live-updatable via `term.options.fontSize` mirroring the theme-reactivity effect at `TerminalView.tsx:218-226`; must re-run `fit()` and notify the PTY (`sendResize`, `:135-139`) since glyph cell size changes cols/rows.
- **Preferences KV store**: `src/bun/db.ts:505-534` (`preferences.get/list/set`), routes `GET /preferences` + `PUT /preferences/:key` (`src/bun/server.ts:2571-2587`), client `api.listPreferences`/`api.setPreference` (`src/mainview/lib/api.ts:1049-1054`). Opaque string values — **no migration, no new route needed**.
- **Boot no-flash channels (theme precedent, to clone)**: `resolveThemePreference()` in `src/bun/window-url.ts:19-27` (sync DB read, swallow-throw → default) → `src/bun/index.ts:394-438` delivers via BOTH `window.__AGETOR` preload globals (packaged `views://` path — rejects URL fragments) AND `buildWindowHash` (`window-url.ts:38-40`, Vite dev path) → blocking inline `<head>` script in `src/mainview/index.html:7-64` applies before splash CSS parses. `ThemeProvider` seeds React state synchronously from the same globals/hash (`theme-provider.tsx:29-32,60-65`); `App.tsx:204-212` reconciles the DB value once at boot.
- **Shortcut pattern**: no central registry — features attach their own `document` keydown listeners (Escape: `RunPanel.tsx:249-259`; Cmd+F: `RunPanel.tsx:1397-1421` with `IS_MAC_PLATFORM` sniff at `:172-173`). Native menu (`src/bun/index.ts:51-92`) registers **no** Cmd+Plus/Minus/0 accelerators, so keydowns reach the webview's JS untouched.
- **Electrobun alternative rejected**: `BrowserWindow.setPageZoom/getPageZoom` exist (electrobun ^1.18.1) but are main-process-controlled, WebKit-only, untestable in the Chromium e2e harness, and add an IPC hop per step. Rem scaling matches the theme precedent. (Decision by reasoning, not spike — see §8.)
- **Test conventions**: no `.test.tsx` — pure logic extracted to `src/mainview/lib/*.ts` with co-located `bun test` files (`theme.ts`/`theme.test.ts` template). Bun-side preference/route tests: `src/bun/theme-preference.test.ts` (mkdtemp `AGETOR_DATA_DIR`, **unique** `AGETOR_API_PORT`, dynamic imports in `beforeAll`). E2e: Playwright — `playwright.config.ts`, `e2e/theme.spec.ts` template (`bunx playwright test`; `scripts/dev-headless.sh`, data dir `~/.agetor-dev-e2e`, pinned `E2E_API_TOKEN`; assert **computed styles**, never screenshots).

## 3. Approach & key decisions

- **Root rem scaling**: preference `fontSize` stores a percent as string (`"100"`…`"170"`). Applied as `document.documentElement.style.fontSize = (16 * pct/100) + "px"`; at exactly 100% the inline style is **removed/omitted** so the default state stays pristine (and boot channels can skip work).
- **Constants + clamp live in `src/shared/types.ts`** (the one both-process import point) so bun and mainview can't drift. `index.html`'s blocking script necessarily duplicates the minimal parse/clamp inline (no module imports pre-paint — same as theme).
- **Shortcut handling**: one `document` keydown listener in **capture phase** with `preventDefault()` when handled, owned by a new `FontSizeProvider` (clone of ThemeProvider's shape). Capture phase guarantees xterm's own key handlers can't swallow it; scope is intentionally global — the ask is "whole agetor", and terminal panes scale with everything else. Primary modifier: meta on Mac, ctrl elsewhere (the `IS_MAC_PLATFORM` approach; keeps Ctrl+− available to terminal programs on the shipped Mac build). Keys: `=`/`+` increase, `-`/`_` decrease, `0` reset; ignore when `altKey`.
- **Feedback**: sonner toast with a fixed `id: "font-size"` (updates in place, no stacking) showing e.g. "Font size: 120%", "Font size: maximum (170%)".
- **Persistence**: optimistic set + `api.setPreference("fontSize", …)` with rollback + toast on failure (ThemeProvider's pattern at `theme-provider.tsx:96-109`).
- **No Settings-dialog control in this slice** — the ask is shortcuts only; a General-section stepper is a natural follow-up (noted in §8).

### Exact contracts (both Wave-1 tasks code against these; typecheck at the barrier catches drift)

`src/shared/types.ts` (owned by T1):
```ts
export const FONT_SIZE_MIN = 100;      // percent — current size is default AND minimum
export const FONT_SIZE_MAX = 170;
export const FONT_SIZE_STEP = 10;
export const FONT_SIZE_DEFAULT = 100;
/** Parse anything (string|number|null|undefined) → int percent clamped to [MIN,MAX]; invalid → DEFAULT. */
export function clampFontSizePercent(raw: unknown): number;
```

`src/bun/window-url.ts` (T1): `resolveFontSizePreference(): number` (reads `preferences.get("fontSize")`, clamps, try/catch → `FONT_SIZE_DEFAULT`); `buildWindowHash` gains a `fontSize: number` field → `…&fontSize=<n>` (omit the param when 100 is acceptable, but keep the field required in the opts type).

`src/bun/index.ts` (T1): `window.__AGETOR = { port, token, theme, fontSize }`; the preload apply-script also sets `document.documentElement.style.fontSize` when pct ≠ 100.

`src/mainview/index.html` (T1): blocking script reads `window.__AGETOR.fontSize` first, hash `fontSize` param second; inline parse + clamp (100–170, invalid → 100); applies when ≠ 100 — before the splash `<style>`.

`src/mainview/lib/font-size.ts` (T2):
```ts
export type FontSizeAction = "increase" | "decrease" | "reset";
export function stepFontSize(pct: number, action: FontSizeAction): number;   // clamped
export function rootFontSizeStyle(pct: number): string | null;               // "19.2px" | null at 100
export function terminalFontSize(pct: number): number;                       // Math.round(12 * pct/100)
export function readFontSizeFromBoot(agetorGlobal: unknown, hash: string): number;
export function fontSizeShortcutAction(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  isMac: boolean,
): FontSizeAction | null;
```

`src/mainview/components/font-size-provider.tsx` (T2): `FontSizeProvider` + `useFontSize(): { percent, setPercent, increase, decrease, reset }` — synchronous boot seed, effect applying/removing the root inline style, capture-phase keydown, toast, optimistic persist w/ rollback. T2 also extends the `window.__AGETOR` type declaration (lives mainview-side) with `fontSize?`.

## 4. Work breakdown — implementation (Wave 1, parallel, file-disjoint)

**T1 — Boot channels & bun side.** Owns: `src/shared/types.ts`, `src/bun/window-url.ts`, `src/bun/index.ts`, `src/mainview/index.html`, `src/bun/theme-preference.test.ts` (its `buildWindowHash` assertions hardcode the hash shape and must be updated for the new field). Acceptance: constants/clamp exported per contract; all three boot channels deliver `fontSize`; at 100% no inline style is written; existing tests still pass.

**T2 — Mainview runtime.** Owns: `src/mainview/lib/font-size.ts`, `src/mainview/components/font-size-provider.tsx`, the `window.__AGETOR` type declaration, provider mount point (wherever `ThemeProvider` mounts — `main.tsx` or `App.tsx`), `App.tsx` boot reconcile (mirror theme's at `App.tsx:204-212`), `src/mainview/components/kanban/TerminalView.tsx` (live `term.options.fontSize` + refit + PTY resize; use the `resolvedRef` pattern at `:95-100` so the mount effect doesn't remount on change). Must verify `terminal-keys.ts` doesn't map Cmd+=/− (investigation says it doesn't). Acceptance: shortcut works globally incl. focused terminal; clamps with toast; persists; no WebSocket teardown on size change.

## 5. Work breakdown — tests (Wave 2, parallel, file-disjoint)

**T3 — Unit tests.** Owns: `src/mainview/lib/font-size.test.ts` (step/clamp/shortcut-parse edge cases: invalid strings, floats, alt-modifier, ctrl-vs-meta per platform, `+`/`_` shifted keys) and `src/bun/font-size-preference.test.ts` (clone `theme-preference.test.ts`: `resolveFontSizePreference` defaults/clamping/DB round-trip, `buildWindowHash` shape, `PUT /preferences/fontSize` route; **pick an `AGETOR_API_PORT` unused by any other test file**).

**T4 — E2e.** Owns: `e2e/font-size.spec.ts`, modeled on `e2e/theme.spec.ts`: (a) boot no-flash — seed `PUT /preferences/fontSize=140` via API token, load, assert computed `documentElement` font-size early via `addInitScript`; (b) shortcut steps the computed size (`expect.poll`); (c) clamps at 170 and at 100; (d) Cmd/Ctrl+0 resets; (e) persistence across `page.reload()`. Assert computed values only. E2e applies because the feature is a user-visible whole-app flow crossing webview→API→DB; the harness exists and runs headless via `scripts/dev-headless.sh`.

## 6. Execution waves

1. **Wave 1**: T1 ∥ T2 → barrier → `bun run typecheck` + `bun test` sanity → commit.
2. **Phase 5**: code review (opus) of `git diff 43709c7…HEAD`.
3. **Wave 2**: T3 ∥ T4 → commit.
4. **Phase 7**: runner executes `bun run typecheck`, `bun test`, `bunx playwright test` (owns the whole e2e lifecycle).
5. **Phase 8**: fixes if needed, re-run to green (cap 3 rounds).

## 7. Blast radius & risks

- `buildWindowHash` signature change → `src/bun/index.ts` call site + `theme-preference.test.ts` (both owned by T1).
- Capture-phase `preventDefault` on Cmd+=/−/0 removes any browser-default zoom in dev Chromium (intended; the packaged WKWebView had none).
- xterm font change alters cols/rows → must `fit()` + `sendResize` or the PTY renders stale geometry.
- Rem scaling scales Tailwind spacing too (`w-80` etc.) — intended "whole UI zoom" behavior, but at 170% narrow layouts get tighter; min=100 caps the risk downward.
- The three boot channels must stay consistent — same clamp everywhere; `index.html` duplication is deliberate (no pre-paint imports), same as theme.

## 8. Open questions / assumptions (autonomous-mode log)

1. **Max = 170%, step = 10%** — "enough maximum" interpreted as generous-but-layout-safe; trivially adjustable via the shared constants.
2. **Cmd+0 reset added** though not asked — standard zoom convention, near-zero cost.
3. **Rem scaling chosen over Electrobun `setPageZoom`** (reasoning in §2/§3; no spike run — the API exists but is untestable in the e2e harness and main-process-bound).
4. **Shortcut fires even with a terminal focused** — "whole agetor" framing; terminal emulator-style per-pane font zoom rejected.
5. **No Settings-dialog stepper in this slice** — natural follow-up in `GeneralSection` (`SettingsDialog.tsx:570-647`).
6. Both human gates (grill, plan approval) self-resolved under autonomous mode.
