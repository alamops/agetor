# Writing knowledge entries

Everything you need to write a good `create_knowledge` or `update_knowledge` call: what to capture, choosing a `kind`, freshness assessment, and what never to write.

## What to capture as knowledge

**Default rule: if you'd put it in a comment, a README, or a Slack message to a teammate — put it in `create_knowledge` instead.** Short entries are fine; update them later. Examples of the everyday low bar:

- *"The type error fixed by importing from `@/lib/x`, not `@/x`"* ← write it
- *"`bun test` requires `--preload ./setup.ts` or tests silently skip"* ← write it
- *"The `users.role` column is a text enum, not a foreign key"* ← write it

Larger things also worth capturing:

- **Architectural decisions** — why a pattern was chosen, what was rejected and why.
- **Non-obvious configuration** — env vars, flags, or settings that must be set a specific way.
- **Bug fixes with a root cause** — not "fixed X" but "X fails when Y because Z; fix is W."
- **API / library quirks** — undocumented behavior, version-specific gotchas, workarounds.
- **Repeatable patterns** — a code shape that solves a class of problems and should be reused.
- **Integration steps** — how two systems connect, what credentials or tokens are involved.
- **Test or build gotchas** — flaky tests, slow steps, environment-specific failures.

**Starting from an empty knowledge base**: empty search results are normal on a new project — not a failure. If you're the first agent in a repo, you're the foundation-setter. Before finishing your first session, write at minimum: (1) the canonical repo slug and agent naming convention your team will use, (2) one entry describing the project's core architectural structure. Future agents will build on what you leave. Don't duplicate what's already in the README — knowledge entries add value by capturing *why*, not just *what*.

## Writing good entries

| Field | Guidance |
|-------|----------|
| `title` | One-line noun phrase: what is this knowledge *about*? (e.g. "Stripe webhook idempotency pattern") |
| `description` | Lead with the insight, then the context. Include the *why*, not just the *what*. 2–6 sentences. **Use markdown** — headers, bullet lists, and code blocks render correctly and make entries easier to scan. |
| `branches` | At least one. When unsure, `["main"]` is always a valid default. |
| `repositories` | At least one. Use the repo slug (e.g. `"jubarteai"`, `"mobile-app"`). When unsure, use the slug from `git remote get-url origin`. |
| `refs` | Optional. External identifiers tying the entry to the work that produced it: ticket IDs (`"ENG-441"`), GitHub issue/PR URLs, Linear/Jira IDs, design-doc links. Use the same identifier you put in `agent_tasks.refs` so a search by ref finds both. Free-form text. |
| `kind` | Optional, defaults to `"knowledge"`. Enum: `knowledge` \| `decision` \| `memory` \| `note` \| `workdone`. See "Choosing a `kind`" below. |

**Choosing a `kind`** — pick the value that matches what the entry actually is:

- `"knowledge"` *(default — use for the bulk of entries)* — reusable findings: bug fixes with root cause, configs and env flags, API quirks, integration steps, repeatable patterns, test/build gotchas. Long-lived; treat as authoritative.
- `"decision"` — architectural or design choices with rationale: why pattern X was chosen over Y, what was rejected and why. Higher-weight; future agents should treat these as the team's stance until explicitly superseded.
- `"memory"` — durable per-fleet context that's not a "fix" or a "decision": user/team preferences, naming conventions, project-specific norms, repo slug conventions, things to remember across sessions. **Trigger to watch for:** if you had to *read existing code to learn how the team does something* before you could write your change consistently (a mapping layer, a guard every route calls, a file you must never hand-edit), that discovered convention is `memory` — capture it so the next agent doesn't reverse-engineer it. This one is easy to skip because applying a convention feels like using context, not learning something.
- `"note"` — informal observations, in-progress hunches, lower-confidence findings that may need verification. Lighter than `knowledge` — useful for capturing leads you don't want to lose without overstating confidence.
- `"workdone"` — per-session/per-task work log. The agent creates one workdone entry early and updates it as the session progresses. Future agents searching the same branch/repository/refs use these entries for handoffs, follow-up work, and conflict resolution. Tag with the same `branches` / `repositories` / `refs` as your `echo_current_task` so the entry is rediscoverable by every dimension. Distinct from `knowledge` (reusable findings) — workdone is a session log, not an encyclopedia entry. See `references/workdone.md` for the full protocol.

When a `note` matures into a confirmed finding, use `update_knowledge` to reclassify it as `knowledge` (or `decision`).

**Minimum viable entry**: a 2-sentence `description` with `branches: ["main"]` and the correct `repositories` slug is better than no entry. Default `kind: "knowledge"` is fine when you don't want to think about it. Write short and often; use `update_knowledge` to expand or reclassify later.

**Example:**
```
title: "Supabase RLS bypass via service-role client"
description: |
  The admin/service-role Supabase client bypasses all RLS policies.

  **Never use it on user-facing paths** — use a `SECURITY DEFINER` RPC instead.
  This was introduced to avoid leaking cross-tenant data through the MCP route,
  where the resolved API key provides the only trust anchor.

  ## Fix
  Replace direct `supabaseAdmin` calls in user-facing routes with an RPC that
  runs with the caller's permissions.
branches: ["main"]
repositories: ["jubarteai"]
refs: ["ENG-441", "https://github.com/org/jubarteai/pull/88"]
```

## Assessing entry freshness

Entries in `search_knowledge` results may be months or years old. Before acting on an entry:

- **Cross-reference against the code.** If the entry's advice contradicts what you observe in the codebase, trust the code — and `update_knowledge` to correct or deprecate the entry.
- **Check the described APIs and config keys still exist.** A config key that was renamed or a function that was refactored away makes an entry actively misleading.
- **When an entry is clearly stale**, call `update_knowledge` with a corrected description or prepend a deprecation note (e.g. `> **Deprecated 2026-04:** this pattern was replaced by X — see "New pattern title" entry`).
- **Cross-linking**: if your entry builds on or contradicts another, mention it by exact title in the `description`. Readers can fetch it with `get_knowledge({ name: "Exact Title" })`.

## What never to put in knowledge entries

Knowledge entries are shared across every agent and human in your company. Never store:

- **Secrets**: API keys, tokens, passwords, connection strings, private keys. Document the *name* and *purpose* of a credential — not its value. Write `"Set STRIPE_SECRET_KEY in .env — obtain from the Stripe dashboard under Developers → API keys"`, not `"STRIPE_SECRET_KEY=sk_live_abc123..."`. Reference your secrets manager or `.env.example` instead.
- **PII**: user emails, names, IDs, addresses, or any data covered by your privacy policy. Describe the data shape and the bug pattern, not the values.
- **Unreleased internal data**: roadmap details, revenue figures, unannounced features, or personnel information.

If you're unsure whether something is safe to write, ask: would I commit this to a public repo? If no, don't write it here.
