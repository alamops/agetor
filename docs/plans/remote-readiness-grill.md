# Grill — Remote Readiness (Mac side of the Companion)

| Field | Value |
| --- | --- |
| Date | 2026-11-25 |
| Source | Investigation brief `docs/plans/remote-readiness-investigation.md`; spec "Agetor Remote Readiness Spec" rev 40 (https://claude.ai/artifact/VepsfQcg7WYRuy8brBf3LX) |
| Mode | Interactive via the decision form, answered by the owner in 3 rounds (23 + 7 + 4 questions; no skips) |
| Answers | `docs/plans/remote-readiness-grill/round-1/answers.json`, `round-2/answers.json`, `round-3/answers.json` |
| Flags | none |
| Spec | Outside the repo. Decision S1: commit it to `docs/specs/remote-readiness-spec.md` (rev 40 + the amendments below, marked inline) and `docs/specs/remote-relay-contract.md` before planning starts |

Every decision below was made by a human. None was delegated, and no one-way door is left unratified.

## What changed the shape of the work

1. **The terminal is in this change.** A phone paired at `configure` gets full keyboard control of the agent's tmux session (R2 `tmux-stream`, R3 `terminal-gates`). This is new scope beyond the spec's v1.
2. **The `operate` level is in v1.** It covers the auto-mode plan approval and `switch-account`. The level is chosen per device in the pairing window: Respond (the default), Operate or Configure (R2 `device-level`, R3 `pair-levels`).
3. **The core owns every notification** (R1 `notifications`, option a). The spec's premise that "the webview already reports focus" is false, so this adds an app-only route for the selected task, plus Electrobun's native focus and blur events.
4. **Ship dark** (R1 `release-visibility`). Everything is compiled and tested, but a release build hides pairing and never starts the gateway.
5. **The key helper is profile-backed, with no fallback** (R1 `k1-account`, R3 `k1-macos27`). It is a Developer ID `.app` with an embedded provisioning profile and Secure Enclave keys only. The login-keychain fallback is removed, so no macOS 27 run is needed.
6. **Previews work as on the Mac** (50 MB, any path), gated by level (R2 `preview-size`, R3 `preview-level`). This **replaces** the fleet decision of 2026-11-24, which limited phones to a per-task path check.
7. **Five more routes join the remote v1 set** (R1 `v1-routes`: all five).

## Decisions

### Shape

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Rollout | What does a release build show of pairing while there is no relay and no phone app? | **Ship dark.** Everything is compiled in and tested. In a release build, "Pair a Phone…", the Settings device list and the CLI `devices` commands are hidden, and the gateway never starts. One switch turns them on for dev, e2e and a future preview channel. A test asserts the switch is off in release. The key helper and its profile still ship, so K1 is proven in a real signed build. | owner (round-1/answers.json#release-visibility, accepted recommendation) |
| D2 | Key helper (K1) | Apple account and macOS versions | **Profile route.** The owner creates an App ID and a Developer ID provisioning profile under their own Developer ID team; the team name stays out of committed files. The helper is a nested `.app` under `Resources/app/bin`. `scripts/release.ts` embeds the profile, and `verify-release.ts` asserts it is present and fails closed if not. | owner (round-1/answers.json#k1-account, accepted recommendation, with a note naming the team) |
| D3 | Key helper (K1) | macOS 27 | **No login-keychain fallback.** Keys live only in the Secure Enclave, in the data-protection keychain under the helper's access group. If the helper can't use the Secure Enclave, pairing refuses and explains why. K1 runs on the owner's Mac (macOS 26.6.2); no macOS 27 run is needed, because nothing depends on the lane 27 reportedly removes. The spec's fallback text is amended. | owner (round-3/answers.json#k1-macos27, accepted recommendation; the owner's round-2 answer was the question "it's just for signing right?", answered in round 3) |
| D4 | Test seams | How a release build refuses the fake key helper and the relay-URL seams | **A build-time constant.** The release build bakes in `RELEASE_BUILD=true` through the bundle `define`, which makes the remote seams dead code there. `verify-release.ts` asserts the constant in the shipped bundles. Dev and e2e builds keep the seams. | owner (round-1/answers.json#release-seams, accepted recommendation) |
| D5 | Notifications | Does the core take over OS notifications? | **Yes, option (a).** A new app-only route (its name must pass TT3(c)) lets the webview report the selected task, the RunPanel or the pipeline view. Window focus comes from Electrobun 1.18.1's native `focus`/`blur`, with webview reports as a backup. One shared policy in the core decides OS notifications, phone pushes and the headless case, and the webview stops calling `maybeNotifyOS`. The e2e specs from `duplicated-macos-notifications-grill.md` must stay green. The spec's "the webview already reports focus" is amended. | owner (round-1/answers.json#notifications, accepted recommendation) |
| D6 | Levels | Unify or map the two vocabularies? | **One ordered vocabulary: `observe` < `respond` < `operate` < `configure`.** A route needs a level, and a device holds a ceiling from the same list. A single enum lives in `packages/remote-protocol`. The spec's device levels (`respond`/`watch`/`operate`/`full`) are amended. | owner (round-1/answers.json#levels, accepted recommendation) |
| D7 | Levels | Which level does a paired device get? | **Chosen per device in the native pairing window.** The window offers **Respond** (default), **Operate** (adds auto-mode plan approval and `switch-account`) and **Configure** (adds the terminal), each with a one-line description. Configure asks for a second confirmation on the Mac. No route raises a level; to change one, revoke the device and pair it again. The router refuses a route whose level is above the device's. | owner (round-2/answers.json#device-level and round-3/answers.json#pair-levels, both accepted recommendations) |

### Trust: what a phone may do

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D8 | tmux cards | Claude "always allow" rows (choices carry only `{key,label}`) | **Fail closed.** A shared classifier marks each tmux choice `once`, `reject` or `unknown`. Only exact known shapes count as once or reject. Always-style rows and `unknown` rows are shown greyed out, with "Answer on your Mac". fx and OpenCode refuse `allow_always`/`always` by ACP `kind`. Fixtures cover every row seen so far (`claude-tmux-scraper.test.ts`). The owner's note about streaming tmux led to D17. | owner (round-1/answers.json#tmux-always, accepted recommendation + note) |
| D9 | Claude plan approval | Which modal rows are allowed from the phone? | **All three.** Row 1, "Yes, and use auto mode", needs an **`operate`** device, a signature bound to the plan hash (the plan is read from the JSONL), and the **unlock window**. Row 2, "Yes, manually approve edits", is `respond` and signed. Row 3, "Tell Claude what to change", is **content**. This moves the Blueprint's v2 "Operate" line into v1, and the spec is amended. | owner (round-1/answers.json#claude-plan, **overrode** the recommendation "rows 2+3 only"; round-2/answers.json#auto-mode-guard, accepted recommendation) |
| D10 | Reject and skip with text | Is a reject or skip with typed text "remove" or content? | **A bare reject or skip is Remove; one with text is content.** The text gets the follow-up rules: signed, plus the unlock window when the task runs without asking. The router classifies by request body. | owner (round-1/answers.json#text-reject, accepted recommendation) |
| D11 | Wildcard bind | Remote access on a headless core bound to `0.0.0.0` or `::` | **Allowed, with a warning.** The gateway runs. `GET /remote-access`, `agetor remote status` and `core.log` show "API is also reachable beyond loopback over plain HTTP". Invariant 5 in the spec and in `security.md` is amended to "loopback, or a wildcard bind with that warning". A Linux container core still has no key helper, so in practice this applies to a macOS headless core. | owner (round-1/answers.json#wildcard-bind, **overrode** the recommendation "refuse"; round-2/answers.json#wildcard-detail, accepted recommendation) |
| D12 | v1 routes | Routes outside the spec's table | **All five join the remote v1 set:** a new `GET /tasks/:id/events/:eventId` (observe; the spec's fetch for tool results cut at 16 KB); `POST /tasks/:id/fx-resume` (respond, signed); `PATCH /tasks/:id/plans/:planId` (content); `GET /tasks/:id/messages/history` (observe); `POST /tasks/:id/switch-account` (operate). | owner (round-1/answers.json#v1-routes, **overrode** the recommendation of the first two only) |
| D13 | Plan edit | Scope of `PATCH /tasks/:id/plans/:planId` | **Mac side only:** a remote policy entry, content-level signing over the edited plan body, the router mapping, and coverage in the headless test client. The phone's editor belongs to the iOS app spec. | owner (round-2/answers.json#plan-edit-scope, accepted recommendation) |
| D14 | Previews | Phone preview cap and paths | **As on the Mac: a 50 MB cap and no folder limit**, through a device-caller preview route with no-follow reads. The file is sent in chunks under the relay limits (2 MB per 10 s, so about 4 minutes for 50 MB), with progress on the phone. | owner (round-1/answers.json#preview-cap "the same as in the mac", clarified in round-2/answers.json#preview-size, **overrode** the recommendation "50 MB with the per-task path check") |
| D15 | Previews | Which level may preview outside the task's folders? | **Files inside the task's folders** (its workdir, worktrees and sent files) open at **any** level. **Any other path needs `operate` or `configure`.** | owner (round-3/answers.json#preview-level, accepted recommendation) |
| D16 | Protocol | A Mac name in the hello | **Yes.** `macName` is a string of at most 40 characters, defaults to the computer name and can be edited in Settings. It is sent inside the Noise session, so the relay never sees it. It is part of protocol v1. | owner (round-1/answers.json#mac-name, accepted recommendation) |
| D17 | Terminal | Streaming tmux to the phone | **In this change, full control at `configure` level.** **Gates:** attaching needs a `configure` device and a signed attach with the biometric approve key, bound to the task id and the session. **While attached:** the Mac shows "Phone attached to \<task\>" in the run panel with a Detach button, and the audit log records the attach and the detach (not the keystrokes). **Detach:** when the phone goes to the background or locks, and after 15 minutes idle. **Transport:** output is batched under the relay limits, and keystrokes ride the Noise session. **Harnesses:** Claude's tmux session and the other tmux-hosted harnesses; ACP harnesses (fx, cursor) have no terminal. The spec gains a terminal section, a protocol message family and a threat-model entry. A `configure` device can bypass every other phone gate by typing, which is why D7 adds the second confirmation. | owner (round-2/answers.json#tmux-stream, **overrode** the recommendation "owner-deferred"; round-3/answers.json#terminal-gates, accepted recommendation) |
| D18 | Residual risks | An agent posing as the core; forged push text | **Both accepted and documented** in `docs/architecture/security.md` and the new `docs/architecture/remote-gateway.md`. They are not closed. | owner (round-1/answers.json#residual-risks, accepted recommendation) |
| D19 | Route rule | The "no device routes" rule (CLAUDE.md, pairing rule 5, TT3(c)) | **Rewritten:** no route pairs a device, turns remote access on, or raises a device's level. Under `/remote-access`, only GET (read) and DELETE (revoke or turn off) exist. TT3(c) pins the exact allowlist: `/remote-access` GET+DELETE, `/remote-access/devices` GET+DELETE, `/remote-access/devices/:id` DELETE, `/remote-access/log` GET. | owner (round-1/answers.json#vocab-rule, accepted recommendation) |

### Confirmed defaults

| # | Topic | Answer | Source |
| --- | --- | --- | --- |
| C1 | Settings "Pair a phone" | Settings shows "Pair from Agetor › Pair a Phone…". No HTTP route opens the pairing window (the same precedent as turning remote access on, `BackgroundSection.tsx:186`). | owner (round-1/answers.json#pair-button) |
| C2 | Audit retention | The trim is a named op. In one `BEGIN IMMEDIATE` it drops the DELETE trigger, deletes the oldest rows (beyond 1 year or 50,000 entries), writes an anchor row with the hash of the last dropped entry, and recreates the trigger. UPDATE is refused at all times. | owner (round-1/answers.json#audit-retention) |
| C3 | Audit timing | An attempt row (device, route, body hash, signature id) is written before the handler and a result row (status code) after it. An attempt with no result row reads "outcome unknown". | owner (round-1/answers.json#audit-timing) |
| C4 | HPKE | Hand-built on `@noble` (RFC 9180 base mode, one suite), with the RFC 9180 vectors in the test suite and covered by the R16 external review. | owner (round-1/answers.json#hpke) |
| C5 | Noise vectors | Cacophony (NK and NKpsk0, including the handshake hash), snow NK, and our own vectors under `packages/remote-protocol/vectors/`. The spec's "cacophony and snow" wording is amended. | owner (round-1/answers.json#vectors) |
| C6 | Background core | The key helper is spawned through `coreSpawn` (disclaimed) from both cores. The background core never opens a pairing window. The relay link reconnects after a port handoff. | owner (round-1/answers.json#background-core) |
| C7 | Spec in the repo | `docs/specs/remote-readiness-spec.md` holds rev 40 plus this grill's amendments, marked inline. `docs/specs/remote-relay-contract.md` holds excerpts of Blueprint §12 and the relay wire contract (30 s ping, 256 KB or 64 frames, 50 frames/s, 2 MB per 10 s). | owner (round-1/answers.json#spec-commit) |
| C8 | CI (R15) | GitHub Actions on `macos-15`, on PRs and pushes to main: `bun install`, then `bun run check` (now covering `packages/`), the remote security suite and the protocol vectors. No Playwright in CI. | owner (round-1/answers.json#ci-scope) |
| C9 | Acceptance | **Integration (bun test):** a headless test client, the local test relay and a headless core with fake drivers. They cover pairing (through the fake key helper), approving each card kind, the signed gate (all six fields), the unlock window, idempotent retry, revoke, revoke-all and the audit chain, plus the D17 terminal (attach, detach, idle and level refusal) and D15 previews. **Playwright:** the Settings device list, revoke and log view, with seeded devices, plus the D17 "Phone attached" banner and Detach. The existing duplicated-notifications and task-stream e2e specs must stay green. | owner (round-1/answers.json#e2e-scope); the D15/D17 additions are the plan's own, following the owner's scope decisions |

### Settled by evidence (not asked)

| # | Topic | Fact | Source |
| --- | --- | --- | --- |
| E1 | Noise | `@noble` 2.4.0 implements both suites with the responder's DH injected and matches cacophony byte for byte | investigation §2, spike `noise-spike.ts` |
| E2 | ES256 | Verify with `lowS:false`, pinned by a test (with noble's defaults only 107 of 200 WebCrypto signatures verify) | investigation §2, `es256-spike.ts` |
| E3 | Router | It can't use `server.fetch`. It calls the policy-wrapped handlers directly, with a synthetic `Request` carrying `params` and the WeakMap mark. The routes object is hoisted out of `Bun.serve` | investigation §2, `invoke-route/spike2.ts`; `server.ts:1896-1917` |
| E4 | Gate signing | A signed gate decision covers `stepId`, `seq`, `decision`, `comment`, `nextStepIds` and `mode` | `server.ts:7171-7226` |
| E5 | Claude plan | The ExitPlanMode plan is in the JSONL while the modal is open, so it can be hashed before approval | investigation §2, live spike on Claude Code 2.1.332 |
| E6 | Migrations | 094 (devices) and 095 (audit) are additive; there is no backfill | investigation §5 |

## Spec amendments for the owner to approve

The owner's answers above decide each of these. Committing the amended spec (C7) is where they get recorded:

- The level vocabulary is replaced (D6, D7) and `operate` joins v1 (D9, D12).
- The login-keychain fallback is removed (D3).
- "The webview already reports focus" is replaced by D5's mechanism.
- Invariant 5 now allows a wildcard bind with a warning (D11).
- Previews are 50 MB with level-gated paths instead of a 10 MB cap (D14, D15).
- A terminal section, its protocol message family and a threat-model entry are added (D17).
- `macName` is added to the hello (D16).
- The vector rule is changed (C5).
- The gate signature covers all six fields (E4).
- Five routes are added to v1 (D12).
- The Controls section's device routes become legal under the rewritten rule (D19).

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Rewriting `CLAUDE.md`, pairing rule 5, TT3(c), `security.md`, `always-on-host.md`, the `README.md` remote-access lines, `testing-seams.md`, a new `remote-gateway.md` and a Topic map row | in this change | D19, D18; repo rule: a doc changes with its behavior |
| The fleet decision "remote callers get a per-task path check" (2026-11-24) | in this change (superseded) | D14/D15. The fleet entry and the local memory are updated in this step |
| The webview's `maybeNotifyOS` and the D7 focused-window rules move into the core | in this change | D5 |
| The task-stream replay, resume and dedup extracted from the `/tasks/:id/events` handler | in this change | investigation assumption 6; a copy would drift |
| The `remote: "none"` literal type and the "every entry is none" assertion (`route-policy.test.ts:184-185`) | in this change (replaced) | orphaned by the remote levels |
| `packages/remote-protocol` plumbing (workspaces, `bunfig.toml` test root, `tsconfig` include, `lint:async` globs, `bun.lock`) | in this change | C8 |
| Provisioning profile embedding in `scripts/release.ts`, `verify-release.ts` and `verify-vendor-signing.ts` | in this change | D2 |
| The terminal (D17): protocol messages, gateway stream, run-panel banner, audit rows, idle timer | in this change | owner, round 2 |
| The phone's plan editor UI | out of scope | Belongs to the iOS app spec; this change ships no phone app (D13) |
| The hosted relay and push gateway | out of scope | The relay spec runs after this one; this change builds only the local test relay |
| An App Attest challenge endpoint (a gap the iOS spec found in the relay spec) | out of scope | It is relay-side work, under the relay spec |
| Closing the push-forgery gap (helper-signed pushes) | out of scope | The owner accepted it as a residual risk (D18) |
| Running K1 on macOS 27 | out of scope | Unnecessary once the fallback is gone (D3) |
| Playwright in CI | out of scope | C8: e2e stays local for now |
| Creating the App ID and the Developer ID profile in the Apple account | owner action (prerequisite) | The owner (D2). The plan's K1 wave waits on it |

## Assumptions still open

- **K1's main path works with a profile-embedded nested `.app` on macOS 26.6.2.** This rests on two public reports (investigation assumption 1). If it's wrong, the helper can't pair at all, because D3 removed the fallback. K1 is wave 1 and blocks everything that depends on the key helper.
- **The macOS 27 data-protection report is accurate** (assumption 2). It no longer matters for correctness after D3. If it's wrong, the removed fallback would have worked, but nothing is lost.
- **Bun's route precedence matches the router's own matcher for the v1 patterns** (assumption 5). If it doesn't, a phone request could reach a different handler than the same path over HTTP. The plan pins a test that compares every remote v1 pattern against `Bun.serve`.
- **The registry public key and the revocation list are always read from the key helper**, never cached (assumption 3). If they're cached, an agent can plant its own registry key.
- **A tmux terminal over the relay is usable within 50 frames/s and 2 MB per 10 s.** If it isn't, output batching needs coarser frames, and the terminal may feel laggy. This is verified in the integration suite against the local test relay's limits.
