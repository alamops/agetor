# Task card mockup and checker

The measured mockup behind the layout decision in [`../task-card-ui-overhaul.md`](../task-card-ui-overhaul.md). The owner picked **C1** on 2026-11-18. `renderC1` in `render.mjs` is the reference markup for the new `TaskCard`, and `checker.js` is the in-page checker that `e2e/task-card-bounds.spec.ts` ports.

| File | What it is |
| --- | --- |
| `states.mjs` | The 12 worst-case card states (26-char pipeline name, 25-char profile, 38-char model · mode, every count, 128-char title with a long path token, `Answer (12)`, long repo + `not on PR head`). |
| `render.mjs` | Today's card (`renderToday`, the control), layouts A, B, C, and the refinements C1 (picked) and C2. |
| `checker.js` | `window.checkCards()`: every child inside the card (clip-aware), every block child inside its row, no overlapping flex siblings, no text squeezed below 24 px, the hat name, progress and title never cut, buttons ≥ 24×24 with an accessible name, no buttons nested in a `role=button` card, text contrast ≥ 4.5:1. |
| `page.mjs` | Builds `page.html` (cards in light and dark, live checks, engine results). |
| `measure.mjs` | Loads the page in Playwright Chromium and WebKit and writes `results.json`. |
| `input.css`, `tw.config.mjs` | The app's tokens (from `src/mainview/index.css`) plus `--warning-solid-foreground`, compiled with the app's Tailwind config. |

## Re-run it

From the repo root, after `bun install` (Playwright's Chromium and WebKit must be installed: `bun node_modules/@playwright/test/cli.js install chromium webkit`):

```bash
D=docs/plans/task-card-ui-overhaul-mockup
node $D/page.mjs                                                   # page.html, used as Tailwind content
node node_modules/tailwindcss/lib/cli.js -c $D/tw.config.mjs -i $D/input.css -o $D/out.css
node $D/page.mjs && node $D/measure.mjs && node $D/page.mjs        # measure, then embed the results
```

`page.html`, `out.css`, `page.local.html`, `results.json` and `shot-*.png` are generated; don't commit them.

## Results on 2026-11-18 (tailwindcss 3.4.19, Playwright 1.62.1)

| Layout | Chromium | WebKit | Avg / max height (light) |
| --- | --- | --- | --- |
| Today | 0/24 | 0/24 | 287 / 425 px |
| A · Meta footer | 24/24 | 24/24 | 260 / 354 px |
| B · Identity header | 24/24 | 24/24 | 252 / 355 px |
| C · Title first | 24/24 | 24/24 | 252 / 356 px |
| **C1 · Title, then two quiet lines** | **24/24** | **24/24** | **249 / 353 px** |
| C2 · Title, preview, then meta | 24/24 | 24/24 | 245 / 349 px |

Today's card fails on: the stack chip 26–27 px outside the card, the gate row's Delete 35 px outside, buttons nested in a `role=button` card, icon buttons without `aria-label`, the workdir line at 2.74:1 (light), and the gate Stop at 1.99:1 (dark).
