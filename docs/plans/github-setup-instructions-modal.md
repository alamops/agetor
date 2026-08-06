# Plan — GitHub Setup Instructions Modal

| Field | Value |
| --- | --- |
| Date | 2026-07-23 |
| Source | /implement: "add a modal with full instructions of how to configure Agetor for connecting to GitHub for having full access to the GitHub integration, including all permissions they need to setup in GitHub" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/configure-github-for-pull-requests-info |
| Base SHA | 4bf523249743f9c02676876eb50988c1864145ee (tree clean apart from this plan file) |
| Mode | **Autonomous** — the grill gate (Phase 2) and plan-approval gate (Phase 3) were bypassed because the run is unattended (agetor-driven `/implement`); every assumption is logged in §8. |

## 1. Objective & success criteria

Add an in-app instructions modal that walks a user through configuring Agetor's GitHub
integration end-to-end: creating a token (fine-grained or classic), granting **every
permission the integration actually uses**, and storing the token in Agetor.

Done means:
- A "Setup guide" affordance opens the modal from Settings → GitHub tokens (the place
  tokens are pasted) — including from its "No tokens stored yet" empty state.
- The modal explains: what the integration can do; the three auth resolution steps;
  fine-grained PAT click-path + full permission list; classic PAT click-path + scope
  list; ssh host-alias / multi-identity handling; org caveats (fine-grained approval,
  SAML SSO authorize); "Open GitHub settings" buttons via `api.openExternal`.
- Permission data lives in a pure, unit-tested lib module.
- `bun run typecheck` green, `bun test` green, `vite build` green.

## 2. Context & constraints (Phase 1 findings)

- **Auth resolution** (`src/bun/github.ts:856-863`): stored token (`tokenForHost` —
  exact raw-host match, then `github.com` default entry; `src/bun/github-tokens.ts:159`)
  → `GITHUB_TOKEN` / `GH_TOKEN` env → `gh auth token`.
- **Token store**: `~/.agetor/github-tokens.json`, per-host entries keyed by the *raw*
  ssh remote host (multi-identity via `~/.ssh/config` aliases like `github-work.com`);
  managed in Settings → GitHub tokens (`src/mainview/components/settings/GitHubTokensSection.tsx`),
  routes `/github/tokens` (+ `/:host` DELETE) in `src/bun/server.ts:2427,2446`.
- **Integration surface** (~70 `/github/*` routes, `src/bun/server.ts:630-2446`): PR
  lifecycle (list/search/diff/commits/create/merge/close/reopen/draft/auto-merge/
  update-branch/mergeability/reviews/reviewers/line comments + replies + suggestions/
  review-thread resolve/linked issues/checks/commit status), issues (create/update/
  lock/pin/transfer/sub-issues), comments CRUD, labels + milestones CRUD, releases +
  tags, Actions (workflows/runs/re-run/cancel/dispatch), Projects v2, Discussions,
  reactions, notifications + thread subscriptions, viewer, repo-permissions.
  GraphQL (`api.github.com/graphql`, `src/bun/github.ts:2812+`) powers draft toggle,
  pin, transfer, Projects v2, Discussions, review-thread resolve.
- **UI conventions**: `Dialog` primitive (`src/mainview/components/ui/dialog.tsx`,
  `open`/`onClose`/`labelledBy`/`describedBy`, `max-w-lg` default overridable via
  `className`); dark mode only; `api.openExternal(url)` (`src/mainview/lib/api.ts:1133`)
  for browser links (webview sandbox — no `target="_blank"`); pure view logic extracted
  to `src/mainview/lib/*.ts` with bun tests (`github-dialog-view.ts` pattern — no DOM).
- **Provider note**: GitLab/Bitbucket share the token store, but this modal is
  GitHub-scoped per the request; the guide text mentions that only GitHub is covered.
- Permission facts verified against docs.github.com by a web-research agent
  (fine-grained permission names, classic scopes, click-paths, org caveats) — its
  findings are encoded in `github-setup-guide.ts`.

## 3. Approach & key decisions

- **One new dialog component** `GitHubSetupDialog.tsx` under
  `src/mainview/components/settings/`, rendered from `GitHubTokensSection` (a small
  "Setup guide" button next to the section header + a link in the empty state).
  No changes to `GitHubDialog.tsx` (8.7k lines, active peer overlap risk) — the
  Settings section is where tokens are pasted, so it's where the guide belongs.
- **Content as data**: `src/mainview/lib/github-setup-guide.ts` exports typed constants
  (fine-grained permission rows {name, level, usedFor}, classic scope rows, auth
  resolution steps, GitHub settings URLs). The component maps over them; the lib gets
  a bun test (uniqueness, https-only URLs, non-empty coverage of the major op groups).
- **No server changes** — purely static instructional UI; token CRUD already exists.
- Alternatives considered: markdown-rendered doc (no markdown renderer in mainview —
  rejected); putting the guide inside GitHubDialog (peer `hollow-haven-4527` /
  `deep-glade-ea8c` are near that surface; higher collision + review cost — rejected).

## 4. Work breakdown — implementation tasks

- **T1** — `src/mainview/lib/github-setup-guide.ts`: typed guide content (permission
  tables, scopes, URLs, resolution steps, org caveats). Owns only this file.
  Acceptance: exports consumed by T2 compile; content covers every op group in §2.
- **T2** — `src/mainview/components/settings/GitHubSetupDialog.tsx` (new) +
  `src/mainview/components/settings/GitHubTokensSection.tsx` (trigger button + empty-state
  link + render the dialog). Owns those two files. Acceptance: modal opens/closes,
  scrolls (`max-h` + `overflow-y-auto`), external links via `api.openExternal`,
  matches dark-mode styling conventions.

Wave 1: T1 + T2 are file-disjoint but T2 imports T1's types — run as ONE agent
(single wave, single task) since the combined scope is small; splitting would only
add an interface-drift risk.

## 5. Work breakdown — test tasks

- **TT1** — `src/mainview/lib/github-setup-guide.test.ts`: no duplicate permission/
  scope names; all URLs https + on github.com/docs.github.com; fine-grained table
  includes the load-bearing permissions (Contents, Pull requests, Issues, Actions,
  Checks, Commit statuses, Discussions, Projects, Metadata…); classic table includes
  repo/workflow/notifications/project/write:discussion; resolution steps mention the
  env vars and gh CLI verbatim (`GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`).

## 6. Execution waves

- Wave 1 (Phase 4): one implementation agent → T1 + T2.
- Phase 5: code-review agent (opus) on the diff.
- Wave 2 (Phase 6): one test agent → TT1.
- Phase 7: test-run agent (haiku): `bun run typecheck` + `bun test` (+ `bunx vite build`).

## 7. Blast radius & risks

- Touches only Settings surface; no server, db, or orchestration changes.
- Peer overlap: active fleet agents are working on Commit&Push button, Diff-modal
  close button, and stream rendering — none own `GitHubTokensSection.tsx`.
- Permissions accuracy is the main product risk — mitigated by doc-verified research;
  UNVERIFIED items are phrased conservatively in the guide text.

## 8. Open questions / assumptions (autonomous mode)

1. **Trigger location**: Settings → GitHub tokens section (primary + empty state).
   Not added to GitHubDialog to avoid colliding with peers on that file.
2. **Scope**: GitHub only (per request); GitLab/Bitbucket setup is out.
3. **Both token types documented** — but research (docs.github.com) showed the
   Notifications API is classic-PAT-only, the Checks API is not grantable to
   fine-grained PATs, and Discussions has no fine-grained permission. So the guide
   recommends a **classic PAT (repo, workflow, notifications, project, read:org)**
   for FULL integration access, and documents fine-grained PATs as the
   least-privilege alternative with an explicit "what won't work" list.
4. **No screenshots/images** — text steps + deep links (consistent with app style).
5. Modal is informational only — it does not embed the token form itself (the form
   is directly behind it in the same Settings section).
