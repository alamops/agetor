# Remote gateway (the Mac side of the Agetor Companion)

The Companion is a phone app that watches and steers the tasks on this Mac. The Mac side lives in `src/bun/remote/` and the shared protocol in `packages/remote-protocol/`. The contract documents are `docs/specs/remote-readiness-spec.md` (as amended by the grill) and the plan `docs/plans/remote-readiness.md`; this file is the subsystem reference. The security argument (keys, trust, invariants, residual risks) is [security.md § The Companion](security.md#the-companion-keys-trust-and-the-fourteen-invariants).

**It ships dark.** A release build compiles the Companion in but never starts it: `COMPANION_ENABLED` is false unless the build sets `AGETOR_COMPANION_BUILD=1`, the relay and push gateway addresses are null in this change, and no test seam survives in a release bundle. See [Ship dark](#ship-dark).

## The shape

```
phone ──Noise over a relay (ciphertext only)── RelayLink ── SessionManager ── session ops ──┬─ router ── the served API handlers (in process)
                                                                                            ├─ subscriptions (task stream, board events)
                                                                                            ├─ signed decisions, unlock window
                                                                                            ├─ push registration, revoke-self
                                                                                            └─ terminal (a tmux client)
key helper (Swift app) ── core key + Secure Enclave registry key + the native pairing window
```

`startRemoteGateway({mode})` (`gateway.ts`) composes it in whichever core serves the API: `app` (the desktop app's core), `background` (the login-item core) or `headless` (a CLI daemon). It runs right after `markBootReady()` and stops in the quit sequence or `shutdown()`. With the Companion compiled out it is a no-op that logs once and never touches the key helper. Only the `app` mode can pair.

## Modules and their single enforcement points

| Module | Owns | Invariant |
|---|---|---|
| `link-gate.ts` | the link is up only with the remote switch ON and (a trusted device OR the pairing window open) | 1 |
| `registry.ts` | trust: a row counts only with a valid registry-key signature, not in the helper's revoked list, status `active`; never cached. A revoke ends the sessions and posts its notice once either write (the helper's list or the row) lands; when both fail nothing is ended or announced and both errors are reported. The gateway's passes over the trusted set (the poll, a pairing, the link gate) run one at a time, so a stale pass never closes a just-paired phone | 2, 3 |
| `session.ts`, `session-dispatch.ts` | Noise NK per device mailbox, channel binding, framing, rekey, lifetimes, op dispatch | 4, 13, 14 |
| `route-policy.ts` (`markDeviceRequest`, `wrapHandler` device branch) | a device caller exists only from the private mark; level ceiling; deny by default | 6, 7 |
| `router.ts`, `route-classes.ts` | the ten steps, below; the class rules | 6, 8, 12 |
| `decisions.ts`, `content-hash.ts`, `autonomy.ts` | challenges, the five ordered checks, the unlock window, the exact bytes a phone signs | 8 |
| `rate-limit.ts` | per-device buckets; `stop` class is never limited | 9 |
| `idempotency.ts` | stored results of every non-GET (SQLite, migration 096) | |
| `audit.ts`, `audit-retention.ts` | the hash-chained log, attempt before handler | 12 |
| `subscriptions.ts`, `projection.ts` | task and board streams to a phone, projected forms, 4 MB backpressure | |
| `push.ts` | sealed pushes through the notification policy | |
| `terminal.ts` | a phone-attached tmux client (configure + signed) | |
| `pairing.ts` | the pairing window's core half | 2 |
| `relay-link.ts`, `relay-pacer.ts`, `relay-config.ts` | one WebSocket per mailbox group, pacing, the (null) addresses | |
| `key-helper-api.ts`, `key-helper.ts`, `key-helper-fake.ts` | the helper client, the fake under a seam | 10 |
| `remote-status.ts` | what the HTTP control routes answer | |

## The session lifecycle

1. **Mailboxes.** For each trusted device the core joins today's and yesterday's mailbox (UTC date) derived from the device's link secret, as role `core`, one WebSocket per device group. At the UTC date change it reconnects with fresh keys. A second core taking a mailbox (a handoff) ends the first link's group (`replaced`) and it stays down.
2. **Handshake.** The phone's first frame carries a session tag the core has not seen: an NK handshake message. The core accepts it only for a device that is trusted right now (an untrusted id gets no answer and costs no Diffie-Hellman), through the 6 a minute handshake bucket, with one `dh` call to the key helper. The prologue is `agetor-remote/1` ‖ the core id: another version or another core fails.
3. **Binding.** The phone must send `binding {deviceId, sig}` within 10 s: an ES256 signature by the device's session key over the handshake hash. The core re-checks trust, then audits `session-open` and sends `hello` (protocol version, level, the routes this level may call, the audit head, the clock, the Mac's name).
4. **Transport.** Every message is chunked (40 KB raw), padded to a size bucket and encrypted; a frame is size-checked before decryption. **Any** decryption failure, nonce gap, bad envelope or oversize frame ends the session. A frame tagged with an ended session is dropped without decrypting. A relay frame the session already took (same mailbox and `seq`, redelivered after a reconnect) is dropped before it reaches the cipher, so it is never read as a replay; that includes the handshake frame that opened the session, and the pairing window keeps the same record for its own frames. Decrypting is one ordered chain per device, but the ops it yields run on their own (up to 64 in flight, then `busy`, except removals; see below): a slow op never holds a Stop, terminal input or the relay ack behind it. The terminal ops (attach, input, resize, detach: `ORDERED_SESSION_OPS` in `session-dispatch.ts`) are the exception to "on their own": one session runs them one at a time in arrival order, so a Detach sent behind an Attach that is still awaiting its lookup or signature finds the terminal and ends it. A listener added with `channel.onClose` to a session that already ended is told at once, so an attach that finishes after its session closed never starts its tmux client. An op already decrypted when its session ends does not act: the session re-checks it is active before a handler runs (and before each queued terminal op), and the router re-checks before it records the attempt and again before it calls the handler (`410 session-ended`, the attempt's result row says so). Removals are never refused `busy`: a terminal detach, an unsubscribe and a request to a `stop`-rate route get 32 slots past the cap (`REMOVAL_HEADROOM_OPS`). The ciphertexts of one session are ONE strictly ordered stream (the nonce counts them), so nothing in a session may overtake anything else: the pacer's priority lane is for relay control frames and the handshake reply only.
5. **Rekey** every 10 minutes or 2^20 messages (an in-band `rekey` message under the old key, then both sides rekey). **Ends** after 15 idle minutes or 12 hours, on revoke, on Remote access off, on a newer handshake from the same device (`replaced`).
6. **Sending** is one ordered pump per session: a message is encoded, sealed lazily (`sealStream`) and handed to the pacer, yielding between chunks and waiting while the pacer's queue is deep, so a big preview never freezes the core and a slow phone never grows memory.

## The router (ten steps, in this order, for every call)

The router (`router.invoke`) turns one `request` message into a call of the SAME served handler the webview and the CLI use, in process (`route-table.ts` holds the walker-wrapped, boot-gated routes `Bun.serve` got). No loopback fetch, no token.

1. **match** the path against every route and method of `ROUTE_POLICY` (`everyRoute()`), with the router's own matcher: among the patterns that serve the method, the one that is static at the first position where candidates differ. `router-precedence.test.ts` runs it and a real `Bun.serve` over 1,000+ path and method pairs and requires the same answer. Odd paths (dot segments, encodings, empty segments) are refused before matching.
2. refuse the SSE routes (`use-subscription`); a route with no remote policy is `403 not-remote`; below the route's level `403 level`. (Both are answered after the rate step below takes its token.)
3. **rate**, taken as soon as the route is known so a call refused for `not-remote` or `level` is limited too: normal 30 a second, heavy 2 a second (previews, history, git status), `stop` never. A call the route's rate refuses is still answered when it classifies as a removal (a bare reject, a bare skip, a draft delete), because removing authority or work is never rate-limited.
4. **classify** (`route-classes.ts`): the base policy raised by the class rules; `never` → `403 not-remote-v1` ("answer this on your Mac"); a card that is gone → `404 gone`.
5. **idempotency**: every non-GET needs a 128-bit `idem` key (`400 idem-required`); a repeat inside 10 minutes answers the stored result (audited `replayed`); the same key with another request is `409 idem-mismatch`.
6. **step-up**: `none`; `unlock` (the signed unlock window, needed only while the task runs without asking, fail closed for an unknown harness or mode); `signed` (a decision over the exact content, five ordered checks); some calls need both.
7. **audit attempt** for every call that changes anything (route, a body HASH, the signature): written BEFORE the handler runs; if it cannot be written the handler does not run (`audit-failed`).
8. **handler**: `markDeviceRequest`, then the served handler (its device branch re-checks the level and the path gate).
9. **audit result**, naming the attempt. An attempt with no result reads **outcome unknown** (the core died between).
10. **store** the result; a consent success raises `remote_action` on the app event stream (a toast) and an OS notification.

### The class rules (`route-classes.ts`)

| Call | Class | Needs |
|---|---|---|
| reads (`GET /tasks`, `/tasks/:id`, runs, events page, event by id, pending interactions, pipeline, subagents, git status, messages history) | read | session |
| `GET /tasks/:id/files/preview` | read | inside the task's folders (workdir, worktrees, sent files): the route's level (observe); anywhere else: operate (D15) |
| cancel a run or pipeline, mark seen, delete a backlog item | remove | session; never rate-limited |
| follow-up into a run, backlog writes, an ask-question answer | content | the unlock window while the task runs without asking; a bare Skip is `remove` |
| `PATCH` a plan | content | signed over the EDITED body, plus the unlock window while autonomous |
| approve a plan, resume an fx recovery | consent | signed over the plan or the recovery |
| a tmux card answer | by row (below) | |
| an fx or OpenCode permission | `allow_once` / `once` → consent; `allow_always` / `always` → never; a bare reject → remove; a reject with text → content; `cancel` → never | |
| review a gate | consent | signed over the gate (handoffs, step, seq, next steps, mode); the body must repeat the signed decision and comment; a phone-chosen next-step subset or a resume mode is not a v1 option |
| switch account | action | operate, no step-up |

**tmux rows (`src/shared/tmux-choice-class.ts`, fail closed).** Only exact known labels are `once` (signed consent over the card) or `reject` (a removal); an always-style row ("don't ask again", "allow all", "during this session") is `always` and an unmatched row is `unknown`: both are never answered from a phone. The OAuth-code card (`answerKind: "code"`) is never answered from a phone. Claude's plan modal: row 1 (auto mode) needs **operate**, a signature over the plan and the unlock window whatever the task's mode is now (it makes the task autonomous); row 2 (manual approval) is a signed consent at respond; row 3 is content. A plan approval (`POST /tasks/:id/plans/:planId/approve`) of a Plan-mode task that is not bound to an agent profile switches the task to Auto (force) before it sends the approval, so it is classified like row 1: operate, signed, and behind the unlock window (`planApprovalFlipsToAuto`, one predicate in `src/shared/plan-approval.ts`, used by the approve route and by the router's live lookup, so they cannot drift).

## Signed decisions and the unlock window

A phone asks for a **challenge** for a target; the core builds the exact bytes to show (canonical JSON), their SHA-256 and a 120 s single-use challenge bound to this session and this target. The decision is an ES256 signature, by the device's approve key, over `{deviceId, sessionHash, challenge, route, target, contentHash, decision, comment, ts}`. `verifyDecision` runs five checks in order and stops at the first failure: **challenge** (issued to this session for this target, under 120 s, unused; consumed now), **session** (the signed hash is this session's handshake hash), **signature**, **content** (what the target holds now hashes to what was signed: a plan revised, a card answered on the Mac, a gate whose next steps changed all fail here), **decision** (one this target accepts). The router also requires the signed `route` to equal the call. The **unlock window** is one signature over `{kind: "unlock", sessionHash, expiresAt}`, at most 10 minutes ahead, ended with the session. `autonomy.ts` says which (harness, mode) pairs run without asking; an unknown pair counts as running without asking.

## Idempotency

`remote_idempotency` (migration 096) holds `(device, key) → request hash, status, content type, response up to 64 KB` for 10 minutes; a larger response stores its status only. Two concurrent calls with one key: the second waits and answers from the first. A step-up refusal or a handler that threw releases the key so the retry can run. A repeat after a core restart answers the stored result.

## Subscriptions and backpressure

`subscribe-task {sub, taskId, afterId, maxBytes}` opens the shared task stream (`task-event-stream.ts`, the same module as `GET /tasks/:id/events`) with the first-load budget (256 KB) or the phone's cursor; each event goes out with its projection (`projection.ts`: user messages without control tags, handoff blocks, TODO tracker, sent files) and a tool result over 16 KB arrives cut with `truncated {eventId, fullBytes}`, fetched whole by `GET /tasks/:id/events/:eventId`. `subscribe-global` forwards the allowlisted global events (`GLOBAL_EVENT_FORWARD`: column, interaction, pipeline, run-status, tasks-changed, files-sent, send-failed, harness-swap, fx-auto-resume). Past 4 MB queued for a phone the subscription is dropped and the phone is told `snapshot-required`; while the phone is away (relay `peer` false) the streams are released and resume from the last event id on return. The board's delta read is `GET /tasks?delta=1&since=<cursor>`.

## Push

`push.ts` is a sink of the one notification policy (`notification-policy.ts`), registered next to the OS sink. It pushes only needs-you kinds, only while nobody is at the Mac (focus within the last two minutes counts as at the Mac; a core with no app is always away), and only SEALED bodies: HPKE to the device's push key, padded to one size (`SEALED_PUSH_BYTES`), authenticated to the gateway by an HMAC under a per-device send key. The collapse id is derived per task from the link secret, so it is stable and reveals nothing. A `410` marks the device's push dead. The gateway address is null in this change.

## The phone terminal

`terminal.ts`: a **configure** device with a **signed attach** (bound to the task and its tmux session name) attaches as one more tmux CLIENT to the task's own session (a tmux-hosted per-task kind: claude-code, codex, gemini, antigravity, copilot or the OpenCode 1.x `run` driver, resolved from the task's harness id to its kind; the session must be alive on agetor's socket, so the ACP harnesses and the OpenCode 2.x server answer `no-terminal`). Output is coalesced every 50 ms into at most 16 KB chunks; the phone's input is never logged or audited. It detaches on the phone's request, the session closing, the phone away for 30 s, 15 minutes without input, the Mac's Detach (`DELETE /tasks/:id/phone-terminal`, the run panel's banner button), a task archived or deleted, or a revoked device. Detaching kills only the client, never the session. One phone per task.

## Audit

`remote_audit` (migration 095) is append-only (triggers) and hash-chained (each row's hash covers the one before it). Rows: `pair`, `revoke`, `revoke-all`, `session-open`, `session-close`, `route` (the attempt) and `route-result`, `unlock`, `replayed`, `terminal-attach`/`terminal-detach`, `refusal` (coalesced to one per device a minute when a device can repeat it at will), `expire`. A row never holds a body or a key, only a body hash and the signature. A daily trim keeps one year or 50,000 rows and leaves an anchor row with the hash of the last dropped entry, so the chain still verifies from it. `GET /remote-access/log` pages it and reports the chain's integrity.

## Control routes

Under `/remote-access` only `GET` (read) and `DELETE` (revoke, off) exist, pinned by `route-policy.test.ts` TT3(c): `/remote-access` (status, off), `/remote-access/devices` (list, revoke all), `/remote-access/devices/:id` (revoke), `/remote-access/log`. Plus `DELETE /tasks/:id/phone-terminal`, `GET /tasks/:id/files/preview`, and `PUT /preferences/remoteMacName` (at most 40 characters, cleaned, never empty). No route pairs a device, turns remote access on or changes a level: pairing is the key helper's native window (opened from Agetor › Pair a Phone…, which first runs the native Remote Access box if the switch is off), and "on" is that box. The CLI mirrors them: `agetor remote [status | off | devices | revoke <device> | revoke-all --yes | log]`; the webview shows them in Settings › Remote access.

## Ship dark

`src/shared/build-flags.ts`: `COMPANION_ENABLED` and `RELEASE_BUILD` come from Bun `define`s (`AGETOR_COMPANION_BUILD=1`, `AGETOR_RELEASE_BUILD=1`; the `build*` scripts set the latter). Every test seam is guarded INLINE with `!(typeof __AGETOR_RELEASE_BUILD__ !== "undefined" && __AGETOR_RELEASE_BUILD__) && remoteSeamsAllowed(env) && …` because Bun folds that expression but not an imported constant, and the guarded branch is the only place the seam's env var name is read. `scripts/verify-release.ts` (`verifyReleaseBundles`) fails a release whose shipped JS holds `AGETOR_FAKE_KEY_HELPER`, `AGETOR_REMOTE_RELAY_URL` or `AGETOR_REMOTE_PUSH_URL`, or the Companion marker (`agetor-companion-compiled-in`) in a dark build. `verifyKeyHelperLayout` checks the helper's packaging (see [Release](#release)). The release gate is exercised by `scripts/verify-release.test.ts` and `src/bun/remote/it/ship-dark.it.test.ts`.

## Release

The key helper (`native/keyhelper/`, built by `scripts/build-keyhelper.ts`) needs a Developer ID provisioning profile for the app id `sh.alamops.agetor.keyhelper` to use the data-protection keychain. `AGETOR_KEYHELPER_PROFILE` points at it (outside the repo; `*.provisionprofile` is gitignored). `scripts/release.ts` refuses to start without it; a local `bun run build` falls back to an ad-hoc helper with a warning (its keychain operations then fail with `keychain-unavailable`: there is no login-keychain fallback). `electrobun.config.ts` copies `vendor/keyhelper` to `Contents/Resources/app/bin`, NOT `Contents/MacOS`, where electrobun's codesign pass would re-sign it and drop the profile. `verify-vendor-signing.ts` and `verify-release.ts` assert the same identity as the notifier, the hardened runtime, the embedded profile whose team equals the signature's, and the `keychain-access-groups` entitlement.

## Deviations from the plan (kept deliberately)

- **Pairing signatures over the FINAL handshake hash** travel in the first transport message (`pairing-request`): a signature can only cover a hash that exists, so it cannot ride the handshake itself.
- **`rekey` is an in-band control message** (`dir: "both"` in the message table), not a separate frame type.
- **The gate's `nextStepIds` subset and resume mode** are not v1 phone options (a signed review sends everything the gate leads to).
- **The preview cap (50 MB) and the relay budget (about 190 KB a second)** mean a large file takes minutes on a phone; the pacer's one-second burst cap (192 KB) keeps it under the relay's 256 KB unacknowledged queue.

## Test seams

`AGETOR_FAKE_KEY_HELPER=1` (+ `AGETOR_FAKE_KEY_HELPER_DIR`) and `AGETOR_REMOTE_RELAY_URL` / `AGETOR_REMOTE_PUSH_URL`, honored only outside a release build and only under `NODE_ENV=test` or `AGETOR_E2E_HARNESS_SEAMS=1` ([testing-seams.md](testing-seams.md)). The fake helper's test controls (`fakeKeyHelperControl`) drive its pairing window; the headless phone is `packages/remote-protocol/src/test-client.ts` and the local relay `test-relay.ts`.

## Tests

- Protocol package: `cd packages/remote-protocol && bun test` (vectors, schemas, the self-test of the headless phone against a minimal responder). Regenerate vectors with `UPDATE_VECTORS=1 bun test` and the JSON schemas with `bun scripts/gen-schemas.ts`.
- The gateway's modules: `bun test src/bun/remote` (a unit test per module, the router's precedence proof, the session manager over the real relay link).
- Integration against a REAL headless core as a child process: `bun test src/bun/remote/it` (the harness is `it/harness.ts`; in-process suites share `it/inproc.ts`). They cover the invariants by name: `inv1` … `inv14`, in `link-gating`, `revoke`, `logs-no-secrets`, `frames`, `router-levels`, `consent`, `audit`, `pairing`, `handoff`, `idempotency`, `terminal`, `previews`, `data`, `push`, `notifications-core` and `ship-dark`. `device-notifications` proves a headless core posts a revoke's notice through the notifier helper under the device's own id.
- The terminal tests need tmux and fail under `CI=true` without it. The helper's Swift side is checked against the TypeScript vectors by `bun scripts/build-keyhelper.ts --adhoc` then `keyhelper selftest-vectors packages/remote-protocol/vectors` (CI runs it).
- `bun run check` runs typecheck, `lint:async`, `bun test`, the script tests and the package tests; the owner marks the `check` job required in branch protection.
