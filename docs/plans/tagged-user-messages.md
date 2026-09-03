# Plan — Tagged user messages (generalized tag rendering in the transcript)

| Field | Value |
| --- | --- |
| Date | 2026-09-03 |
| Source | `/implement` request: beautify the `<local-command-stdout>…</local-command-stdout> <forked-skill-launch>{…}</forked-skill-launch>` message that appears after invoking a background-forkable skill in Claude Code, and generalize the treatment to any tag — including tags the user types on purpose. |
| Config | AGENTS_CONFIG.yml (balanced) — host `claude_code` (detected via native Agent tool) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | `feature/user-message-tags` (pre-existing; not the default branch) |
| Base SHA | `3a771b3f94988af1a1dfb9a6bf2dcff74a093cb2` (tree clean at start) |

## 1. Objective & success criteria

Claude Code's transcript writes several XML-ish control tags into `type:"user"` (and first-command `type:"system"/local_command`) JSONL lines. agetor forwards those lines verbatim on the `user` stream, and today only three exact shapes are recognized (`src/mainview/lib/command-message.ts`): the slash-command XML expansion, the plain `/cmd` echo, and a message that is *exactly one* `<local-command-stdout>` element. Anything else — the two-tag line above, the `!` shell-escape tags, a user's own `<context>…</context>` prompt tags — falls through to `ReactMarkdown`, which (react-markdown 10.1, no `skipHtml`, no `rehype-raw`) turns raw HTML nodes into literal text, so the tags render as noise.

Done means:

1. The exact message `<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n<forked-skill-launch>{"agentId":"…","skillName":"code-review","description":"/code-review"}</forked-skill-launch>` renders in the run panel as a "command output" block followed by a "skill launched in background" card showing `/code-review`, with no literal tag text.
2. **General method**: any balanced, lowercase-named `<name>…</name>` (or `<name/>`) at the top level of a user message becomes a labeled block; known Claude Code tags get dedicated renderers; unknown tags get a generic labeled block (JSON bodies pretty-printed, prose bodies as markdown, nested tags rendered recursively). Text between/around tags still renders as markdown. Guards keep ordinary messages byte-identical: tags inside fenced/inline code, unbalanced tags, uppercase names, HTML element names, autolinks/emails/generics are all left alone.
3. The `!` shell-escape tags (`bash-input`, `bash-stdout`, `bash-stderr`) get dedicated shell-styled blocks (owner: in this run).
4. The same parser drives all three surfaces (owner: webview + CLI + TUI): `agetor logs` and the TUI dashboard print a plain-text form (`cmd›`, `skill›`, `sh›`, `out›`, `err›`, `<name>›`) instead of raw tags; ordinary messages print exactly as today.
5. The message-history picker never offers machine-emitted tag messages for re-send, but keeps user-typed tagged messages verbatim.
6. Dedup keys, search indexing and every persisted event stay untouched (rendering-only change; already-persisted transcripts are fixed retroactively).

## 2. Context & constraints (Phase 1 findings)

- **Real shape (ground truth, prod transcript):** one `type:"system", subtype:"local_command"` line (first command of a session; later ones are `type:"user"`) whose content is `<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>` — newline-separated (the space in the request is a copy artifact; the parser must accept both). Found at `~/.agetor/harnesses/<name>/projects/…/0d1f522c….jsonl`. JSON keys: `agentId`, `skillName`, `description`.
- **Shell escape shape:** `<bash-input>supabase db push --linked</bash-input>` as its own user line, then `<bash-stdout></bash-stdout><bash-stderr>(eval):1: command not found: supabase\n</bash-stderr>` as the next line (stdout may be empty). No agetor code handles these today.
- **Bun forwarding (`src/bun/claude-tmux.ts`):** plain user turns and local-command lines are forwarded as `user` chunks CR-normalized but otherwise verbatim (`:1208-1209`, `:1340-1342`); `isLocalCommandStdoutEvent` (`:730-736`) uses `startsWith`/`includes`, so the two-tag line still drives the local-command turn-settle correctly — **no bun change needed or wanted**. `task-notification` is already demoted to `status` (`:1135-1140`), the `isMeta` caveat is silenced (`:1173-1175`), `system-reminder` never arrives as plain user text (only inside tool_result / attachment records).
- **Why client-side:** same decision as PR #122 (knowledge entry 0e2ae6e0): persisted events stay raw so historical transcripts render correctly after upgrade; a bun-side split would also change the persisted shape the settle logic keys on.
- **Render surfaces today:**
  - `RunPanel.tsx` `UserMessageBlock` (`:4418-4564`): three branches on `parsed?.kind` (`command-output` mono block / `command` badge + markdown args + `AttachmentChips` / plain markdown + chips), capped `contentRef` div with Show more/less, `USER_MD_COMPONENTS` from `md-components.tsx`.
  - `MessageHistoryPicker.tsx` `cleanMessageText` (`:42-59`): `command` → "/name args", `command-output` → `""` (dropped), else `splitReferences(text).args`.
  - `event-dedup.ts:55-58` uses `canonicalizeUserText` (identity for anything but the command XML shape) — must stay a strict identity for non-command text.
  - `event-search.ts:84-90` indexes raw `data` — precedent: unaware of parsed kinds; leave alone.
  - CLI `src/cli/commands/logs.ts:93-96` (`formatEvent`, unexported) prints `you› <raw>`; TUI `src/cli/tui/Dashboard.tsx:287-293` (`EventLine`) prints `you› <raw>` truncated. Both already import from `../../shared/types.ts`; neither can import `src/mainview/lib`.
- **Cross-process rule:** `src/shared/` is the only directory all three processes import from; it must stay free of runtime imports from either side. `command-message.ts` already has zero React/DOM deps and imports only `../../shared/refs.ts`, so the move is mechanical.
- **Markdown fact (verified in `node_modules/react-markdown/lib/index.js`):** `raw` nodes become `{type:'text', value}` unless `skipHtml` — so HTML-named tags (`<b>`, `<div>`) already render as literal text today; leaving them as text keeps behavior unchanged.
- **Tests:** `bun:test`; lib tests are literal-string fixtures (`command-message.test.ts`); CLI `logs.test.ts` drives `cmdLogs --rebuild` with mocked `context.ts`/`output.ts` (`c` mocked to identity-ish); TUI `Dashboard.test.tsx` uses `ink-testing-library` and pushes synthetic `RunEvent`s through a mocked `streamSse`. No React-DOM test infra for `src/mainview` (no happy-dom / testing-library) → webview rendering is covered by e2e.
- **E2E technique (knowledge 0245b878, `e2e/markdown-readability.spec.ts`):** the orchestrator echoes the task prompt as a `user` event on `startTask` regardless of driver, so seeding the *prompt* with the tagged text renders it through `UserMessageBlock` under the fake driver. Run with `bun node_modules/@playwright/test/cli.js test e2e/<spec>` (one Playwright run at a time).
- **Runnability:** `bun install` done in this worktree; `bun run typecheck`, `bun test`, Playwright e2e via `webServer: bun run hmr` (`playwright.config.ts`).
- **Icons available (lucide-react):** `GitFork`, `Terminal`, `SquareTerminal`, `Braces`, `Tag`.

## 3. Approach & key decisions

1. **One shared parser** — new `src/shared/user-message.ts` absorbs everything in `src/mainview/lib/command-message.ts` (`parseUserMessage`, `splitReferences`, `canonicalizeUserText`, `matchCommandXml`, ANSI stripping) and adds the segment parser + plain-text formatter. `src/mainview/lib/command-message.ts` is deleted (import sites updated) — no shim left behind. *Reasoning: owner chose webview + CLI/TUI; the CLI must recognize the command XML twin too or it would print three generic "command name/args" lines, so the whole parser moves, not just the new part.*
2. **Segment model, not a fourth regex** — `parseMessageSegments(text): MessageSegment[]` where a segment is `{kind:"text", text}` or `{kind:"tag", name, attrs, body, raw}`. Top-level scan with depth counting for same-name nesting; only `[a-z][a-z0-9_-]*` names; must be balanced or self-closing; regions inside fenced code (``` / ~~~) and inline code spans are never tags; a curated `HTML_ELEMENT_NAMES` set is excluded so `<b>x</b>` stays text exactly as today; whitespace-only text between tags is dropped; text segments otherwise verbatim (markdown handles leading newlines). *Reasoning: this is the "general beautify method" — every tag renders through one path, known tags just pick a nicer renderer.*
3. **`ParsedUserMessage` gains `{ kind: "tagged"; text; segments; references }`** — returned when the message is not a command shape, not a lone `<local-command-stdout>`, and segmenting (after `splitReferences`) yields ≥1 tag. `command` and `command-output` kinds are unchanged (existing tests move verbatim). Command *args* are also rendered through the segment renderer (a slash command's args are an intended user message too).
4. **Machine-emitted set** — `MACHINE_TAGS = {local-command-stdout, forked-skill-launch, bash-input, bash-stdout, bash-stderr}` + `isMachineEmittedMessage(segments)` (true when every segment is a machine tag and there's no text). Drives: history-picker drop, the bubble's header label ("you" only when authored content exists), and the plain-text tone.
5. **Webview renderers** live in a new `src/mainview/components/kanban/MessageSegments.tsx` (RunPanel is already 4.5k lines): `MessageSegments` (dispatcher, recursion depth ≤ 3 for generic bodies), `CommandOutputBlock` (extracted from today's JSX so the `command-output` kind and the segment share it), `ForkedSkillCard`, `ShellInputBlock`, `ShellOutputBlock` (stdout / stderr, empty stdout omitted), `GenericTagBlock` (mono name pill + optional attrs; JSON body → pretty-printed mono, else nested `MessageSegments`). All styled with semantic tokens only (`text-danger`, `bg-muted`, `border-border`, `text-primary`…), never palette classes.
6. **Plain-text form for CLI/TUI** — `userMessageLines(text): PlainLine[]` (`{label, text, tone: "user"|"machine"|"error"|"tag"}`) in the shared module; ordinary text yields exactly one `you›` line with the untouched data (byte-identical output to today); the command XML twin yields `you› /name args` via `canonicalizeUserText`. CLI colors labels (`cyan`/`dim`/`red`), TUI renders one `<Text>` per line inside a column `<Box>`.
7. **Untouched by design:** `canonicalizeUserText` (dedup identity), `event-search.ts` (raw indexing precedent), bun driver, persisted event shape.

Alternatives rejected: (a) bun-side split of the line into a `user` + `status` chunk — changes persisted shape, doesn't fix history, risks the local-command settle gate; (b) allow-list-only tag detection — owner chose general detection; (c) `rehype-raw`/`skipHtml` — would hide tags instead of rendering them.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Create the shared parser: move `command-message.ts` wholesale into `src/shared/user-message.ts`, add `parseMessageSegments`, `MACHINE_TAGS`, `isMachineEmittedMessage`, `parseForkedSkillLaunch`, `humanizeTagName`, `stripAnsiSgr`, `userMessageLines`, extend `ParsedUserMessage` with the `tagged` kind. Move the existing test file to `src/shared/user-message.test.ts` (import path only; every existing assertion must still pass). Leave `src/mainview/lib/command-message.ts` as a temporary one-line re-export so wave-2 tasks can switch imports independently. | `src/shared/user-message.ts` (new), `src/shared/user-message.test.ts` (moved), `src/mainview/lib/command-message.ts` (reduced to `export * from "../../shared/user-message.ts"`), `src/mainview/lib/command-message.test.ts` (deleted) | — | `bun run typecheck` green; `bun test src/shared/user-message.test.ts` green with all pre-existing cases; the two real fixtures (newline- and space-separated forked line) parse to `tagged` with 2 tag segments; guards (fence, inline code, unbalanced, uppercase, HTML names, `Array<string>`, `<https://x>`) return a single text segment. |
| T2 | Webview rendering: new `MessageSegments.tsx` with the renderers in §3.5; `UserMessageBlock` imports from `@/../shared/…` (i.e. `../../../shared/user-message.ts`), adds the `tagged` branch, routes command args and the `command-output` kind through the shared components, keeps the capped div + Show more, chips, `stripImagePlaceholders` behavior. `data-testid`s: `user-tag-block` (+`data-tag="<name>"`), `command-output-block`, `forked-skill-card`, `shell-input-block`, `shell-output-block`. | `src/mainview/components/kanban/MessageSegments.tsx` (new), `src/mainview/components/kanban/RunPanel.tsx` | T1 | Typecheck green; the forked message renders "command output" + skill card with `/code-review` and short agent id; ordinary messages' DOM unchanged; header reads "you" only when authored content exists. |
| T3 | History picker: `cleanMessageText` handles `tagged` — machine-emitted → `""` (dropped), authored → `parsed.text.trim()`; import from shared. | `src/mainview/components/kanban/MessageHistoryPicker.tsx` | T1 | Typecheck green; behavior for `command`/`command-output`/plain unchanged. |
| T4 | CLI + TUI plain rendering via `userMessageLines`: `formatEvent` case `"user"` joins lines (`c.cyan` for user labels, `c.dim` for machine/tag, `c.red` for error); `EventLine` case `"user"` renders a column of `<Text>` lines with the same tones (cyan / dimColor / red), still `wrap="truncate-end"`. | `src/cli/commands/logs.ts`, `src/cli/tui/Dashboard.tsx` | T1 | Typecheck green; an ordinary user event prints byte-identical to today; the forked event prints `cmd›` + `skill›` lines with no raw tags. |
| T5 | Retire the shim + docs: delete `src/mainview/lib/command-message.ts`; point `event-dedup.ts` at the shared module; fix doc-comment references to `lib/command-message.ts` in `src/bun/claude-tmux.ts` (comments only, lines ~956 and ~1336) and `src/shared/attachments.ts` (comments only, ~36 and ~179); update CLAUDE.md's "(4) Local slash commands" sentence that names `lib/command-message.ts` and add one bullet describing the tagged-message renderer + the shared parser location. | `src/mainview/lib/command-message.ts` (delete), `src/mainview/lib/event-dedup.ts`, `src/bun/claude-tmux.ts` (comments only), `src/shared/attachments.ts` (comments only), `CLAUDE.md` | T1 | Typecheck green after wave 2; `grep -rn "command-message" src` returns nothing but historical comments that were deliberately rewritten. |

## 5. Work breakdown — test tasks

E2E **applies**: the feature is a user-visible rendering flow (UI ← API ← orchestrator echo) and the repo has a Playwright harness; the fake driver plus prompt-seeding technique makes it deterministic.

| ID | Layer | Covers | Owns | Notes |
| --- | --- | --- | --- | --- |
| U1 | unit | T1 | `src/shared/user-message.test.ts` (extend) | Segment parser matrix (balanced / self-closing / attrs / nested same-name depth / unbalanced / uppercase / HTML names / generics / autolink / email / fenced + inline code / CR newlines / whitespace-only gaps), both real forked fixtures, `bash-*` fixtures (incl. empty stdout), `parseForkedSkillLaunch` valid + invalid JSON, `isMachineEmittedMessage`, `parseUserMessage` → `tagged` incl. trailing refs block split, `userMessageLines` per shape (ordinary is a single untouched `you›` line), `canonicalizeUserText` identity on tagged text. |
| U2 | unit (CLI/TUI) | T4 | `src/cli/logs.test.ts`, `src/cli/tui/Dashboard.test.tsx` (extend) | Push a forked-shape user event and a `bash-*` pair: assert labels appear and no `<forked-skill-launch>` literal; assert an ordinary user event is unchanged. |
| U3 | e2e | T2, T3 (rendering) | `e2e/tagged-user-messages.spec.ts` (new) | Modeled on `e2e/markdown-readability.spec.ts` (`createAndStartTask` with the tagged prompt, `runPanel(page)`, `.agetor-md`). Three serial tests: (1) forked shape → `command-output-block` + `forked-skill-card` containing `/code-review`, bubble text has no `<forked-skill-launch`; (2) user-typed `<context>…</context>\n\nPlease do Y` → `user-tag-block[data-tag=context]` + markdown paragraph "Please do Y" + header "you"; (3) `<bash-input>…</bash-input>` → `shell-input-block` with `$ …`. |

Run recipe: `bun test` (unit); `bun run typecheck`; e2e `bun node_modules/@playwright/test/cli.js test e2e/tagged-user-messages.spec.ts` — Playwright boots `bun run hmr` itself (webServer) and a per-worker headless backend with `AGETOR_CLAUDE_DRIVER=fake`; no credentials or services needed; never run two Playwright invocations concurrently (port collisions).

## 6. Execution waves

- **Wave 1:** T1 (single agent). Barrier: typecheck + `bun test src/shared/user-message.test.ts` green.
- **Wave 2:** T2, T3, T4, T5 in parallel (disjoint files; T2/T3/T4 import from the shared module directly, never the shim, because T5 deletes it in the same wave). Barrier: typecheck + full `bun test` green.
- **Phase 6:** U1, U2, U3 in parallel (disjoint files).
- **Phase 7:** one background agent runs `bun run typecheck`, `bun test`, then the e2e spec.

## 7. Blast radius & risks

- **Ordinary messages must not change.** Every guard in the segment parser exists for this; U1 pins the byte-identity cases and U3 test 2 pins the "you" header. The plain-text formatter returns the untouched data for non-tag messages, so `agetor logs --json` (raw) and the human render stay identical for them.
- **Dedup:** `canonicalizeUserText` unchanged → `eventDedupKey` unchanged. Machine-emitted lines have no live-echo twin; user-typed tagged messages already dedupe byte-for-byte.
- **History picker:** dropping machine tag messages mirrors the existing `command-output` drop; user tags stay verbatim so a re-send reproduces the prompt.
- **Local-command turn settle (bun):** untouched — still keys on `startsWith("<local-command-stdout>")`.
- **False positives:** a user literally typing `<foo>bar</foo>` as prose now renders as a labeled "foo" block instead of literal text — this is the requested behavior; code fences/inline code keep literal rendering, and HTML names keep today's literal-text behavior.
- **Sibling branch overlap:** `feature/reference-files-in-the-from-the-selected` also edits `UserMessageBlock` (path shortening) — not on this branch; a later merge will conflict in `RunPanel.tsx` and must keep both. Noted, not actionable here.
- **Rollback:** pure rendering change; reverting the branch restores raw rendering with no data migration.

## 8. Open questions / assumptions

Owner answers (grill, 2026-09-03): surfaces = webview + CLI + TUI; detection = any balanced lowercase tag with guards; `bash-*` swept in.

Assumptions proceeding on:
- A1. Tag body for a generic block: JSON (object/array) → pretty-printed mono; anything else → markdown with nested tags rendered recursively (depth ≤ 3).
- A2. Forked-skill card shows the skill as `description` when it starts with `/`, else `/${skillName}`, plus the first 8 chars of `agentId` muted; a malformed JSON body falls back to the generic block.
- A3. Generic-block label is the raw tag name in mono (users recognize their own tags); known machine blocks use humanized uppercase labels matching today's "command output" idiom.
- A4. Empty `<bash-stdout>` next to a non-empty `<bash-stderr>` renders nothing for stdout; both empty → a single "—" line, mirroring the existing `parsed.output || "—"`.
- A5. Attributes on a tag (`<note kind="x">`) are captured raw and shown muted beside the label; not parsed further.
- A6. Search (`event-search.ts`) keeps indexing raw data; highlight fidelity inside tag blocks is best-effort, matching today's command-bubble precedent.

## 9. Completeness ledger

| Remainder | Disposition | Owner / task |
| --- | --- | --- |
| Two-tag `local-command-stdout` + `forked-skill-launch` line renders raw | in this run | T1, T2 |
| `bash-input` / `bash-stdout` / `bash-stderr` render raw | in this run (owner: yes) | T1, T2, T4 |
| User-typed tags in ordinary messages and in slash-command args | in this run (owner: general detection) | T1, T2 |
| CLI `agetor logs` and TUI print raw tags (and raw command XML) | in this run (owner: all surfaces) | T4 |
| History picker offering machine-emitted tag lines for re-send | in this run | T3 |
| `src/mainview/lib/command-message.ts` left as a dead shim after the move | in this run — deleted, imports repointed, comments/docs updated | T5 |
| CLAUDE.md references to `lib/command-message.ts` | in this run | T5 |
| `event-search.ts` indexing the display form instead of raw data | out of scope — existing precedent for command bubbles is raw indexing; different ticket if wanted | — |
| Bun-side demotion of `forked-skill-launch` to a `status` chip | out of scope — would change the persisted shape and not fix history; rendering approach chosen in §3 | — |
| `task-notification` / `system-reminder` rendering | out of scope — never reach the user stream as plain text (status-demoted / silenced bun-side) | — |
| Sibling branch's `RunPanel.tsx` path-shortening edits | out of scope — different branch, merge-time concern | — |
