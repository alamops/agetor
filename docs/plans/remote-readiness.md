# Plan — Remote Readiness (Mac side of the Agetor Companion)

| Field | Value |
| --- | --- |
| Date | 2026-11-25 |
| Source | Spec `docs/specs/remote-readiness-spec.md` (rev 40, unamended; the grill's amendments land as task D0) and `docs/specs/remote-relay-contract.md`; investigation `docs/plans/remote-readiness-investigation.md`; grill record `docs/plans/remote-readiness-grill.md` (D1–D19, C1–C9, E1–E6) with `docs/plans/remote-readiness-grill/round-{1,2,3}/` |
| Flags | none |
| Gates | Grilled (3 owner rounds, nothing skipped) and **approved by the owner on 2026-11-25**, with three decisions taken at approval: full `bun run check` is the required CI job (A-2), switch-account is session-only (A-4), and delivery is one PR with per-wave commits (A-11). See §8.2. |
| Status | **implemented** on `feature/agetor-remote-ready` (waves 0–6 committed, one checkpoint commit per wave; wave 7 is this refresh and the e2e specs). **K1V (live key-helper verification) was NOT run: it is owner-gated** (App ID and Developer ID profile); see `docs/plans/remote-readiness-k1.md`. **W1 verdict:** `ts-json-schema-generator` expressed all 11 route-body types, no hand-written fallback was needed. **Verification at the final head:** typecheck, `lint:async`, the package tests (134), the script tests (18) and every changed or affected `bun test` file (7,500 tests across remote, route-policy, migrations, db, server, background, headless, cli, mainview, shared) pass. The last full `bun test` run (24 min, before the final fixes) had 16 failures: 14 were this change's own and are fixed (three migration-list tests, the spawn allowlist for the IT harness, `route-db-errors` fixtures, two load-sensitive tests in `server-remote-access.test.ts`), and 2 are pre-existing on `1d37cdc2` (`archiveTask keeps a dirty worktree on disk…`, `archiving a multi task with one dirty repository…`, reproduced on the base commit). Integration suites `src/bun/remote/it`: 82 tests against a real headless core. e2e (Playwright, one run at a time): `remote-access-devices` (2), `phone-terminal-banner` (1), `one-notification-per-task`, `event-stream-resume`, `cursor-stream` and `background-settings` all pass. Known red on `main`, untouched: `tmux-socket.test.ts`, `reconcile.test.ts` "startTask honors cancel", `model-discovery.test.ts` copilot refreshAllModels, `github-network.test.ts`, and the two archive tests above. |
| Branch | `feature/agetor-remote-ready` |
| Base SHA | `1d37cdc2` (v1.2.2). Wave commits: 0 `ee6bb316`, 1 `186aa6c6`, 2 `cda89b2a`, 3 `5aba2fa0`, 4 `2f723b6b`, 5 `e4cc2b7d`, 6 `56917fcb`, 7 `b9a91366` |

Reading guide. §1 says what "done" means and which production path produces each result. §3 pins the interfaces several tasks code against at once. §4 is the contract each implementation agent works from: every task lists the files it owns, the scenarios it must prove, and what wires it in. §6 orders the tasks into waves whose owned files never overlap.

---

## 1. Objective & success criteria

**Objective.** After this change the Agetor core can pair a phone through a native window, serve it over an end-to-end encrypted, mutually authenticated Noise session over a relay link, and let it call only the v1 routes at or below its level. It also gains: signed consent and the unlock window, idempotency, a cross-task inbox, small first loads, a phone projection of events, one core-owned notification decision with sealed pushes, a hash-chained audit log, controls (menu, Settings, CLI, HTTP), a configure-level terminal on the phone, and level-gated previews. No phone app ships. A headless test client proves the whole loop, and a CI job gates the protocol and the security suite. Release builds ship it **dark**: compiled and tested, with pairing hidden and the gateway never started (D1).

Each criterion names the production path that produces it (entry point → … → new code) and the test that drives that path.

| # | Criterion | Production path | Proven by |
| --- | --- | --- | --- |
| SC1 | A phone pairs only through the native window: the code is typed on the Mac, then Touch ID or the login password. The device gets the level chosen in the window: Respond (the default), Operate, or Configure, which asks for a second confirmation. | `app-menu.ts` "Pair a Phone…" → `index.ts` menu handler → `remote/gateway.ts` `startPairing` → `remote-access-box.ts` (turns the switch on if it is off) → `remote/key-helper.ts` `pairBegin` (helper window, QR) → `remote/relay-link.ts` (pairing mailbox) → `remote/pairing.ts` (NKpsk0 responder) → `pairComplete` (code, level, Touch ID, registry signature) → op `remote.addDevice` (+ audit) | TS1 `pairing.it.test.ts` (fake helper); K1V (real helper, owner's Mac) |
| SC2 | The relay link is up only while invariant 1 holds, and goes down within 1 s when remote access is turned off, the last device is revoked, or the pairing window closes with no devices left. | `remote/gateway.ts` → `remote/link-gate.ts` (one decision) → `remote/relay-link.ts` | TS1 `link-gating.it.test.ts` |
| SC3 | A phone reaches route handlers only through `invokeRoute`, only for routes with a remote level at or below its own. It never reaches `app` routes, and it passes the CLI path gate. | session op `request` → `remote/session.ts` → `remote/router.ts` → `route-policy.ts` `wrapHandler` (device branch) → the wrapped route in `route-table.ts` | TS2 `router-levels.it.test.ts`; RP unit tests |
| SC4 | Consent is signed over the exact content shown (all 6 gate fields; plan hash; card question, options and mode). Content sent into a task that runs without asking needs the unlock window. The D8 and D9 rows are classified, and so are D10 texts. Always-allow, unknown rows and login codes are refused. | `remote/router.ts` → `remote/route-classes.ts` → `remote/decisions.ts` + `remote/content-hash.ts` → handler | TS2 `consent.it.test.ts`; DE and RT unit tests |
| SC5 | A repeated `idem` key returns the stored result. The same key with a different body is refused. This survives a port handoff. | `remote/router.ts` → `remote/idempotency.ts` → op `remote.idempotencyPut` (migration 096) | TS2 `idempotency.it.test.ts` (with a real core restart) |
| SC6 | The phone builds its inbox in one request and catches up within `maxBytes`. It sees tool results over 16 KB cut, fetches them by event id, and gets each event with its parsed form. | `GET /interactions/pending` and `GET /tasks/:id/events/:eventId` (server.ts) via the router; task and global subscriptions → `remote/subscriptions.ts` → `task-event-stream.ts` + `remote/projection.ts` | TS3 `data.it.test.ts`; E1, SU and PR unit tests |
| SC7 | One notification decision in the core feeds the macOS sink and the phone sink: OS notifications in the app and the headless core, and sealed pushes. No push goes out while the window had focus in the last 2 minutes. The webview no longer decides. | GlobalEvent → `notification-policy.ts` (sinks: OS via `index.ts` native or `headless.ts`; phone via `remote/push.ts`) ← `presence.ts` (Electrobun focus/blur + `PUT /app/presence`) | N1/N2 unit tests; e2e `one-notification-per-task.spec.ts`; TS3 `push.it.test.ts` |
| SC8 | Every remote action leaves a hash-chained audit row before its answer goes out: an attempt row first, then a result row. UPDATE is always refused, and DELETE outside the trim op. The chain head is sent in the hello. Settings and the CLI can show the log. | `remote/router.ts`, `pairing.ts`, `registry.ts`, `session.ts`, `terminal.ts` → `remote/audit.ts` → ops `remote.auditAppend`, `remote.auditTrim` | TS3 `audit.it.test.ts`; DB trigger tests |
| SC9 | Controls: the menu item; Settings › Remote access (devices, trust, Revoke, Revoke all, Activity, relay address, Mac name); the CLI `devices`, `revoke`, `revoke-all` and `log`; and the D19 routes. Revoke, revoke-all and turning remote access off end live sessions within 1 s. | `server.ts` `/remote-access/*` → `remote/registry.ts` / `remote/audit.ts` / `remote/session.ts`; `src/cli/commands/remote.ts`; `RemoteAccessSection.tsx` | TS1 `revoke.it.test.ts`; CLI tests; e2e `remote-access-devices.spec.ts` |
| SC10 | A `configure` device can attach to a task's tmux session with a signed biometric attach. While it is attached, the Mac shows "Phone attached to \<task\>" with a Detach button. Detach happens on request, when the session ends or the peer leaves, after 15 minutes idle, or on Detach. Attach and detach are audited, keystrokes are not. | session op `terminal-attach` → `remote/terminal.ts` → `coreSpawn` tmux `attach-session` in a PTY; app event `phone_terminal` → `RunPanel` banner; `DELETE /tasks/:id/phone-terminal` | TS2 `terminal.it.test.ts`; e2e `phone-terminal-banner.spec.ts` |
| SC11 | Phone previews work up to 50 MB with no folder limit. Paths inside the task's folders open at any level; any other path needs `operate` or above. Files are read without following symlinks and sent in chunks under the relay limits. | `GET /tasks/:id/files/preview` via the router (`route-classes.ts` D15 rule) → `core-file-read.ts` → chunked by `session.ts`, paced by `relay-link.ts` | TS2 `previews.it.test.ts` |
| SC12 | Ship dark plus a signed helper. In a release build the gateway never starts, pairing, Settings devices and the CLI device commands are unavailable, and the test seams are dead code. The key helper ships as a Developer ID nested `.app` with an embedded profile. `verify-release.ts` fails closed otherwise. | `src/shared/build-flags.ts` (Bun `define`) → `remote/gateway.ts`, `app-menu.ts`, `remote/key-helper-api.ts`, `remote/relay-config.ts`; `scripts/build-keyhelper.ts` → `electrobun.config.ts` copy → `scripts/verify-release.ts` | REL unit tests (`verifyKeyHelperLayout`, `verifyReleaseBundles`); B1 unit tests; K1V |
| SC13 | `packages/remote-protocol` implements Noise NK and NKpsk0, framing, padding, canonical JSON, ES256 with `lowS:false`, HPKE, the derivations, strict message parsers and the JSON Schemas. It passes the cacophony NK and NKpsk0 vectors, snow NK, RFC 9180 and our own vectors. | consumed by every `src/bun/remote/*` module | P1–P5 unit tests and vectors; the CI required job |
| SC14 | A headless test client pairs and works the blocked-agent loop. Every invariant has a named passing test. CI runs the gate on `macos-15`. | `packages/remote-protocol/src/test-client.ts` → the local test relay → a headless core (`bun src/bun/headless.ts`) | TS1–TS3; CI2 |

---

## 2. Context & constraints

### 2.1 Contract documents (in the repo)

- `docs/specs/remote-readiness-spec.md`: the spec as rev 40, unamended. Task D0 applies the grill's amendments inline, marked, as its own commit, so the diff can be reviewed.
- `docs/specs/remote-relay-contract.md`: the relay wire contract and limits (relay spec rev 50, two sections) plus the Blueprint §12 work list that the spec's "Blueprint" column cites (C7).
- `docs/plans/remote-readiness-investigation.md`: findings, spikes and the completeness inventory.
- `docs/plans/remote-readiness-grill.md`: the owner's decisions. Where this plan and the spec differ, **the grill wins**, as amended by D0.

### 2.2 Code anchors (checked on this branch at `1d37cdc2`)

| Area | Anchor | What it means for the plan |
| --- | --- | --- |
| Policy type | `src/bun/route-policy.ts:59-101` (`remote: "none"` at :67), building blocks :103-109, `ROUTE_POLICY` :160 | RP widens the type and keeps `"none"` everywhere except the v1 set |
| Caller | `route-policy.ts:34` `ApiCaller`; `resolveCaller` :532; private `callers` WeakMap :546; `callerOf` :553 | The device mark lives beside it, module-private (invariant 7) |
| Walker | `route-policy.ts:748-788` `wrapHandler` (CLI path gate at :778), `applyRoutePolicy` :813-871 (startup checks) | The single enforcement point for device level, app-route refusal and the path gate |
| Policy tests | `route-policy.test.ts:184-188` (every entry `none`), TT3(c) :454-504, CLI inventory :630-646 | Replaced or extended by RP, CT and CLI |
| Routes object | `server.ts:1896-1917` inline in `Bun.serve`; `startApiServer` :1729 returns `server` (:10205) | E1 hoists it and registers it in `route-table.ts` (E3) |
| v1 handlers | `server.ts` switch-account :6765, pipeline :7089, review :7171-7226 (6 fields, E4), cancel :7254, runs :7324, subagents :7331, git-status :7539, run cancel :7609, `/files/preview` :8012, ask answer :8139, tmux answer :8403, fx answer ~:8571, per-task pending :8638, backlog :8661, seen :8773, plan PATCH :8795, approve :8859, fx-resume :9090, run input :9161, `/events` :9462, `/remote-access` :9555, `/notifications` :9568 and `/:taskId` :9623, events page :9843, messages history :9885, task events :9918-~10160 | Levels in RP; E1 extracts the replay from :9918 |
| Streams | `event-resume.ts` (forward resume), `orchestrator.ts:647` `subscribe`, :944 `subscribeGlobal`; budgets `src/shared/types.ts:6287, 6296`; `db-core/runs.ts:82, 564-667` (`maxBytes` walk) | E1 and SU reuse them; no second copy (investigation assumption 6) |
| Global events | `src/shared/types.ts:6505+` (10 kinds), `AppEvent` :6904; `broadcastAppEvent` in `src/bun/quit-guard.ts:46` | SU allowlist; RP adds the `phone_terminal` and `remote_action` app events |
| Interactions | `interactions.ts:173-184` `TmuxPromptChoice {key,label}`, :278-279 `TMUX_ENTER_ANSWER`/`TMUX_CODE_ANSWER`, ACP kinds :316, OpenCode :1110-1127; `task-plans.ts:202`; `pipeline-runner.ts:86` `pendingHumanSteps` | J1 classifier; DE content hashes; E1 inbox |
| Notifications | `src/mainview/lib/toasts.ts:81-102` `maybeNotifyOS`; `toast-slots.ts:83` `FocusedForcedPosts` (D7 rules); `headless-notifications.ts:155` `headlessNotificationFor`, :487 `installHeadlessNotifications`; `task-notifier.ts`, `notification-hooks.ts`; `src/shared/os-notification.ts:21` `NOTIFICATION_KINDS` | N1 moves the decision to the core; N2 cuts the webview over |
| Focus | Electrobun 1.18.1 native window `focus`/`blur` (`electrobun/dist/api/bun/events/windowEvents.ts:19-20`) | N2 wires them in `index.ts` (D5) |
| Remote switch | `background.ts:87-121` (`getRemoteAccess`, `setRemoteAccessOff`, `setRemoteAccessOnFromNativeBox`, `subscribeBackgroundChanges`); fake seam :68-78; probe reset :224-240; `remote-access-box.ts:91`; menu `app-menu.ts:40`; `index.ts:522-531` | GW subscribes; PA turns the switch on through the box |
| Boot | `index.ts:296-311` (bind, then restore), `markBootReady` :573; `headless.ts:291-313`; `boot-gate.ts:43` `gateRoutesUntilReady` | The gateway starts after `markBootReady` in whichever core owns the port |
| Spawns | `core-spawn.ts:165-176` (`coreSpawn` spreads `opts`, so `terminal:` works); `terminals.ts:329-345` (the one PTY spawn, `spawn-exempt(terminal-tab)`) | The key helper and the phone terminal both go through `coreSpawn`; no new exemption |
| tmux | `claude-tmux.ts:581` `sessionNameFor(taskId)` = `agetor-<12>` (shared by codex, gemini, copilot and opencode-tmux); `tmux-resolution.ts:213-226` `tmuxSocketName`/`tmuxSocketArgs` | TM attaches to exactly that session on agetor's socket |
| Logs | `core-log.ts:81` `registerLogSecret`, :98 `redactLogText` | Every new secret is registered (invariant 11) |
| DB | `db-core/ops/index.ts:16-45` (op registry), `db-core/modules.ts`, `db.ts:80-96`, `db-async.ts:157-219`, `db-rpc.ts:249-264`; latest migration `093_task_revs.sql` | DB adds 094, 095, 096, a module and an op file |
| Build | `electrobun.config.ts` `build.copy` (helpers under `Resources/app/bin`, never re-signed); `ElectrobunConfig.build.bun` accepts `Bun.build` options including `define` (`electrobun/dist/api/bun/ElectrobunConfig.ts:114-125`); `scripts/build-notifier.ts` (the model for a hand-assembled signed `.app`); `scripts/verify-release.ts:83` `verifyBackgroundLayout`; `scripts/release.ts:215-222` | B1 and REL |
| e2e | `e2e/fixtures.ts:555-583` (one headless backend per worker: `AGETOR_HEADLESS_NOTIFICATIONS=0`, `AGETOR_CLAUDE_DRIVER=fake`); `e2e/one-notification-per-task.spec.ts` observes the webview's `POST /notifications` with `page.route` (header :1-20) | N2 moves the observation point to the core (§8 A-4) |
| Workspace | Root `package.json` has no `workspaces`; `bunfig.toml` `root = "src"`; `tsconfig.json` includes only `src`, `e2e` and the configs; `lint:async` globs `src/bun`, `src/cli` and `src/shared`; `.github/` holds only `FUNDING.yml` | P1 and CI1 |

### 2.3 Repo rules that bear on this change

- `CLAUDE.md` § Security and process boundaries:
  - every route needs a `ROUTE_POLICY` entry;
  - every spawn goes through `coreSpawn`;
  - CLI path routes declare `pathParams`;
  - no-follow reads for agent-writable files;
  - the core never touches a task dir in-process while the disclaim switch is on;
  - Agetor never adds its own text to a message (phone follow-ups go in verbatim).
- `CLAUDE.md` § Data: production code imports `db-async.ts`; multi-statement writes are named ops; the three read-modify-write patterns; persisted events stay raw (the projection is applied at send time only); every `run_events` query must SEARCH (`db-run-events-plans.test.ts`); `src/shared/` has no runtime imports.
- `CLAUDE.md` § Runtime: no long synchronous loops on the main thread (Noise, HPKE and chunking are sliced, and a 50,000-row chain walk runs in the db worker); a maximum of about 6 connections per host in WKWebView, so add no new event stream (the banner rides the existing app-events stream); text printed by the CLI goes through `src/shared/terminal-text.ts` (phone-supplied device names).
- `CLAUDE.md` § Webview: `RunPanel` is a single long-lived instance (any per-task state needs a reset line); semantic color tokens only; a popover inside a dialog follows the `data-popover-open` contract; Settings layout state goes in `localStorage`, never in preferences.
- `CLAUDE.md` § Persistence: never edit an applied migration; append to `migrations/index.ts`; tests set `AGETOR_DATA_DIR` at the top level, call `rmTestDataDir`, and snapshot and restore harness state.
- `docs/plans/companion-pairing-requirements.md` rules 1–5 (rule 5 is rewritten by D19 in CT).
- `docs/architecture/security.md`, `always-on-host.md`, `core-responsiveness.md`, `persistence.md`, `notifications.md`, `run-panel.md`, `testing-seams.md`: each is updated by the task that changes its subsystem (§9).
- `src/bun/claudemd-citations.test.ts`: code cites docs by path. Until DOCS writes `docs/architecture/remote-gateway.md` in wave 6, new code cites `docs/specs/remote-readiness-spec.md`.
- Fleet and local rules for executors (owner memory):
  - never commit real ticket ids, client names or the Apple team name (D2), and use synthetic fixtures;
  - dogfood only in `~/.agetor-dev`;
  - in a fresh worktree run `bun install` and `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`;
  - macOS has no `timeout`, so bound probes with `perl -e 'alarm N; exec @ARGV'`;
  - zsh `nomatch` aborts a line with an unmatched glob;
  - scripted edits must assert their replacement count;
  - CLI smoke tests may use only `--help` or a fresh `--data-dir`, because `--no-daemon` still hits the running core;
  - Playwright runs one at a time, with Node 24.22.3 first on `PATH`, via `bun node_modules/@playwright/test/cli.js test`;
  - never `git stash` in a shared worktree.
- Pre-existing failures on `main` that are not regression signals (memory, last reconfirmed 2026-11-19): `tmux-socket.test.ts` ×2, `reconcile.test.ts` "startTask honors cancel", `model-discovery.test.ts` copilot `refreshAllModels` ×2, `github-network.test.ts` ×5, plus load-dependent timeouts. A full `bun test` takes about 20 minutes. This is the evidence behind §8 A-2.

### 2.4 Runtime and trust shape

- **Instances.** One core owns `127.0.0.1:4317`: the app or the background core, with a handoff (`app-takeover.ts`). Before this change a headless core may bind a wildcard address. After it, the gateway may still run there, with a warning (D11). The gateway runs only in the port owner, after `markBootReady()`. The core that loses the bind exits before touching any run, and with it its relay connections. The new owner's `core`-role connection replaces the old one (`replaced`).
- **Crash between steps.**
  - During pairing: the registry row is written only after the helper signs; a crash before that leaves nothing, and the phone fails and pairs again.
  - During a mutation: an attempt row with no result row reads "outcome unknown" (C3), and the `idem` row (persisted, A-7) answers the retry.
  - During a session: the phone handshakes again and resumes from its cursors.
  - A relay redelivery: dropped by its session tag.
- **Who can send input.**
  - The webview (master token: every route).
  - The CLI or any agent (CLI token: `app+cli` routes, path-gated).
  - A phone (`device`, only through a Noise session and the router: the v1 set at or below its level).
  - An agent running as the user, which can also: write SQLite (including device rows and the switch), read `agetor-core.json`, run Agetor's signed binaries (the key helper included, as a DH oracle), set env vars on cores it starts, and drop triggers.
  - The plan keeps every decision that matters behind the helper's signature, the helper's revocation list and Touch ID (invariants 2, 3 and 10). Seams are dead code in release builds (D4).
- **Privileged actions a phone can reach:** answers, consent, follow-ups and drafts, stop and cancel; at operate, auto-mode plan approval, switch-account and previews outside the task's folders; at configure, a live terminal that can type anything (D17's accepted bypass).

### 2.5 Spike verdicts (investigation §2)

| Question | Verdict | Versions |
| --- | --- | --- |
| Noble implements NK and NKpsk0 with an injected responder DH and matches cacophony byte for byte (including the handshake hash) | Yes | `@noble/*` 2.4.0, Bun 1.3.10 |
| Snow covers NK only, without a handshake hash and with no NKpsk0 for this suite | Partly, which is why C5 sets the vector set | snow `main`, 2026-11-25 |
| ES256 verifies with noble defaults | No (107/200); `{lowS:false}` 200/200 | `@noble/curves` 2.4.0 |
| The router can use `server.fetch` | No (it skips `routes:`) | Bun 1.3.10 |
| A handler can be called directly with a synthetic `Request` carrying `params` and a WeakMap mark, and `server.timeout()` doesn't throw on it | Yes; but `req.clone()` drops both `params` and the mark | Bun 1.3.10 |
| Claude's ExitPlanMode plan is in the JSONL while the modal is open | Yes (rows: 1 "Yes, and use auto mode", 2 "Yes, manually approve edits", 3 "Tell Claude what to change") | Claude Code 2.1.332 |

**Not yet spiked:**

- **K1 (live).** Profile-backed helper, Secure Enclave and the data-protection keychain. This is task K1V and gates nothing in code, but pairing cannot work without it (§8).
- **W1.** JSON Schema generation from `src/shared` types. Folded into P4, which has a fallback.

### 2.6 Live facts checked while planning (read-only)

- `ls src/bun/migrations | tail -4` → `093_task_revs.sql` is the latest, so the next migrations are 094, 095 and 096.
- `ls .github` → `FUNDING.yml` only. There is no CI to extend; CI1 creates the first workflow.
- `grep define …/electrobun/dist/api/bun/ElectrobunConfig.ts` → `build.bun` takes `Bun.build` options, `define` included (read from the main checkout; this worktree has no `node_modules` yet).
- `git status` → only the planning documents are untracked. Nothing on this branch is ahead of `main` (`1d37cdc2`).
- The owner's App ID and Developer ID provisioning profile do not exist yet (grill D2: an owner prerequisite).

---

## 3. Approach & key decisions

### 3.1 Shape

- **Protocol package.** `packages/remote-protocol/` is a Bun workspace package (`@agetor/remote-protocol`, private). Its `package.json` has a single wildcard export, `"./*": "./src/*.ts"`, so no task edits a barrel. It holds the cryptography, codecs, strict parsers, JSON Schemas, vectors, the **local test relay** and the **headless test client**. The relay spec's conformance suite reuses the last two; neither is ever imported by `src/`. *(Reasoning.)*
- **Core modules.** These live under `src/bun/remote/`, one module per concern. The gateway (`gateway.ts`) is the only composition point. The router (`router.ts`) is the only door from a session to a handler. `route-policy.ts` holds the only device-caller check. *(Spec "Architecture"; E3.)*
- **Router mechanics (E3, evidence).** `server.ts` hoists the fully wrapped routes object (`gateRoutesUntilReady(applyRoutePolicy({...}))`) into a variable and registers it in `src/bun/route-table.ts`. The router builds a synthetic `Request`, sets `params`, marks it with a module-private device principal, and calls that same wrapped handler. The boot gate, the policy walker and the path gate all run unchanged. Rejected: `server.fetch` (it skips `routes:`) and a second API for phones (it would drift).
- **Classification by value (D8, D9, D10, D15).** Some rules depend on the body or the query: a tmux choice's class, a reject or skip carrying text, a Claude plan row, a preview path outside the task's folders. The router applies them in `route-classes.ts` before step-up, keyed by `"METHOD pattern"`. The policy entry holds the route's *base* level. A classifier may only raise it or refuse the call, never lower it. *(Reasoning: one place, and it is testable.)*
- **The key helper is a long-lived child.** `coreSpawn` starts it, disclaimed, from either core (C6), and it speaks JSON lines over stdio (protocol pinned in §3.3). One DH per handshake keeps the X25519 static key out of Bun (invariant 10). The fake helper uses the same interface and is reachable only through the seam guard (B1). *(Spec plus D2, D3, D4.)*
- **Build flags (D1, D4).** `src/shared/build-flags.ts` exposes `RELEASE_BUILD` and `COMPANION_ENABLED`. Their values come from Bun `define` in `electrobun.config.ts` (`build.bun.define`), `scripts/build-daemon-bundle.ts` and `scripts/build-cli.ts`, driven by the env vars `AGETOR_RELEASE_BUILD=1` and `AGETOR_COMPANION_BUILD=1`, which the `build*` package scripts set. With no define (`bun test`, `bun run dev`, e2e) the defaults are `RELEASE_BUILD=false` and `COMPANION_ENABLED=true`. One guard, `remoteSeamsAllowed()`, is the only place a seam env var is honoured. It requires `!RELEASE_BUILD` and either `NODE_ENV=test` or `AGETOR_E2E_HARNESS_SEAMS=1`. `verify-release.ts` asserts that the seam markers are absent from the shipped bundles, which proves the dead-code elimination.
- **Idempotency is persisted (migration 096).** The spec's "keep each device's results for 10 minutes" would lose its store on a port handoff, which is a named runtime event (§2.4). A phone retrying across a handoff would then apply the mutation twice. Rows are pruned at 10 minutes, and responses are capped at 64 KB (a larger mutation response stores its status only). *(Reasoning, two-way: §8 A-7.)*
- **Audit.** An attempt row goes in before the handler and a result row after it (C3). The trim op drops and recreates the DELETE trigger inside one `BEGIN IMMEDIATE` and writes an anchor row (C2). Chain verification runs as a worker op.
- **Notifications (D5).** `notification-policy.ts` is the one decision, with sinks for the OS (native in the app, the notifier in a headless core) and the phone (`remote/push.ts`). `presence.ts` holds window focus (Electrobun native `focus`/`blur` is authoritative; the webview's `PUT /app/presence` is the backup and the only source on a headless core), the selected task and view, and `lastFocusedAt`. The webview keeps its in-app toasts and stops calling `notifyOS`.
- **The terminal (D17).** `coreSpawn([tmux, ...tmuxSocketArgs(), "attach-session", "-t", sessionNameFor(taskId)], { terminal })` runs it as a disclaimed tmux client in a PTY. Output is batched and paced under the relay limits. Only tmux-hosted per-task sessions qualify: claude-code, codex, gemini, antigravity, copilot and the OpenCode 1.x `run` driver. ACP harnesses and the OpenCode 2.x server answer `no-terminal`.
- **Relay addresses.** `relay-config.ts` keeps `BUILT_IN_RELAY_URL = null` and `BUILT_IN_PUSH_URL = null` until the relay spec ships. Dev and e2e reach the local test relay and the stub push gateway only through the seams. In release the gateway is dark anyway. *(Reasoning: no production relay exists, and the relay spec owns the signed config.)*
- **Schemas (W1).** Security messages get **hand-written** JSON Schemas and hand-written strict TS parsers (exact key sets: an unknown field is refused, invariant 13). The vectors are validated against both. Bodies of v1 routes get schemas **generated** from `src/shared` types by `ts-json-schema-generator` (a devDependency) and checked in. A test regenerates them and fails on drift. *(Fallback inside P4: if the generator can't express a type, hand-write that schema and record the verdict in `Status`.)* The Swift and Kotlin models are app work.

### 3.2 Decisions with their basis

| # | Decision | Basis |
| --- | --- | --- |
| A-1 | One level vocabulary, `observe < respond < operate < configure`, in `packages/remote-protocol/src/levels.ts`. A device's level is in its signed registry entry, so no route can raise it. | D6, D7 (owner) |
| A-2 | CI: one **required** job runs the full `bun run check` (which already covers `packages/remote-protocol`, the route-policy tests and the remote unit, integration and security suites) plus the key-helper vector self-test. No Playwright. | **Owner, at plan approval (2026-11-25):** "Full check required" (confirms C8). Consequence: the pre-existing failures on `main` (§2.3) keep the required check red until a separate ticket fixes them (owner-deferred, §9). |
| A-3 | Relay frames are binary: 1 byte version, 1 byte type, then type-specific fields. Variable fields are length-prefixed (u16 or u32 big-endian). Ciphertext frames carry the 8-byte session tag ahead of the Noise message. App messages inside Noise are JSON envelopes `{t, id, ci, cc, b}`, padded into the buckets 256 B, 1 KB, 4 KB, 16 KB and 64 KB. Both codecs are vector-pinned. | Spec framing; the relay contract (binary WS, ≤ 66 KB) |
| A-4 | `POST /tasks/:id/switch-account` is `operate`, step-up `none` (session only), class `action`. | **Owner, at plan approval (2026-11-25):** "Session only" (D12 set the level) |
| A-5 | `PATCH /tasks/:id/plans/:planId` is `respond`, content class, `signed` over the SHA-256 of the edited body, plus the unlock window when the task runs without asking. | D13 |
| A-6 | `POST /tasks/:id/fx-resume` is `respond` + `signed` over the task's fx recovery record. | D12 |
| A-7 | Idempotency rows persist (096). | Runtime shape (handoff) |
| A-8 | Phones never use the SSE routes. Task and global streams are session subscriptions served by `subscriptions.ts`, and the router refuses `/tasks/:id/events` and `/events`. | Spec "Subscriptions over the session" |
| A-9 | Detaching the terminal from the Mac uses a new route, `DELETE /tasks/:id/phone-terminal` (`app+cli`, removes authority), outside `/remote-access`, so D19's pinned allowlist stays exact. | D17 + D19 |
| A-10 | The Mac name is the preference `remoteMacName` (≤ 40 chars, cleaned). It defaults to `scutil --get ComputerName` through `coreSpawnSync`, falling back to `os.hostname()`. | D16 |
| A-11 | Delivery is **one PR** on `feature/agetor-remote-ready`, with one checkpoint commit per wave (§6.3). | **Owner, at plan approval (2026-11-25):** "One PR, per-wave commits" |

### 3.3 Pinned interfaces (several tasks code against these within a wave)

**Remote policy shape (RP, `route-policy.ts`)**

```ts
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
export type RemoteRate = "normal" | "heavy" | "stop";
export type RemoteStepUp = "none" | "unlock" | "signed";
export interface RemotePolicy { level: RemoteLevel; stepUp: RemoteStepUp; rate: RemoteRate; since: 1 }
// RoutePolicy.remote: "none" | RemotePolicy
export type ApiCaller = "app" | "cli" | "device";
export function markDeviceRequest(req: Request, principal: DevicePrincipal): void; // importable ONLY by src/bun/remote/router.ts (pinned by a test)
export function deviceOf(req: Request): DevicePrincipal | null;
export function remotePolicyFor(method: HttpMethod, routeKey: string): RemotePolicy | "none";
export function remoteRoutesFor(level: RemoteLevel): Array<{ method: HttpMethod; route: string; policy: RemotePolicy }>;
```

The device branch of `wrapHandler`, in this order:

1. Remote is `"none"` → 403 `{code:"not-remote"}`.
2. `callers` is `app` or `public` → 403 `{code:"not-remote"}` (startup already forbids it).
3. The route's level is above the principal's level → 403 `{code:"level"}`.
4. `pathParams` → `gatePaths` (403 `path-not-accessible`).
5. Set the caller to `device`, then run the handler.

**Shared remote types (RP, `src/bun/remote/types.ts`)**

```ts
export interface DevicePrincipal { kind: "device"; deviceId: string; deviceName: string; level: RemoteLevel; sessionId: string; sessionHash: Uint8Array; approvePub: Uint8Array }
export interface PhoneChannel {           // implemented by session.ts (SS); faked in unit tests
  readonly principal: DevicePrincipal;
  send(type: string, body: unknown, opts?: { heavy?: boolean }): void; // chunks + pads + paces
  queuedBytes(): number;                  // for the 4 MB backpressure cap
  peerPresent(): boolean;
  onClose(fn: (reason: string) => void): () => void;
  onPeerChange(fn: (present: boolean) => void): () => void;
}
export type RemoteClass = "read" | "remove" | "action" | "content" | "consent" | "never"; // action = a session-only mutation (switch-account, A-4)
export interface Classified { class: RemoteClass; level: RemoteLevel; stepUp: RemoteStepUp; rate: RemoteRate; target?: ContentTarget; reason?: string }
export type ContentTarget =
  | { kind: "plan"; taskId: string; planId: string }               // cursor/copilot approve, and PATCH edits (edited-body variant)
  | { kind: "claude-plan"; taskId: string; promptId: string; row: "auto" | "manual" }
  | { kind: "tmux-card"; taskId: string; promptId: string }
  | { kind: "fx-permission"; taskId: string; permissionId: string }
  | { kind: "gate"; taskId: string; stepId: string; seq: number }
  | { kind: "fx-resume"; taskId: string }
  | { kind: "terminal"; taskId: string; tmuxSession: string };
```

**App events (RP adds to `src/shared/types.ts` `AppEvent`)**

```ts
| { type: "phone_terminal"; taskId: string; deviceId: string; deviceName: string; attached: boolean; since: number; ts: number }
| { type: "remote_action"; taskId: string | null; deviceName: string; action: "plan-approved" | "card-allowed" | "gate-decided" | "auto-mode-approved" | "terminal-attached" | "device-paired" | "device-revoked"; ts: number }
```

**Presence and notification policy (N1)**

```ts
// presence.ts
export function setNativeWindowFocus(focused: boolean): void;   // Electrobun focus/blur (authoritative when seen)
export function setWebviewPresence(p: { focused: boolean; selectedTaskId: string | null; view: "run-panel" | "pipeline" | null }): void;
export function presence(): { focused: boolean; selectedTaskId: string | null; view: string | null; lastFocusedAt: number | null; appAttached: boolean };
export function setAppAttached(attached: boolean): void;        // false on a background core
// notification-policy.ts
export interface NotificationSink { id: "os" | "phone"; deliver(d: NotificationDecision): void | Promise<void>; remove?(r: TaskNotificationRemoval): void }
export function installNotificationPolicy(deps: {...}): { registerSink(s: NotificationSink): () => void; dispose(): void };
export function postDeviceNotification(n: { deviceId: string; title: string; body: string }): void; // pairing/revoke alerts (OS sink)
```

**Key helper protocol (K1 ↔ KH), JSON lines on stdin/stdout, one object per line**

- Request: `{"id":<n>,"cmd":"<name>","args":{…}}`. Response: `{"id":<n>,"ok":true,"result":{…}}` or `{"id":<n>,"ok":false,"error":{"code":"…","message":"…"}}`. Unsolicited events: `{"event":"window-closed"|"pairing-cancelled"}`.
- Byte fields are lowercase hex. Strings longer than the documented caps are refused.

| `cmd` | args | result | Notes |
| --- | --- | --- | --- |
| `status` | — | `{version, secureEnclave: true, corePub, registryPub}` | Creates the X25519 core key (data-protection keychain, access group `<TEAM>.sh.alamops.agetor.keyhelper`) and the Secure Enclave P-256 registry key (`.userPresence`) on first use. Fails `no-secure-enclave` / `keychain-unavailable` (no fallback, D3). |
| `dh` | `{peerPub}` | `{shared}` | One X25519 with the core static key. The private key never leaves. |
| `revoked` | — | `{ids}` | Reads the helper's own append-only list. |
| `revoke` | `{id}` | `{ids}` | Append-only. There is no remove command. |
| `revoke-all` | — | `{ids, corePub}` | Revokes every id the helper has ever signed, then replaces the core key. |
| `pair-begin` | `{relayUrl, macName, expiresAt}` | `{pairingSecret, qr}` | Opens the window, draws the QR (format in P4), and shows "Only continue if you chose Pair a Phone from Agetor's menu." |
| `pair-complete` | `{handshakeHash, deviceId, name, platform, appVersion, sessionPub, approvePub, pushPub, enrolledAt}` | `{level, entry, sig}` or error `wrong-code` / `expired` / `cancelled` / `auth-failed` | Shows the name as plain text. The user types the six-digit code (3 tries) and picks the level (Respond default / Operate / Configure, with a second confirm for Configure). Touch ID: "Add '\<name\>' to Agetor". Signs the canonical JSON of `{id, name, platform, session_pub, approve_pub, push_pub, level, enrolled_at}`. |
| `pair-cancel` | — | `{}` | Closes the window. |

The helper's command-line modes are `selftest` (K1 checks) and `selftest-vectors <dir>` (SAS, canonical JSON and QR against P1/P4 vectors).

**Encodings the Swift helper and the TS core must agree on (pinned; P1/P4 vectors are the proof)**

- **Registry entry.** The canonical JSON (RFC 8785) of exactly these fields:
  - `id`: 32 lowercase hex characters;
  - `name`: already cleaned by the core, ≤ 40;
  - `platform`: `"ios"` or `"android"`;
  - `session_pub` and `approve_pub`: uncompressed P-256, lowercase hex;
  - `push_pub`: X25519, lowercase hex;
  - `level`: one of the 4;
  - `enrolled_at`: integer milliseconds.
  - The signature is ES256, raw `r‖s`, 64 bytes, stored as BLOB.
- **QR payload.** Base64url (no padding) of the canonical JSON `{"fmt":1,"corePub":hex,"relayUrl":string,"mailbox":hex16,"pairingSecret":hex32,"expiresAt":ms}`. The helper builds it; `qr.ts` parses it (P4); `agetor-qr.json` holds the vectors.
- **SAS.** As in P1 `derive.ts`; `agetor-derive.json` holds the vectors.

**Session op handlers (SS registry, registered by GW)**

```ts
export function registerSessionOp(type: string, handler: (ch: PhoneChannel, body: unknown, msgId: string) => Promise<void>): void;
export function endDeviceSessions(deviceId: string, reason: string): void; // < 1 s
export function endAllSessions(reason: string): void;
```

The op types are `request`, `subscribe-task`, `subscribe-global`, `unsubscribe`, `challenge`, `unlock`, `push-register`, `revoke-self`, `terminal-attach`, `terminal-input`, `terminal-resize` and `terminal-detach`. Each body is parsed by a strict P4 parser.

### 3.4 The v1 remote route set (pinned by RP's and CT's tests)

| Route | Level | Step-up | Rate | Class rules (route-classes.ts) |
| --- | --- | --- | --- | --- |
| `GET /tasks` (the delta form) | observe | none | normal | read |
| `GET /tasks/:id` | observe | none | normal | read |
| `GET /tasks/:id/runs` | observe | none | normal | read |
| `GET /tasks/:id/events/page` | observe | none | heavy | read; `maxBytes` |
| `GET /tasks/:id/events/:eventId` (new, E1) | observe | none | heavy | read |
| `GET /tasks/:id/interactions/pending` | observe | none | normal | read |
| `GET /interactions/pending` (new, E1) | observe | none | normal | read |
| `GET /tasks/:id/pipeline` | observe | none | normal | read |
| `GET /tasks/:id/subagents` | observe | none | normal | read |
| `GET /tasks/:id/git-status` | observe | none | heavy | read |
| `GET /tasks/:id/messages/history` (D12) | observe | none | normal | read |
| `GET /tasks/:id/files/preview` (new, CT) | observe | none | heavy | Path outside the task's folders (workdir, worktrees, sent files) → level **operate** (D15) |
| `POST /runs/:id/cancel` | respond | none | stop | remove |
| `POST /tasks/:id/pipeline/cancel` | respond | none | stop | remove |
| `POST`, `DELETE /tasks/:id/seen` | respond | none | normal | remove |
| `POST /ask-questions/:id/answer` | respond | unlock | normal | content. A Skip with a `message` is content (D10); a bare Skip is remove. |
| `POST /runs/:id/input` | respond | unlock | normal | content |
| `POST`, `PUT /tasks/:id/backlog`; `PATCH`, `DELETE /tasks/:id/backlog/:itemId` | respond | unlock | normal | content (DELETE = remove) |
| `POST /tasks/:id/plans/:planId/approve` | respond | signed | normal | consent (cursor/copilot plan hash); a reject is remove |
| `PATCH /tasks/:id/plans/:planId` (D13) | respond | signed | normal | content signed over the edited body, plus unlock when autonomous (A-5) |
| `POST /tmux-prompts/:id/answer` | respond | signed | normal | J1 class: `once` → consent; `reject` → remove; `always` / `unknown` → never; `answerKind:"enter"` → consent; `"code"` → never. Claude plan modal row 1 → **operate** + signed (plan hash) + unlock (D9); row 2 → consent; row 3 → content. |
| `POST /fx-permissions/:id/answer` | respond | signed | normal | `allow_once` / OpenCode `once` → consent; `allow_always` / `always` → never; a bare reject → remove; a reject with `message` → content (D10) |
| `POST /tasks/:id/pipeline/review` | respond | signed | normal | consent over all 6 fields (E4) |
| `POST /tasks/:id/fx-resume` (D12) | respond | signed | normal | consent (A-6) |
| `POST /tasks/:id/switch-account` (D12) | **operate** | none | normal | action: session only (A-4, owner) |

Session ops, not routes:

- hello, push registration, revoke this device, challenge and unlock are session-only.
- `terminal-attach` is **configure** and signed with the approve key (D17).
- `subscribe-task` and `subscribe-global` are observe.

Everything else stays `remote: "none"`.

---

## 4. Work breakdown — implementation tasks

Each task: **ID · Goal · Wave · Depends · Risk · Wired by**, then **Owns** (exact paths, nothing else) and **Acceptance** (given/when/then scenarios and how each is proven).

**For every task:**

- Unit tests live in the owned `*.test.ts` files beside the code, and each one must be shown red against a broken copy of the behavior.
- A test that needs a missing binary (tmux, swiftc) **skips loudly** locally and **fails** under `CI=true`.
- Nothing is called "done" without its named test passing.

### Index

| ID | Goal | Wave | Depends | Risk | Wired by |
| --- | --- | --- | --- | --- | --- |
| D0 | Apply the grill's amendments to the spec copy, marked inline | 0 | — | none | docs |
| P1 | Protocol package: workspace plumbing, primitives, codecs | 1 | — | trust, infra | P2–P6; every `src/bun/remote/*` |
| B1 | Build flags and the seam guard | 1 | — | trust, infra | KH, LK, PU, GW, REL |
| K1 | Key helper (Swift `.app`): keys, DH, revocation list, pairing window | 1 | — | trust, infra | REL (bundle), KH (client) |
| J1 | tmux choice classifier (D8, D9) | 1 | — | trust | RT `route-classes.ts` |
| N1 | Core notification policy and presence store | 1 | — | state | `headless.ts` (already), N2 (app), PU (phone sink) |
| E1 | Task-stream extraction, inbox, event by id, `maxBytes`, presence route, route table | 1 | — | data, concurrency | `server.ts` routes; SU; RT |
| P2 | Noise NK / NKpsk0 with vectors | 2 | P1 | trust | SS, PA, P6 |
| P3 | HPKE and the push payload | 2 | P1 | trust | PU, P6 |
| P4 | Message parsers, decision payloads, QR format, JSON Schemas (W1) | 2 | P1 | trust | SS, PA, DE, RT, TM, P6, K1 vectors |
| P5 | Local test relay | 2 | P1 | external, tests | LK tests, P6, TS*, E2E |
| RP | Remote levels, device caller, v1 set, remote types, app events | 2 | P1, E1 | trust | `applyRoutePolicy` (server start); RT |
| DB | Migrations 094–096, the remote db module, named ops | 2 | P1 | data, migration | RG, AU, ID, PU, PA |
| KH | Key helper client and fake (behind the seam guard) | 2 | P1, B1 | trust, external | RG, PA, SS, GW |
| N2 | Cut the app and webview over to core notifications | 2 | N1, E1 | state | `index.ts` boot; `App.tsx` |
| PR | Phone projection of events | 2 | — | data | SU |
| CI1 | First GitHub Actions workflow (gate skeleton) | 2 | P1 | infra | GitHub |
| RG | Device registry: verify, revoke, revoke-all, expiry | 3 | DB, KH | trust | GW, CT, PA, SS |
| LK | Relay config, link gate, relay link and pacing | 3 | P1, P5, B1 | external, concurrency | GW, SS, PA |
| DE | Challenges, content hashes, signed decisions, unlock window | 3 | P4, RP, J1 | trust | RT, TM |
| SU | Subscriptions, global allowlist, backpressure | 3 | E1, PR, RP | concurrency, data | GW (session ops) |
| PU | Phone push sink, sealing, gateway client, presence rule | 3 | N1, N2, P3, DB, B1 | trust, external | GW (registers the sink) |
| AU | Audit writer and reader, chain verification, retention job | 3 | DB | data, trust | RT, PA, RG, SS, TM, CT, GW |
| ID | Idempotency store and rate limits | 3 | DB | concurrency | RT, SS |
| P6 | Headless test client (phone simulator) | 3 | P2, P3, P4, P5 | tests | TS*, E2E |
| SS | Session manager: handshake, binding, hello, rekey, lifetime, dispatch | 4 | P2, P4, LK, RG, KH, ID, AU | trust, concurrency | GW |
| PA | Pairing orchestration | 4 | P2, P4, LK, RG, KH, AU, PU | trust, state | GW (menu → `startPairing`) |
| RT | Router, route classes, remote toasts | 4 | RP, E1, ID, AU, DE, J1 | trust | GW (`request` op) |
| TM | Phone terminal (D17) | 4 | DE, AU, RP | trust, concurrency | GW (terminal ops); CT (detach route) |
| GW | Gateway composition and process wiring, menu, schedulers | 5 | all of waves 3–4 | concurrency, state | `index.ts`, `headless.ts` |
| CT | Control routes, device preview route, status, D19 rule | 5 | RG, AU, TM, SS | trust | `server.ts` routes |
| REL | Release wiring: helper bundle, profile, verify scripts | 5 | K1, B1 | infra | `bun run build*`, `release.ts` |
| UI1 | Settings › Remote access | 6 | CT | none | `SettingsDialog.tsx` |
| UI2 | Run panel "Phone attached" banner and remote-action toasts | 6 | CT, TM | state | `RunPanel.tsx`, `App.tsx` |
| CLI | `agetor remote devices`, `revoke`, `revoke-all`, `log`; status additions | 6 | CT | trust | `src/cli/index.ts` |
| DOCS | Architecture docs and the CLAUDE.md topic map and env list | 6 | waves 1–5 | none | docs |
| K1V | Live K1 verification on the owner's Mac (owner-gated) | 6 | REL, owner profile | trust, infra | the release pipeline |
| FIN | Refresh the plan status, PR bodies and test counts | 7 | everything | none | — |

Test tasks TS1–TS3, E2E and CI2 are in §5.

### Wave 0

**D0 — Amend the spec copy.** Owns: `docs/specs/remote-readiness-spec.md`.

Acceptance:
- Every amendment in the grill's "Spec amendments for the owner to approve" list (11 bullets) appears inline, marked `> **Amended (grill D#/C#/E#, 2026-11-25):** …`, beside the text it replaces. The original sentence stays, struck through with `~~…~~`. Proven by reviewing `git diff` against the unamended commit.
- The added sections exist:
  - terminal: D17 gates, transport and harnesses;
  - the terminal message family;
  - the threat-model row for a configure device;
  - `macName` in the hello;
  - the level vocabulary and the per-device level choice;
  - the five added v1 routes;
  - previews at 50 MB with level-gated paths;
  - no login-keychain fallback;
  - the wildcard bind warning;
  - the core-owned notification mechanism;
  - the vector set (C5);
  - the 6-field gate signature;
  - the D19 route rule.
- No other wording changes.

### Wave 1

**P1 — Protocol package plumbing and primitives.**

Owns:
- `package.json` (root: `"workspaces": ["packages/*"]`; dependency `"@agetor/remote-protocol": "workspace:*"`; `check` also runs `bun test` in `packages/remote-protocol`; the `lint:async` globs add `packages/remote-protocol/src/**/*.ts`; the `build`, `build:canary` and `build:stable` scripts gain the prefix `AGETOR_RELEASE_BUILD=1`, the B1 interface pin)
- `bun.lock`
- `tsconfig.json` (include `packages`)
- `packages/remote-protocol/package.json` (`"exports": {"./*": "./src/*.ts"}`, `@noble/curves`, `@noble/ciphers` and `@noble/hashes` pinned exactly at `2.4.0`)
- `packages/remote-protocol/bunfig.toml`
- `packages/remote-protocol/README.md`
- `packages/remote-protocol/src/{levels,constants,bytes,canonical-json,es256,derive,padding,relay-frames,envelope}.ts` and a `*.test.ts` for each
- `packages/remote-protocol/vectors/{README.md,agetor-canonical-json.json,agetor-es256.json,agetor-derive.json,agetor-padding.json,agetor-relay-frames.json,agetor-envelope.json}`
- `packages/remote-protocol/scripts/gen-vectors.ts`

Acceptance:
- `levels.ts` exports `REMOTE_LEVELS = ["observe","respond","operate","configure"] as const`, `RemoteLevel` and `levelAtLeast(a,b)`. A test pins the order.
- `canonical-json.ts`: the RFC 8785 examples (number formatting, key order, escapes) round-trip. A duplicate key or a non-finite number is refused.
- `es256.ts`:
  - `verifyEs256(pubRaw, msg, sigRaw64)` uses `lowS:false`;
  - 200 WebCrypto-generated signatures, including high-S ones, verify 200/200;
  - a flipped bit fails;
  - a DER-encoded signature is refused.
  - The test fails if `lowS:false` is removed (E2).
- `derive.ts`:
  - mailbox key = HKDF-SHA256(link secret, info `agetor-mailbox/1` ‖ `YYYY-MM-DD` UTC, 32 bytes);
  - id = first 16 bytes of the key's SHA-256;
  - pairing mailbox uses info `agetor-pairing/1`;
  - SAS = u32be(HKDF(handshake hash, `agetor-sas/1`)[0..4]) mod 1,000,000, zero-padded to 6 digits;
  - core id = SHA-256(core pub);
  - collapse id = HMAC-SHA256(link secret, taskId);
  - the push request HMAC.
  - Each has a vector. The two dates on either side of midnight UTC produce different ids.
- `padding.ts`: pads to the smallest bucket of 256, 1024, 4096, 16384 or 65535 − overhead. Unpadding refuses bad padding. Vectors cover every bucket edge.
- `relay-frames.ts`: encodes and decodes `hello`, `welcome`, `send`, `deliver`, `ack`, `peer`, `full`, `replaced`, `ping` and `pong` (A-3). It refuses anything over 66 KB **before** parsing. Unknown trailing fields are ignored (relay contract), and an unknown type is refused. A **fuzz test** (10,000 random buffers and truncations) never throws anything but `FrameError`.
- `envelope.ts`:
  - chunks a message into ≤ 64 KB Noise plaintexts `{t,id,ci,cc}`;
  - a reassembler caps the chunk count (1,024) and the total size (64 MB) and refuses out-of-order or duplicate chunks.
- `bun install` produces a lockfile with the workspace link. `bun run typecheck`, `bun run lint:async` and `bun run check` are green. A deliberately failing test in the package turns `check` red, which proves the package tests run.

**B1 — Build flags and the seam guard.**

Owns:
- `src/shared/build-flags.ts`
- `src/shared/build-flags.test.ts`
- `src/types/build-flags.d.ts` (`declare const __AGETOR_RELEASE_BUILD__: boolean | undefined; declare const __AGETOR_COMPANION__: boolean | undefined;`)
- `electrobun.config.ts` (`build.bun.define`)
- `scripts/build-daemon-bundle.ts`
- `scripts/build-cli.ts`

Acceptance:
- `build-flags.ts` exports `RELEASE_BUILD` (default false), `COMPANION_ENABLED` (default true when not a release; in a release only with `AGETOR_COMPANION_BUILD=1` at build time) and `remoteSeamsAllowed(env)`. The guard returns true only when `!RELEASE_BUILD && (env.NODE_ENV === "test" || env.AGETOR_E2E_HARNESS_SEAMS === "1")`.
- With no define (`bun test`) the flags read false/true. A Bun.build of a fixture entry with `define` set to release produces output with the guarded branch eliminated: the string `AGETOR_FAKE_KEY_HELPER` is absent. Proven by a test that runs `Bun.build` in-process.
- `electrobun.config.ts`, `build-daemon-bundle.ts` and `build-cli.ts` set the same two defines from `process.env.AGETOR_RELEASE_BUILD` and `AGETOR_COMPANION_BUILD`. `bun scripts/build-daemon-bundle.ts` with `AGETOR_RELEASE_BUILD=1` emits a `vendor/daemon/headless.js` without the marker. Proven by a test that runs the script into a temp out dir (if the script can't take an out dir, it gains `--out`).

**K1 — Key helper (Swift).**

Owns:
- `native/keyhelper/{main.swift,Protocol.swift,Keys.swift,Revocation.swift,PairingWindow.swift,Canonical.swift,SelfTest.swift,Info.plist,entitlements.plist.template}`
- `scripts/build-keyhelper.ts`
- `scripts/build-keyhelper.test.ts`

Acceptance:
- `bun scripts/build-keyhelper.ts` builds `vendor/keyhelper/AgetorKeyHelper.app`, hand-assembled with `swiftc` like `build-notifier.ts`:
  - `LSUIElement`;
  - bundle id `sh.alamops.agetor.keyhelper`;
  - arm64.
- Signing:
  - **with** `AGETOR_KEYHELPER_PROFILE` (a path outside the repo) and a Developer ID identity: embeds the profile as `Contents/embedded.provisionprofile`, fills the entitlements template's `keychain-access-groups` and application identifier from the signing identity's team id (read at build time, never committed), and signs with the hardened runtime and a timestamp;
  - **without** a profile: `--adhoc` builds an ad-hoc-signed helper for `selftest-vectors` only, and the script prints that keychain operations will fail;
  - in CI it never needs secrets.
- The stdio protocol is exactly §3.3. Unknown commands, oversized strings and malformed JSON get error responses, never crashes.
- `status`:
  - creates the Secure Enclave registry key (`kSecAttrTokenIDSecureEnclave`, `.privateKeyUsage` + `.userPresence`) and the X25519 core key (a generic password in the **data-protection keychain**, `kSecUseDataProtectionKeychain=true`, access group from entitlements);
  - when either fails it answers `no-secure-enclave` or `keychain-unavailable`, and **never** falls back to the login keychain (D3).
- `pair-complete`:
  - recomputes the SAS from the handshake hash with the P1 derivation (Swift `HKDF<SHA256>`);
  - allows 3 wrong codes, then `wrong-code`;
  - expires at `expiresAt`;
  - offers Respond (preselected) / Operate / Configure with one-line descriptions, and Configure shows a second confirmation sheet;
  - Touch ID prompts with the device name;
  - signs the canonical JSON (keys sorted, strings escaped per RFC 8785) of the entry.
- `revoke-all` appends every id in the helper's own `signed` list to `revoked`, then replaces the core key.
- `selftest-vectors <vectors dir>` checks the SAS (`agetor-derive.json`), canonical JSON (`agetor-canonical-json.json`) and QR (`agetor-qr.json`) vectors. It prints each file it checked, skips a file that is absent (the QR vectors arrive with P4 in wave 2), and exits non-zero on any mismatch. `build-keyhelper.test.ts` builds `--adhoc` and runs it (skips loudly without `swiftc`, fails under `CI=true`). CI2 asserts that all three files were checked.
- The device name is drawn as plain text (`NSTextField` label, not attributed or markup).

**J1 — tmux choice classifier (D8, D9).**

Owns: `src/shared/tmux-choice-class.ts`, `src/shared/tmux-choice-class.test.ts`.

Acceptance:
- `classifyTmuxChoice(promptText, choice)` returns `"once" | "reject" | "always" | "unknown" | "plan-auto" | "plan-manual" | "plan-revise"`.
- Only **exact** known label shapes count as `once` or `reject`.
- Every row already seen in `src/bun/claude-tmux-scraper.test.ts`, `claude-prompt-screens.ts` and `claude-tmux-card-drive.test.ts` is copied as a fixture (synthetic project names) with its expected class. Every "don't ask again" / "always" style row → `always`. Anything unmatched → `unknown`.
- The ExitPlanMode modal's three rows map to `plan-auto`, `plan-manual` and `plan-revise`. They match only when the prompt is the plan modal, so the same labels in another prompt are `unknown`.
- A label with an extra word or a different digit → `unknown`, which proves fail-closed behaviour.

**N1 — Core notification policy and presence.**

Owns:
- `src/bun/notification-policy.ts`
- `src/bun/notification-policy.test.ts`
- `src/bun/presence.ts`
- `src/bun/presence.test.ts`
- `src/bun/headless-notifications.ts` (+ `.test.ts`)
- `src/shared/focused-forced-posts.ts` (+ `.test.ts`)
- `src/mainview/lib/toast-slots.ts` (re-export only)
- `src/shared/os-notification.ts` (+ `.test.ts`)

Acceptance:
- `FocusedForcedPosts` moves verbatim to `src/shared/focused-forced-posts.ts`, and `toast-slots.ts` re-exports it. The webview behaves the same, proven by the existing webview tests.
- `notification-policy.ts` holds the single decision:
  - **inputs:** GlobalEvent, task lookup, `presence()`, the event's urgency;
  - **outputs:** `NotificationDecision`s for registered sinks.
  - Rules, ported from `headlessNotificationFor` plus the webview's `maybeNotifyOS`:
    - one entry per task;
    - the same `NOTIFICATION_KINDS`;
    - removal triggers;
    - the selected task (open RunPanel or pipeline view) gets no OS post;
    - the focused window clears an older entry (D7) unless forced;
    - forced posts for a proactive `files-sent`.
  - A table-driven test covers every kind × {focused, unfocused} × {selected, not}.
- `headless-notifications.ts` now builds on the policy. **Every existing headless notification test passes unchanged.**
- `presence.ts`: native focus overrides webview focus once a native event has been seen. `lastFocusedAt` updates on every focus and while focused. `appAttached` defaults true in the app and false on a background core.
- `os-notification.ts` gains `remoteDeviceNotificationId(deviceId)`; `postDeviceNotification` goes through the OS sink with that id.

**E1 — Streams, inbox, event by id, `maxBytes`, presence route, route table.**

Owns:
- `src/bun/server.ts`
- `src/bun/route-policy.ts` (entries for the 3 new routes, `remote: "none"`)
- `src/bun/route-policy.test.ts` (desktop-only set or inventory lists that pin these keys)
- `src/bun/route-table.ts`
- `src/bun/task-event-stream.ts` (+ `.test.ts`)
- `src/bun/pending-inbox.ts` (+ `.test.ts`)
- `src/shared/interactions-inbox.ts`
- `src/bun/db-core/runs.ts`
- `src/bun/db-run-events-plans.test.ts`
- `src/shared/types.ts` (byte-budget constants only)
- `docs/architecture/core-responsiveness.md`
- `src/bun/server-events-max-bytes.test.ts`

Acceptance:
- **Extraction.** The replay window, anchor extension, forward resume (`Last-Event-ID` / `afterId`), `snapshotRequired`, buffer and dedup-by-hash logic of the `/tasks/:id/events` handler (`server.ts:9918+`) move into:

  ```ts
  openTaskEventStream(taskId, {cursor, anchor, maxBytes}, sink) → {close()}
  ```

  The handler becomes a thin SSE adapter. Every existing stream test passes unchanged: `server*events*.test.ts`, `event-resume*.test.ts` and the forward-resume tests. The e2e specs `event-stream-resume.spec.ts` and `cursor-stream.spec.ts` pass.
- **`maxBytes`.** It is accepted on `/tasks/:id/events` (replay) and `/tasks/:id/events/page`, and clamped to [64 KB, current max]. A 256 KB request on a task with 3 MB of history returns ≤ 256 KB plus at most one oversize event (the `minEvents` rule). With no param the behaviour is byte-identical to today (pinned).
- **`GET /tasks/:id/events/:eventId`** returns the raw stored event of that task. An event of another task gets 404, an unknown task 404, a non-numeric id 400. The new `runs.eventById` query appears in `db-run-events-plans.test.ts`, which shows SEARCH. A Bun precedence test shows `/tasks/:id/events/page` still reaches the page handler.
- **`GET /interactions/pending`** returns `{cards, gates}`:
  - every pending ask, tmux, fx and OpenCode card across tasks;
  - each pipeline step card folded into its parent (`parentTaskId`);
  - every gate waiting for a human (`pendingHumanSteps`).
  - The per-task route and this one share one builder (`pending-inbox.ts`). A test shows the per-task output is unchanged.
- **`PUT /app/presence`** (callers `app`) validates `{focused: boolean, selectedTaskId: string|null, view: "run-panel"|"pipeline"|null}` and calls `setWebviewPresence`. A bad body gets 400 and the CLI token gets 403.
- **`route-table.ts`** exports `setServedRoutes` and `servedRoutes()`. `startApiServer` hoists the gated routes object into a variable, registers it, and passes the same object to `Bun.serve`. A test shows `servedRoutes()["/health"]` is the same function Bun serves.
- `core-responsiveness.md` documents `maxBytes`, the event-by-id route and the stream module.

### Wave 2

**P2 — Noise.**

Owns: `packages/remote-protocol/src/noise.ts`, `noise.test.ts`, `vectors/{cacophony-nk.json,cacophony-nkpsk0.json,snow-nk.json,agetor-noise.json}`.

Acceptance:
- `HandshakeState` exists for `Noise_NK_25519_ChaChaPoly_SHA256` and `Noise_NKpsk0_25519_ChaChaPoly_SHA256`:
  - initiator and responder roles;
  - the responder's static DH is an **injected async function**;
  - the prologue is `agetor-remote/1` ‖ core id.
- `CipherState` has the nonce counter, `rekey()` and a max-nonce refusal.
- `split()` exists, and `handshakeHash()` is exposed.
- Vectors:
  - all cacophony NK and NKpsk0 vectors for this suite pass, ciphertexts and handshake hash;
  - snow NK passes ciphertexts;
  - our own vectors (with prologue, rekey, a wrong PSK and a wrong prologue) pass.
  - Each vector file carries `source`, `license` and `retrieved` fields.
- A wrong prologue or PSK fails the handshake. A replayed or reordered transport message fails decryption.

**P3 — HPKE and push payload.**

Owns: `packages/remote-protocol/src/hpke.ts`, `hpke.test.ts`, `push-payload.ts`, `push-payload.test.ts`, `vectors/{rfc9180-base-x25519-chacha.json,agetor-push.json}`.

Acceptance:
- RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305, `setupBaseS/R`, `seal/open`: matches the RFC's test vectors for this suite (C4).
- `sealPush({v:1, taskId, kind, title, subtitle, ts}, pushPub)` pads to exactly 1 KB before sealing with info `agetor-push/1`. The output size is constant whatever the title length (≤ 1 KB plaintext; longer titles are cut to fit, never refused). `openPush` inverts it.

**P4 — Messages, decisions, QR, schemas (W1).**

Owns:
- `packages/remote-protocol/src/{messages,decision,qr}.ts` and their tests
- `packages/remote-protocol/schemas/**`
- `packages/remote-protocol/scripts/gen-schemas.ts`
- `packages/remote-protocol/vectors/{agetor-messages.json,agetor-decision.json,agetor-qr.json}`
- `packages/remote-protocol/package.json` (devDependencies `ts-json-schema-generator`, `ajv`)
- `bun.lock`

Acceptance:
- A strict parser exists for every message in §3.3's op list, plus:
  - `hello` (core → phone: `protocolVersion, minProtocolVersion, deviceId, level, routes[], auditHead, clock, macName`);
  - `binding` (phone: `deviceId, sig`);
  - `pairing-request` (phone's first NKpsk0 payload: `name ≤ 40, platform, appVersion, sessionPub, approvePub, pushPub, sessionSig, approveSig`);
  - `pairing-result` (`deviceId, linkSecret, level`);
  - `decision`, `unlock`, `challenge-response`, `error`;
  - `response` (`status, contentType, body | chunked`).
- Parsing:
  - an unknown field, a missing field or a wrong type is refused (invariant 13);
  - `cleanDeviceName` strips control, bidi and zero-width characters and caps at 40;
  - a fuzz test of each parser with random JSON never throws anything but `ParseError`.
- `decision.ts`:
  - builds the canonical bytes of `{v:1, kind:"decision", deviceId, sessionHash, challenge, route, target, contentHash, decision, comment, ts}` and of `{kind:"unlock", sessionHash, expiresAt}` and `{kind:"terminal-attach", …}`;
  - provides `verifySigned(payload, sig, approvePub)` via P1 ES256.
- `qr.ts`: encodes and decodes `{fmt:1, corePub, relayUrl, mailbox, pairingSecret, expiresAt}` (base64url canonical JSON), with a vector.
- Schemas:
  - every message has a hand-written schema, and every vector validates against both the schema (ajv, `additionalProperties:false`) and the parser;
  - `gen-schemas.ts` generates schemas for the v1 route bodies (Task, the delta response, RunEvent, the pending inbox, interactions, PipelineRun, git status, the subagent list) from `src/shared/types.ts`;
  - a test regenerates and fails on any diff.
  - If the generator cannot express a type, that schema is hand-written, and `Status` records the W1 verdict with the type name.

**P5 — Local test relay.**

Owns: `packages/remote-protocol/src/test-relay.ts`, `test-relay.test.ts`.

Acceptance:
- `startTestRelay({port?, limits?})` is a Bun WS server implementing the relay contract (`docs/specs/remote-relay-contract.md` §1–2):
  - roles; a newer same-role connection replaces the older one (`replaced`);
  - `peer` joined/left;
  - per-mailbox order, with at-least-once redelivery of un-acked frames on reconnect;
  - 10-minute retention (an injectable clock);
  - queues capped at 256 KB **or** 64 frames, answering `full` and never evicting;
  - throughput 50 frames/s and 2 MB/10 s, with excess dropped and counted;
  - idle close at 5 minutes;
  - frames over 66 KB refused.
- It never decrypts and stores only mailbox ids. A limit-override option exists for tests.
- Each limit has a test.

**RP — Remote levels and the device caller.**

Owns:
- `src/bun/route-policy.ts`
- `src/bun/route-policy.test.ts`
- `src/bun/route-policy-remote.test.ts`
- `src/bun/remote/types.ts`
- `src/shared/types.ts` (the `AppEvent` variants of §3.3)
- `docs/architecture/security.md` (the section "Remote levels and the device caller")

Acceptance:
- The type and helpers are as §3.3. Every v1 route in §3.4 that exists now gets its policy (the files-preview route is CT's), and every other entry stays `"none"`.
- **Startup.** `applyRoutePolicy` throws when a remote policy sits on an `app` or `public` route, or lacks `level`, `stepUp`, `rate` or `since`. Tested with a synthetic table.
- **Pinned set.** `route-policy-remote.test.ts` pins the exact list of `METHOD route → {level, stepUp, rate}`. Adding or changing one fails the test. This replaces the "every entry `remote: none`" assertion at :184-188.
- **Device branch.** Calling the real wrapped `server.ts` handlers with a marked request:
  - (a) an `app` route → 403 `not-remote`;
  - (b) a route with `remote:"none"` → 403;
  - (c) a respond route with an observe principal → 403 `level`;
  - (d) a `pathParams` route → the gate runs with caller `device`;
  - (e) an allowed route → the handler runs and `callerOf(req) === "device"`.
- **Invariant 7.** No header, `?token=` or bearer value produces `device`; this is fuzzed over the header names and values `resolveCaller` reads. A test scans `src/` imports and fails if any file other than `src/bun/remote/router.ts` (and RP's own test) imports `markDeviceRequest`.
- `remoteRoutesFor(level)` returns the routes at or below the level, in a stable order.
- `security.md` documents the remote field, the device branch and the import rule.

**DB — Persistence for devices, audit and idempotency.**

Owns:
- `src/bun/migrations/{094_remote_devices.sql,095_remote_audit.sql,096_remote_idempotency.sql}` and `src/bun/migrations/index.ts`
- `src/bun/db-core/remote.ts`
- `src/bun/db-core/ops/remote-ops.ts`
- `src/bun/db-core/ops/index.ts`
- `src/bun/db-core/modules.ts`
- `src/bun/db.ts`
- `src/bun/db-async.ts`
- `src/bun/db-rpc.ts`
- `src/shared/remote-types.ts`
- `src/bun/db-remote.test.ts`
- `src/bun/db-remote-worker.test.ts`
- `docs/architecture/persistence.md`

Acceptance:
- **094 `remote_devices`.** Columns: `id` PK, `name`, `platform`, `app_version`, `session_pub`, `approve_pub` and `push_pub` (BLOB), `link_secret` BLOB, `level` CHECK in the 4 levels, `status` CHECK `active|revoked`, `enrolled_at`, `last_seen_at`, `push_ref` NULL, `push_send_key` NULL, `push_dead` 0/1, `sig` BLOB.
- **095 `remote_audit`.** Columns: `seq` INTEGER PK AUTOINCREMENT, `ts`, `kind` CHECK `entry|anchor`, `device_id`, `session_hash`, `action`, `route`, `target_json`, `result_code`, `attempt_seq`, `body_hash`, `signature`, `prev_hash`, `hash`. Plus `remote_audit_no_update` (BEFORE UPDATE → ABORT) and `remote_audit_no_delete` (BEFORE DELETE → ABORT).
- **096 `remote_idempotency`.** Columns: (`device_id`, `idem_key`) PK, `body_hash`, `status`, `content_type`, `response` BLOB NULL, `created_at`.
- **Ops** (`tx: true`):
  - `remote.addDevice` (insert row + an audit `pair` entry in one transaction);
  - `remote.revokeDevices(ids, reason)` (status + audit);
  - `remote.auditAppend(entry)` (reads the head, computes `hash = SHA-256(prev_hash ‖ canonicalJSON(entry without hash))`, inserts);
  - `remote.auditTrim({maxAgeMs, maxRows})` (C2: drop trigger → delete oldest → anchor row holding the hash of the last dropped entry → recreate trigger, all in one `BEGIN IMMEDIATE`);
  - `remote.auditVerify()` (walks the chain in the worker, returns `{ok, firstBadSeq}`);
  - `remote.idempotencyPut`, `remote.idempotencyPrune(beforeTs)`.
  - Reads go through `remoteDevices.list/get/setLastSeen/setPushRef/markPushDead`, `remoteAudit.head/page`, `remoteIdempotency.get`.
- **Tests:**
  - UPDATE on `remote_audit` is refused;
  - DELETE outside the op is refused;
  - after a trim the chain verifies from the anchor;
  - editing a row's `action` via a raw `UPDATE` with the trigger dropped makes `auditVerify` return that seq;
  - every op runs on the real worker thread (`db-remote-worker.test.ts`).
- Production code reaches all of this only through `db-async.ts`, and `db-import-guard.test.ts` stays green.
- `persistence.md` records 094–096 and the trigger and trim rule.

**KH — Key helper client and fake.**

Owns: `src/bun/remote/key-helper-api.ts`, `key-helper.ts`, `key-helper-fake.ts`, `key-helper.test.ts`, `key-helper-fake.test.ts`.

Acceptance:
- `getKeyHelper()`:
  - returns the fake **iff** `remoteSeamsAllowed(process.env) && process.env.AGETOR_FAKE_KEY_HELPER === "1"`;
  - otherwise returns the real client, which resolves the bundled path (`Resources/app/bin/AgetorKeyHelper.app/Contents/MacOS/keyhelper`) or the dev path `vendor/keyhelper/...`;
  - with no helper found it reports `helper-missing` (status surfaces it, and pairing refuses with an explanation).
- **Real client:**
  - a long-lived child via `coreSpawn` with `env: childEnv({})`;
  - a JSON-lines request map with per-command timeouts (`dh` 5 s, `pair-complete` up to `expiresAt` + 30 s);
  - a crash rejects in-flight calls and restarts lazily;
  - `close()` on quit;
  - it never logs args or results.
- A stub helper (a Bun script under `/tmp` via `fakeBinDir`) proves the framing, timeouts and crash handling.
- **Fake:**
  - X25519 via noble, P-256 registry key via noble;
  - an append-only revocation set;
  - persistence to `AGETOR_FAKE_KEY_HELPER_DIR` when set (honoured only through the guard);
  - test controls `fakeKeyHelperControl.{enterCode, chooseLevel, confirmConfigure, deny, closeWindow}` for in-process tests;
  - a cross-process control for a core in another process (TS1): when `AGETOR_FAKE_KEY_HELPER_DIR` is set, `pair-complete` polls `<dir>/pairing-control.json` (`{code, level, confirmConfigure, deny}`) written by the test, and deletes it once read;
  - the same error codes as the real helper.
  - A conformance test runs the same scenarios against the fake and the stub.
- With `NODE_ENV` unset and no `AGETOR_E2E_HARNESS_SEAMS`, setting `AGETOR_FAKE_KEY_HELPER=1` still yields the real client. A test covers this.

**N2 — The app and webview cut over to core notifications.**

Owns:
- `src/bun/index.ts`
- `src/bun/task-notifier.ts` (+ test)
- `src/bun/notification-hooks.ts` (+ test)
- `src/mainview/lib/toasts.ts`
- `src/mainview/App.tsx`
- `src/mainview/lib/api.ts`
- `src/mainview/lib/presence-report.ts` (+ test)
- `e2e/one-notification-per-task.spec.ts`
- `e2e/notification-stub.ts`
- `docs/architecture/notifications.md`

Acceptance:
- **App core.** `index.ts` installs the notification policy with the native OS sink and the removal hooks. Electrobun `focus`/`blur` on the main `BrowserWindow` call `setNativeWindowFocus`.
- **Webview.**
  - `toasts.ts` no longer calls `api.notifyOS` or `api.clearTaskNotification`, and in-app toasts are unchanged.
  - `presence-report.ts` sends `PUT /app/presence` on focus, blur, selected-task and view changes: debounced to 250 ms, deduped, fire-and-forget, and stopped with a 5-second back-off after an error.
  - `api.ts` drops `notifyOS` and `clearTaskNotification` and adds `reportPresence`.
- **Behaviour parity.** Unit tests drive the policy with presence changes and assert the same posts and clears the webview made before:
  - unfocused → post;
  - focused → clear the older entry;
  - selected → none;
  - proactive `files-sent` → forced post.
- **e2e.** `one-notification-per-task.spec.ts` keeps every behavioural assertion; only its observation point moves. The backend for that spec gets `AGETOR_HEADLESS_NOTIFICATIONS=1` and `AGETOR_NOTIFIER_BIN` pointing at `e2e/notification-stub.ts`'s recording stub (which appends post and remove calls to a log), and the spec reads that log. Window focus is driven through the presence report (the existing `document.hasFocus` override plus focus and blur events). The spec passes, and so does `background-settings.spec.ts`.
- `notifications.md` describes the single decision, the sinks and presence. `DELETE /notifications/:taskId` stays registered until CT removes it (ledger).

**PR — Phone projection.**

Owns: `src/bun/remote/projection.ts`, `projection.test.ts`, `src/shared/tool-result-trim.ts` (optional budget parameter).

Acceptance:
- `projectEvent(ev)` returns `{raw, parsed}`, where `parsed` comes from the existing `src/shared` parsers:
  - tagged user messages and pasted-content unwrapping (`user-message.ts`);
  - TODO progress (`todo-progress.ts`);
  - sent files (`sent-files.ts`);
  - handoff blocks (`handoff-locator.ts`);
  - compaction summaries (`compaction.ts`).
  - Any parser that lives only in `src/mainview` is **not** copied: the projection lists it as raw-only, and the plan's ledger records it.
- A tool result over 16 KB has its text cut through `tool-result-trim.ts` with `budgetBytes: 16384` (the existing default stays 4 KB, so the retention tests are unchanged) and carries `truncated: {eventId, fullBytes}`.
- Every parser variant has a fixture passing through `projectEvent`.
- Persisted rows are never modified, as a test proves.

**CI1 — First workflow.**

Owns: `.github/workflows/ci.yml`.

Acceptance:
- On `pull_request` and on `push` to `main`, `macos-15`:
  - checkout;
  - `oven-sh/setup-bun` with the version pinned to the repo's;
  - `bun install --frozen-lockfile`;
  - one job, **`check`**, required (A-2, owner): `bun run check`, which runs typecheck, `lint:async`, `bun test` (src) and the `packages/remote-protocol` tests via P1's script;
  - the job uploads nothing secret and sets `CI=true`, so the tests that skip loudly locally fail here.
- **Known red at first.** The first run is expected to fail on the pre-existing `main` failures (§2.3), plus any macOS-runner environment gaps (for example tests that need `claude` or `tmux` on `PATH`). CI1 records the exact failing test names from that run in this plan's `Status` and in the separate ticket (§9). It does **not** skip, loosen or delete them.
- No secrets and no Playwright.
- The workflow is syntax-checked with `actionlint` if available, otherwise by a YAML parse in a test.

### Wave 3

**RG — Registry.**

Owns: `src/bun/remote/registry.ts`, `registry.test.ts`.

Acceptance:
- `trustedDevices()` loads the rows and fetches `status()` and `revoked()` **from the helper on every call** (no cache: assumption 3).
- A row counts as trusted only if:
  - ES256 over canonical `{id, name, platform, session_pub, approve_pub, push_pub, level, enrolled_at}` verifies with the registry pub;
  - its id is not in the helper's revoked list;
  - its status is `active`.
- Every other row is returned in `untrusted[]` with a reason (`bad-signature` / `revoked` / `status`) and audited once per row per process.
- **Scenarios:**
  - a row inserted straight into SQLite with a made-up signature → untrusted;
  - a valid row whose `level` was edited → untrusted;
  - an old signed row re-inserted after revoke → untrusted (the revoked list wins);
  - `revoke(id)` → helper `revoke` → op `remote.revokeDevices` → `onRevoked(id)` callback (sessions end) → OS notification → audit;
  - `revokeAll()` → helper `revoke-all` (new core pub) → all rows revoked → every session ends;
  - `expireStale(now)` revokes devices whose `last_seen_at` is older than 60 days, through the same path.

**LK — Relay config, link gate, relay link.**

Owns: `src/bun/remote/relay-config.ts`, `link-gate.ts`, `relay-link.ts`, `relay-pacer.ts` and a test for each.

Acceptance:
- `relayUrl()`:
  - `AGETOR_REMOTE_RELAY_URL` only via the guard (`ws://localhost`/`127.0.0.1` allowed only there);
  - otherwise `BUILT_IN_RELAY_URL` (null), in which case the link refuses with `no-relay-configured`, surfaced in status;
  - `wss://` only otherwise.
- `LinkGate`:

  ```ts
  wanted = remoteOn && (hasTrustedDevice() || pairingWindowOpen)
  ```

  Inputs are injected providers plus `recompute()`. Down/up transitions are emitted within 1 s of any input change. Each input flip has a test.
- `RelayLink`:
  - one WS per mailbox (device mailboxes and the pairing mailbox);
  - `hello` with today's and yesterday's keys;
  - re-join at UTC midnight;
  - ping every 30 s;
  - reconnect with jittered back-off (cap 30 s);
  - `deliver` → handler, then `ack`;
  - `peer` / `full` / `replaced` surfaced;
  - `closeAll()` within 1 s.
- Session-tag filtering hook: frames tagged with an ended session are dropped before the session layer.
- `relay-pacer.ts`: a per-connection token bucket at 50 frames/s and 2 MB per 10 s, with priority for `stop`-class frames and a bounded queue reported to SS for backpressure.
- All tests run against P5's relay: kill the relay → reconnect; `replaced`; redelivery after reconnect; pacing never exceeds the limits (asserted by the relay's counters).

**DE — Decisions.**

Owns: `src/bun/remote/decisions.ts`, `content-hash.ts`, `autonomy.ts` and a test for each.

Acceptance:
- `issueChallenge(principal, target)` → `{challenge, contentBytes, contentHash, expiresAt}`.
  - The content builders in `content-hash.ts`:
    - plan: markdown + revision from `task-plans.ts`;
    - claude-plan: the ExitPlanMode plan recorded for the task (E5) + row;
    - tmux-card: question, choices and the task's mode;
    - fx-permission: tool call, options and mode;
    - gate: handoffs + `stepId, seq, decision, comment, nextStepIds, mode` (E4);
    - fx-resume: the recovery record;
    - terminal: `{taskId, tmuxSession}`;
    - plan-edit: the edited body.
  - All are canonical JSON, hashed SHA-256.
- `verifyDecision(principal, signed, expected)` runs the spec's five checks **in order** and refuses on the first failure:
  1. challenge issued to this session for this target < 120 s ago and unused (consumed now);
  2. `sessionHash` equals this session's;
  3. ES256 with the approve key verifies;
  4. `contentHash` equals the current content;
  5. the decision is valid for the target.
- One test per check, each red when that check is removed:
  - a stale challenge;
  - another session's challenge;
  - a plan revised after the challenge;
  - a card answered on the Mac in between;
  - the wrong key;
  - a decision not in the allowed set;
  - a gate whose `nextStepIds` differs from what was signed.
- `verifyUnlock` accepts `{kind:"unlock", sessionHash, expiresAt ≤ now + 10 min}` signed by the approve key. It is valid until `expiresAt` or the session's end.
- `autonomy.ts`: `runsWithoutAsking(task)` holds a pinned table per harness kind of the modes that count as without asking (claude auto / bypass, codex full-auto, fx `yolo` and `auto`, …). **An unknown mode counts as without asking (fail closed)**, and the test pins every mode in `AGENT_OPTIONS`.

**SU — Subscriptions.**

Owns: `src/bun/remote/subscriptions.ts`, `subscriptions.test.ts`.

Acceptance:
- `subscribe-task {taskId, afterId?, maxBytes?=262144}` → `openTaskEventStream` → each event through `projectEvent` → `channel.send("event", …)`. `snapshotRequired` is forwarded.
- `subscribe-global` forwards only the allowlist `column, interaction, pipeline, run-status, tasks-changed, files-sent, send-failed, harness-swap, fx-auto-resume`. The allowlist is pinned by a test that also fails when a new `GlobalEvent` kind is added without a decision.
- **Backpressure.** When `channel.queuedBytes() > 4 MB`, the subscription is dropped and `snapshotRequired{reason:"backpressure"}` is sent. The test pumps events into a fake channel that never drains.
- `peerPresent() === false` pauses delivery. On return the subscription resumes from its last id, or a snapshot if the window passed.
- Unsubscribe and session close release every stream; a leak test counts the subscribers.

**PU — Phone push.**

Owns: `src/bun/remote/push.ts`, `push.test.ts`.

Acceptance:
- `createPhoneSink()` is registered into the policy and sends only `needs-you` kinds.
- It sends nothing while `presence().focused` is true or `lastFocusedAt` is within 2 minutes. A background core with `appAttached=false` counts as away.
- **Per active device with a live `push_ref`:**
  - payload sealed with P3 to `push_pub`;
  - collapse id = HMAC(link secret, taskId);
  - POST to `pushUrl()` (`AGETOR_REMOTE_PUSH_URL` via the guard, else null → no-op with a status note);
  - body `{push_ref, kind, collapse, sealed, ts, nonce}`, authenticated by HMAC under the push send key.
  - A `410` marks `push_dead`.
- No title, path or plan text leaves unsealed: the test inspects the stub gateway's received bodies.
- **Session op `push-register {pushRef, sendKey}`** stores them through `setPushRef`. The send key is registered with `registerLogSecret`.
- `alertOtherDevices(exceptId, kind)` sends a generic sealed alert (`device-paired`, `device-revoked`).

**AU — Audit.**

Owns: `src/bun/remote/audit.ts`, `audit-retention.ts` and their tests.

Acceptance:
- `auditAttempt({deviceId, sessionHash, action, route, target, bodyHash, signature?})` → seq. It runs before the handler.
- `auditResult(attemptSeq, resultCode)` writes the result row.
- `auditEvent(action, fields)` covers `pair`, `revoke`, `revoke-all`, `session-open`, `session-close`, `refusal`, `terminal-attach`, `terminal-detach` and `expire`.
- Refusals from rate limits are coalesced to at most one row per device per minute.
- `head()` serves the hello. `page({beforeSeq, limit})` serves the viewer and CLI, with `chain: {ok, firstBadSeq}` from `auditVerify` (worker op, cached until the next append).
- An attempt with no result row is reported as `outcome: "unknown"`.
- `audit-retention.ts` is a cooperative daily job calling `remote.auditTrim({1 year, 50,000})`.
- Signatures are stored; plaintext bodies are not, only the body hash. A test shows a follow-up's text is absent from `remote_audit`.

**ID — Idempotency and rate limits.**

Owns: `src/bun/remote/idempotency.ts`, `rate-limit.ts` and their tests.

Acceptance:
- `idempotency.lookup(deviceId, idem, bodyHash)` → `hit` (stored response) / `mismatch` (409 `idem-mismatch`) / `miss`.
- `store` persists via the op, with ≤ 64 KB responses stored whole and larger ones as status only.
- Prune at 10 minutes. A 128-bit key format is enforced.
- **Rate limits**, per device token buckets:
  - handshakes 6/min;
  - requests 30/s;
  - heavy 2/s;
  - the `stop` class always passes.
- Scenarios:
  - a burst of 100 requests → 30 pass, the rest get 429 `rate`;
  - a cancel during the burst passes;
  - a revoke during the burst passes.

**P6 — Headless test client.**

Owns: `packages/remote-protocol/src/test-client.ts`, `test-client.test.ts`.

Acceptance:
- `TestPhone`:
  - keys (P-256 session and approve via noble, X25519 push);
  - `pair({qrPayload, name, platform, appVersion})` → NKpsk0 initiator with signatures, exposing `sasCode()`;
  - `connect({corePub, deviceId, linkSecret})` → NK + channel binding → `hello`;
  - `request(method, path, body?, {idem?})`;
  - `subscribeTask`, `subscribeGlobal`, `challenge(target)`, `decide(…)`, `unlock(ttl)`, `registerPush`, `revokeSelf`, `terminal.{attach,input,resize,detach}`;
  - tamper hooks `{flipBit, reorder, replay, oversize}` for the security suite;
  - it works against any relay URL.
- Self-test: pairs and talks to a minimal responder built from P2 and P4 through P5's relay (no core).

### Wave 4

**SS — Session manager.**

Owns: `src/bun/remote/session.ts`, `session-dispatch.ts`, `mac-name.ts` and their tests.

Acceptance:
- **Per device mailbox:** the first frame starts an NK responder handshake (DH via `getKeyHelper().dh`, prologue with the current core id).
  - A version below `MIN_PROTOCOL_VERSION`, or a handshake failure, ends it.
  - Then the phone must send `binding` (deviceId + ES256 over the handshake hash with the session key) within 10 s. The device must be in `trustedDevices()`, otherwise the session ends and a `refusal` is audited.
  - Then the core sends `hello` (§3.3; routes = `remoteRoutesFor(level)`, `auditHead`, clock, `macName()`) and audits `session-open`.
- **Transport:**
  - size check before decrypt;
  - **any** decryption failure, nonce gap or oversize frame ends the session (invariant 13);
  - session tags drop stale frames;
  - rekey every 10 minutes or 2^20 messages;
  - 15 minutes idle or 12 hours total ends it;
  - a new handshake from the same device replaces the old session;
  - handshakes go through the 6/min bucket.
- **Sending:** pad, chunk (envelope), paced by `relay-pacer`. The send queue cap is 4 MB, exposed as `queuedBytes()`.
- **Dispatch:** strict-parse each op, route it to its registered handler, and answer unknown ops with an error.
- `endDeviceSessions(id)` and `endAllSessions()` close within 1 s and audit `session-close`.
- `mac-name.ts`: reads the `remoteMacName` preference, else the computer name (`scutil --get ComputerName` via `coreSpawnSync`), else `os.hostname()`, capped at 40 and cleaned.
- Integration-style unit tests use P5 + P6 + the fake helper + seeded trusted rows: handshake, hello fields, a bad binding, a tampered frame, rekey (injected clock), the idle end and replacement.

**PA — Pairing.**

Owns: `src/bun/remote/pairing.ts`, `pairing.test.ts`.

Acceptance:
- `startPairing()`:
  - refuses when `!COMPANION_ENABLED` or not in the app core (`mode !== "app"`, C6);
  - calls `pairBegin({relayUrl, macName, expiresAt: now + 120 s})`;
  - registers the pairing secret with `registerLogSecret`;
  - joins the pairing mailbox (`agetor-pairing/1`);
  - sets `linkGate.pairingWindowOpen = true`;
  - runs the NKpsk0 responder.
- The phone's `pairing-request` must parse (name cleaned) and both signatures must verify over the handshake hash.
- Then `pairComplete` (with a core-generated 128-bit `deviceId` and `enrolledAt`) → verify the returned signature with the registry pub → op `remote.addDevice` at the **returned** level → send `pairing-result {deviceId, linkSecret, level}` → OS notification "\<name\> was paired" → `alertOtherDevices` → app event `remote_action{device-paired}` → close the window, retire the mailbox, recompute the gate.
- **Failures:**
  - wrong code ×3, expiry, a closed window, bad phone signatures or a bad helper signature → nothing written, an audited `refusal`, the gate recomputed;
  - a second `startPairing` while one is open focuses the existing one;
  - the pairing secret is zeroed after use.
- Tests with the fake helper and P6: success at each of the three levels; each failure path; the link down within 1 s after a cancel with no devices.

**RT — Router.**

Owns: `src/bun/remote/router.ts`, `route-classes.ts`, `router.test.ts`, `route-classes.test.ts`, `router-precedence.test.ts`.

Acceptance:
- `invokeRoute(principal, {method, path, query, body, idem?, decision?}, deps)`:
  1. **match** against `remoteRoutesFor(principal.level)` plus the routes above that level (to answer 403 `level` rather than 404), using its own matcher;
  2. refuse the SSE routes (`/events`, `/tasks/:id/events`) with `use-subscription`;
  3. **rate** (ID);
  4. **classify** (`route-classes.ts`): base policy + D8 (J1), D9 rows, D10 texts, D15 path scope, never-remote rows. A raise above the device level → 403 `level`; `never` → 403 `not-remote-v1`;
  5. **idempotency** for non-GET: `idem` is required (400 `idem-required`); a hit returns the stored response and audits `replayed`; a mismatch → 409;
  6. **step-up**: `unlock` needs a live unlock only when `runsWithoutAsking(task)`; `signed` needs `verifyDecision` against the class's target; failure → 403 with `code`;
  7. **audit attempt**;
  8. build `new Request("http://127.0.0.1" + path + query, {method, headers: {"content-type": "application/json"}, body})`, set `params`, `markDeviceRequest`, call the handler from `servedRoutes()` (boot gate and policy walker included);
  9. **audit result**;
  10. store idempotency;
  11. on success of a consent or operate action, `broadcastAppEvent(remote_action)` and post an OS notification.
- The response becomes `{status, contentType, body}`, with large bodies streamed to SS as chunks. Status codes pass through unchanged (for example a 503 `launches-frozen`).
- **Precedence test.** For every v1 pattern and a corpus of ≥ 200 paths (including `/tasks/:id/events/page` vs `/tasks/:id/events/:eventId`), the router's match equals the route `Bun.serve` picks (a real `Bun.serve` with echo handlers). Closes assumption 5.
- **Scenarios:**
  - a reject with text → content (needs unlock on an autonomous task);
  - a bare reject → remove (no unlock);
  - Claude plan row 1 from a respond device → 403 `level`; from operate without unlock → 403 `unlock`; with a signature on a stale plan → 403 `content-changed`;
  - an `allow_always` → 403;
  - `answerKind:"code"` → 403;
  - a preview outside the task folders from respond → 403 `level`, from operate → 200.

**TM — Phone terminal.**

Owns: `src/bun/remote/terminal.ts`, `terminal.test.ts`.

Acceptance:
- **`attach(channel, {taskId, decision})`:**
  - requires `level === "configure"` (else 403 `level`) and `verifyDecision` against target `terminal` (signed with the approve key, bound to the task id and the tmux session);
  - the task's harness must be a tmux-hosted per-task kind and `has-session -t sessionNameFor(taskId)` must succeed on agetor's socket (else `no-terminal`);
  - spawns `coreSpawn([tmuxBin, ...tmuxSocketArgs(), "attach-session", "-t", name], {terminal: {cols, rows, data}, env: childEnv({TERM: "xterm-256color"})})`.
- **Output** is coalesced every 50 ms into ≤ 16 KB chunks through `channel.send("terminal-output", …)` under the pacer.
- **Input and resize** come from the phone. The input bytes are never logged or audited.
- **Detach** on:
  - `terminal-detach`;
  - the channel closing;
  - `peerPresent()` false for more than 30 s;
  - 15 minutes without input;
  - `detachForTask(taskId)` (the Mac Detach route);
  - task archive or delete;
  - device revoke.
- Detach kills only the tmux **client** process, never the session.
- One phone per task: a second attach replaces the first.
- Audits `terminal-attach` and `terminal-detach`. `broadcastAppEvent(phone_terminal)` fires on both. `attachedTerminals()` serves the status.
- **Tests:**
  - with a real tmux on the test socket (a detached session running `cat`), attach, echo through, and detach on idle (injected clock);
  - level refusal;
  - a bad signature;
  - an ACP harness → `no-terminal`;
  - the session still alive after detach;
  - skips loudly without tmux, fails under `CI=true`.

### Wave 5

**GW — Gateway composition and process wiring.**

Owns:
- `src/bun/remote/gateway.ts`
- `gateway.test.ts`
- `src/bun/headless.ts`
- `src/bun/index.ts`
- `src/bun/app-menu.ts` (+ `app-menu.test.ts`)
- `src/bun/remote-access-box.ts` (pairing entry: "turn on first")
- `docs/architecture/always-on-host.md`

Acceptance:
- `startRemoteGateway({mode: "app"|"background"|"headless", native?})`:
  - **if `!COMPANION_ENABLED`:** a no-op that logs once ("companion disabled in this build");
  - **otherwise it composes:** KH, RG, LK (gate inputs: the remote switch via `getRemoteAccess` + `subscribeBackgroundChanges`, `hasTrustedDevice`, pairing open), SS (registers the session ops → RT `request`, SU `subscribe-*`, DE `challenge` / `unlock`, PU `push-register`, RG `revoke-self`, TM `terminal-*`), PU sink registration, schedulers (RG expiry daily, AU trim daily, ID prune every minute);
  - logs the D11 warning to `core.log` when bound beyond loopback;
  - returns `{stop, startPairing?}` (`startPairing` only in `app` mode).
- **`index.ts`:**
  - starts the gateway right after `markBootReady()`;
  - stops it in the quit path;
  - the menu action `pair-phone` → `startPairing`, preceded by `runRemoteAccessBox` when the switch is off.
- **`headless.ts`:** starts it after boot in `background` (login-item) or `headless` mode, with no pairing.
- **`app-menu.ts`:** "Pair a Phone…" appears under the Remote Access item only when `COMPANION_ENABLED`. Tested both ways by injecting the flag.
- **Scenarios** (gateway.test.ts, using the fakes):
  - switch off → `endAllSessions` + link down within 1 s;
  - the C3 probe reset → same;
  - the last device revoked → link down;
  - a handoff: stop, then start on a new core with the same data dir → the device reconnects (P6) and resumes from its cursor;
  - a release flag → `startRemoteGateway` never touches the helper (spy).
- `always-on-host.md`: the gateway follows the port owner; reconnect after a handoff; the background core never pairs.

**CT — Control routes, device preview, status, the D19 rule.**

Owns:
- `src/bun/server.ts`
- `src/bun/route-policy.ts`
- `src/bun/route-policy.test.ts`
- `src/bun/route-policy-remote.test.ts`
- `src/bun/remote/remote-status.ts` (+ test)
- `src/shared/types.ts` (`RemoteAccessStatus`)
- `src/shared/remote-types.ts` (DTOs for devices and log)
- `src/bun/server-remote-access.test.ts`
- `src/bun/server-task-preview.test.ts`
- `CLAUDE.md` (the security bullet only)
- `docs/plans/companion-pairing-requirements.md` (rule 5)

Acceptance:
- **Routes:**
  - `GET /remote-access` returns `RemoteAccessStatus {enabled, preview, companion, relay: {url|null, state}, devices: {trusted, untrusted}, bindWarning|null, macName, attachedTerminals[], auditHead}`;
  - `DELETE /remote-access` keeps today's behaviour (the gateway reacts through background changes);
  - `GET /remote-access/devices` returns trusted and untrusted rows with cleaned names, platform, last seen, level and trust;
  - `DELETE /remote-access/devices` runs `revokeAll`;
  - `DELETE /remote-access/devices/:id` runs `revoke`;
  - `GET /remote-access/log?beforeSeq&limit` returns the page plus the chain status;
  - `GET /tasks/:id/files/preview?path=` (`app+cli`, `pathParams` `QUERY_PATH`, remote observe/heavy): no-follow read through `core-file-read.ts`, 50 MB cap (`MAX_FILE_PREVIEW_BYTES`), the same content types as `/files/preview`, 404 for an unknown task; the D15 rule is applied in the router;
  - `DELETE /tasks/:id/phone-terminal` (`app+cli`) runs `detachForTask`;
  - `PUT /preferences/remoteMacName` is validated (≤ 40, cleaned, refused when empty).
- **Removed:** `DELETE /notifications/:taskId` and its policy entry, once a grep (both `api.ts` and `api-client.ts` method names, per memory) shows no caller.
- When `!COMPANION_ENABLED` the device, log, preview and phone-terminal routes answer 404 `{code:"companion-unavailable"}`.
- **TT3(c) rewritten (D19).** `REMOTE_ACCESS_ALLOWLIST` is exactly `{"/remote-access": ["GET","DELETE"], "/remote-access/devices": ["GET","DELETE"], "/remote-access/devices/:id": ["DELETE"], "/remote-access/log": ["GET"]}`. No POST, PUT or PATCH sits under `/remote-access`, and no other key carries a banned segment (`phone-terminal` and `presence` pass). The pinned v1 set gains the preview route.
- `CLAUDE.md` § Security bullet and pairing-requirements rule 5 say: no route pairs a device, turns remote access on, or raises a device's level. Under `/remote-access` only GET (read) and DELETE (revoke or off) exist, pinned by TT3(c). `claudemd-citations.test.ts` is green.
- **Tests:**
  - a revoke over HTTP ends that device's live session within 1 s (P6 observes the close);
  - revoke-all → every session closes and the helper's core key changes;
  - the CLI token can list, revoke and read the log;
  - the D15 preview scenarios are covered with RT.

**REL — Release wiring.**

Owns:
- `electrobun.config.ts` (copy `"vendor/keyhelper": "bin"`)
- `package.json` (`vendor:keyhelper`; the `build*` chains run it after `vendor:notifier`)
- `scripts/verify-vendor-signing.ts`
- `scripts/verify-release.ts`
- `scripts/verify-release.test.ts`
- `scripts/release.ts`
- `.gitignore` (`*.provisionprofile`, `vendor/keyhelper/`)

Acceptance:
- `release.ts` fails before building when `AGETOR_KEYHELPER_PROFILE` is unset or unreadable, with an actionable message.
- `verify-vendor-signing.ts` checks that `AgetorKeyHelper.app` is signed with the same identity as the notifier, has the hardened runtime, contains `embedded.provisionprofile`, and has entitlements with `keychain-access-groups`.
- `verify-release.ts`:
  - **`verifyKeyHelperLayout(app)`:** the helper is at `Contents/Resources/app/bin/AgetorKeyHelper.app`, not in `Contents/MacOS`; it passes `codesign --verify --strict`; the profile's team equals the signature's team; the entitlements are present;
  - **`verifyReleaseBundles(app)`:** `Resources/app/bun/index.js`, `daemon/*.js` and `bin/agetor` (if bundled) contain none of `AGETOR_FAKE_KEY_HELPER`, `AGETOR_REMOTE_RELAY_URL` or `AGETOR_REMOTE_PUSH_URL`, and the companion flag compiled false (a marker string emitted only when `COMPANION_ENABLED` is true is absent);
  - **fail closed** on a missing helper, a missing profile, or a marker found.
- `verify-release.test.ts` runs both functions against fixture trees: good → pass; a helper under `MacOS` → fail; no profile → fail; a marker present → fail.
- `bun run build` without a profile still builds for local dev: `build-keyhelper` falls back to `--adhoc` with a warning. Only `release.ts` and `verify-release.ts` refuse.

### Wave 6

**UI1 — Settings › Remote access.**

Owns:
- `src/mainview/components/settings/RemoteAccessSection.tsx` (+ `.test.tsx`)
- `src/mainview/components/settings/SettingsDialog.tsx`
- `src/mainview/components/settings/BackgroundSection.tsx` (pointer and link only)
- `src/mainview/lib/api.ts`
- `src/mainview/lib/remote-access-store.ts`

Acceptance:
- The section is hidden when `status.companion === false`.
- It shows:
  - the switch state;
  - the relay address (read-only) or "No relay configured";
  - the bind warning;
  - the Mac name (an editable field with ≤ 40 validation);
  - devices (name as plain text, platform, last seen, level, "Not trusted" with its reason);
  - Revoke per device;
  - Revoke all (a confirm dialog that follows the popover contract);
  - Activity (paged log, chain status, "outcome unknown" rows);
  - the text "Pair a phone from Agetor › Remote Access › Pair a Phone…" (C1: no button route).
- Semantic tokens only. The status refreshes on the existing `background_changed` and `remote_action` app events; no new stream.
- `api.ts` gains `getRemoteDevices`, `revokeRemoteDevice`, `revokeAllRemoteDevices`, `getRemoteLog`, `detachPhoneTerminal` and `setMacName`.
- Component tests: a seeded list renders; revoke calls the route; untrusted rows show their reason; the section is hidden when companion is off.

**UI2 — Banner and remote toasts.**

Owns:
- `src/mainview/components/kanban/RunPanel.tsx`
- `src/mainview/components/kanban/PhoneAttachedBanner.tsx` (+ test)
- `src/mainview/lib/phone-terminal.ts` (+ test)
- `src/mainview/App.tsx`
- `docs/architecture/run-panel.md`

Acceptance:
- `App.tsx`'s single `subscribeAppEvents` handler forwards `phone_terminal` into the `phone-terminal.ts` module store (seeded from `GET /remote-access` `attachedTerminals`) and turns `remote_action` into a sonner toast ("Plan approved from Ana's iPhone").
- `RunPanel` renders `PhoneAttachedBanner` for the selected task when the store has an entry: "Phone attached to \<task\>", the device name, and a Detach button calling `api.detachPhoneTerminal`.
- No per-task local state is added to `RunPanelBody`, or if any is added, it gets a reset line in the `[task.id]` effect. Keys are unique.
- `run-panel.md` documents the banner.
- Tests: the store reducer; the banner renders and calls detach; switching tasks hides the other task's banner.

**CLI — Remote CLI commands.**

Owns:
- `src/cli/commands/remote.ts`
- `src/cli/api-client.ts`
- `src/cli/index.ts` (help text)
- `src/cli/remote.test.ts`
- `src/cli/cli-scope-daemon.test.ts`
- `src/cli/api-client.test.ts`
- `src/bun/route-policy.test.ts` (the CLI inventory list at ~:630)

Acceptance:
- `agetor remote [status | off | devices | revoke <device> | revoke-all | log [--limit N]]`:
  - `<device>` matches an id prefix or an exact name, and an ambiguous match is refused;
  - every phone-supplied string is printed through `escapeControlChars` or `escapeFreeText`;
  - there is still no `on` and no `pair`.
- `status` adds the device counts, the relay state and the bind warning (D11).
- Against a core with companion unavailable it prints "not available in this build". In a release CLI build the device subcommands are absent from the help.
- Tests use a fresh `--data-dir` only (memory), and the inventory lists include the new routes.

**DOCS — Architecture docs.**

Owns:
- `docs/architecture/remote-gateway.md` (new)
- `docs/architecture/security.md`
- `docs/architecture/testing-seams.md`
- `docs/architecture/README.md`
- `CLAUDE.md` (the Topic map row, the env-var list and the "Rules that apply everywhere" additions; not CT's bullet)
- `README.md`

Acceptance:
- `remote-gateway.md` is the subsystem contract:
  - modules and their single enforcement points (§7);
  - the session lifecycle;
  - the router order;
  - the classification table (§3.4);
  - step-up;
  - idempotency;
  - subscriptions and backpressure;
  - push;
  - terminal;
  - audit;
  - ship-dark flags;
  - test seams;
  - how to run the suites.
- `security.md` covers:
  - the key helper;
  - registry trust;
  - invariants 1–14, each with its test name;
  - invariant 5 amended (D11);
  - residual risks (D18: an agent posing as the core; forged push text);
  - the configure-terminal bypass (D17).
- `testing-seams.md` covers `AGETOR_FAKE_KEY_HELPER`, `AGETOR_FAKE_KEY_HELPER_DIR`, `AGETOR_REMOTE_RELAY_URL`, `AGETOR_REMOTE_PUSH_URL`, the build flags and the guard.
- `CLAUDE.md` gets the Topic map row and the new env vars.
- `README.md` replaces the remote-access lines at :296, :320, :401 and :407.
- `claudemd-citations.test.ts` is green.
- Code comments that cited the spec may stay; no comment cites a numbered CLAUDE.md section.

**K1V — Live key-helper verification (owner-gated).**

Owns: `docs/plans/remote-readiness-k1.md` (verification record).

Acceptance (needs the owner's App ID and Developer ID profile, D2):
1. `AGETOR_KEYHELPER_PROFILE=<path> bun scripts/build-keyhelper.ts`, then `…/keyhelper selftest`, prints:
   - Secure Enclave available;
   - the data-protection item was created under the access group;
   - `security find-generic-password -l <label>` run from Bun **cannot** read the core key.
2. `bun run release:build-only` passes `verify-release.ts`.
3. On `~/.agetor-dev` with `AGETOR_E2E_HARNESS_SEAMS=1` and `AGETOR_REMOTE_RELAY_URL` at a local test relay: a P6 test client pairs with the **real** helper (window, typed code, Touch ID, level choice), connects, and reads the board.
4. Revoke from Settings closes the client within 1 s.

The record holds the commands, the macOS version (26.6.2) and the outputs. **If step 1 fails, stop: D3 removed the fallback, so the owner must re-decide (§8).**

### Wave 7

**FIN — Final refresh.**

Owns: `docs/plans/remote-readiness.md` (`Status`, Branch, Base SHA, the W1 verdict, the recorded CI failures), and the PR description.

Acceptance: test counts, e2e results, the CI failures that are known and recorded, and the K1V outcome are current at the final head. The single PR body lists every wave with its tasks and tests, the owner prerequisite (App ID and profile), and the separate ticket for the pre-existing failures.

---

## 5. Work breakdown — test tasks

These are in addition to every implementation task's own unit tests. Every test must be shown failing against a broken copy of the behavior. Missing binaries or env skip loudly and fail under `CI=true`.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TS1 | integration and security (wave 6) | SC1, SC2, SC9, SC12; invariants 1, 2, 3, 7, 9, 10, 11, 12, 14 | `src/bun/remote/it/{harness.ts,pairing.it.test.ts,link-gating.it.test.ts,revoke.it.test.ts,handoff.it.test.ts,logs-no-secrets.it.test.ts,ship-dark.it.test.ts}` | See below |
| TS2 | integration and security (wave 6) | SC3, SC4, SC5, SC10, SC11; invariants 4, 5, 6, 8, 13 | `src/bun/remote/it/{router-levels.it.test.ts,consent.it.test.ts,idempotency.it.test.ts,terminal.it.test.ts,previews.it.test.ts,frames.it.test.ts}` | See below |
| TS3 | integration (wave 6) | SC6, SC7, SC8 | `src/bun/remote/it/{data.it.test.ts,push.it.test.ts,audit.it.test.ts,notifications-core.it.test.ts}` | See below |
| E2E | e2e (wave 7) | SC7 (regression), SC9, SC10 | `e2e/remote-access-devices.spec.ts`, `e2e/phone-terminal-banner.spec.ts`, `e2e/remote-helpers.ts`, `e2e/fixtures.ts` (env passthrough only) | See below |
| CI2 | CI (wave 7) | SC13, SC14 | `.github/workflows/ci.yml` | See below |

**TS1 (pairing, trust, link, lifecycle).**

- `harness.ts` starts a **real** headless core process (`bun src/bun/headless.ts`) with:
  - `NODE_ENV=test`;
  - a temp `AGETOR_DATA_DIR`;
  - `AGETOR_FAKE_KEY_HELPER=1` and `AGETOR_FAKE_KEY_HELPER_DIR`;
  - `AGETOR_REMOTE_RELAY_URL` at P5;
  - `AGETOR_FAKE_LOGIN_ITEM=1` and `AGETOR_FAKE_REMOTE_ACCESS=on`;
  - the fake drivers.
- In-process helpers drive pairing through the fake helper's dir-based control file (KH documents it) and P6.
- Named tests (one per invariant):
  - `inv1: link stays down with switch on and no devices`;
  - `inv2: no HTTP route, CLI command or webview action adds a device or raises a level` (walks `ROUTE_POLICY` + the CLI help);
  - `inv3: a row written into SQLite is ignored`, and `… a replayed revoked row is ignored`;
  - `inv7: no header produces a device caller`;
  - `inv9: revoke mid-session closes within 1 s` (also for Remote access off and Revoke all; never rate-limited);
  - `inv10: no private key in SQLite or files` (scans the data dir for the fake's private key bytes);
  - `inv11: core.log and daemon.log hold no key, token, signature, link secret, pairing secret, push key or plaintext` (searched for every secret the run created);
  - `inv12: audit row precedes response` (kill the core between attempt and result using a slow handler → the restart shows "outcome unknown");
  - `inv14: protocol version is bound into the handshake` (a wrong prologue version fails; a version below the minimum is refused).
- `handoff`: kill -9 core A mid-session, start core B on the same data dir → P6 re-handshakes and resumes from `afterId` with no duplicate events.
- `ship-dark`: a bundle built with the release define never starts the gateway and refuses the seams.

**TS2 (router and consent).**

- `inv6: a device reaches no app route and nothing above its level` (every `ROUTE_POLICY` key × each level);
- `inv8:` stale challenge / other session / changed plan / wrong key / changed gate field → refused, and each correct one accepted;
- the D9 rows at each level;
- D10 texts;
- D8 `always` / `unknown`;
- `answerKind` `code`;
- the unlock window: a follow-up into an autonomous task is refused without it, accepted with it, and refused after it expires;
- idempotent repeat → stored result; same key + different body → 409; a repeat **after a core restart** → stored result (096);
- terminal: attach at configure + a signed attach, refused at operate, idle detach, Mac Detach via HTTP, revoke → detach, the session survives;
- previews: in task scope at respond → 200; outside at respond → 403; outside at operate → 200; a symlink in the path is refused (no-follow); 50 MB arrives in chunks within the pacer limits (asserted by P5's counters);
- `inv13`: flipped, reordered, replayed and oversize frames end the session; an unknown field in a security message is refused;
- `inv4`: P5 sees only ciphertext (no plaintext marker strings in any relayed frame);
- `inv5`: the HTTP API is still bound to 127.0.0.1 only, and the gateway adds no listener (`lsof` on the core's pid).

**TS3 (data, notifications, audit).**

- inbox in one request, with folded step cards and gates;
- 256 KB first load;
- a 20 KB tool result arrives cut and is fetched whole by event id;
- projection forms present;
- board delta + `tasks-changed` via the global subscription;
- backpressure → `snapshotRequired`;
- push: needs-you only, nothing within 2 minutes of focus, sealed bodies only, a 410 marks the device dead, the collapse id is stable per task;
- audit: the chain verifies; a forged row (trigger dropped by the test) is detected; trim leaves an anchor; the hello carries the head;
- notifications-core: an app-mode core with a recording native sink posts once per task, and the webview presence suppresses.

**E2E.**

- `remote-access-devices.spec.ts`: devices seeded by `e2e/remote-helpers.ts` (it creates the fake helper dir with a registry key and signs rows into the backend's SQLite before boot) → Settings lists them, one shown as "Not trusted"; Revoke removes one; Activity shows the audit rows with chain OK.
- `phone-terminal-banner.spec.ts`: the spec creates a detached tmux session `agetor-<id12>` on the backend's tmux socket, and a P6 client (seeded configure device) attaches → the run panel shows "Phone attached to \<task\>" → Detach → the banner disappears and the client sees the detach.
- Regression: `one-notification-per-task.spec.ts` (N2's version), `event-stream-resume.spec.ts`, `cursor-stream.spec.ts` and `background-settings.spec.ts` pass.

**CI2.**

- The `check` job adds the helper vector step: `bun scripts/build-keyhelper.ts --adhoc && vendor/keyhelper/AgetorKeyHelper.app/Contents/MacOS/keyhelper selftest-vectors packages/remote-protocol/vectors`, which asserts that all three vector files were checked. The remote and `it/` suites already run inside `bun run check` (they live under `src/`).
- The job installs tmux on the runner (Homebrew, or `bun run vendor:tmux`), so the terminal tests run in CI instead of skipping.
- The workflow's header comment says the owner marks `check` required in branch protection, a GitHub setting this plan doesn't change.

**E2e: applies.** The change has user-visible flows (Settings, the banner, the notification cutover) and crosses process boundaries (webview → core → relay → client).

**Run recipe:**

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install
# tmux must resolve (bundled: bun run vendor:tmux, or Homebrew tmux on PATH)
bun node_modules/@playwright/test/cli.js test \
  e2e/remote-access-devices.spec.ts e2e/phone-terminal-banner.spec.ts \
  e2e/one-notification-per-task.spec.ts e2e/event-stream-resume.spec.ts \
  e2e/cursor-stream.spec.ts e2e/background-settings.spec.ts
```

- The per-worker headless backend comes from `e2e/fixtures.ts` (one Vite at :5173). Only one Playwright run at a time.
- No real credentials. Device rows are seeded by `e2e/remote-helpers.ts`. The relay is P5, started by the spec on a free port and passed via `AGETOR_REMOTE_RELAY_URL` in `backendEnv`, together with `AGETOR_E2E_HARNESS_SEAMS=1` (already set by the e2e backend).

**Unit and integration run recipe:**

- `bun run check` runs typecheck, `lint:async`, `bun test` (src) and the package tests.
- The remote subset: `bun test src/bun/remote src/bun/route-policy*.test.ts src/shared/tmux-choice-class.test.ts src/bun/db-remote*.test.ts && (cd packages/remote-protocol && bun test)`.

---

## 6. Execution waves

### 6.1 Waves (owned files are disjoint within each wave; checked below)

| Wave | Tasks (parallel) | Barrier: must be green before the next wave |
| --- | --- | --- |
| 0 | D0 | Docs only: a review of the diff against the unamended spec commit |
| 1 | P1, B1, K1, J1, N1, E1 | `bun install`; `bun run check`; e2e `event-stream-resume`, `cursor-stream` (E1) |
| 2 | P2, P3, P4, P5, RP, DB, KH, N2, PR, CI1 | `bun run check`; e2e `one-notification-per-task`, `background-settings` (N2) |
| 3 | RG, LK, DE, SU, PU, AU, ID, P6 | `bun run check` |
| 4 | SS, PA, RT, TM | `bun run check` (the TM tmux test needs tmux) |
| 5 | GW, CT, REL | `bun run check`; `bun run build` locally (the ad-hoc helper path) |
| 6 | UI1, UI2, CLI, DOCS, TS1, TS2, TS3 (+ K1V when the owner's profile exists) | `bun run check`; the TS suites |
| 7 | E2E, CI2, then FIN | The full e2e recipe (§5); the required `check` job on the PR fails on nothing except the pre-existing tests CI1 recorded (owner-deferred, §9) |

**Hot files and who owns them, by wave:**

| File | Owner by wave |
| --- | --- |
| `server.ts` | E1 (1) → CT (5) |
| `route-policy.ts` | E1 (1) → RP (2) → CT (5) |
| `route-policy.test.ts` | E1 (1) → RP (2) → CT (5) → CLI (6) |
| `src/shared/types.ts` | E1 (1) → RP (2) → CT (5) |
| `index.ts` | N2 (2) → GW (5) |
| `App.tsx` | N2 (2) → UI2 (6) |
| `api.ts` | N2 (2) → UI1 (6) |
| `package.json` | P1 (1) → REL (5) |
| `bun.lock` | P1 (1) → P4 (2) |
| `electrobun.config.ts` | B1 (1) → REL (5) |
| `packages/remote-protocol/package.json` | P1 (1) → P4 (2) |
| `security.md` | RP (2) → DOCS (6) |
| `CLAUDE.md` | CT (5, the security bullet) → DOCS (6, map and env) |
| `e2e/fixtures.ts` | E2E (7) |
| `.github/workflows/ci.yml` | CI1 (2) → CI2 (7) |

Each file has one owner per wave.

**Cross-task interface pins within a wave:**

- Wave 1: the `AGETOR_RELEASE_BUILD=1` script prefix (P1) for B1; `setWebviewPresence` (N1) for E1's presence route.
- Wave 4: the `PhoneChannel` (RP, wave 2) for TM, RT and PA against SS.
- Wave 5: `detachForTask`, `endDeviceSessions` and `revoke` (waves 3–4) for CT; `remote-status.ts` is CT's, so GW does not edit it.

**Expected red tests at barriers:**

- Local barriers: none. The one-notification e2e spec changes in the same task (N2) that changes the behaviour it observes.
- The required CI `check` job: exactly the pre-existing `main` failures (§2.3) and the runner gaps CI1 records, until the separate ticket lands (A-2). Any other red test is a defect of this change.

### 6.2 Checkpoints

- Each wave ends in one checkpoint commit (`git add` of the owned files only, never `-A` outside them).
- A resumed run continues from the last green checkpoint.
- Never use `git stash`.

### 6.3 Delivery: one PR, one checkpoint commit per wave (A-11, owner)

- **One PR** from `feature/agetor-remote-ready` to `main`.
- **Commit 1:** the planning documents, the two spec copies **unamended**, the investigation and the grill records.
- **Commit 2:** D0's amendments to the spec copy, so they can be reviewed as a diff.
- **Then one checkpoint commit per wave** (1 to 7), each green at its barrier, plus the review-fix commits after the trust-tagged waves (§7.4).
- Commit subjects name the wave and its task ids (for example `wave 3: RG LK DE SU PU AU ID P6`), so a reviewer can walk the PR commit by commit. Per the owner's global rule, no Claude co-author trailer.
- What production reaches as the commits land: the inbox, event-by-id, `maxBytes` and presence routes (wave 1); the notification cutover and migrations (wave 2); the gateway in dev and e2e builds (wave 5); release builds stay dark throughout (D1).
- Once wave 5 lands on `main`, any release **needs the owner's profile** (REL fails closed).
- The PR body lists the waves, the tests per wave, the owner prerequisite (App ID and profile), the K1V outcome, and the required `check` job's known pre-existing failures until the separate ticket lands.

---

## 7. Invariants, runtime shape & risks

### 7.1 Invariants and their single enforcement point

| Invariant | Enforced at | Every path routes through it |
| --- | --- | --- |
| 1. The link is up only with the switch on AND (a trusted device OR the pairing window open) | `remote/link-gate.ts` `LinkGate` | `relay-link.ts` opens only on its `up`; pairing sets its input; the gateway feeds the switch and the registry |
| 2. Adding a device needs the native window, the code and Touch ID; nothing raises a level | The key helper's `pair-complete` (the signature covers the level) + `remote/registry.ts` trust check | No route, CLI command or session op writes a device row; TT3(c) pins the routes; `inv2` walks them |
| 3. Trust comes from the signature and the helper's revocation list | `remote/registry.ts` `trustedDevices()` (no cache) | SS binding, CT listing, PU push targets, the link-gate provider |
| 4. End-to-end encryption, mutual auth | `remote/session.ts` (NK + channel binding) over `packages/remote-protocol/src/noise.ts` | Every app message goes through the session send path |
| 5. The HTTP API stays on loopback (or a wildcard with the warning, D11) | `api-config.ts` `resolveApiHost` (unchanged) + GW's warning | The gateway adds no listener (`inv5` test) |
| 6. Deny by default; level ceiling | `route-policy.ts` `wrapHandler` device branch | The router calls only wrapped handlers via `route-table.ts` |
| 7. A device caller exists only from the private mark | `route-policy.ts` `markDeviceRequest` (module-private WeakMap); importable only by `remote/router.ts` (test) | `resolveCaller` never returns `device` |
| 8. Consent is signed over the exact content | `remote/decisions.ts` `verifyDecision` (five checks in order) | `remote/router.ts` step-up and `remote/terminal.ts` attach |
| 9. Removal is never rate-limited and is immediate | `remote/rate-limit.ts` (`stop` class bypass) + `session.ts` `endDeviceSessions` | Revoke (CT, RG), off (GW), revoke-all, revoke-self |
| 10. Private keys never leave their store | The key helper (only `dh` crosses to Bun) | KH is the only path to the core and registry keys |
| 11. Nothing secret is logged | `core-log.ts` `registerLogSecret` (link secret, pairing secret, push send key) + no logging in remote modules of bodies or keys | `inv11` scans the logs |
| 12. Audited first (attempt before handler, result after) | `remote/audit.ts` called by `remote/router.ts` steps 7 and 9; ops write rows in the same tx as device changes | Pairing, revoke, sessions and the terminal call `auditEvent` |
| 13. Parse strictly, fail closed | `packages/remote-protocol/src/messages.ts` parsers + `session.ts` (size before decrypt, any failure ends the session) | Every op is parsed before dispatch |
| 14. No downgrade | The `noise.ts` prologue (`agetor-remote/1` ‖ core id) + `session.ts` minimum version | Both handshakes |
| D1/D4 ship dark; seams dead in release | `src/shared/build-flags.ts` `COMPANION_ENABLED` / `remoteSeamsAllowed` | The gateway start, the menu, the routes' 404, KH, LK and PU seams; `verify-release.ts` checks the bundles |
| D5 one notification decision | `src/bun/notification-policy.ts` | OS (app and headless) and phone sinks; the webview no longer posts |
| D7 levels per device, chosen natively | The key helper window + the signed entry | No other writer |
| D15 preview path scope | `remote/route-classes.ts` preview rule | The only device path to the preview route |
| D17 terminal gate | `remote/terminal.ts` `attach` (configure + signed) | The only spawn of a phone-attached tmux client |
| Idempotency of remote mutations | `remote/idempotency.ts` inside the router | Every non-GET remote call |

### 7.2 Runtime shape

- **One port owner.** The gateway starts only after `markBootReady()` in that core. On a takeover the old core exits and the new owner's link replaces it (`replaced`). Phones re-handshake, and idempotency rows (SQLite) and cursors carry the work across.
- **A crash between attempt and result.** The audit reads "outcome unknown" and the `idem` row answers the retry.
- **A crash mid-pairing.** No row is written and the pairing secret dies with the process.
- **Helper failure.**
  - The helper crashes → the in-flight DH fails → that handshake fails, and the phone retries.
  - The helper is missing → status `helper-missing`, the gateway stays down, and Settings explains it.
  - No Secure Enclave → pairing refuses (D3).
- **Relay outage.** Back-off reconnect. Sessions end, the phone re-handshakes, and pushes are unaffected (a different service, null in this change).
- **Kill switches, in order of reach:**
  - the build flag (release = dark);
  - Remote access off (Settings, CLI, HTTP, menu) → every session and the link end within 1 s;
  - Revoke all (+ a new core key);
  - Revoke per device.
  - The switch wins over everything at runtime: link-gate input 1.
- **Main-thread budget.** Handshakes take a few ms. Preview and terminal chunking yield every slice (`setImmediate`). Chain verification and trimming run in the db worker. No loop over all devices or events runs synchronously.

### 7.3 Blast radius

- **Desktop behaviour changes:**
  - OS notifications are now decided by the core (N2), covered by the rewritten one-notification e2e and the policy table tests;
  - the task-stream handler becomes an adapter (E1), covered by the existing stream tests and two e2e specs;
  - `DELETE /notifications/:taskId` is removed (CT) after a caller grep;
  - a new menu item (dev builds only).
- **Routes:**
  - new: `/interactions/pending`, `/tasks/:id/events/:eventId`, `/app/presence`, `/tasks/:id/files/preview`, `/tasks/:id/phone-terminal`, `/remote-access/devices[/:id]`, `/remote-access/log`;
  - changed: the `GET /remote-access` body (additive fields; the CLI tolerates them);
  - `ROUTE_POLICY` type widened.
- **Migrations:** 094–096 are additive with no backfill. Rollback = an older build ignores the tables (never drop them in a later migration without a plan).
- **Release pipeline:** gains a required provisioning profile (REL). This is the one operational dependency on the owner once wave 5 is merged.
- **Dependencies:** `@noble/curves`, `@noble/ciphers` and `@noble/hashes` 2.4.0 (runtime); `ts-json-schema-generator` and `ajv` (dev, package only).
- **Cross-repo dependencies:** none. The relay and push gateway (relay spec) and the iOS and Android apps (iOS spec) build on this contract later. The vectors and schemas here are what they test against.

### 7.4 Top risks

1. **K1 fails on the owner's Mac** (assumption 1). There is no fallback, so pairing would be impossible. Mitigation: K1's source lands in wave 1 so the owner can run K1V early, in parallel with waves 2–5.
2. **The notification cutover regresses desktop notifications.** Mitigation: the table-driven parity tests and the e2e spec. Wave 2's checkpoint commit isolates the cutover for review.
3. **Router and Bun disagree on route precedence.** Mitigation: RT's precedence test over ≥ 200 paths.
4. **Tmux classification misses an always-style row.** Mitigation: unmatched rows are `unknown` and refused (fail closed); the fixtures come from every row seen.
5. **Terminal throughput under the relay limits feels laggy.** Mitigation: the pacer tests plus TS2's measured throughput. Coarser batching is a tuning change, not a redesign.
6. **Size.** One PR, about 45 tasks. Owner memory says feature-sized runs needed three opus review rounds. Plan a review pass after waves 2, 4 and 6 (trust-tagged waves), and re-run the remote suites after each fix wave.

---

## 8. Open questions / assumptions

### 8.1 Unratified one-way decisions

None from the grill: every one-way door was decided by the owner (D1–D19).

### 8.2 Decisions taken at plan approval, and the planner's remaining defaults

Decided by the owner at approval (2026-11-25, AskUserQuestion):

- **A-2 CI:** "Full check required". The required job runs `bun run check` (plus the helper vectors). The pre-existing `main` failures (§2.3) keep it red until a **separate ticket** fixes them; the owner chose that option, which named the separate ticket. Implementing must not skip or loosen those tests to turn CI green.
- **A-4 switch-account:** "Session only". Operate level, no step-up, class `action`.
- **A-11 delivery:** "One PR, per-wave commits".
- **Plan:** "Approve as written".

The planner's defaults, approved with the plan:

- **A-7 idempotency persisted** (migration 096) rather than in memory, because of the port handoff. This is two-way.
- **N2's e2e observation point.** `one-notification-per-task.spec.ts` keeps every behavioural assertion but observes the core's notifier calls instead of the webview's requests, because the decision moved (D5).
- **Relay and push addresses are null in this change.** Dev and e2e reach the local test relay and the stub gateway through seams only.
- **The schema generator** is a dev-only dependency (`ts-json-schema-generator`, `ajv`) in `packages/remote-protocol`.

### 8.3 Assumptions carried from the grill (not re-decided)

- **K1 works** with a profile-embedded nested `.app` on macOS 26.6.2 (investigation assumption 1). If K1V fails, **stop and re-grill**: D3 removed the fallback.
- **Bun's route precedence matches the router's matcher** (assumption 5). Closed by RT's precedence test.
- **The registry public key and revocation list are read from the helper on every check** (assumption 3). Enforced in RG and tested.
- **A tmux terminal is usable within 50 frames/s and 2 MB/10 s.** Measured in TS2. Batching is tunable.
- **The owner creates the App ID and Developer ID profile** (D2). This gates K1V and every release once wave 5 is merged, not the code.

---

## 9. Completeness ledger

| Item | Disposition | Task / reason / who |
| --- | --- | --- |
| Spec copy in the repo; amendments marked inline (C7) | In this run | Copies written at planning; D0 amendments |
| Relay contract + Blueprint §12 excerpts (C7) | In this run | Written at planning (`docs/specs/remote-relay-contract.md`) |
| `packages/remote-protocol` plumbing: workspaces, test root, tsconfig, lint globs, `bun.lock` | In this run | P1 (P4 for dev deps) |
| Noise, HPKE, canonical JSON, ES256, derivations, padding, framing, parsers, schemas, vectors (C4, C5, E1, E2) | In this run | P1–P4 |
| W1 spike (schema generation) | In this run, with a fallback | P4 (verdict recorded by FIN) |
| Local test relay | In this run | P5 |
| Headless test client | In this run | P6 |
| Key helper source + build + selftest (D2, D3) | In this run | K1 |
| K1 live run on macOS 26.6.2 | In this run, owner-gated | K1V |
| K1 on macOS 27 | Out of scope | Unnecessary after D3 (owner) |
| Provisioning-profile embedding: `release.ts`, `verify-release.ts`, `verify-vendor-signing.ts` (D2) | In this run | REL |
| Creating the App ID and profile in the Apple account | Owner prerequisite | Owner (D2); gates K1V and releases once wave 5 is merged |
| Build flags, seams dead in release (D1, D4) | In this run | B1, REL (verification) |
| `ROUTE_POLICY` remote levels; the `remote: "none"` literal type and the "every entry none" assertion replaced | In this run | RP |
| Device caller + walker device branch + import rule | In this run | RP |
| Startup check: no remote on `app` or `public` | In this run | RP |
| Pinned v1 set (incl. five D12 routes, preview) | In this run | RP, CT |
| Routes object hoisted; route table | In this run | E1 |
| Router, classification (D8, D9, D10, D15), step-up, toasts | In this run | RT |
| Signed decisions, challenges, content hashes (E4 six fields), unlock window, autonomy table | In this run | DE |
| tmux choice classifier with fixtures of every row seen (D8) | In this run | J1 |
| Idempotency (persisted, 096) | In this run | DB, ID |
| Rate limits | In this run | ID |
| Migrations 094 devices, 095 audit (+ triggers), 096 idempotency; ops; db-async wiring | In this run | DB |
| Registry verification, revoke, revoke-all (+ core key replacement), 60-day expiry | In this run | RG (+ GW scheduler) |
| Relay link, pacing, link gating | In this run | LK |
| Sessions: handshake, binding, hello (`macName`, D16), rekey, lifetime, rate, backpressure cap | In this run | SS |
| Pairing orchestration; Mac notification + alerts to other devices | In this run | PA |
| Gateway in the app and background cores; reconnect after handoff; background never pairs (C6) | In this run | GW |
| "Pair a Phone…" menu item | In this run | GW |
| Settings shows "Pair from Agetor › Pair a Phone…" with no route (C1) | In this run | UI1 |
| Task-stream replay, resume and dedup extracted (no copy) | In this run | E1 |
| `GET /interactions/pending`, `maxBytes`, `GET /tasks/:id/events/:eventId` | In this run | E1 |
| Phone projection; tool results cut at 16 KB | In this run | PR |
| Subscriptions with a global allowlist; backpressure | In this run | SU |
| Notification decision in the core; webview `maybeNotifyOS` removed; presence route + Electrobun focus/blur (D5) | In this run | N1, N2 |
| `api.notifyOS` / `clearTaskNotification` (webview) orphaned | In this run (deleted) | N2 |
| `DELETE /notifications/:taskId` orphaned after D5 | In this run (deleted after a caller grep) | CT |
| `POST /notifications` (the CLI `notify` still uses it) | Kept | Still called by `src/cli/notify.ts` |
| Sealed pushes, presence rule, push registration, dead tokens on 410 | In this run | PU |
| Audit log: chain, attempt/result (C3), trim op (C2), viewer, CLI | In this run | DB, AU, CT, UI1, CLI |
| Controls: D19 routes; Settings section; CLI `devices`, `revoke`, `revoke-all`, `log` | In this run | CT, UI1, CLI |
| Wildcard bind allowed with a warning (D11): status, CLI, `core.log` | In this run | CT, CLI, GW |
| Mac name preference + Settings edit (D16) | In this run | SS, CT, UI1 |
| Previews 50 MB, any path, level-gated, chunked (D14, D15) | In this run | CT, RT, SS, LK |
| Terminal: protocol messages, attach gate, batching, detach rules, audit, banner + Detach (D17) | In this run | P4, TM, CT, UI2 |
| Remote-approval toasts ("Plan approved from …") | In this run | RT (event), UI2 (toast) |
| D19 rule text: `CLAUDE.md`, pairing-requirements rule 5, TT3(c) | In this run | CT |
| `security.md` (levels, device caller; then key helper, invariants, residual risks D18, invariant 5 amendment) | In this run | RP, DOCS |
| `always-on-host.md` (gateway follows the port owner) | In this run | GW |
| `core-responsiveness.md` (stream module, `maxBytes`, event by id) | In this run | E1 |
| `persistence.md` (094–096, triggers, trim) | In this run | DB |
| `notifications.md` (one decision, sinks, presence) | In this run | N2 |
| `run-panel.md` (banner) | In this run | UI2 |
| `testing-seams.md`, new `remote-gateway.md`, Topic map row, env-var list, `README.md` remote-access lines | In this run | DOCS |
| CLI inventory lists (`route-policy.test.ts`, `cli-scope-daemon.test.ts`) | In this run | CLI |
| Release-build CLI hides device subcommands | In this run | B1 (`build-cli` define), CLI |
| Hello replaces adding a protocol version to `/info` (Blueprint 3.5) | In this run (via the hello) | SS; `/info` unchanged by design |
| `launches-frozen` retry | No Mac work: the router passes status codes through | RT acceptance |
| First CI workflow; full `bun run check` as the required job | In this run | CI1, CI2 (A-2, owner) |
| Making `check` a required check in branch protection | Owner action | GitHub setting (CI2 workflow note) |
| Playwright in CI | Out of scope | C8 (owner): e2e stays local |
| Fixing the pre-existing failing unit tests on `main` (and any macOS-runner gaps the first CI run shows) | Owner-deferred | Owner, plan approval 2026-11-25 (A-2: "Full check required", whose option named a separate ticket). The required CI check stays red on exactly those tests until it lands; CI1 records the names |
| The phone's plan-editor UI | Out of scope | iOS app spec (D13) |
| Swift and Kotlin model generation from the schemas; app vectors in CI | Out of scope | App work (spec "Repository layout") |
| Hosted relay, push gateway, signed relay config, revoke cleaning up pushes (`DELETE /v1/register`), UnifiedPush | Out of scope | The relay spec (G1–G14) |
| App Attest challenge endpoint | Out of scope | Relay-side work under the relay spec |
| Closing push forgery (helper-signed pushes) | Out of scope | Accepted residual risk (D18, owner) |
| Keep-awake | Out of scope | Deferred by the owner (always-on host grill) |
| External security review (R16) | Out of scope for code; required before the first TestFlight build connects | Owner schedules it after PR F |
| Raising a device's level without re-pairing | Out of scope by design | D7 (owner): revoke and pair again |
| Fleet decision "phones get a per-task path check" (2026-11-24) superseded | Done | Grill step (decision 76298acb updated) |

## 10. Changes made during execution (not ratified by the owner)

- **Claude plan row 1 always needs the unlock window**, whatever the task's current mode (the plan said "plus unlock (D9)"; the first implementation read the live mode and the integration suite showed an ask-mode task skipped it although the row makes it autonomous): `Classified.alsoUnlock: "always"`.
- **Session ciphertexts never use the pacer's priority lane**; the pacer spaces frames evenly (one per 1000/45 ms) and caps 192 KB per second (the relay holds 256 KB the phone has not acknowledged, then drops). The plan only named 45 frames/s and 1.9 MB/10 s.
- **The router matches over every route and method** of `ROUTE_POLICY`, method-aware as `Bun.serve` is, then checks the winner's remote policy (the plan said the remote routes only).
- **`rekey` is an in-band control message** (`dir: "both"`); `RUN_EVENT.id` and `subagentId` are optional for live-only frames.
- **The gateway refreshes its trusted-device set every 5 s while the switch is on**, so a change made behind its back is noticed.
- **`agetor remote revoke-all` needs `--yes`**; `GET /remote-access/devices` answers 503 `helper-unavailable` when the key helper is missing.
- **Tests outside the plan's list were updated** for additive changes: three migration-list expectations, the `route-db-errors` policy fixtures (`remote: "none"` is now required), the remote CLI and background-routes status expectations, and one wording check in `e2e/background-settings.spec.ts`.

