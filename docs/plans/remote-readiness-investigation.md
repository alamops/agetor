# Investigation — Remote Readiness (pair a phone, Noise sessions, remote route levels)

| Field | Value |
| --- | --- |
| Date | 2026-11-25 |
| Change | Build the Mac side of the Agetor Companion: a signed key helper, native pairing, a signed device registry, Noise sessions over a relay link, remote levels in `ROUTE_POLICY` with an in-process router, signed decisions, audit log, push sealing, controls, the `packages/remote-protocol` package, a headless test client, a security suite and a CI gate. This brief informs the grill and the implementation plan for that spec. |
| Agents | none (this pipeline step forbids sub-agents); 1 inline codebase pass, 1 inline git-history pass, web checks, 4 inline spikes |
| Flags | none |

## 0. Contract

- **The spec lives outside the repo**: "Agetor Remote Readiness Spec", a Claude Docs document (https://claude.ai/artifact/VepsfQcg7WYRuy8brBf3LX, rev 40, dated 2026-11-24). The plan must check a copy into `docs/plans/` (for example `docs/plans/remote-readiness-spec.md`), because a reviewer can't hold code against a document the repo doesn't carry.
- It builds on two more documents, both outside the repo:
  - the **Agetor Companion Blueprint** (https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy, an HTML page; its §12 work-list ids are what the spec's "Blueprint" column cites);
  - the **Agetor Relay and Push Gateway Spec** (https://claude.ai/artifact/StLvx8goStUPYWH7hyzyd4), which defines the relay's side of the wire contract and runs only after this spec ships.
- The spec doc has no comments. The fleet knowledge base has the decisions behind it (native apps, hosted relay only, no folder limit on `/files/preview`, the iOS app spec at https://claude.ai/artifact/4u6KXXLd1AuEBakdao9Z6g).
- **Repo rules already in force:** `docs/plans/companion-pairing-requirements.md` (rules 1–5), `CLAUDE.md` § Security and process boundaries, `docs/architecture/security.md`.

## 1. What we know

### The route policy today

- `ROUTE_POLICY` has **213 route keys**, every entry `remote: "none"`. The type is literally `remote: "none"` (`src/bun/route-policy.ts:67`), and the test pins it (`src/bun/route-policy.test.ts:184-185`).
- `ApiCaller = "app" | "cli"` (`route-policy.ts:35`). `resolveCaller` reads only the `Authorization` header and, where `legacyQueryToken` is set, `?token=` (`route-policy.ts:526-538`).
- The caller is recorded in a **private `WeakMap<Request, ApiCaller>`** (`route-policy.ts:540-548`), and `authed()` in `server.ts:694-704` admits a request only when `callerOf(req) !== null`. That WeakMap is exactly the "private in-process mark" the spec's `device` caller needs.
- The CLI path gate runs only for `caller === "cli"` (`route-policy.ts:794`). A `device` caller must be added to that condition, because the spec says a device passes every check the CLI token passes.
- **Vocabulary test TT3(c)** (`route-policy.test.ts:454-504`):
  - It bans any path segment matching `/^(pair|pairing|device|devices|remote|remote-access)$/i`, except the allowlisted `/remote-access`.
  - It asserts the allowlist is exactly `{"/remote-access": ["GET","DELETE"]}`, and that no other key carries a `remote` segment.
  - The spec's four new routes (`GET /remote-access/devices`, `DELETE /remote-access/devices/:id`, `DELETE /remote-access/devices`, `GET /remote-access/log`) fail all three assertions today. The spec says the test changes on purpose ("Controls" section).
- **`CLAUDE.md` § Security and process boundaries** says verbatim: "Never add a pair or device route … the only remote-access routes are `GET`/`DELETE /remote-access`". Rule 5 of `companion-pairing-requirements.md` says "No HTTP route … lists-and-edits devices". The new device routes conflict with both texts, so both must be rewritten in the same change.

### Server and routes

- The routes object is built **inline** inside `Bun.serve({ routes: gateRoutesUntilReady(applyRoutePolicy({...})) })` (`server.ts:1896-1917`). The gateway can't reach the wrapped handlers unless that object is hoisted into a variable and passed to it.
- 32 handlers call `server.timeout(req, 0)`, and 157 read `req.params`.

### The v1 route set

Every route in the spec's v1 table exists, with these caveats:

- **Plan approval for Cursor and Copilot only.** `POST /tasks/:id/plans/:planId/approve` serves only those two harnesses (`planKindGuard`, `server.ts:920-929`).
- **Claude Code plans** are approved through the ExitPlanMode modal, which arrives as a `tmux_prompt` card and is answered with `POST /tmux-prompts/:id/answer` (`claude-tmux.ts:8289`). The plan is also recorded in `task.plans` from the `ExitPlanMode` tool_use (`orchestrator.ts:3357`, `task-plans.ts:202`).
- **OpenCode permission cards** use `POST /fx-permissions/:id/answer` (with `harness === "opencode"`). Their options are once, always and reject (`interactions.ts:1125-1127`).
- **OpenCode question cards** use `POST /ask-questions/:id/answer`.
- **Reject and skip can carry free text.**
  - An OpenCode Reject may carry a `message`, which the driver relays to the agent (`server.ts` `/fx-permissions` handler).
  - An OpenCode question Skip may carry a `message` (`server.ts:8139-8190`).
- **tmux cards have no option semantics.** A `tmux_prompt` choice is only `{ key, label }` (`interactions.ts:173-184`), so nothing marks an "always allow" or "don't ask again" row. fx and OpenCode options do carry ACP kinds (`allow_once | allow_always | reject_once | reject_always`, `interactions.ts:316`).
- **The gate route takes more than a decision.** `POST /tasks/:id/pipeline/review` takes `stepId`, `seq`, `decision`, `comment`, `nextStepIds` and `mode` (`server.ts:7171-7226`). A signed gate decision must cover all six fields, not just `decision` and `comment`.
- **Not in the v1 table but present:**
  - `PATCH /tasks/:id/plans/:planId` (edit a Cursor/Copilot plan before approving);
  - `POST /tasks/:id/fx-resume` (fx recovery);
  - `PUT/DELETE /tasks/:id/draft`;
  - `GET /tasks/:id/messages/history`;
  - `/runs/:id/events`;
  - `POST /tasks/:id/switch-account`.
- **No route fetches one event by id** (event routes: `server.ts:9193, 9367, 9462, 9639, 9843, 9918`). The spec's "tool results over 16 KB arrive cut, with a fetch-by-event-id for the full text" needs a new observe route that its v1 table does not list.
- **Reusable trimming exists.** `src/shared/tool-result-trim.ts` already does it for archived-history retention, with a 4 KB budget.

### Streams

- `/tasks/:id/events` and `/events` are SSE `ReadableStream`s built inside their handlers. The task route also holds the replay window, the buffer and the dedup-by-hash logic (`server.ts:9918-…`).
- The in-process broadcasters exist: `subscribe` (`orchestrator.ts:647`) and `subscribeGlobal` (`orchestrator.ts:944`).
- Reusing the task-stream replay and dedup for a phone means **extracting that logic** out of the handler.
- Byte budgets today: `EVENTS_REPLAY_MAX_BYTES` = 4 MB and `EVENTS_PAGE_MAX_BYTES` = 2 MB (`src/shared/types.ts:6287, 6296`). A `maxBytes` walk already exists in the db layer (`db-core/runs.ts:82, 564-667`).
- The global stream carries **10 kinds**: `column`, `files-sent`, `fx-auto-resume`, `harness-swap`, `interaction`, `pipeline`, `run-status`, `send-failed`, `tasks-changed`, `update` (`types.ts:6505+`). A phone subscription needs its own allowlist of these.

### Previews

- `/files/preview` is `app`-only, follows symlinks, and caps size at `MAX_FILE_PREVIEW_BYTES` = 50 MB (`src/shared/attachments.ts:152`, `server.ts:8012-8075`). The spec wants 10 MB for phones.

### Notifications

- **The core is not told about window focus today.** The spec says "the webview already reports focus", but that is not true. The webview only reads `document.hasFocus()` locally (`App.tsx:1246, 1265, 1598`) and decides OS notifications itself in `maybeNotifyOS` (`src/mainview/lib/toasts.ts:81-107`). The inputs it uses are `isSelected` (the open RunPanel or pipeline view), `isFocused` and the D7 focused-window rules (`FocusedForcedPosts`).
- `headlessNotificationFor` lives in `src/bun/headless-notifications.ts`. `NOTIFICATION_KINDS` (10 kinds) and urgency live in `src/shared/os-notification.ts`.
- **Electrobun 1.18.1 emits native window `focus`/`blur` events** on the Bun side (`node_modules/electrobun/dist/api/bun/events/windowEvents.ts:19-20`), so the app core can learn focus natively.

### Remote access switch, menu, CLI and Settings

- The switch is the SQLite pref `remoteAccess` (`background.ts:87-110`), and a probe resets it to off when the background host isn't running, parked or starting (`background.ts:224-240`).
- The menu has a single `Remote Access…` item (`app-menu.ts:40`).
- `agetor remote [status|off]` is in `src/cli/commands/remote.ts`. The Settings UI is in `src/mainview/components/settings/BackgroundSection.tsx`.

### Persistence

- The latest migration is `093_task_revs.sql`, so the next two are 094 and 095.
- Multi-statement writes are named ops in `src/bun/db-core/ops/`.

### Native helpers and signing

- Helpers are built by `scripts/build-*.ts` and checked by `scripts/verify-vendor-signing.ts` and `scripts/verify-release.ts`.
- Electrobun re-signs **every Mach-O under `Contents/MacOS`** with the app's entitlements. It never touches `Resources/app/bin`, where `AgetorNotifier.app` lives (`electrobun.config.ts:82-94`).
- So a key helper that needs its own `keychain-access-groups` entitlement and an embedded provisioning profile must be a nested `.app` under `Resources/app/bin`. It must not sit in `Contents/MacOS`, or the re-sign would strip its entitlements.

### Test seams

- `AGETOR_FAKE_LOGIN_ITEM` and `AGETOR_FAKE_REMOTE_ACCESS` are honoured by an env var **in any build** (`login-item-helper.ts:156`, `background.ts:68-78`).
- The harness seams use `NODE_ENV=test || AGETOR_E2E_HARNESS_SEAMS=1` (`harness-failover.ts:279`).
- **Nothing in the repo detects a "signed release build".** The closest is the channel read from `version.json` (`channel-defaults.ts`).

### Workspace, typecheck and CI

- The root `package.json` has **no `workspaces`**. `bunfig.toml` scopes `bun test` to `root = "src"`. `tsconfig.json` includes only `src`, `e2e` and the config files. `lint:async` globs only `src/bun`, `src/cli` and `src/shared`.
- So a new `packages/remote-protocol` is invisible to `bun run check` unless all four change.
- `.github/` holds only `FUNDING.yml`: **there is no CI today**.

### Dependencies and runtime

- **No `@noble/*` package is in the repo.** npm's current line is 2.4.0 for curves, ciphers and hashes. 2.x is ESM-only with `.js` subpath imports (`@noble/curves/ed25519.js` for x25519, `@noble/curves/nist.js` for p256).
- **noble has no HPKE.** On npm: `hpke` 1.1.10 with `@panva/hpke-noble` 1.1.9, and `@hpke/core` 1.10.1.
- Bun is 1.3.10 here; nothing pins it.

### Logs, history and the API host

- `core.log` already redacts registered secrets and token patterns (`src/bun/core-log.ts:22-98`). `daemon.log` is written by `src/bun/daemon-log.ts`.
- **Git history.** The spike branches `spike/spike-agetor-companion-app` and `spike/spike-app-for-remote-control` carry no commits beyond `main`. No reverted attempt touches this area. `57716956` limited `AGETOR_API_HOST` to safe binds, and a headless core can still bind `0.0.0.0`/`::`.

### Standards that apply

- `CLAUDE.md`: every route needs a `ROUTE_POLICY` entry; every spawn goes through `coreSpawn`; no-follow reads; production code imports `db-async.ts`; multi-statement writes are named ops; persisted events stay raw; `src/shared` stays import-free; text printed by the CLI goes through `terminal-text.ts`; the TaskCard and RunPanel rules apply if touched.
- `companion-pairing-requirements.md` rules 1–5.
- `docs/architecture/security.md`, `always-on-host.md` and `core-responsiveness.md` (no long synchronous loops on the main thread; that matters for Noise and HPKE work on the Bun thread).
- `persistence.md` (never edit an applied migration).
- Fleet convention: never commit real ticket ids or names in fixtures.

### Runtime and trust shape

- **One core owns port 4317**: the app, or the background (login-item) core, with a handoff between them (`app-takeover.ts`). The gateway must follow the port owner.
- **Two worker threads** (`db`, transcript); SQLite lives only in the worker.
- **Who can send input, and what each reaches:**
  - the webview (master token: every route);
  - the CLI or an agent (CLI token: `app+cli` routes, path-gated);
  - after this change, phones (`device`: the v1 set only, through Noise);
  - agents running as the user can also write SQLite, read `agetor-core.json`, run Agetor's signed binaries (the key helper included), and set env vars on any core they start.

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Can `@noble` implement the spec's exact Noise suites, with the responder's static DH injected (the key-helper design)? | **Yes** | `bun noise-spike.ts cacophony.txt` → `Noise_NK_25519_ChaChaPoly_SHA256 {"ctOk":true,"hhOk":true,"n":6}` and `Noise_NKpsk0_25519_ChaChaPoly_SHA256 {"ctOk":true,"hhOk":true,"n":6}`: every ciphertext and the handshake hash match | `@noble/*` 2.4.0, Bun 1.3.10 | `<scratchpad>/spikes/noble/noise-spike.ts` |
| Do the cacophony and snow vector files both cover these suites? | **Partly** | Cacophony has NK and NKpsk0 with `handshake_hash`. Snow (`main`) has `Noise_NK_25519_ChaChaPoly_SHA256` without `handshake_hash` and **no** `NKpsk0` for this suite (its NK variants: `NK`, `NK1`) | cacophony `master`, snow `main` (fetched 2026-11-25) | `<scratchpad>/dl/vectors/` |
| Does noble 2.x verify ordinary ES256 signatures (WebCrypto, CryptoKit, Keystore produce high-S about half the time)? | **No, not with defaults** | `bun es256-spike.ts` → `default opts 107/200, {lowS:false} 200/200` | `@noble/curves` 2.4.0 | `<scratchpad>/spikes/noble/es256-spike.ts` |
| Can `invokeRoute` dispatch through Bun's own router (`server.fetch`)? | **No** | `server.fetch(new Request(".../tasks/abc/thing"))` → `404 fallback`. `server.fetch` skips the `routes:` object, and `server.routes` is `undefined` | Bun 1.3.10 | `<scratchpad>/spikes/invoke-route/spike.ts` |
| Can a handler be called directly with a synthetic `Request` carrying `params` and a WeakMap caller mark? Does `server.timeout()` throw on it? | **Yes**; **does not throw** | `spike2.ts` → `200 {"id":"abc","mark":"device:d_1",…}`. `server.timeout(new Request("http://x/"), 0)` → no throw. `req.clone()` drops both `params` and the mark | Bun 1.3.10 | `<scratchpad>/spikes/invoke-route/spike2.ts` |
| While Claude Code's ExitPlanMode approval modal is open, is the plan in the JSONL (so the core can show and hash it)? | **Yes** (unlike AskUserQuestion) | Live: `claude --model haiku --permission-mode plan` in an isolated tmux. With the modal up, the JSONL has `assistant tool_use ExitPlanMode planlen=2054`. The pane showed only the tail ("↑ 17 more lines"). Options: `1. Yes, and use auto mode`, `2. Yes, manually approve edits`, `3. Tell Claude what to change` | Claude Code 2.1.332, Haiku 5.5 | spike torn down; its session dir and plan file were deleted |

## 3. What we're assuming

1. **K1 needs a profile-backed bundle.** The key helper must be a Developer ID–signed **`.app` bundle with an embedded Developer ID provisioning profile** granting `keychain-access-groups`. Two public reports say a bare binary carrying that entitlement is killed by AMFI unless a team profile grants it ([Sunrise #389](https://github.com/justin13888/Sunrise/issues/389), [M1K3 #518](https://github.com/Round-Tower/M1K3/pull/518)), and Secure Enclave keys need the data-protection keychain. **If wrong:** K1's main path is simpler (no profile), or impossible. This needs an App ID and a Developer ID profile from the owner's Apple account, and a release-script change to embed and verify the profile.
2. **K1's fallback may not exist on macOS 27.** A third-party report (M1K3 #518, Oct 2026) says that on **macOS 27** every keychain call goes to the data-protection keychain, so the login-keychain lane is gone there. This Mac runs macOS 26.6.2, so it is **unverified** here. **If true:** drop the fallback and require the profile route, then re-run K1 on macOS 27.
3. **The registry public key comes from the helper.** The registry public key and the revocation list are read from the key helper every time, never cached in SQLite or a file. **If wrong:** an agent could plant its own registry public key, and every security property of the registry falls.
4. **HPKE is hand-built on noble** (RFC 9180 base mode, one suite) and checked against RFC 9180's vectors, to keep "noble only" in the core. **If the owner prefers a dependency:** `hpke` plus `@panva/hpke-noble` exist.
5. **The router keeps its own matcher.** It takes the policy-wrapped routes object by reference and matches only the remote-enabled patterns (the 2nd spike shows `server.fetch` can't be used). **If wrong:** the matcher could disagree with Bun's precedence. Limiting it to the v1 patterns keeps that risk small.
6. **Phones get their own stream service.** Phone subscriptions reuse the task-stream replay, resume and dedup by extracting it from the `/tasks/:id/events` handler into a module both paths call. **If wrong** (a copy instead): the two paths drift, and an OpenCode in-place tool_use rewrite could be deduped differently on the phone.
7. **Audit entries are written after the handler and before the response** (with the result code). A crash between the action and the write leaves an unaudited action. **If the owner wants zero gaps:** use an "attempt" row before and a "result" row after.
8. **The cancels are dedicated routes.** "Stop" in the v1 set is `POST /runs/:id/cancel` and `POST /tasks/:id/pipeline/cancel`, while "reject or dismiss on any card" means each answer route's reject or skip variant.

## 4. What we must ask the owner

1. **Always-allow is not cleanly separable.** Claude's tmux cards include "Yes, and don't ask again"-style rows, and choices carry only `{ key, label }`. The spec says "any non-reject choice" on a tmux card is signed consent, and also that "Always allow" is never remote in v1. Options: (a) classify tmux choices by label and refuse the always-style ones (fragile across Claude versions); (b) allow every non-reject choice, signed (always-allow becomes remotely possible); (c) open only Enter-only and trust screens on tmux in v1. For fx and OpenCode the ACP `kind` makes refusal of `allow_always`/`always` straightforward.
2. **Claude plan approval can switch the mode.** "Yes, and use auto mode" switches the session to an autonomous mode, and the Blueprint treats a switch to an autonomous mode as a v2, signed "Operate" action. Should v1 allow that row from a phone (signed), or offer only "Yes, manually approve edits"? Is "Tell Claude what to change" content (unlock window when autonomous)?
3. **Rejects and skips with text are content.** An OpenCode Reject or Skip with a typed `message` reaches the agent as text, yet the spec classes reject and dismiss as "Remove" (session only). Treat a reject or skip *with* text as content (unlock window when the task runs without asking), or allow only the bare variants from the phone?
4. **Notification unification is large.** The core can't see `isSelected` (the open panel or pipeline view) or the D7 focused-window rules, and the spec's "the webview already reports focus" is false (§1). Options: (a) a new app-only route for the webview to report focus and the selected task, with the core taking over OS notifications; (b) the app keeps its OS decision while open, and the core uses the shared policy plus native focus/blur (Electrobun 1.18.1) only for the phone sink and the headless case. (a) matches the spec but risks desktop regressions against the `duplicated-macos-notifications` decisions.
5. **What does Settings' "Pair a phone" button call?** The webview reaches the core only over HTTP. A route that opens the window needs a name that passes TT3(c) (no `pair`/`device`/`remote` segment, no POST under `/remote-access`) and should be `app`-only, since an open window brings the relay link up. Or should Settings only point to the menu item?
6. **How is a "signed release build" detected for the two test seams?** Nothing detects one today; the existing seams are env-only in every build. Options: a build-time constant in the bundles, the `version.json` channel, or the helper's own signature. Is "an agent can start a core with the fake key helper" acceptable, given that its pairings won't verify under the real registry key (assumption 3)?
7. **Audit retention vs. append-only.** The spec has both "Triggers refuse UPDATE and DELETE" and "Retention: one year or 50,000 entries, trimming records the hash of the last dropped entry"; they collide. Should the trim drop and recreate the trigger inside its op, or should the trigger allow a delete gated by a control row?
8. **Two level vocabularies.** Device levels are `respond`, `watch`, `operate`, `full`; route levels are `observe`, `respond`, `operate`, `configure`. Pick one vocabulary, or fix the mapping (`watch`↔`observe`, `full`↔`configure`) and the order.
9. **A wildcard-bound headless core.** A headless core can bind `0.0.0.0`/`::` (`AGETOR_API_HOST`), while invariant 5 assumes 127.0.0.1. Should remote access, or the gateway, refuse to run on a core bound beyond loopback?
10. **Missing v1 routes.** Decide the route that fetches one event by id (needed for "tool results over 16 KB arrive cut"). Also decide whether `POST /tasks/:id/fx-resume` (an fx task paused in recovery waits for you) and `PATCH /tasks/:id/plans/:planId` (edit a plan before approving) belong in v1.
11. **Spec wording to correct.** "All three implementations must pass the cacophony and snow Noise vectors": snow has no NKpsk0 for this suite and no handshake hash (§2). OK to require cacophony for both suites plus snow's NK, plus our own vectors?
12. **K1 needs the owner's Apple account.** Creating an App ID for the key helper and a Developer ID provisioning profile, and embedding it in the release pipeline (`scripts/release.ts`, `verify-release.ts`, the `.signed-by` stamps), needs the owner's account. Confirm, and say whether K1 must also run on macOS 27 (assumption 2).
13. **Gateway on a background core with no app.** Pairing only starts from the app, but a background core runs the gateway and the key helper's DH with no app open. Confirm the helper is spawned through `coreSpawn` (disclaimed) from both cores, and that the background core never opens a pairing window.

## 5. Completeness inventory

### Callers and handlers the v1 set touches (`server.ts`)

| Line | Route |
| --- | --- |
| 6254 | `/tasks` (delta) |
| 7089 | `/tasks/:id/pipeline` |
| 7171 | `/tasks/:id/pipeline/review` |
| 7254 | `/tasks/:id/pipeline/cancel` |
| 7324 | `/tasks/:id/runs` |
| 7331 | `/tasks/:id/subagents` |
| 7539 | `/tasks/:id/git-status` |
| 7609 | `/runs/:id/cancel` |
| 8012 | `/files/preview` (model for the new per-task route) |
| 8139 | `/ask-questions/:id/answer` |
| 8403 | `/tmux-prompts/:id/answer` |
| ~8571 | `/fx-permissions/:id/answer` |
| 8638 | `/tasks/:id/interactions/pending` |
| 8661 | `/tasks/:id/backlog` (and `/:itemId`) |
| 8773 | `/tasks/:id/seen` |
| 8859 | `/tasks/:id/plans/:planId/approve` |
| 9161 | `/runs/:id/input` |
| 9462 | `/events` |
| 9555 | `/remote-access` |
| 9843 | `/tasks/:id/events/page` |
| 9918 | `/tasks/:id/events` |

Also `GET /tasks/:id`.

**Interaction sources:**

- `interactions.ts` (`ask_questions`, `tmux_prompt`, `fx_permission`; OpenCode permission and ask at lines 1110-1240);
- `task-plans.ts` (Claude, Cursor and Copilot plans);
- `pipeline.ts` `pendingHumanSteps` (gates).

### Entry points new code must be wired into

- `startApiServer` (`server.ts:1729`): hoist the wrapped routes and hand them to the gateway.
- `index.ts:306` and `headless.ts:313`: start and stop the gateway with port ownership.
- `app-takeover.ts` and the login-daemon handoff: reconnect the link after a handoff.
- `boot-gate.ts`: the router waits for boot like routes do.
- `app-menu.ts:40` and `index.ts`'s menu handler: add "Pair a Phone…".
- `remote-access-box.ts`: turn remote access on before pairing.
- `background.ts`: `setRemoteAccessOff` ends sessions; the C3 reset path.
- `route-policy.ts`: the `remote` type, `ApiCaller`, the walker, the startup checks.
- `migrations/index.ts`: 094 devices, 095 audit, plus a named op module under `db-core/ops/`.
- `src/cli/index.ts` and `commands/remote.ts`: `devices`, `revoke`, `revoke-all`, `log`.
- `api-client.ts` and `src/mainview/lib/api.ts`: new methods.
- `settings/BackgroundSection.tsx` or a new Remote access section.
- `headless-notifications.ts`, `task-notifier.ts`, `notification-hooks.ts`, `App.tsx`, `lib/toasts.ts`: the notification move.
- `electrobun.config.ts` `build.copy` and the `package.json` `build*` scripts: the key-helper vendor step.
- `scripts/verify-vendor-signing.ts` and `scripts/verify-release.ts`: assert the key helper, its entitlements and its profile.

### Propagation surface

- `src/shared/types.ts`: `RemoteAccessStatus`, the new device, audit and hello types, `GlobalEvent` (the phone allowlist).
- `RoutePolicy.remote` (the type and all 213 entries keep `"none"` except the v1 set).
- `route-policy.test.ts`: TT3(c), the CLI inventory list at :640, a pinned v1 remote set.
- `core-spawn-allowlist.test.ts` (the helper spawn).
- `claudemd-citations.test.ts` (doc cites).
- The JSON Schema and vectors under `packages/remote-protocol/vectors/`.
- Workspace plumbing for the new package: `bunfig.toml` test root (or a second test command), `tsconfig.json` include, `lint:async` globs, root `package.json` `workspaces`, `bun.lock`.
- `build-daemon-bundle.ts` and `build-cli.ts`, if `src/bun` imports the package.

### Existing data a migration would have to backfill

None: there are no devices or audit rows yet. The `remoteAccess` pref already exists.

### Docs, config and examples that describe current behaviour

- `CLAUDE.md` (security bullets: no device routes; only GET/DELETE `/remote-access`; the Topic map needs a new row);
- `docs/architecture/security.md:20-23`;
- `docs/architecture/always-on-host.md:30-39`;
- `docs/plans/companion-pairing-requirements.md` rule 5;
- `README.md:296, 320, 401, 407`;
- `docs/architecture/testing-seams.md` (new seams);
- a new `docs/architecture/remote-gateway.md`.

### What the change would orphan

`RoutePolicy.remote`'s literal `"none"` type, and the "every entry is none" assertion (`route-policy.test.ts:184-185`).

## 6. Runnability

- **Setup:** a fresh worktree needs `bun install`. Put `$HOME/.bun/bin`, `$HOME/.local/bin` and `/opt/homebrew/bin` on `PATH`.
- **Running the app:** `bun run dev:hmr` for UI work. `bun run dev` uses `~/.agetor-dev`, port 4318; never dogfood against `~/.agetor`.
- **Headless core:**
  ```sh
  AGETOR_DATA_DIR=<tmp> AGETOR_API_PORT=<port> AGETOR_API_TOKEN=<t> AGETOR_DAEMON_IDLE_MS=0 bun src/bun/headless.ts
  ```
- **Tests:**
  - `bun run check` (typecheck, `lint:async`, `bun test`);
  - one file: `bun test src/bun/route-policy.test.ts`;
  - `bun test` only sees `src/` (`bunfig.toml`).
- **E2E:** Playwright, 98 files in `e2e/`. Run `bun node_modules/@playwright/test/cli.js test`, one run at a time, with Node 24 first on `PATH` (Node 26 aborts under Vite). Fake drivers come from `AGETOR_<KIND>_DRIVER=fake`.
- **CI:** none today. The spec's R15 adds the first GitHub Actions job (`macos-15`).

## 7. Risks and blast radius

- **Security-critical surfaces are all new**: pairing, Noise, signed decisions, the key helper. The spec's R16 external review is the backstop.
- **Specific hazards:**
  - verifying ES256 without `lowS:false` refuses about half of valid phone signatures (§2);
  - a tmux choice misclassified as "once" grants always-allow;
  - a reject-with-text read as "remove" bypasses the unlock window;
  - a gate decision signed without `nextStepIds`/`mode` lets a changed body ride a valid signature.
- **Notification unification (R11, L) changes desktop behaviour** that a whole grill settled (`docs/plans/duplicated-macos-notifications-grill.md`). Keep its e2e specs green.
- **Extracting the task-stream replay** from `server.ts` touches the most-used route (forward resume #284, OpenCode in-place rewrites). Run its existing tests and e2e.
- **The release pipeline gains a provisioning profile.** A build that silently ships without it would make the helper fail at launch (AMFI) or fall back. Fail closed in `verify-release.ts`.
- **An on-Mac agent can act as the core to the phone.** It can read the link secret from SQLite, join a mailbox as `core` (replacing the real core: a DoS), and use the helper as a DH oracle to complete Noise as the core. The phone can't tell. The signatures it collects are bound to the fake session hash, so they are useless against the real core. This is accepted by the spec's threat model ("ask the key helper for a handshake"), but the plan should say so in `security.md`.
- **An agent can forge push text.** A push is HPKE base mode, so anyone with the device's `push_pub` and `send_key` (both in SQLite) can seal any title to the phone. Only notification text is at risk, since the lock screen offers no approvals. Accepted as residual unless the owner wants it closed.
- **Relay contract details the spec omits**, from the relay spec: clients ping every 30 s (the relay closes idle connections after 5 minutes), queues are 256 KB **or 64 frames**, and throughput is limited to 50 frames a second and 2 MB per 10 s. These constrain the core's streaming and the local test relay.
- **The iOS app spec proposes a hello addition** (a Mac name), which this spec's hello doesn't carry. Decide now if it should be in protocol v1.
