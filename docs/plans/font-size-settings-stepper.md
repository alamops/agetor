# Plan — Settings → General font-size stepper

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | Follow-up to docs/plans/cmd-font-size-controller.md ("no Settings stepper yet"); user: "/implement it" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/cmd-cmd-font-size-controller |
| Base SHA | 8551625 (tip after the shortcut slice) |
| Mode | Autonomous (small, fully-specified slice; assumptions logged in §4) |

## 1. Objective

A "Font size" section in Settings → General (`GeneralSection`, `src/mainview/components/settings/SettingsDialog.tsx:570-647`) that shows the current percent and steps it ±10% within [100, 170], with a reset affordance — a discoverable mirror of the existing Cmd+/Cmd−/Cmd+0 shortcuts. All state/persistence/clamping already lives in `useFontSize()` (`font-size-provider.tsx`); this slice adds UI only.

## 2. Design (contract pinned for the e2e task)

New `<section>` after the Theme section, matching its label/control/hint shape:

- Row: outline icon `Button` **aria-label "Decrease font size"** (lucide `Minus`, disabled at `percent <= FONT_SIZE_MIN`) · percent readout `{percent}%` (tabular-nums, fixed width) · outline icon `Button` **aria-label "Increase font size"** (lucide `Plus`, disabled at `percent >= FONT_SIZE_MAX`) · ghost `Button` **aria-label "Reset font size"**, text "Reset", disabled at `percent === FONT_SIZE_DEFAULT`.
- Hint (`text-[11px] text-muted-foreground` like the Theme hint): platform-aware via `isMacPlatform()` — "⌘= / ⌘− work anywhere; ⌘0 resets." (Ctrl variants on non-Mac).
- Clicks call the context's `increase`/`decrease`/`reset` (persistence, debounce, clamping already handled there; whether the shared path toasts on stepper clicks is the implementer's call — visible readout change is the primary feedback, don't add a second feedback path).

## 3. Work breakdown

- **I1 (sonnet)**: `SettingsDialog.tsx` only (+ `font-size-provider.tsx` strictly if the context surface is missing something — not expected). Typecheck + existing tests stay green.
- **Review (opus)**: diff of I1.
- **E1 (sonnet)**: extend `e2e/font-size.spec.ts` with a Settings-driven test mirroring the theme picker e2e: open Settings → General, click increase twice → computed root 19.2px, readout "120%", persisted "120" (debounce-aware poll); reset → 16px; bound-disabled assertions. Sequenced after I1 (needs the real selectors).
- **Run (haiku)**: typecheck + bun test + full playwright.

## 4. Assumptions (autonomous)

1. Stepper (−/%/+/Reset) over a slider or select — matches the discrete 10% steps and the button-row idiom already in GeneralSection.
2. Placement after Theme; no new Settings section.
3. Reset button always rendered, disabled at 100% (stable e2e selector, clearer affordance).
