# Plan — Actionable credential-error panel in the Git dialog

| Field | Value |
| --- | --- |
| Date | 2026-08-05 |
| Source | /implement follow-up: "let it well explained for the user" — the one-time Bitbucket credential setup must be clearly explained in-app, at the point of failure |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/bitbucket-git-integration-not-loading-pr |
| Base SHA | 19ea57c |
| Mode | Autonomous — gates bypassed; assumptions in §8 |

## 1. Objective & success criteria

When loading PRs/issues fails because of a missing/invalid git-host credential,
the dialog shows a friendly explainer panel — what happened, the one-time fix
(create the token, save it as `email:api_token` / PAT for the repo's host), and
a button that closes the dialog and opens Settings (where the "Git host tokens"
section and its setup guide live) — instead of a bare red error row.

## 2. Context & constraints

- Credential errors are already enriched server-side with the marker phrase
  "Settings → Git host tokens" (github.ts `privateRepoHint`, gitlab.ts
  `authHint`, bitbucket.ts `bitbucketAccessHint`). The webview shows them
  verbatim: main list error block at GitHubDialog.tsx:3829-3833.
- SettingsDialog opens via App.tsx `settingsOpen` state (App.tsx:153, 909);
  GitHubDialog has no Settings affordance today.
- The setup guide (GitHubSetupDialog) already documents the full Bitbucket
  (API token with scopes → email:api_token) and GitLab flows; the missing link
  is discoverability from the error.

## 3. Approach & key decisions

- Single source of truth for detection: add a `GIT_HOST_TOKENS_SECTION`
  constant ("Git host tokens") to src/shared/types.ts; bun hint builders
  interpolate it, and the webview detects a credential error with
  `error.includes(\`Settings → ${GIT_HOST_TOKENS_SECTION}\`)` — no duplicated
  magic string. Rendered wording unchanged (existing tests keep passing).
- Panel over toast: render an explainer card in place of the current error row
  (title, the server's enriched message, a short numbered one-time-setup
  summary, "Open Settings" + "Dismiss"-free — the panel IS the error state).
- `onOpenSettings?: () => void` prop threaded from App.tsx (closes the git
  dialog, opens SettingsDialog). Optional so other mounts don't break.

## 4. Work breakdown — implementation tasks

Single task/agent (small, interdependent): owns src/shared/types.ts,
src/bun/github.ts, src/bun/gitlab.ts, src/bun/bitbucket.ts (constant
interpolation only — no wording change), src/mainview/components/kanban/
GitHubDialog.tsx, src/mainview/App.tsx.

## 5. Work breakdown — test tasks

Existing wording tests already pin the hint text (unchanged). Add none unless
the constant refactor breaks one (then fix in place). E2e: not applicable —
no runnable e2e harness on this branch; visual change verified by typecheck +
unchanged hint-wording tests.

## 6. Execution waves

1. T1 → typecheck + targeted tests → commit. 2. Opus review → fixes if needed.
3. Full suite.

## 7. Blast radius & risks

- Hint strings byte-identical after constant interpolation (tests prove it).
- GitHubDialog is large; change is confined to the list-error block + prop.
- Marker-phrase detection is heuristic; acceptable — false negative degrades
  to today's behavior (plain error text).

## 8. Open questions / assumptions

- A1: Panel appears for the main list error only (where "not loading PRs"
  manifests); per-sub-panel errors keep plain text (they're post-load actions
  and already carry the hint text).
- A2: "Open Settings" opens the Settings dialog root (no deep-link/scroll to
  the section) — the section is prominent enough; deep-linking is future work.
