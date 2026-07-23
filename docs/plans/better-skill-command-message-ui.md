# Plan — Better skill/command message UI in the stream list

| Field | Value |
| --- | --- |
| Date | 2026-07-23 |
| Source | /implement task: "make the skill/command message UI look better … without the command tags, in the stream messages list in the task details modal" + screenshot `screenshot-2026-07-23_18-36-43-d5ba31a5.png` |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/better-skill-command-message-ui |
| Base SHA | 4bf523249743f9c02676876eb50988c1864145ee |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (agetor-driven unattended session); assumptions logged in §8 |

## 1. Objective & success criteria

When a task (or follow-up) is started with a slash command, the "YOU" bubble in the
task-details stream currently shows claude CLI's raw expansion:

```
<command-message>implement</command-message> <command-name>/implement</command-name>
<command-args>make the skill/command message UI look better … </command-args>
```

Success:
- No raw `<command-*>` tags visible anywhere in the stream list.
- A command invocation renders as a structured bubble: a `/command` badge, the
  arguments as normal markdown body, and any trailing "Referenced files/folders:"
  block as compact reference chips instead of a raw bullet list.
- The live echo (`/implement …`) and the JSONL twin (XML expansion) collapse into
  **one** bubble instead of today's two.
- `<local-command-stdout>` user lines render as a labeled output block, not raw tags.
- Non-command user messages render exactly as before.
- `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (Phase 1 findings)

- `renderEvent` dispatches `case "user"` → `UserMessageBlock` at
  `src/mainview/components/kanban/RunPanel.tsx:2220`; the block itself is
  `RunPanel.tsx:2466-2537` — memoized, sticky bubble, ~3-line collapse cap with
  Show more/less, body via `<ReactMarkdown components={USER_MD_COMPONENTS}>` (2521).
- Markdown `components` maps are hoisted to module scope on purpose
  (`RunPanel.tsx:2421-2425`) — a fresh object per render re-parses every block
  every poll. Any new rendering must keep that invariant and be `memo`'d.
- Every user message is emitted twice (live echo + JSONL twin); dedup is
  `src/mainview/lib/event-dedup.ts` keying `user|runId|first-200-normalized-chars`.
  For slash commands the two texts differ (plain `/cmd args` vs XML expansion),
  so they slip past dedup → duplicate bubbles.
- The XML twin's `<command-args>` includes the full args *and* the
  "Referenced files/folders:" block agetor appended (verified against a real
  transcript), so canonicalizing the XML shape back to `/name args` reproduces
  the echo text and makes the existing 200-char key collapse them.
- `REFS_HEADING = "Referenced files/folders:"` and bullet shape live in
  `src/shared/refs.ts` (`formatReferences`) — parse with the same constant, never
  a re-typed string.
- Bun side (`claude-tmux.ts:743-772`) only strips tags for `isMeta` entries;
  real human turns pass through untouched. We fix rendering client-side; no Bun
  changes needed.
- Repo convention: no DOM test harness. Pure logic goes in
  `src/mainview/lib/*.ts` with a co-located `*.test.ts` (`bun:test`, flat
  `test`/`expect`) — e.g. `prompt-noise.ts`, `diff-selection.ts`.
- Codex never emits `user` events from its wire mapper (echo only), so this is
  claude-shape-specific but harmless for codex.

## 3. Approach & key decisions

- **Parse client-side, upstream of ReactMarkdown** — a new pure lib
  `src/mainview/lib/command-message.ts`. Rejected: stripping tags Bun-side in
  `claude-tmux.ts` (would bake presentation into persisted events and not fix
  already-persisted history; client-side parsing fixes old transcripts too).
- **Dedup by canonicalization** — `eventDedupKey` canonicalizes user text
  (XML shape → `/name args`) before slicing 200 chars, so echo + twin share a
  key. Rejected: fuzzy merge in the render path (stateful, riskier).
- **Render both shapes identically** — even if dedup ever misses, both bubbles
  look the same.
- **Strict XML parse** — require `<command-name>`; leftover non-whitespace
  outside recognized tags → bail to raw rendering (never mis-render a message
  that merely resembles the shape).
- **Plain-echo detection** is conservative: `^/[a-z0-9][a-z0-9_:-]*(\s|$)` —
  lowercase command names only, so `/Users/...` paths can't match; `/tmp/foo`
  fails the boundary.

## 4. Work breakdown — implementation tasks

**T1 (wave 1, one agent)** — owns all three files (they interlock; splitting
would collide on imports/types):
- `src/mainview/lib/command-message.ts` (new): `parseCommandMessage`,
  `parseLocalCommandStdout`, `splitReferences`, `canonicalizeUserText`.
- `src/mainview/lib/event-dedup.ts`: apply `canonicalizeUserText` in the user key.
- `src/mainview/components/kanban/RunPanel.tsx`: `UserMessageBlock` renders the
  parsed command (badge + args markdown + ref chips) or local-command-stdout
  block; falls back to current rendering otherwise.

Acceptance: criteria in §1, typecheck green, no changes outside the three files.

## 5. Work breakdown — test tasks

**T2 (after review)** — `src/mainview/lib/command-message.test.ts` (new) +
extend `src/mainview/lib/event-dedup.test.ts`: XML shape (with/without args,
with refs, reordered tags, `\r` newlines), plain echo shape, path false-positives,
leftover-content bail, local-command-stdout, echo↔twin key collapse, non-command
key unchanged.

## 6. Execution waves

Wave 1: T1 (single agent — no partition needed). Barrier. Review. Barrier. T2.
Barrier. Test run. Fixes if red.

## 7. Blast radius & risks

- `eventDedupKey` change affects all user events: canonicalization must be
  identity for non-command text or existing dedup behavior shifts. Covered by tests.
- `UserMessageBlock` renders every user bubble ever persisted — the fallback
  path must be byte-identical behavior for plain messages.
- Collapse-cap + scroll-compensation machinery in `UserMessageBlock` must keep
  working for the new command layout (content div still wraps the whole body).
- Perf: parser runs per user bubble per render unless memoized — memoize on
  `text` inside the memo'd component.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: Reference chips are in scope as part of "better formatted and
  structured" (the refs bullet list is part of the same visual noise). Chips are
  display-only (basename + icon, full path in `title`), no click action.
- **A2**: `[screenshot-….png]` inline tokens stay as plain text in the args body.
- **A3**: `<local-command-stdout>` handling is included (same family of raw-tag
  noise), rendered as a muted mono block labeled "command output".
- **A4**: No Bun-side/DB changes — presentation only.
- **A5**: Both gates (grill, plan approval) self-approved per autonomous mode.
