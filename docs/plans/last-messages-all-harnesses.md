# Plan — Last Messages across all harnesses

| Field | Value |
| --- | --- |
| Date | 2026-08-10 |
| Source | /implement "let's make Last Messages list all last messages, not limited to the same harness" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/last-messages-open-for-all |
| Base SHA | b0efc2add7debdf30c881e69f3cd85dbc2c2d838 |
| Mode | Autonomous (no owner present — grill skipped, plan self-approved; see §8) |

## 1. Objective & success criteria

The composer's "Last Messages" history dropdown (MessageHistoryPicker) currently
lists past sent user messages only from tasks whose harness *kind* matches the
current task's. Remove that restriction: the dropdown lists the most recent
sent messages across **all** tasks regardless of harness.

Done when: `GET /tasks/:id/messages/history` returns messages from every
harness kind, tests assert the new behavior, typecheck + full `bun test` green.

## 2. Context & constraints (grounded)

- Route: `src/bun/server.ts:4686` — builds `agentIds` as the kind-sibling union
  via `harnesses.getByIdOrKind(task.agent)` + `harnesses.list()` filter, falls
  back to `[task.agent]` for unknown agents, then calls
  `runs.userMessageHistory(agentIds, limit)`.
- Query: `src/bun/db.ts:984` `userMessageHistory(agentIds, limit)` — the only
  harness scoping is `AND tasks.agent IN (…)`. Sole non-test caller is the
  route above.
- Index: `migrations/039_run_events_user_history.sql` covers
  `(stream, id DESC) WHERE subagent_id IS NULL` — no `tasks.agent` involvement,
  stays valid unchanged. **No migration needed.**
- Client: `src/mainview/components/kanban/MessageHistoryPicker.tsx` — fetches,
  cleans (CR-normalize → canonicalizeAttachmentText → parseUserMessage →
  splitReferences), dedups on cleaned text, caps at 50. The pipeline is
  harness-agnostic (fleet knowledge entry 81fcbc7a); non-claude harnesses'
  user events are appended by agetor's own sendInput path, so they contain
  plain user text and pass through the cleaner unchanged.
- Tests: `src/bun/message-history.test.ts` — two tests assert the *old*
  kind-scoping (cross-kind exclusion, unknown-agent isolation); the rest
  (streams/blank/dup/ordering/limit/shape/project/auth) are scope-agnostic.

## 3. Approach & key decisions

Drop the filter at the query, simplify the route, fix the copy, update tests.

- Keep the route shape `/tasks/:id/messages/history` and its 404-on-unknown-task:
  the task id remains the natural UI call site and API-shape churn buys nothing.
- `userMessageHistory(limit)` loses the `agentIds` param entirely rather than
  accepting an optional one — one caller, and a dead param is drift bait.
- The route's `harnesses` lookup block for this endpoint is deleted.
- Empty-state copy "No past messages for this agent yet." → "No past messages
  yet." (the qualifier is now wrong).

## 4. Work breakdown — implementation

Single wave, single task (files are small and cohesive; splitting buys nothing).

- **T1** — remove harness scoping end to end. Owns:
  `src/bun/db.ts` (userMessageHistory signature + SQL),
  `src/bun/server.ts` (history route only),
  `src/mainview/components/kanban/MessageHistoryPicker.tsx` (empty-state copy
  + stale doc comments mentioning per-agent scoping, if any),
  `src/bun/message-history.test.ts` (rewrite the two kind-scoping tests to
  assert cross-harness inclusion; leave scope-agnostic tests untouched).
  Acceptance: history returns messages from claude-code, codex and
  custom-harness tasks alike; unknown agent strings included too.

## 5. Work breakdown — tests

Folded into T1: this changes behavior an existing suite already pins, so the
test edits are inseparable from the code change. New coverage = the rewritten
cross-harness-inclusion test (bare kind + custom harness + different kind +
unknown agent all mutually visible). **E2e: not applicable** — no e2e harness
exists in this repo; the HTTP-level bun tests exercise the full route.

## 6. Execution waves

Wave 1: T1. Then review (opus) → test run (haiku: `bun run typecheck` +
`bun test`).

## 7. Blast radius & risks

- Sole caller of `userMessageHistory` is the route; sole consumer of the route
  is MessageHistoryPicker. No other surface reads these.
- Index unaffected; no migration.
- Risk: non-claude user-event shapes reaching the cleaner — mitigated by the
  pipeline being shape-agnostic and by dedup-on-cleaned-text.
- Behavior note: list may now surface messages typed to a different harness
  (e.g. codex-flavored slash commands into a claude task). Accepted — that is
  exactly what was asked for.

## 8. Open questions / assumptions (autonomous mode)

1. "All last messages" = across all tasks/projects/harnesses globally. The
   feature already crossed tasks and projects; the only remaining scoping was
   harness kind, which the request names.
2. Archived tasks' messages are currently included (no archived filter exists);
   preserved as-is — out of scope.
3. Route stays per-task (`/tasks/:id/…`); no API-shape change.
