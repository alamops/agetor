# Remote relay contract and desktop work list (excerpts)

<!--
Excerpts the Remote Readiness build relies on, copied unamended from two documents
outside the repository (decision C7 in docs/plans/remote-readiness-grill.md):

1. "Agetor Relay and Push Gateway Spec", Claude Docs document
   https://claude.ai/artifact/StLvx8goStUPYWH7hyzyd4, revision 50, read 2026-11-25:
   the sections "Relay: mailboxes and the wire contract" and "Relay: queues and limits".
   The limits table is re-laid as a Markdown table; its cells are unchanged.
2. "Agetor Companion Blueprint", HTML page
   https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy (version 1795561380-a214), §12
   "Desktop work first": the work-list item ids the spec's "Blueprint" column cites.
   Extracted from the page's HTML with the tags stripped; wording unchanged.

The core-side contract in docs/specs/remote-readiness-spec.md ("Sessions and the
relay link") is the normative text for this change; the relay spec's sections below
are the server-side view of the same frames and limits.
-->

## 1. Relay: mailboxes and the wire contract (relay spec, rev 50)

A mailbox joins one Mac to one phone for one day. Each side presents the mailbox key to join; the relay forwards frames to the other side and holds them briefly while that side is away.

- **Keys and ids.** For each paired device and UTC date, both sides derive a 32-byte mailbox key from the device's link secret (pairing uses the pairing secret). The mailbox id is the first 16 bytes of the key's SHA-256. The relay computes the id from the key a client presents, keeps the key only in memory while that client is connected, and never writes it down.
- **Roles.** Each connection joins as `core` or `device`. One connection per role per mailbox: a newer one replaces the older, which gets `replaced` and is closed.
- **Frames.** `hello` (role plus the mailbox keys for today and yesterday, to cover midnight UTC), `welcome` (the joined ids and how many frames are queued), `send` (ciphertext for the other side), `deliver` (with a relay sequence number), `ack`, `peer` (the other side joined or left), `full` (the other side's queue is full, the frame was dropped), `ping` and `pong`.
- **Order and delivery.** Frames reach the other side in the order they were sent. Delivery is at least once: a frame not acknowledged before a disconnect is delivered again on reconnect.
- **Stale frames.** Every frame carries an 8-byte session tag outside the encryption. A receiver drops frames tagged with a session it has ended without trying to decrypt them, so a redelivered frame can never end a new session.
- **Format.** Binary WebSocket messages over TLS (`wss://`), one frame each, at most 66 KB (one Noise message plus the header). Unknown fields are ignored.

The Remote Readiness Spec carries this same contract (aligned on 24 Nov), so its vectors and local test relay already cover these frames when this phase starts. This spec adds only the server side.

## 2. Relay: queues and limits (relay spec, rev 50)

The queue exists so a phone's Stop or answer survives a Mac waking up; it is not storage. The values below are the starting points the load test (G13) tunes.

| Limit | Value | Why |
| --- | --- | --- |
| Frame size | 66 KB | One Noise message plus the header |
| Queue per mailbox side | 256 KB or 64 frames | A handshake and a few commands fit; a transcript does not, which is right: the core stops streaming when `peer` says the phone left |
| Queue lifetime | 10 minutes | Enough for a Mac to wake; queued approvals expire at 120 s anyway |
| Throughput per connection | 50 frames a second, 2 MB per 10 seconds | A live transcript fits; bulk transfer does not |
| Volume per mailbox | 1 GB a day | Caps misuse as a free tunnel |
| Connections per IP address | 64 open, 30 new a minute | A Mac with many phones fits behind one address |
| Failed `hello` per IP address | 20 a minute, then a 10-minute block | Slows key guessing, which 256-bit keys make hopeless anyway |
| Idle connection | Closed after 5 minutes without a frame; clients ping every 30 seconds | Frees memory held for dead clients |

- When a queue is full the relay answers `full` and drops the frame. It never evicts older frames, so commands already queued are kept.
- Queued frames are stored, not held in memory, so they survive the relay restarting or a hosting node being recycled.
- Expiry is exact: a frame is deleted at 10 minutes even if nobody connects again.

## 3. Blueprint §12, "Desktop work first" (item ids cited by the spec)

```text

§12Desktop work first
Everything in this section lives in the desktop codebase and can ship before any phone code exists. Most items improve the desktop app on their own, so the roadmap can start here without committing to the app's timeline. The items are grouped by area (tracks); the waves below give the order. Sizes are relative (S, M, L), not estimates.
Update, 24 Nov (v1.2.2): v1.1.0 shipped the master-token fix (#281): 1.1, 1.5, the policy table behind 2.1, 1.2 (the legacy stream token stays on purpose for older CLIs), part of 1.3, and 1.4 (previews stay unlimited on the desktop, by owner decision). v1.1.1 then shipped forward resume for task streams (3.1, #284) and the always-on host, with headless notifications and a preview remote-access switch (4.2, 5.1 to 5.3 and part of 6.5, #286). The board delta and push in v1.2.2 (#314) cover what 3.3 asked for. The owner deferred keep-awake (5.4). One item is new: 2.6, for the ways a task can wait for you that were added since v1.1.0. Rows sized "Done" need nothing more; everything else is still open.
Wave A · nowHarden and unblock
Small, independent, and useful today. Shipped from this wave: 1.1, 1.2, 1.4, 1.5, 3.1, 4.2 and 5.2; 5.4 is deferred. What remains:
1.3 · 2.4 · 2.6 · 3.2 · 3.5 · 7.1 · 7.6
Wave B · backbonePolicy, streams, notifications
The structural changes both v1 and v2 stand on. 2.1 only adds remote levels to the existing table, and the board delta already covers 3.3. Nothing here has started.
2.1 · 2.2 · 2.3 · 2.5 · 3.4 · 4.1 · 4.3 · 7.2 · 7.3
Wave C · identityReady to pair
The host half shipped in v1.1.1 (5.1, 5.3). Identity remains. After it, Phase 0 only adds the remote gateway itself: Noise sessions, the relay link and the push dispatcher.
6.1 · 6.2 · 6.3 · 6.4 · 6.5 · 7.4 · 7.5 · 7.7
Track 1 · Harden what exists
Closes paths an agent can use today to act as Agetor.app.
#ChangeWhereWhy the app needs itSize
| 1.1 | Split the master token. Done. The master token lives in memory and reaches only the webview; `AGETOR_API_TOKEN` is deleted from the environment as it is read, so no child process inherits it. The CLI token in `agetor-core.json` is refused on desktop-only routes (403 `desktop-only`).Shipped in v1.1.0
| `api-config.ts`, `route-policy.ts`, `core-creds.ts` | Pairing, device levels and the registry stay out of reach of anything an agent can read. | Done
| 1.2 | Tokens out of URLs. Done. The webview authenticates SSE with headers (`sse-fetch.ts`) and loads images as authenticated blobs (`authed-blob.ts`). Terminal WebSockets use a single-use ticket from `POST /terminals/:id/ws-ticket`, and since v1.1.0 the CLI sends a header too. Three streams (`/events`, `/app/events`, `/tasks/:id/events`) still accept `?token=` with the CLI token, on purpose (grill D13). CLIs installed with `install.sh` before v1.1.0 (v0.0.17 to v1.0.3) put the token in the stream URL, and nothing updates a separately installed CLI. Without it their `agetor logs`, clone progress and TUI would get 401 while every other command kept working. Keeping it costs little: the CLI token is readable from `agetor-core.json` anyway, the master token is never accepted in a URL, and the phone never uses these URLs. Remove it once old CLIs are gone; a `core.log` line on the first legacy use per launch would show when that is.Shipped in v1.1.0Legacy stream token kept on purpose
| `route-policy.ts` (`legacyQueryToken`), `cli/sse.ts` | The remote path carries no reusable secret, and the same request code serves both. | Done
| 1.3 | Validate preferences. Partly done. A stored "disclaim off" is now only a request: the app confirms it in a native dialog at launch, and the headless core ignores it. Since then, `remoteAccess` refuses "on" for every caller and the retention key is validated, but most keys behind `PUT /preferences/:key` are still unvalidated and reachable with the CLI token.Shipped in v1.1.0Remaining: a schema per key
| `disclaim-switch.ts`, preferences route in `server.ts` | A phone at Full control must not be able to weaken Agetor's own safeguards. | S
| 1.4 | Gate file routes. Done for the desktop. `/files/preview` and `/tasks/:id/diff/blob` are desktop-only, and CLI routes that take a path check it first through an isolated probe, so the core never opens a protected folder on an agent's behalf. The webview keeps previewing any absolute path on purpose: attachments, screenshots and sent files often live outside the project (owner decision, 24 Nov). The phone gets no folder limit either. Its policy entry (2.1) lets it preview a path only when one of its tasks already points at it.Shipped in v1.1.0No folder limit (owner decision)
| `server.ts`, `caller-fs.ts`, `core-file-read.ts` | The phone shows images and sent files through these routes. | Done
| 1.5 | Disclaim every process the core starts. Done. Every spawn goes through `coreSpawn`, which runs it as responsible for itself, including terminal tabs, git (whose `core.fsmonitor` an agent could plant) and harness probes. A test fails on any raw spawn, and the master token is scrubbed from child environments.Shipped in v1.1.0
| `core-spawn.ts`, `disclaim.ts`, `core-spawn-allowlist.test.ts` | Removes confused-deputy paths before any remote surface exists. | Done
Track 2 · Make every route policy-aware
The backbone of the remote router for v1 and v2.
#ChangeWhereWhy the app needs itSize
| 2.1 | Per-route policy entries. The table exists: `ROUTE_POLICY` classifies all 213 route paths by caller (`app`, `app+cli`, `public`), with a `remote` field set to `none` everywhere. The core refuses to start with an unclassified route, CLI routes that take paths must declare them, and a test rejects routes named like pairing or devices. Remaining: add a remote level, step-up rule, rate class and opening release to each entry. File routes also get a per-task path check for remote callers (1.4).Foundation shipped in v1.1.0
| `route-policy.ts`, `route-policy.test.ts` | This table is the remote router's whole security model. | M
| 2.2 | Caller identity in handlers. Requests already resolve to a caller (`app` or `cli`) in `resolveCaller`. Add device principals and pass the principal into handlers. | `route-policy.ts`, `server.ts`, orchestrator entry points | Audit entries, "Plan approved from iPhone" toasts, per-device rate limits. | M
| 2.3 | Invoke routes in-process. `invokeRoute(method, path, body, principal)` runs a handler without going through the HTTP listener. | New `remote-router.ts` | How the phone reaches every feature without a second API. | M
| 2.4 | Idempotency keys. Accept an `Idempotency-Key` on sends, answers, approvals, starts and creates, and replay the stored result for 10 minutes. Today only pipeline review-gate decisions have one.Helps desktop now
| `server.ts`, `orchestrator.ts` | The relay may redeliver after a reconnect; a follow-up must never be sent twice. | M
| 2.5 | Signable decisions. Interactions and plans expose a content hash. Approve routes issue a 120 s challenge and verify a device signature when the caller is remote. | `interactions.ts`, `task-plans.ts`, the plan-approve route | Face ID approvals bound to exactly what the phone displayed. | M
| 2.6 | Classify the answers added since v1.1.0. Pipeline review gates (`POST /tasks/:id/pipeline/review`, accept or return with an optional comment, v1.2.0) and Claude Code's new card answers (`answerKind` `enter` and `code`, v1.2.2). Gates and trust screens become signable decisions (2.5); a gate decision already has an idempotency key (the run's `startedAt` plus the gate's `seq`). Login codes stay Mac only.New
| `route-policy.ts`, `interactions.ts`, `pipeline-runner.ts` | v1 promises to unblock everything, and these are new ways a task waits for you. | S
Track 3 · Streams and data
What the phone needs to catch up quickly over a relay.
#ChangeWhereWhy the app needs itSize
| 3.1 | Forward cursors. Done. Every saved event frame on `/tasks/:id/events` carries its `run_events.id` as the SSE `id:`. The route resumes from `Last-Event-ID` or `?afterId=`, and answers `snapshotRequired` with a fresh window when the gap exceeds 800 events or 4 MB.Shipped in v1.1.1 (#284)
| `server.ts`, `event-resume.ts` | Catch-up every time the app comes to the foreground. | Done
| 3.2 | One "needs you" query. `GET /interactions/pending` across all tasks (pipeline steps folded into their parents), plus blocked and review tasks. Today it exists only per task. Since v1.2.2 the board delta carries each task's pending-card count, so the phone knows which tasks to ask, but reading the cards still takes one request per task.Helps desktop now
| `interactions.ts`, `server.ts` | The inbox in one request instead of one per task. | S
| 3.3 | Recoverable board state. Done, differently than planned. The global stream is still live-only, but the board is recoverable: `GET /tasks?delta=1&since=<cursor>` returns changed rows, removed ids and in-memory decorations (pending cards, open terminals, stalls), or a snapshot for a stale cursor. A throttled `tasks-changed` event on `/events` says when to ask. The phone fetches a delta on reconnect instead of replaying events.Shipped in v1.2.2 (#314)
| `task-delta-route.ts`, `task-change-push.ts`, `src/shared/task-delta.ts` | A phone that reconnects learns what changed while it was asleep. | Done
| 3.4 | Mobile-sized payloads. Replays are capped at 4 MB today (2 MB per page). Add a `maxBytes` option (around 256 KB for a first load) and truncated tool results with a "load full" fetch. | `db.ts`, events routes | A fast first screen over mobile data. | S
| 3.5 | Protocol version. `/info` returns only `{version}`. Add `protocolVersion`, `minClientProtocol` and feature flags, plus contract tests that shared types only change additively. | `server.ts`, `src/shared/types.ts` | The app and the Mac update independently, so mixed versions are normal. | S
Track 4 · Notifications
One set of rules for the Mac and the phone.
#ChangeWhereWhy the app needs itSize
| 4.1 | A notification router in the core. There are now two decisions: the headless core's `headlessNotificationFor` (v1.1.1) and the webview's `maybeNotifyOS` while the app is open. Make the core's decision the only one, with sinks (macOS, phone) and the same removal triggers. | `headless-notifications.ts`, `task-notifier.ts`, `notification-hooks.ts`, `App.tsx` | Phone pushes follow the same one-per-task rules, and work while the window is closed. | L
| 4.2 | Run it in the headless core. Done. A headless core on macOS posts the one-per-task notifications through the notifier helper, installs the removal hooks itself, and raises "Pipeline needs you" the way the app does.Shipped in v1.1.1 (#286)
| `headless-notifications.ts` | The daemon is the host whenever the app is closed. | Done
| 4.3 | Presence. Tell the core whether you are at the Mac: window focus from the webview, plus idle time from a small native helper.Helps desktop now
| Webview, `native/` | No phone pushes while you are at the desk. | M
Track 5 · Always-on host
The phone is only useful if a core is running.
#ChangeWhereWhy the app needs itSize
| 5.1 | Start at login. Done. An `SMAppService` LaunchAgent runs the Swift helper `agetor-login-item` from `Contents/MacOS`, which runs a supervisor that parks while the app owns the port. `verify-release.ts` checks the helper and the plists.Shipped in v1.1.1 (#286)
| `native/login-item/`, `login-daemon.ts`, `background.ts` | Otherwise there is nothing to reach after a reboot. | Done
| 5.2 | No idle exit. Done, and broader than asked: a core started by the login item never idles out, whether or not remote access is on. Remote access needs the background switch, and turning the background off turns remote access off.Shipped in v1.1.1 (#286)
| `headless.ts` (`resolveIdleTimeoutMs`) | A backgrounded phone drops its stream, and the core must stay up. | Done
| 5.3 | Hand back to the daemon. Done. When the app quits, the supervisor starts a core within about a second. When the app opens, it asks that core to hand off, and new launches wait until the switch completes.Shipped in v1.1.1 (#286)
| `app-takeover.ts`, `login-daemon-machine.ts`, `quit-launch-gate.ts` | The Mac stays reachable across app restarts. | Done
| 5.4 | Keep awake while agents run. Optional, using `caffeinate -i -w <pid>` or a power assertion, released when the last run settles. The owner deferred it in the always-on host decisions.Deferred
| `orchestrator.ts`, preferences | Fewer "Mac asleep" dead ends. | S
Track 6 · Identity, devices and audit
Built and tested on the Mac before any phone pairs.
#ChangeWhereWhy the app needs itSize
| 6.1 | Core identity keys. X25519 for sessions and Ed25519 for the audit chain, kept in the Keychain (a 0600 file on headless Linux). The Keychain protects them from other apps and from backups, not from agents, which can run Agetor's own signed binary. The access list must admit both the app and the login item's helper, since either may own the port. | New `remote-identity.ts`, `native/` | The key the phone pins when it scans the QR code. | M
| 6.2 | A device registry that needs you present. A migration for devices (keys, level, status, last seen). Adding a device or raising its level is signed by a Secure Enclave key on the Mac that needs Touch ID or the login password for each use, and every phone already paired is told. A Keychain-keyed MAC is not enough, because an agent can run Agetor's own signed binary and pass the Keychain check. | `migrations/`, `db.ts`, `native/` | Stops an agent from quietly adding its own device by editing the database. | M
| 6.3 | Audit log. An append-only, hash-chained table (UPDATE and DELETE triggers raise) with a viewer in Settings.Helps desktop now
| `migrations/`, `db.ts`, Settings | A record of every remote action and signed approval. | M
| 6.4 | Native pairing window. Electrobun 1.18.1 has no text-input dialog, and the webview renders agent-written content. Use a Swift helper window, or a separate window that renders no agent text, for the QR code and the typed confirmation code. The Remote Access… box added in v1.1.1 is a button-only message box: enough to turn the switch on, not to type a code. | `native/`, `index.ts` | The only place a device can ever be added. | M
| 6.5 | Remote access settings and CLI. Partly done. The preview switch exists: off by default, on only from Agetor › Remote Access… (which also turns the background host on), off from Settings, `DELETE /remote-access` or `agetor remote off`, and `agetor remote status` reads it. Remaining: Settings lists devices and the audit log and offers revoke and the relay URL; pairing and raising a level open the native window (6.4); the CLI gains `devices|revoke|log`. The gateway opens the relay link only while the switch is on and a device is in the signed registry or a pairing window is open, because an agent can write the switch's database row.Switch shipped in v1.1.1Remaining: devices, revoke, log
| Settings, `src/cli/commands/` | Control and a kill switch from the Mac and over SSH. | M
Track 7 · Shared code and test seams
So the app reuses Agetor's types and rules instead of copying them.
#ChangeWhereWhy the app needs itSize
| 7.1 | Workspace packages. Bun workspaces with `packages/shared` (today's `src/shared`, which has no `node:` imports outside tests, so Metro can bundle it), `remote-protocol` and `noise`. | Repo root, `tsconfig.json`, `vite.config.ts` | The app imports the same types and parsers as the desktop. | M
| 7.2 | Move pure logic out of the webview. The board delta merge (`applyTaskDelta`) already lives in `src/shared` and serves the webview and the TUI. Event dedup, pipeline attention, path shortening, message history and the markdown-image classifier still live in `src/mainview/lib`. | `src/mainview/lib` → shared | The same rendering rules on both screens. | M
| 7.3 | Transport-agnostic API client. Lift request and response types from `mainview/lib/api.ts` and `cli/api-client.ts` into one typed client with a pluggable transport: fetch locally, the Noise session remotely. | New package | The phone and the desktop call routes the same way. | M
| 7.4 | Demo core. `agetor daemon --demo`: fake drivers plus seeded projects, tasks and a pipeline. | `headless.ts`, the fake drivers | App Review, store screenshots and e2e tests. | S
| 7.5 | Remote test client. A headless client that pairs through a local relay and drives the blocked-agent loop. | `e2e/`, new package | Proves Phase 0 end to end without a phone. | M
| 7.6 | CI on every pull request. GitHub Actions running typecheck, a stable subset of unit tests, the route-policy coverage test and the protocol vectors, with e2e nightly on a macOS runner. There is no CI today (§13). The gate exists locally: `bun run check` runs typecheck, the async lint and the unit suite, and since v1.2.2 each test run gets its own temp root (#307), so the suite can run on a shared runner. What it still needs is listed in §13.Helps desktop now
| `.github/workflows/` | The app and the Mac ship separately, so the contract between them needs a gate. | M
| 7.7 | Publish the canary channel. `build:canary` exists, and since v1.1.1 a canary app uses its own data dir, port and launchd label, but nothing publishes it. Ship pre-release cores to users who opt in. | `scripts/release.ts`, `scripts/upload-release.ts` | Every TestFlight build needs a matching pre-release core to pair with. | S
```
