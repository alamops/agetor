# Plan - Settings Dialog Max Height And Scroll
| Field | Value |
| --- | --- |
| Date | 2026-08-06 |
| Source | `/implement It's missing a max height and a scroll for the Settings screen` |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/settings-no-max-height |
| Base SHA | 4b9328fb64dfdc70e7208ceed89fa26807d82240 |

## 1. Objective & success criteria
Bound the Settings dialog to the viewport and make its content scroll vertically when it exceeds the available height.

Success criteria:
- Settings dialog panel has a viewport-relative max height.
- Header remains visible while list/template/editor content scrolls.
- Existing Settings subviews keep their current behavior and styling.

## 2. Context & constraints
- `src/mainview/components/ui/dialog.tsx` supplies a centered modal panel but does not impose a max height or internal body scroller on consumers.
- Similar larger dialogs use `flex max-h-[85vh] ... flex-col p-0` on `Dialog` and wrap body content in `min-h-0 flex-1 overflow-y-auto`.
- `src/mainview/components/settings/SettingsDialog.tsx` currently passes only `max-w-2xl`, then renders the header and active view directly in the panel.

## 3. Approach & key decisions
- Convert Settings dialog panel to a flex column with `max-h-[85vh]`, `w-full`, `max-w-2xl`, and `p-0`.
- Move the header padding onto the header container so it remains visually unchanged.
- Wrap the active view switch in a `min-h-0 flex-1 overflow-y-auto p-4 pt-0` body.
- Leave child view components unchanged to keep this a layout-only fix.

## 4. Work breakdown - implementation tasks
I1 - Bound and scroll Settings dialog
Files owned: `src/mainview/components/settings/SettingsDialog.tsx`
Acceptance: Settings content scrolls inside the modal instead of expanding past the viewport.

## 5. Work breakdown - test tasks
No automated test will be added for this CSS-only modal sizing change. Verification is typecheck/build-level validation.

E2E is not added because the repository does not have an existing webview E2E harness for modal visual layout, and adding one is outside this narrow bug fix.

## 6. Execution waves
- Wave 1: I1.
- Wave 2: Typecheck.

## 7. Blast radius & risks
Blast radius is limited to the Settings modal. The main risk is losing panel padding or making nested Settings subviews double-pad; the wrapper uses existing child `pt-3` spacing and keeps horizontal padding at the body level.

## 8. Open questions / assumptions
- Assumption: `85vh` is acceptable because sibling dialogs already use `85vh` or `86vh`.
