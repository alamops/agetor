<!--
Source: "Agetor Remote Readiness Spec", Claude Docs document
https://claude.ai/artifact/VepsfQcg7WYRuy8brBf3LX, revision 40 (dated 2026-11-24),
exported as Markdown on 2026-11-25. The content below is that revision UNAMENDED.
The export replaced its two embedded diagrams (architecture; pairing sequence) with
text placeholders; the numbered pairing steps carry the same content.
The owner's grill amendments (docs/plans/remote-readiness-grill.md, "Spec amendments
for the owner to approve") are applied below, marked inline as "Amended (grill ...)"
blocks, with the replaced sentence struck through. The unamended text is the previous
commit of this file, so the amendments are a reviewable diff.
-->

# Agetor Remote Readiness Spec

Nov 24, 2026 · @Alamo Saravali

After this change, the Agetor core can pair a phone and serve it over an end-to-end encrypted, mutually authenticated session, and every route stays closed to phones except the v1 monitor-and-unblock set. No phone app ships here: a headless test client proves the whole loop. It builds on the [Agetor Companion Blueprint](https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy) and on main at v1.2.2.

## Scope

This change is Mac-side only: everything the core needs before a v1 app can pair. Anything needed only by v2, by the store launch, or by servers off the Mac waits.

| Area | In this change | Later |
| --- | --- | --- |
| Keys and pairing | A signed key helper, the native pairing window, a signed device registry | Raising a device's level (v2) |
| Sessions | Noise sessions over a relay link; a local test relay | Production relay and push gateway (their own specs); iroh direct link (v1.x) |
| Routes | Remote levels in `ROUTE_POLICY`; ~~v1 opens observe and respond only~~ v1 opens observe, respond and the five `operate` routes listed in the router section | ~~Operate and configure routes (v2)~~ Further operate and configure routes (v2), after a per-key preference schema |
| Consent | Signed approvals, the unlock window, idempotency keys | Signed launches, merges and deletes (v2) |
| Data | Remote subscriptions on today's cursors; one needs-you query; a phone projection of events; small first loads; per-task file previews | — |
| Notifications | One notification decision in the core; sealed pushes; presence from window focus | Idle-time presence; Live Activities |
| Audit | Hash-chained log with a viewer and CLI | The phone's witness of chain heads (app work) |
| Protocol code | `packages/remote-protocol`: the core's TypeScript implementation, message schemas and test vectors | The Swift (iOS) and Kotlin (Android) implementations, in the app work |
| Quality | Headless test client, security suite, a CI gate for both, an external review | Full-suite CI baseline; demo core and canary channel before App Review |

Not in any phase of this spec: keep-awake (deferred), ~~a terminal on the phone~~ (a configure-level terminal is now in scope, see Terminal), lock-screen approvals, commands sent while no session exists, and tailcat.


> **Amended (grill D17, 2026-11-25):** A phone with the `configure` level can attach to a task's tmux session. See the Terminal section.

## Security invariants

Each rule is a MUST, and each has a named test in the security suite (see Tests, CI and review).

1. **Nothing is exposed before a device is paired.** The relay link opens only while the remote-access switch is on AND either a trusted device exists or a native pairing window is open. The switch alone never authorizes anything.
2. **Adding a device needs you at the Mac.** It takes the native pairing window, a code shown on the phone and typed on the Mac, and Touch ID or the login password. No HTTP route, CLI command or webview action can add a device or raise its level.

> **Amended (grill D6, D7, 2026-11-25):** The level is chosen in the native pairing window (Respond by default, Operate, or Configure with a second confirmation) and is covered by the registry signature. A level is never raised later: revoke and pair again.
3. **Trust comes from signatures, not rows.** A device counts only if its registry row carries a valid signature from the Mac's registry key and the key helper has not revoked it. Any other row is ignored and logged.
4. **Every byte to a phone is end-to-end encrypted and authenticated both ways.** The relay and the push gateway see only ciphertext, padded sizes and timing.
5. **The HTTP API stays on 127.0.0.1.** Phones reach route handlers only through the in-process router; no listener is added.

> **Amended (grill D11, 2026-11-25):** ~~The HTTP API stays on 127.0.0.1.~~ The HTTP API keeps the bind it has today: loopback for the app, and for the headless core whatever `AGETOR_API_HOST` resolves to (loopback or a wildcard, with the existing cleartext warning). The gateway adds no listener, and when the core is bound beyond loopback the gateway logs a warning to `core.log` and `GET /remote-access` reports `bindWarning`.
6. **Deny by default.** A phone may call a route only if its `ROUTE_POLICY` entry has an explicit remote level. Desktop-only routes, test routes and native-only actions are never remote.
7. **A device caller exists only inside an authenticated session.** No header, query string or token can produce it.
8. **Consent that runs code is signed.** Plan approvals, Allow-once answers, trust screens and pipeline gate decisions carry a Face ID signature over the exact content the phone showed. A changed content hash voids it.
9. **Removing authority is always easy and immediate.** Stop, reject, revoke and Remote access off work at every level, are never rate-limited, and revoke ends live sessions at once.
10. **Private keys never leave their store.** Phone keys stay in its Secure Enclave or StrongBox, the registry key in the Mac's Secure Enclave, and the core's session key inside the key helper, never in SQLite, files or Bun's memory.
11. **Nothing secret is logged.** No keys, plaintext, signatures, push tokens or pairing secrets in `core.log`, `daemon.log`, run events or error messages.
12. **Everything remote is audited first.** Every pairing, revoke, session and remote mutation is written to the audit log before its result is returned.
13. **Parse strictly, fail closed.** Frames are size-checked before decryption and schema-checked after it. An unknown field in a security message is refused, and any decryption failure ends the session.
14. **No downgrade.** The protocol version is bound into the handshake, there is no cipher negotiation, and the core enforces a minimum version.

## Threat model

The most likely attacker is already on the Mac: an agent running as you. The design assumes it can do anything Bun can, and puts the decisions that matter behind your physical presence.

| Adversary | Can | Cannot |
| --- | --- | --- |
| An agent running on the Mac as you | Read the CLI token and `agetor-core.json`; write SQLite, including the remote-access switch and registry rows; run Agetor's signed binaries; ask the key helper for a handshake | Add a device (it needs the phone's code typed into the native window plus Touch ID); make an unsigned or replayed row trusted; un-revoke a device; copy the session or registry key off the Mac |
| Relay operator or network attacker | See IP addresses, timing, padded sizes and the day's mailbox ids; drop, delay, reorder or replay ciphertext | Read or change content; impersonate either side; link a device's traffic across days |
| Push gateway, Apple, Google | See push tokens and timing | Read task titles, questions or plans |
| Thief with a locked phone | Hold the phone | Use any key (they need the phone unlocked) |
| Thief who knows the passcode | Read the board, stop runs, answer questions in tasks that ask before acting | Approve, allow, or send into tasks that run without asking (current biometrics, no passcode fallback) |
| Tampered app or OS on the phone | Show one thing and sign another | Avoid the Mac alert and the audit entry every remote approval creates (this is detection, not prevention) |
| Agent text shown on the phone | Mislead you with words | Change the facts the core shows outside agent text (mode, project, command) or load remote images |
| A phone paired at `configure` (grill D17) | Attach to a task's tmux session and type anything the agent's shell accepts, with the user's full privileges | Do it without a signed approve-key attach, in a task with no tmux session, or after revoke; keystrokes are not audited, attach and detach are. This is an accepted bypass of the consent classes: configure means "as trusted as the keyboard" |

What a revoke or Remote access off protects: from that moment the device's sessions end and its keys stop working, even if an agent rewrites the database.

## Architecture

One new module in the core, the remote gateway, is the only door from a phone session to the existing handlers. A small signed Swift helper is the only process that can use the Mac's keys.

&#91;embedded content: architecture · phone, relay, push gateway, remote gateway, key helper\]

Both the core and the phone only dial out, so the Mac opens no new port. The gateway runs in whichever core owns the port, the app or the background core.

## Keys and cryptography

Seven keys, each in the strongest store its algorithm allows, built only from standard primitives: X25519, P-256, ChaCha20-Poly1305, SHA-256 and HKDF.

| Key | Algorithm | Lives in | Who can use it | Replaced when |
| --- | --- | --- | --- | --- |
| Core session key | X25519 | A ~~keychain item~~ data-protection keychain item (access group of the key helper) only the key helper's signature can open (spike K1) | The key helper, for one Diffie-Hellman per handshake; Bun never holds it | Revoke all; every device pairs again |
| Registry key | P-256 ECDSA | The Mac's Secure Enclave, requiring user presence (no Secure Enclave: pairing is refused) | The key helper, only at the end of its own pairing window, with Touch ID or the login password each time | Never; replacing it means every device pairs again |
| Device session key | P-256 ECDSA | Phone Secure Enclave or StrongBox, usable while unlocked | The phone; the core verifies | Each pairing |
| Device approve key | P-256 ECDSA | Phone Secure Enclave or StrongBox, current biometrics, no passcode fallback | The phone; the core verifies | When biometrics change: pair again |
| Device push key | X25519 | Phone keychain shared with the notification extension | The core seals to it | Each pairing |
| Pairing secret | 32 random bytes | The QR code and core memory, single use, 120 s | Pre-shared key of the pairing handshake | Every pairing |
| Link secret | 32 random bytes per device | The registry row | Derives the device's daily mailbox keys; it opens no content | Each pairing |

**Suites and encodings**

- Pairing handshake: `Noise_NKpsk0_25519_ChaChaPoly_SHA256`, with the pairing secret as the PSK.
- Session handshake: `Noise_NK_25519_ChaChaPoly_SHA256`. The phone pins the core's public key from the QR code.
- Prologue: `agetor-remote/1` followed by the core id (SHA-256 of the core's public key). A different version or core fails the handshake.
- Channel binding: the phone's first transport message carries its device id and an ES256 signature by its session key over the handshake hash. The core accepts nothing else until it verifies.
- Push sealing: HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, info `agetor-push/1`.
- Signed JSON: RFC 8785 canonical JSON, ES256 with raw r and s.
- Mailbox key and id: the key is HKDF-SHA256 of the link secret with info `agetor-mailbox/1` and the UTC date, 32 bytes (pairing uses the pairing secret with info `agetor-pairing/1`). The id is the first 16 bytes of the key's SHA-256. A side joins by presenting the key; the relay keeps only the id.
- Pairing code: six digits, the first four bytes of HKDF(handshake hash, `agetor-sas/1`) as an unsigned integer, modulo 1,000,000.
- Implementations: three, each on its platform's standard primitives, and all must pass ~~the cacophony and snow Noise vectors~~ the vector set below, plus this protocol's own vectors.

> **Amended (grill C5, 2026-11-25):** The vector set is: the cacophony NK and NKpsk0 vectors for `Noise_*_25519_ChaChaPoly_SHA256` (ciphertexts and handshake hash), snow's NK vectors (ciphertexts; snow has no NKpsk0 vectors for this suite and no handshake hash), RFC 9180 base-mode vectors for DHKEM(X25519, HKDF-SHA256) with ChaCha20-Poly1305, and this protocol's own vectors for prologue, rekey, NKpsk0 failures, framing, padding, canonical JSON, ES256 (high-S included), mailbox ids, SAS codes, push seals and signed decisions. Each vector file records its source, license and retrieval date.
  - Core: `@noble/curves`, `@noble/ciphers` and `@noble/hashes` 2.x in `packages/remote-protocol`. The responder's static Diffie-Hellman is an injected function, so the key helper performs it.
  - iOS: CryptoKit only: Curve25519, P256 in the Secure Enclave, ChaChaPoly, SHA256, HKDF and HPKE (iOS 17 and later). No third-party crypto ships in the iOS app.
  - Android: Android Keystore for the P-256 keys (StrongBox when present), and Google's Tink for X25519, ChaCha20-Poly1305 and HPKE.

## Pairing

A phone is added only by a window the key helper draws itself, with a code read off the phone and Touch ID at the end. The helper signs nothing outside that flow.

&#91;embedded content: pairing · you, key helper, core, relay, phone · 13 messages\]

The highlighted step is the one an agent on the Mac cannot do for you: it never sees the phone's code, and it cannot pass Touch ID.

1. You choose **Agetor › Remote Access › Pair a Phone…** (or the button in Settings, which only asks the app to open the window). If remote access is off, the existing Remote Access box turns it on first.
2. The key helper opens its own window. It creates the pairing secret, reads the core's public key from its own keychain item, and draws a QR code holding: format version, core public key, relay URL, pairing mailbox, pairing secret, expiry (120 s). A release build of the phone app refuses a QR whose relay URL is not in its signed relay config, after fetching a fresh copy; only debug builds also accept the local test relay. The window says: *Only continue if you chose Pair a Phone from Agetor's menu.*
3. The core opens the relay link for that pairing mailbox only while the window is open.
4. The phone scans and runs the `NKpsk0` handshake through the relay. Its first message carries its name (40 characters at most), platform, app version and its session, approve and push public keys. The session and approve keys each sign the handshake hash.
5. The core checks both signatures and hands the hash, keys and name to the helper.
6. The phone shows the six-digit code derived from the handshake hash. You type it in the helper window. A wrong code three times, or the expiry, ends the pairing.
7. The helper compares the code, asks for Touch ID ("Add 'Ana's iPhone' to Agetor"), and signs the registry entry. Only then does the core write the row, at ~~level `respond`~~ the level chosen in the window (Respond preselected, Operate, or Configure after a second confirmation), which the signature covers.
8. Over the same session the core sends the device id and link secret. It posts a Mac notification ("Ana's iPhone was paired"), alerts other paired devices, and writes an audit entry.
9. The window closes, the pairing mailbox is retired, and the device's own mailbox takes over.

The device name comes from the phone, so the window and Settings show it as plain text, cleaned of control and invisible characters.

> **Amended (grill D2, D3, 2026-11-25):** The key helper is a Developer ID signed nested `.app` carrying an embedded provisioning profile, and keeps the core key in the data-protection keychain under its own access group. There is **no login-keychain fallback**: when the Secure Enclave or the data-protection keychain is unavailable the helper answers `no-secure-enclave` or `keychain-unavailable`, and pairing is refused with an explanation.

## Sessions and the relay link

The core and the phone only dial out to the relay, which forwards ciphertext between per-device mailboxes. Every session is a fresh Noise handshake.

- **Gating.** The link is up only while invariant 1 holds. Remote access off, the last device revoked, or the pairing window closing with no devices left takes it down within a second.
- **Relay contract (core side).** WSS to the relay named by Agetor's signed relay config, which the relay spec defines; until that ships, the build's built-in address (tests point the core at the local test relay through an override honored only under NODE\_ENV=test, like the other test seams), one connection per mailbox. A mailbox joins one Mac and one phone for one day: each side joins with the mailbox key and a role (`core` or `device`), and a newer connection of the same role replaces the older. Frames: `hello` (role, plus the mailbox keys for today and yesterday, to cover midnight UTC), `welcome`, `send`, `deliver` (with a relay sequence number), `ack`, `peer` (the other side joined or left), `full` (the other side's queue is full and the frame was dropped), `replaced`, `ping` and `pong`. The relay keeps order per mailbox, delivers at least once, holds frames for an absent side for 10 minutes, and caps each queue at 256 KB. The core pauses a session's subscriptions while `peer` says the phone is away. The production relay has its own spec, the [Agetor Relay and Push Gateway Spec](https://claude.ai/artifact/StLvx8goStUPYWH7hyzyd4); this change ships a local test relay that follows the contract.
- **Handshake.** The phone is the Noise initiator and the core the responder. One session per device; a new handshake from the same device replaces the old session.
- **Framing.** Noise messages are at most 65,535 bytes. Each app message has a type, an id and a chunk index and count, and is padded inside the encryption to 256 B, 1 KB, 4 KB, 16 KB or 64 KB.
- **Order.** Any decryption failure, nonce gap or oversized frame ends the session. The phone handshakes again and resumes from its cursors. Every frame also carries an 8-byte session tag outside the encryption; a frame tagged with an ended session is dropped without decrypting, so a frame the relay delivers again after a reconnect can never end a new session.
- **Lifetime.** Noise rekey every 10 minutes or 2^20 messages; a session ends after 15 idle minutes or 12 hours. Revoke, Remote access off and Revoke all end it immediately.
- **Hello.** The core's first message carries the protocol version and minimum version, the device's level, the routes open to it (read from `ROUTE_POLICY`), the audit chain head, and the core's clock, and the Mac's name (`macName`, at most 40 characters, from the `remoteMacName` preference or the computer name). This replaces adding a protocol version to `/info` (blueprint item 3.5).

> **Amended (grill D16, 2026-11-25):** `macName` is added to the hello.
- **Handoff.** The gateway runs in whichever core owns the port, app or background. After a handoff the link reconnects from the new owner. A launch refused with `launches-frozen` is retried by the phone.
- **Rate limits.** Token buckets per device: 6 handshakes a minute, 30 requests a second, 2 heavy reads a second. Stop, cancel, reject and revoke are never limited.

## Device registry

Devices live in a new SQLite table, but a row is only trusted with a valid registry-key signature and no revocation in the key helper's own list.

| Column | Holds |
| --- | --- |
| `id` | Random 128-bit device id |
| `name`, `platform`, `app_version` | From the phone at pairing; the name cleaned and capped at 40 characters |
| `session_pub`, `approve_pub`, `push_pub` | Public keys, raw bytes |
| `link_secret` | The device's mailbox secret (finds mailboxes, grants nothing) |
| `level` | ~~`respond` for v1; `watch`, `operate` and `full` are reserved for v2~~ One of `observe`, `respond`, `operate`, `configure`, chosen in the native pairing window and covered by `sig` |
| `status` | `active` or `revoked` (a convenience copy; the helper's list decides) |
| `enrolled_at`, `last_seen_at` | Times |
| `push_ref` | The gateway's opaque push address and the device's push send key, set by the phone over its session |
| `sig` | Registry-key signature over the canonical JSON of id, name, platform, the three public keys, level and enrolled\_at |

- **Checked on every load and every session.** A row whose signature fails, or that names a revoked id, is ignored, shown as "not trusted" in Settings, and audited.
- **Revocation is one-way.** Revoking (Settings, CLI, the device itself, or Revoke all) needs no Touch ID: it only removes authority. The key helper records the id in a list kept in its own keychain item and has no command to remove an entry, so replaying an old signed row cannot bring a device back. A revoked device returns only by pairing again.
- **Unused devices expire.** A device not seen for 60 days is revoked the same way.
- **Agents can delete rows.** That only revokes; it is accepted.

## Remote router and route policy

Phones call the same route handlers the webview and CLI use, in-process, and the existing `ROUTE_POLICY` table decides each call. Every entry today says `remote: "none"`; this change gives a level to the v1 set only.

```ts
remote: "none" | {
  level: "observe" | "respond" | "operate" | "configure"; // v1 opens observe, respond and five operate routes (grill D9, D12)
  stepUp: "none" | "unlock" | "signed";  // "unlock" applies only when the task runs without asking
  rate: "normal" | "heavy" | "stop";       // "stop" is never limited
  since: 1;                                  // protocol version that opened it
}
```

- **Startup checks.** The core refuses to start if a remote entry sits on an `app` or `public` route, or lacks a level. `route-policy.test.ts` pins the exact v1 remote set, so opening a route shows up in review.
- **Router.** `invokeRoute(method, path, body, principal)` builds the request inside the core and runs the handler. `resolveCaller` returns a new caller kind, `device`, only from a private in-process mark, never from a header or query.
- **Device checks.** A device caller passes every check the CLI token passes today (desktop-only routes refused, filesystem path probes) plus level, step-up, rate and file scope. Handlers read the caller to name the device in toasts and audit entries.
- **File previews.** A new `GET /tasks/:id/files/preview` serves devices only the paths the task points at: its attachments and references, sent files, images in its transcript, and files under its worktree or project. ~~Images only, 10 MB at most, read through the existing disclaimed reader.~~ Read through the existing disclaimed no-follow reader, 50 MB at most, in chunks under the relay limits. The desktop route keeps previewing any path (owner decision, 24 Nov).

> **Amended (grill D14, D15, 2026-11-25):** Previews are 50 MB with no folder limit. A path inside the task's folders (workdir, worktrees, sent files) opens at any level; any other path needs `operate` or above. ~~Phones get only the paths the task points at.~~

| Group | v1 routes | Step-up |
| --- | --- | --- |
| Observe | `GET /tasks?delta=1`, `GET /tasks/:id`, `/tasks/:id/runs`, `/tasks/:id/events` (as a subscription), `/tasks/:id/events/page`, `/tasks/:id/interactions/pending`, `GET /interactions/pending` (new), `/tasks/:id/pipeline`, `/tasks/:id/subagents`, `/tasks/:id/git-status`, `GET /tasks/:id/files/preview` (new), the global event subscription | None |
| Respond, removing | `POST /runs/:id/cancel`, `POST /tasks/:id/pipeline/cancel`, reject or dismiss on any card, `POST` and `DELETE /tasks/:id/seen` | None; rate `stop` for the cancels |
| Respond, content | `POST /ask-questions/:id/answer`, `POST /runs/:id/input`, `/tasks/:id/backlog` and `/tasks/:id/backlog/:itemId` | Unlock window when the task runs without asking |
| Respond, consent | `POST /tasks/:id/plans/:planId/approve`, `POST /tmux-prompts/:id/answer` (any non-reject choice), `POST /fx-permissions/:id/answer` (allow options), `POST /tasks/:id/pipeline/review` | Signed, every time |
| Added to v1 (grill D12) | `GET /tasks/:id/messages/history` (observe); `PATCH /tasks/:id/plans/:planId` (respond, signed over the edited body, D13); `POST /tasks/:id/fx-resume` (respond, signed); `POST /tasks/:id/switch-account` (operate, session only); `DELETE /tasks/:id/phone-terminal` is Mac-side only and not remote | As listed |
| Session operations | Hello, push registration, revoke this device | Session only |

## Signed decisions and the unlock window

The proof a phone must give grows with what the action can cause: removing needs nothing, content into a task that acts without asking needs a recent Face ID, and consent needs a signature over exactly what you saw.

| Class | Examples | Proof |
| --- | --- | --- |
| Remove | Stop, cancel, reject, dismiss, revoke | Session |
| Read | Everything in the observe group | Session |
| Content | Answers to questions, follow-ups, drafts | Session; plus the unlock window if the task's mode runs without asking (auto, yolo, Full access) |
| Consent | Plan approval, Allow once, Claude Code trust and Press-Enter screens, pipeline gate Accept or Return | A signed decision, every time |
| Never remote in v1 | Always allow, Claude login codes, starting tasks, settings | Refused |

> **Amended (grill D8, D9, D10, 2026-11-25):** A tmux card choice is classified by value with exact known label shapes only: `once` is consent, `reject` is removal, `always` and anything unknown are never remote. The Claude plan modal's "Yes, and use auto mode" row needs `operate`, a signature over the plan hash and the unlock window; the manual-approve row is consent; "Tell Claude what to change" is content. A reject or skip that carries text is content, not removal.

**Signed decision.** The core sends the exact bytes to show (plan markdown and revision; card question, options and the task's mode; gate handoffs and sequence number), their SHA-256 and a challenge. The phone renders those bytes, recomputes the hash, and signs with its approve key:

```json
{"v":1,"kind":"decision","deviceId":"d_7f3a…","sessionHash":"…","challenge":"…",
 "route":"POST /tasks/9a1f…/plans/p2/approve","target":{"taskId":"9a1f…","id":"p2"},
 "contentHash":"sha256:…","decision":"approve","comment":null,"ts":1795560000000}
```

The core then checks, in order, and refuses on the first failure:

1. The challenge was issued to this session for this target less than 120 seconds ago and is unused; it is consumed now.
2. `sessionHash` equals this session's handshake hash.
3. The ES256 signature verifies with this device's approve key.
4. `contentHash` equals the hash of what the target holds now. A plan revised since, or a card answered elsewhere, fails here.
5. The decision is valid for that target.

Only then does the handler run, and the audit entry keeps the payload and the signature. A gate comment is inside the signed payload, because it reaches the next step's prompt as trusted owner text.

> **Amended (grill E4, 2026-11-25):** The pipeline gate signature covers all six fields: handoffs, `stepId`, `seq`, `decision`, `comment`, `nextStepIds` and the task's `mode`.

**Unlock window.** One approve-key signature over `{kind: "unlock", sessionHash, expiresAt}`, at most 10 minutes ahead, opens the content class for tasks that run without asking. It ends with the session.

**Answer kinds added since v1.1.0** (blueprint item 2.6): a pipeline gate decision is consent and already has an idempotency key (the run's `startedAt` plus the gate's `seq`). A tmux card with `answerKind: "enter"` is consent. `answerKind: "code"` (a Claude login code) is never remote.

## Sync, streams and the inbox

The phone reuses the cursors main already has; this change adds one inbox query, smaller first loads and idempotency.

- **Subscriptions over the session.** The router subscribes in-process to the same broadcasters the SSE routes use, never over HTTP. Task events resume after `afterId` and answer `snapshotRequired` past the replay window (#284). The board uses the delta cursor and the `tasks-changed` push (#314); a cursor from before a restart or handoff returns a snapshot.
- **One needs-you query (new).** `GET /interactions/pending` returns every pending card across tasks, with pipeline step cards folded into their parent, plus pipeline gates waiting for you. One request builds the inbox instead of one per task.
- **A phone projection of events (new).** Native apps share no code with the webview, so the core runs the parsers in `src/shared` (tagged user messages, pasted-content unwrapping, TODO progress, sent files, handoff reminders, compaction summaries) and sends each event with its parsed form. The iOS and Android apps render that form instead of porting the parsers twice.
- **Small first loads (new).** A `maxBytes` parameter on the event replay and `/tasks/:id/events/page`; the phone asks for 256 KB first. Tool results over 16 KB arrive cut, with a fetch-by-event-id for the full text.
- **Idempotency (new).** Every mutation carries a 128-bit `idem` key. The core keeps each device's results for 10 minutes and returns the stored result for a repeat; the same key with a different body is refused.
- **Backpressure.** Each session's send queue is capped at 4 MB. Past it, the core drops that subscription and sends `snapshotRequired`, so a slow phone never grows memory on the Mac.

## Push notifications

The core decides once whether a task needs you, then tells the Mac and every phone. A push carries a sealed payload only the phone can open.

- **One decision in the core (blueprint item 4.1).** Today the headless core decides in `headlessNotificationFor` and the open app decides in the webview's `maybeNotifyOS`. Move the app's decision into the core, so both use one module with two sinks (macOS, phones), the same `NOTIFICATION_KINDS`, one entry per task, and the same removal triggers.
- **Presence.** No phone push while the Agetor window had focus in the last 2 minutes ~~(the webview already reports focus)~~.

> **Amended (grill D5, 2026-11-25):** Electrobun's native window focus and blur events are authoritative in the app; the webview reports focus, the selected task and view through `PUT /app/presence` as the backup and the only source on a headless core. The core owns the decision through one notification policy with an OS sink and a phone sink. A background core with no app open counts as away.
- **What is sent.** Only needs-you kinds by default. The payload `{v, taskId, kind, title, subtitle, ts}` is padded to 1 KB and HPKE-sealed to the device's push key. The visible text is generic ("A task needs you"); the phone decrypts the title on the device. No plan, command, path or transcript text ever goes in a push.
- **One entry per task.** The collapse id is an HMAC-SHA256 of the task id under the device's link secret, so Apple and Google see an opaque, stable value.
- **Delivery.** The core posts to the push gateway with the device's `push_ref`, authenticated by an HMAC under the device's push send key. The gateway's own contract is a separate spec; tests use a stub gateway.

## Terminal

> **Amended (grill D17, 2026-11-25):** New section.

A phone paired at `configure` can attach to a task's tmux session and type into it.

- **Gate.** The `terminal-attach` session op needs level `configure` and a signature by the approve key over `{kind:"terminal-attach", sessionHash, taskId, tmuxSession, challenge}` (current biometrics). The signature is checked by the same five-check verifier as other decisions.
- **Transport.** The core runs `tmux attach-session -t <session>` on Agetor's tmux socket in a PTY through `coreSpawn`. Output is coalesced every 50 ms into chunks of at most 16 KB and paced under the relay limits. Messages: `terminal-attach`, `terminal-input`, `terminal-resize`, `terminal-detach` from the phone; `terminal-output` and `terminal-closed` from the core.
- **Harnesses.** Only tmux-hosted per-task sessions qualify (claude-code, codex, gemini, antigravity, copilot and the OpenCode 1.x `run` driver). ACP harnesses and the OpenCode 2.x server answer `no-terminal`.
- **Detach.** On request, when the session ends or the peer leaves for 30 s, after 15 minutes without input, from the Mac (`DELETE /tasks/:id/phone-terminal`, Mac side only), on archive, delete or revoke. Detach kills only the tmux client, never the session. One phone per task: a second attach replaces the first.
- **Mac side.** The run panel shows "Phone attached to <task>" with a Detach button. Attach and detach are audited; keystrokes are not logged or audited.

## Audit log

Every remote action leaves a hash-chained entry before its answer goes out, and the phone keeps the chain heads it has seen, so a rewritten history shows.

- **Table `remote_audit`.** Sequence, time, device id, session hash, action (pair, revoke, session open or close, route call, decision, refusal), route, target ids, result code, the signature for a decision, the previous hash, and its own hash: SHA-256 of the previous hash and the entry's canonical JSON.
- **Written first.** In the same transaction as the action's database changes where it has any, and always before the response leaves the core.
- **Append-only.** Triggers refuse `UPDATE` and `DELETE`. An agent can drop the triggers; the chain and the phone's saved heads still reveal an edit.
- **Heads to the phone.** Every session hello carries the current head. Comparing heads is app work.
- **Viewer.** Settings › Remote access › Activity, and `agetor remote log`.
- **Retention.** One year or 50,000 entries. Trimming records the hash of the last dropped entry as the new starting point.

> **Amended (grill C2, C3, 2026-11-25):** A trim drops and recreates the DELETE trigger and writes an anchor row inside one `BEGIN IMMEDIATE`. A mutation writes an attempt row first and a result row after; an attempt with no result reads "outcome unknown".

## Controls: menu, Settings, CLI and kill switches

Turning things on and adding devices stay native; reading, revoking and turning off work everywhere.

| Surface | Today (v1.2.2) | Added here |
| --- | --- | --- |
| Agetor menu | Remote Access… (on or off) | Pair a Phone… |
| Settings › Remote access | The switch | Relay address (read-only); devices (name, platform, last seen, level, trust); Revoke; Revoke all; Activity; a "Pair a phone" button that asks the app to open the native window |
| CLI | `agetor remote status`, `agetor remote off` | `agetor remote devices`, `revoke <device>`, `revoke-all`, `log`; still no `on` and no `pair` |
| HTTP | `GET` and `DELETE /remote-access` | `GET /remote-access/devices`, `DELETE /remote-access/devices/:id`, `DELETE /remote-access/devices (revoke all)`, `GET /remote-access/log` |

- **The route test changes on purpose.** `REMOTE_ACCESS_ALLOWLIST` in `route-policy.test.ts` gains exactly the routes above, all GET or DELETE, so no POST, PUT or PATCH ever sits under /remote-access.

> **Amended (grill D19, 2026-11-25):** The rule is rewritten: no route pairs a device, turns remote access on or raises a device's level. Under `/remote-access` only GET (read) and DELETE (revoke or turn off) exist. The pairing button in Settings is replaced by the text "Pair a phone from Agetor › Remote Access › Pair a Phone…" (grill C1). They only read or remove authority, which the repo's rule 3 allows; nothing under them can add a device or raise a level.
- **Remote access off** ends every session and the link at once.
- **Revoke all** has the key helper revoke every device and replace the core session key, so every phone must pair again.
- **Mac alerts.** A notification for every pairing and revoke, and a toast for every remote approval ("Plan approved from Ana's iPhone").

## Repository layout

Yes, keep the apps in this repository, each in its own folder. The apps are native (Swift for iOS, Kotlin for Android; owner decision, 24 Nov), so they share no code with the core. What they share is the protocol: one pull request can change the core, the protocol and both apps, and CI can test all three against the same vectors.

```
/                          desktop app, unchanged (src/, native/, scripts/)
packages/remote-protocol/  the core's TypeScript protocol, message schemas, test vectors (this change)
apps/ios/                  Swift and SwiftUI app, Xcode project (later)
apps/android/              Kotlin and Jetpack Compose app, Gradle project (later)
services/relay/            relay and push gateway (later, deployed on their own)
```

- **The desktop stays at the root.** Moving it into `apps/desktop` would touch about 1,200 files and every path in the docs for no gain.
- **Vectors are the contract.** The protocol now exists three times: TypeScript in the core, Swift and Kotlin in the apps. `packages/remote-protocol/vectors/` holds JSON test vectors for handshakes, frames, padding, pairing codes, mailbox ids, push seals and signed decisions, and all three implementations must pass them in CI.
- **Schemas, not shared types.** The messages a phone reads (the hello, envelopes, decisions, and the bodies the v1 routes return) are described as JSON Schema generated from `src/shared`. Swift `Codable` and Kotlin serialization models are generated from those schemas, and CI fails when a checked-in model drifts.
- **Separate toolchains.** Only `packages/remote-protocol` is a Bun workspace. The apps build with Xcode and Gradle and never touch the desktop's `node_modules`.
- **CI by path.** Desktop jobs run on `src/` and `packages/`; iOS jobs on `apps/ios/` and the vectors; Android jobs on `apps/android/` and the vectors; relay jobs on `services/relay/`.
- **Separate releases.** Tags `v*` for the desktop, `companion-v*` for both apps (one version number), `relay-v*` for the relay.
- **Public stays safe.** No secret lives in the repo: the APNs and FCM keys stay in the gateway's secret store, and the apps hold no shared secret.

A separate repository would only pay off with a different license or a closed team, which is not the case.

## Tests, CI and review

The change is done when a headless client pairs, works the blocked-agent loop end to end, and every invariant's test passes in a required CI job.

- **Vectors.** Noise (cacophony and snow), HPKE (RFC 9180), canonical JSON with ES256, the pairing code derivation, and a frame-parser fuzz: random bytes never crash it, and oversized frames are refused before decryption.
- **Policy.** The route-policy test pins the v1 remote set and the widened `/remote-access` allowlist; startup refuses a remote level on an `app` or `public` route.
- **Security suite** (an in-process core, the local test relay and the headless client), one named test per invariant, including:
  - the link stays down with the switch on and no devices;
  - a row written straight into SQLite is ignored, and so is a replayed revoked row;
  - a flipped, reordered or replayed frame ends the session;
  - a signed decision is refused for a stale challenge, another session, a changed plan, or the wrong key;
  - a follow-up into a task that runs without asking is refused without the unlock window, and accepted with it;
  - a revoke mid-session closes it within one second;
  - a device reaches no `app` route and nothing above its level;
  - an idempotent repeat returns the stored result;
  - after a full run, `core.log` and `daemon.log` hold no key, token, signature or plaintext (searched for every secret the run created).
- **End to end.** A headless test client pairs through the local relay (with a fake key helper), reads the inbox and the board delta, answers a question, approves a plan with a signed decision, accepts a pipeline gate, and stops a run.
- **Test seams.** `AGETOR_FAKE_KEY_HELPER` (keys in memory, Touch ID granted, the code typed by the test) and `AGETOR_REMOTE_RELAY_URL` (the local relay). Neither is honoured in a signed release build.
- **CI.** A required GitHub Actions job on `macos-15`: typecheck, lint, the route-policy test, `packages/remote-protocol` and the security suite. The full-suite baseline is separate work (blueprint §13).
- **Review.** An external security review of pairing, the Noise implementation, the key helper and signed decisions, before the first TestFlight build connects to a real Mac.

## Work breakdown

Seventeen items in six waves; items in a wave own different files and can run in parallel. Sizes are relative, not estimates.

| ID | Work | Needs | Size | Blueprint |
| --- | --- | --- | --- | --- |
| R1 | `packages/remote-protocol`: workspace, Noise NK and NKpsk0, framing, padding, canonical JSON, message schemas, language-neutral vectors | Spike W1 | L | 7.1 |
| R2 | Key helper (Swift, signed): session key and Diffie-Hellman, Secure Enclave registry key, pairing window, revocation list | Spike K1 | L | 6.1, 6.4 |
| R3 | Device registry: migration, signature checks, revocation, 60-day expiry | R2 | M | 6.2 |
| R4 | Relay link client, link gating, local test relay | R1 | M | — |
| R5 | Remote gateway: sessions, hello, rekey, rate limits, handoff reconnect | R1, R3, R4 | L | 3.5 |
| R6 | Remote levels in `ROUTE_POLICY`, startup checks, the pinned v1 set | — | M | 2.1 |
| R7 | Router: `invokeRoute`, the `device` caller, per-task file previews | R5, R6 | M | 2.2, 2.3, 1.4 |
| R8 | Signed decisions, challenges, content hashes, unlock window, the new answer kinds | R7 | M | 2.5, 2.6 |
| R9 | Idempotency store | R7 | S | 2.4 |
| R10 | `GET /interactions/pending` and `maxBytes` on event routes | — | S | 3.2, 3.4 |
| R11 | One notification decision in the core, the phone sink, presence | R3 | L | 4.1, 4.3 |
| R12 | Audit log, viewer, chain head | R3 | M | 6.3 |
| R13 | Controls: menu item, Settings section, CLI commands, allowlisted routes | R2, R3, R12 | M | 6.5 |
| R14 | Headless test client and security suite | R5 to R13, R17 | M | 7.5 |
| R15 | CI job | R14 | S | 7.6 |
| R16 | External security review | All | — | — |
| R17 | Phone projection of events (the `src/shared` parsers run in the core) | R7 | M | 7.2 |

**Order**

1. Wave 1: spikes K1 and W1, then R1, R6 and R10 (nothing depends on them yet).
2. Wave 2: R2 and R4.
3. Wave 3: R3 and R5.
4. Wave 4: R7, R11 and R12.
5. Wave 5: R8, R9, R13 and R17.
6. Wave 6: R14, R15, then R16.

## Spikes and open questions

Two spikes gate the work; the rest are decisions for later specs.

- **K1, key storage (gates R2).** Can a Developer ID-signed Swift helper keep keys in the data-protection keychain under its own access group, and use the Mac's Secure Enclave, so that Agetor's own `bun` cannot read them? This may need the `keychain-access-groups` entitlement and an embedded provisioning profile. ~~Fallback: a login-keychain item whose only trusted app is the helper, so any other caller triggers a visible macOS prompt.~~

> **Amended (grill D3, 2026-11-25):** There is no fallback. If the live check fails, stop and decide again.
- **W1, schemas to native models (gates R1).** Generate JSON Schema from the `src/shared` types the v1 routes return, then Swift `Codable` and Kotlin serialization models from it (for example with quicktype), and check the output compiles and needs no hand edits.
- **Open: the relay's delivery guarantees** on Cloudflare Durable Objects (order per mailbox, at-least-once) belong to the relay spec; the core already tolerates redelivery through idempotency and fresh handshakes.
- **Decided: Agetor runs the only relay.** On Durable Objects at workers.dev addresses, picked by a signed config on agetor.dev that Agetor can switch without an app or Mac update. No self-host image and no setting to use another relay (owner, 25 Nov); details in the relay spec.
- **Open: the 60-day expiry** might become a setting once people use the app.

## Decisions already made

| Decision | Source |
| --- | --- |
| The apps are native: Swift and SwiftUI for iOS, Kotlin and Compose for Android; no Expo | Owner, 24 Nov |
| v1 is monitor and unblock; v2 is desktop parity | Owner, 27 Oct |
| Remote access turns on only natively; off over HTTP or the CLI | Repo rules, #286 |
| No folder limit on `/files/preview`; phones get a per-task check | Owner, 24 Nov |
| The legacy `?token=` on three streams stays for older CLIs | Master-token grill D13 |
| Keep-awake is deferred | Always-on host grill |
| No accounts; pairing by QR code | Blueprint |
| Relay first; iroh direct link in v1.x | Blueprint |
| No approvals on the lock screen | Blueprint |
| tailcat: watch only | Blueprint |

## References

- [Agetor Companion Blueprint](https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy): research, product scope, transport choice and the desktop work list this spec draws from.
- In the repository: `docs/plans/companion-pairing-requirements.md`, `docs/architecture/security.md`, `docs/architecture/always-on-host.md`, `docs/architecture/core-responsiveness.md` (delta and push), `src/bun/route-policy.ts`.
- [Noise Protocol Framework](https://noiseprotocol.org/), [RFC 9180 (HPKE)](https://www.rfc-editor.org/rfc/rfc9180), [RFC 8785 (canonical JSON)](https://www.rfc-editor.org/rfc/rfc8785), [noble-curves](https://github.com/paulmillr/noble-curves).
