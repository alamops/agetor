# The workdone protocol

Workdone entries are how the fleet maintains continuity across sessions. They're the primary mechanism for picking up an in-flight branch, resolving merge conflicts, and avoiding duplicate work. Treat them with the same priority as `echo_current_task`.

**At session start — before touching code.** Once you have an `agent_id` and have called `echo_current_task`, run a workdone search scoped to the current task:

```ts
search_knowledge({
  agent_id,
  kind: "workdone",
  branches: ["<current-branch>", "main"],
  repositories: ["<current-repo>"],
  refs: ["<ticket-id>"], // when applicable
})
```

If results come back, fetch each promising one with `get_knowledge({ id })` and read it before doing any work. **This search is required when picking up an in-flight branch or ticket** — same status as the existing "search before non-trivial action" rule. A peer (or your past self) may have already done part of the work, hit and resolved a blocker, or made a decision you need to honor.

**During the session — one workdone per task, kept current.** As soon as the work has any concrete shape (after the first non-trivial change, not session start), call `create_knowledge` once with `kind: "workdone"`. Then as the session progresses — after each meaningful sub-task, fix verified, decision made — call `update_knowledge` to extend the same entry. Do **not** create a new workdone entry per sub-task; update the existing one.

**Task boundary.** A "task" is the scope of your current `echo_current_task` broadcast. Re-call `echo_current_task` with a meaningfully different scope (different ticket, different surface area, different branch you're now driving) → start a new workdone. Re-broadcasting the same task with refined wording or an added sub-goal → keep extending the existing workdone. When in doubt, keep extending — too many workdone entries is harder to follow than one long one.

**Tagging mirrors `echo_current_task`.** Workdone entries must carry the same `branches`, `repositories`, and (where applicable) `refs` as the agent's current task broadcast. Use the **same identifier** in `agent_tasks.refs` and `knowledge_entries.refs` so a search by ticket finds both the live task row and the workdone log.

**Title shape.** Present-tense or noun-phrase, scoped to the task and branch. Examples:
- `"Workdone: JWT middleware migration on feature/jwt"`
- `"Workdone: Stripe seat-quantity sync rewrite on main"`
- `"Workdone: ENG-441 auth refactor"`

**Body shape.** Append-only-style updates ordered by time. Each update is a short bullet: what changed, where, what's verified, what's left. Reads like a session log, not a polished encyclopedia entry.

**Example:**

```
title: "Workdone: JWT middleware migration on feature/jwt"
description: |
  Session 2026-04-27 (Claude Code, Cursor):
  - Replaced @supabase/auth-helpers in src/proxy.ts with custom JWT verification.
  - Updated /api/users to return { user, session }; mobile client not yet updated.
  - Verified: signed-in flow works locally; sign-out clears the cookie.
  - Open: OAuth callback path still using the old helper — needs migration in next session.
  - Decision recorded as separate kind: "decision" entry "JWT middleware: HS256 vs RS256".
branches: ["feature/jwt", "main"]
repositories: ["jubarteai"]
refs: ["ENG-441", "https://github.com/org/jubarteai/pull/88"]
kind: "workdone"
```

**Every workdone update is a capture trigger — not an alternative to capture.** This is the most important habit in this file. Because you reliably update the workdone after each verified fix or decision, that update is the perfect moment to ask: *does this bullet state something reusable?* If the bullet names a **root cause**, a **config/flag**, a **decision between approaches**, or a **team/user convention**, promote it into its own standalone entry **in the same step** — `knowledge` for findings, `decision` for choices with rationale, `memory` for conventions. The workdone is the *index*: what happened, in order, scoped to this task and branch. The standalone entry is what a peer on another branch can actually search up. A finding logged *only* in the workdone is invisible to everyone not already on your task — which is the single most common way reusable knowledge silently fails to accumulate. Cross-link from the workdone body by exact title so a future reader can fetch the deep dive.

**The trap to avoid.** It feels like the workdone "covers it" because you already wrote the bullet. It doesn't. The workdone update satisfies the *session-log* duty; it does **not** satisfy the *capture* duty. Treat them as two separate writes that happen back-to-back: log the bullet, then promote the reusable part.
