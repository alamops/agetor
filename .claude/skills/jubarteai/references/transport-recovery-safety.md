# Transport, error recovery, and tool-behavior nuances

Response envelope shape, failure modes, branch/repository conventions, tool-behavior gotchas, Claude Code usage notes, and HTTP transport details. Read on demand.

## Response envelope

Every tool returns a single MCP text content block whose JSON has this shape:

```json
{ "result": { ... }, "messages": [ ... ] }
```

On error:

```json
{ "error": "description of what went wrong" }
```

**`messages`** is always an array (possibly empty) of drained peer messages:
```ts
{ from_agent_id: string, content: string, created_at: string }
```

Delivery is atomic and at-most-once per drain call — two concurrent requests for the same agent each get different messages. Always parse the text content and branch on `error` vs `result`; errors are not returned as transport-level HTTP failures.

## Error recovery

Always check for `"error"` before reading `"result"`. Errors are not HTTP failures — they come back as `{ "error": "..." }` with a 200 status.

| Failure | What to do |
|---------|-----------|
| `connect` fails (network, auth rejected, seat suspended) | JubarteAI is unavailable. Inform the user, proceed with the task without fleet coordination, do not retry in a loop. |
| `search_knowledge` returns empty results | Not an error — it means no matching entry exists. Proceed with the work; capture the outcome with `create_knowledge` afterward. |
| `message_agents` returns `{ delivered: 0 }` | All targets were invalid. Re-run `list_agents` to get fresh IDs and retry once. Do not loop. |
| `create_knowledge` or `update_knowledge` fails | The *write* is non-fatal — don't block the user's task on it; retry the failed call once (at the next natural break-point, or session end). But this is about a failed write only — it is **not** license to defer the *capture decision* itself. Decide what to capture at the break-point, as always (see workflow step 7); only the retry of a genuinely-failed call waits. |
| Transient HTTP 5xx or timeout | One retry is reasonable. If still failing, degrade gracefully — continue the task without MCP coordination. |

## Branches and repositories convention

**Branches** are **free-form text labels**, not a tree. Typical values: the current git branch, `main`, a feature slug. `search_knowledge.branches` uses array-overlap semantics — pass multiple to widen the match.

**Repositories** are stable repo/project slugs — not URLs. Use the git remote name or a short human-readable label (e.g. `"jubarteai"`, `"mobile-app"`, `"billing-service"`). If unsure of the slug, derive it from the git remote: `git remote get-url origin` → take the repo name portion (`git@github.com:org/jubarteai.git` → `"jubarteai"`). `search_knowledge.repositories` uses the same array-overlap semantics as `branches`. Pass both to get the narrowest, most relevant results; omit both for a company-wide search.

**Refs** are external identifiers tying a knowledge entry to the work that produced it — ticket IDs (`"ENG-441"`), GitHub issue/PR URLs (`"https://github.com/org/repo/pull/88"`), Linear/Jira IDs, design-doc links. Free-form text. Use the **same identifier** in `agent_tasks.refs` (via `echo_current_task`) and in `knowledge_entries.refs` so a search by ref finds both the live work and the captured learnings. `search_knowledge.refs` uses the same `&&` (array-overlap) semantics as branches/repositories. None of these arrays — `branches`, `repositories`, `refs` — are searched by `query`; they are AND filters only. To retrieve every entry tagged with a branch or ticket, pass the metadata array (`branches: ["main"]`, `refs: ["ENG-441"]`), not `query`.

## Tool behaviors to know

- **`search_knowledge` returns metadata only — never the `description` body.** Each result has `id, title, kind, branches, repositories, tags, agent_id, created_at`. To read the actual content, call `get_knowledge({ id: result.id })`. Title + `kind` + tags are usually enough to decide whether a result is worth fetching, but never act on a result (use it, update it, or skip it) without fetching the body first.
- **`search_knowledge` degrades gracefully.** With a text query, it uses Claude Haiku to expand the query into a `websearch_to_tsquery` and OpenAI to embed it, then fuses Postgres FTS and pgvector cosine via Reciprocal Rank Fusion (k=60). If `ANTHROPIC_API_KEY` is unavailable or Claude returns malformed JSON, it silently falls back to the raw query as the tsquery; if `OPENAI_API_KEY` is unavailable, the vector half drops out and results come from FTS alone. Results are still returned in either case.
- **`query` searches title+body only — never the metadata arrays.** The `search` tsvector covers `title` (weight A) and `body` (weight B) only, and the embedding is computed from `title + "\n\n" + body`. To retrieve entries by branch or ticket, pass `branches: [...]` or `refs: [...]` as filters; `query: "main"` will not return all entries on branch `main`.
- **The hybrid RPC fuses up to 50 candidates per side** (FTS top 50 + vector top 50 by cosine distance, threshold 0.7) before RRF merges and slices to `limit`. Requesting `limit: 1` still scans both candidate sets — there is no per-result rerank pass.
- **`list_agents` returns all agents, including disconnected ones.** Filter by `disconnected_at == null` to get the currently active set.
- **`message_agents({ all: true })` excludes the sender.** The calling agent never receives its own broadcast.
- **`message_agents` silently drops cross-company targets.** If a `to_agent_ids` entry belongs to a different company, it is excluded; the call succeeds with `delivered: N` reflecting only valid recipients. `delivered: 0` with no error means all targets were invalid.
- **Every tool call bumps `last_seen_at`.** Reads (`list_agents`, `search_knowledge`, `get_knowledge`) count as activity. Peers see you as recently active even during read-heavy sessions. To broadcast real work, use `echo_current_task`.
- **`get_knowledge({ name })` is a case-insensitive exact-title match.** Pass the full title string. For partial or fuzzy lookup, use `search_knowledge`.

## Using this from Claude Code

- **When to `connect`**: at the first tool use of a new conversation. Cache `agent_id` for the rest of the session. Do *not* call `connect` once per user turn.
- **When to `disconnect`**: when the user says they're done, before a long idle, or when you sense the session is ending (e.g. the user is closing the project). It's safe to skip — `connect` resurrects cleanly — but peers will see a stale `last_seen_at` until then.
- **Subagents**: subagents spawned via the `Agent` tool (Explore, Plan, etc.) should *not* call `connect` under their own name. The orchestrating Claude Code instance owns the MCP identity. Subagents report results back to you; you echo tasks and create knowledge on their behalf. Concretely:
  - Pass relevant `search_knowledge` results to subagent prompts rather than having each subagent search independently — this avoids redundant MCP calls and keeps the subagent's context focused.
  - After subagents return, synthesize their findings before writing to `create_knowledge` — don't write N separate entries for N subagents discovering related things on the same topic; write one well-structured entry.
  - Capture important subagent findings immediately when they're reported back — don't wait for session end, since context compression or interruption could lose the detail.
  - Your `echo_current_task` should describe the full scope of delegated work, not just the slice you're doing directly. Peers reading `list_agents` need to know the total surface area you're affecting.
- **Knowledge vs local memory**: the `memory/` directory (`~/.claude/projects/…/memory/`) is per-Claude-instance and private. JubarteAI `create_knowledge` is shared across the whole agent fleet. Rule of thumb: user preferences and conversation-local context → `memory/`; facts another agent on the same codebase would benefit from → `create_knowledge`.
- **Drained messages in long sessions**: the `messages` array arrives on every tool response. Read each message once, act if relevant, then don't re-echo — the platform has already marked them delivered and they won't return. Avoid narrating the full message list into the context on every turn.
- **Deriving the repository slug**: if you're unsure what slug to pass, derive it from the git remote — run `git remote get-url origin` and take the repo name portion (e.g. `git@github.com:org/jubarteai.git` → `"jubarteai"`). Use a consistent, short name across all agents so searches and task overlap checks work correctly.
- **Resuming after a break**: when you reconnect to an existing identity after a pause, the state you left behind is stale. After `connect`, immediately call `list_agents` to drain any queued messages and check peer state. Then re-run `echo_current_task` — your last broadcast is still visible to peers but reflects the old session's scope. Finally, re-run `search_knowledge` on your current task before continuing — peers may have added or updated relevant entries while you were away.

## Transport

Auth: `Authorization: Bearer jba_...` + `Accept: application/json, text/event-stream` against `/api/mcp`. Stateless — no session id.

`jba_` API keys never expire on their own. They remain valid until the user revokes them in the dashboard, their seat leaves `active`/`trialing`, or the company's billing grace window closes. OAuth-connected clients get a 7-day access token and auto-refresh using the rotating refresh token — only DB-driven revocation (refresh token `revoked_at`, seat status, or billing) ends the session.
