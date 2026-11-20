# Grill — broken preview for images picked with the Files Picker

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Pipeline task prompt (owner report + `~/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png`); investigation brief `docs/plans/picked-image-preview-tcc-investigation.md` |
| Mode | Interactive, through the decision form, answered by the owner in 1 round. The form server was stopped when the earlier session ended, before it wrote `answers.json`. The owner then pasted the submitted answers (submittedAt `2026-11-18T21:26:32.653Z`) into chat, and they are saved verbatim. The file has no `summary` or `specSha256` block for that reason. |
| Answers | `docs/plans/picked-image-preview-tcc-grill/round-1/answers.json` (questions: `round-1/questions.json`) |
| Flags | none |
| Spec | Outside the repo: the owner's Desktop screenshot. Per `c-spec`, the plan restates the symptom in-repo, and the screenshot is not committed. |

Every required question was answered (20 of 21; `copy-lifetime` was hidden by `showIf`, so it does not apply). Every answer matches the recommendation it was offered. Neither one-way door (`mechanism`, `agent-chosen`) is left open.

## Facts proved during the grill (on top of the investigation)

- **Agents in tmux read picked originals.** This step runs as Claude Code in Agetor's tmux, and its Read tool opened `~/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png`. Copying is therefore needed for the thumbnail, not for the agent (cursor and fx are a separate question; see D13).
- **`dataDir/screenshots` is unbounded.** On the owner's machine it holds 573 files (117 MB), and no retention or delete path touches it. A drag copy is renamed `screenshot-<utc-ts>-<id>.<ext>` (`src/bun/server.ts:7711-7717`).
- **The open panel runs in the core process.** `/refs/pick` calls `openFileDialogLabelled` (`server.ts:1432`), which calls `native.openFileDialog`, Electrobun over FFI in the Bun process. A copy made at pick time is made by the process that holds the user-intent grant. It is still unproven that this triggers no prompt; the D15 spike checks it.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Mechanism (one-way door) | How does a user-picked image in a protected folder get a thumbnail? | **B′: preview twin keyed by path, with the original path kept in the prompt.** At pick time, while the core holds the user's intent grant, copy the bytes to `dataDir/previews/<sha256(path)>.<ext>`. No stored mapping. The agent still receives the original path. D26(j) is unchanged: every read stays disclaimed, and a planted twin can only show bytes from a folder that is not protected. | owner (round-1/answers.json#mechanism; accepted recommendation) |
| D2 | Entry points | Which gestures create a twin? | All three: `/refs/pick` (files mode); a paste of a Finder-copied file (`file://` → `/refs/resolve`, **app caller only**, never the CLI token); and a Finder drag of a non-uploadable image through `/refs/drag` (heic, svg, bmp, ico, avif). A Finder drag of png/jpg/gif/webp still uploads to `screenshots/`, unchanged. | owner (#entry-points; accepted recommendation) |
| D3 | Image types | Which extensions get a twin? | The 10 `isImagePath` types: png jpg jpeg gif webp svg bmp ico avif heic (`src/shared/attachments.ts:44`). | owner (#extensions; accepted recommendation) |
| D4 | Size cap | Largest file that gets a twin? | **25 MB**, the same cap as `/screenshots`. A bigger file gets no twin, and its chip shows the honest unavailable state. | owner (#size-cap; accepted recommendation) |
| D5 | Twin lifetime | How long do twins live? | **A size-capped cache.** Past the total cap, the oldest twins are evicted. Eviction runs at boot and after each write. Losing a twin only turns that chip into the honest state. | owner (#twin-lifetime; accepted recommendation) |
| D6 | Cache cap | Total twin-cache cap? | **500 MB.** | owner (#twin-cap; accepted recommendation) |
| D7 | Blob status | Should a 403 get its own status? | Yes. Add `denied` to `AuthedBlobStatus`: `statusForHttp(403)` → `denied`, separate from `error`. | owner (#denied-status; accepted recommendation) |
| D8 | Chip look | How does a chip without a preview look? | **Neutral** (muted border, `ImageOff` icon), and it stays clickable and opens the file. **Amber is kept for 404 only.** | owner (#chip-look; accepted recommendation) |
| D9 | Copy | What do the tooltips say? | denied (403): "Preview blocked by macOS privacy — Agetor can't read files in this folder for previews. Click to open." · error/timeout: "Preview unavailable. Click to open." · too-large (413): "Too large to preview. Click to open." · missing (404): "Image not found: <path>" (unchanged) | owner (#chip-copy; accepted recommendation) |
| D10 | Surfaces | Which surfaces get the 404-vs-other split and the new copy? | All four: `AttachmentChips` (a click must reach `/open-path`), the `MdImage` final fallback (the candidate walk is unchanged), `SentFilesCard` (wording only), and the `BinaryFilePreview` pane. | owner (#surfaces; accepted recommendation) |
| D11 | Agent-chosen images (one-way door) | Markdown images and `SendUserFile` tiles in protected folders? | **An honest blocked chip that still opens (LaunchServices). No thumbnail and no click-to-load.** D26(j) is unchanged. | owner (#agent-chosen; accepted recommendation) |
| D12 | Old messages | Already-sent protected-folder refs? | "Preview unavailable, click opens" is enough. No C/D mechanism and no backfill. Because the twin is keyed by path, re-attaching the same file later lights up the old chips as well. | owner (#old-messages; accepted recommendation) |
| D13 | Cursor and fx reading picked files | They are spawned disclaimed without tmux and may be unable to read a picked Desktop file. | **Spike it in this change.** If it is broken, open a separate ticket with the evidence. Fixing it is not part of this change. | owner (#acp-read; accepted recommendation) |
| D14 | BinaryFilePreview scope | More than the wording fix? | **Wording only, through the `denied` status.** No thumbnail mechanism, because those bytes are agent-written. | owner (#binary-scope; accepted recommendation) |
| D15 | Pick-time spike | Prove the copy at pick time doesn't prompt | Before the twin work is built, run a dev-build spike (`~/.agetor-dev`): pick a `~/Desktop` image through the real NSOpenPanel and check that the core's in-process copy succeeds **without** an "Agetor would like to access Desktop" prompt. **If it prompts, stop and go back to the owner with the honest-chip floor only.** | owner (#c-spike; confirmed default) |
| D16 | Lookup order | Original or twin first? | `/files/preview` tries the original first, disclaimed as today. **Only on `denied`** does it look up `previews/<sha256(path)>`, read through the same disclaimed `openFileBytes`. A readable original always wins. | owner (#c-order; confirmed default) |
| D17 | Tests | The acceptance bar | A new `e2e/attachment-chips.spec.ts` (`AGETOR_FAKE_PICK_REFS_DIR` + a `chmod 000` png) checks four things: (1) the chip shows the unavailable state, not amber; (2) a click reaches `/open-path`, not the not-found dialog; (3) a deleted file still shows amber and the not-found dialog; (4) a picked file that is then `chmod 000` still shows its thumbnail through the twin. Unit tests: `statusForHttp(403)`; twin write, lookup and eviction; and a CLI-token `/refs/resolve` never creating a twin. | owner (#c-e2e; confirmed default) |
| D18 | Docs | What gets updated | `docs/architecture/security.md` (D26(j) scope names attachment chips and states the twin rule), `docs/architecture/markdown-images.md` (403 copy), `docs/architecture/testing-seams.md` (the chmod-000 idiom for chips), and a dated note in `docs/plans/improve-image-attached-message-ui.md`. | owner (#c-docs; confirmed default) |
| D19 | Source of truth | The spec | The plan restates the symptom in-repo. The screenshot is not committed. | owner (#c-spec; confirmed default) |
| D20 | CLI/TUI parity | Parity work | None. `agetor send` builds the references block but never renders thumbnails. | owner (#c-cli; confirmed default) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| `AttachmentChips` 404-vs-other split, neutral chip, and a click that opens | In this change | D7, D8, D10 |
| `MdImage` fallback title/copy for 403 | In this change | D10 |
| `SentFilesCard` wording | In this change | D10 |
| `BinaryFilePreview` 403 copy (`isolation: "none"` in a protected folder) | In this change (wording only) | D10, D14 |
| Twin creation on `/refs/pick`, app-caller `/refs/resolve`, `/refs/drag` (non-uploadable images) | In this change | D1, D2 |
| `/files/preview` twin fallback on `denied` | In this change | D16 |
| Twin cache eviction (500 MB, at boot and after each write) | In this change | D5, D6 |
| Pick-time no-prompt spike (it gates the twin work) | In this change | D15 |
| Cursor/fx read spike | In this change (spike only) | D13 |
| Cursor/fx read **fix**, if the spike shows it broken | Owner-deferred to a separate ticket, with the spike's evidence | owner (#acp-read) |
| Thumbnails for already-sent messages | Out of scope: the honest chip is accepted | owner (#old-messages) |
| Click-to-load or thumbnails for agent-chosen images | Out of scope: D26(j) is kept on purpose | owner (#agent-chosen) |
| Cleanup of the unbounded `dataDir/screenshots` (573 files, 117 MB) | Out of scope: a different ticket (drag-upload retention, not preview correctness). Nothing in this change adds to it. | judgment (not asked; surfaced for a follow-up ticket) |
| e2e + unit tests | In this change | D17 |
| Doc updates | In this change | D18 |
| CLI/TUI parity | Out of scope: no thumbnails there | D20 |

## Assumptions still open

- **The pick-time in-process copy triggers no TCC prompt** (investigation assumption 1). D15 gates this. If the spike shows a prompt, the plan stops at the honest-chip floor (D7–D10, D14) and goes back to the owner about D1.
- **Electrobun's open panel runs in the Bun core process** (from the code path in `server.ts:1432`). The D15 spike confirms it as a side effect.
- **The twin key is sha256 of the raw absolute path bytes** (U+202F and other characters kept as they are). This is a planning detail. If the webview and the pick route ever normalize the path differently, a lookup misses, and the chip falls back to the honest state, which is harmless.
- **Twin eviction order** is mtime-oldest-first. A lookup refreshes a twin's mtime, which makes the cache LRU-like. This is a planning detail, and the only cost of getting it wrong is losing a thumbnail.
