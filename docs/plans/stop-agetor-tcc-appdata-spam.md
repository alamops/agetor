# Plan — Stop "Agetor would like to access data from other apps" TCC spam

| Field | Value |
| --- | --- |
| Date | 2026-09-10 |
| Source | `/implement` — "fix agetor spamming this permission request" + screenshot of the macOS `SystemPolicyAppData` dialog |
| Config | AGENTS_CONFIG.yml (balanced preset) |
| Flags | none |
| Gates | grilled + approved by owner (chose "disclaim + dedicated tmux socket" and "harden Cursor poller") |
| Branch | fix/fix-access-data-permission-spam (already on it) |
| Base SHA | fe65199c93ad6bc74b59972d1da31de669620976 |

## 1. Objective & success criteria

**Objective:** Stop macOS from repeatedly prompting "**Agetor** would like to access data from other apps." (`kTCCServiceSystemPolicyAppData`).

**Success criteria:**
1. A running `claude`/`codex`/`cursor`/`gemini`/`fx` agent that touches another app's data no longer produces a prompt *named "Agetor"* — the child process is TCC-responsible for itself, so any prompt names the agent binary and, once allowed, **persists** instead of re-prompting.
2. Agetor's own bun process never trips the same gate unprompted in the background (Cursor usage read hardened).
3. Behavior is reversible via a Settings toggle (default on, macOS only).
4. Existing unit/e2e suites stay green; typecheck clean.

## 2. Context & constraints (grounded findings from Phase 1)

- **Root cause = TCC responsibility inheritance.** Unified-log evidence (`log show --predicate 'subsystem=="com.apple.TCC"'`): over 6h, **69 of 70** `SystemPolicyAppData` prompts had the **`claude` CLI** (`~/.local/share/claude/versions/2.1.267`) as the *responsible/accessing* binary, every one with `subject=Sub:{sh.alamops.agetor}` — i.e. named "Agetor". **Zero** came from agetor's own bun process. Agetor spawns the tmux server (and thus `claude`) via `Bun.spawn`, so children inherit agetor's TCC "responsible process" identity (`src/bun/claude-tmux.ts:1461` `tmux()`, and `spawnTmuxNewSession` in `src/bun/tmux-resolution.ts:132`). When a child reads another app's `~/Library/Application Support/<App>` (machine has `Cursor`, `Claude`, `CodexBar`, `chrome-devtools-mcp` dirs), macOS blames Agetor. The grant never persists because the responsible *identity* (agetor) ≠ the accessor *binary* (claude).
- **Agetor's own grant already persists** (Developer-ID signed, hardened runtime) — that's why the Cursor-usage poller (`src/bun/usage/cursor-usage.ts` reads `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` every `USAGE_POLL_SWEEP_MS`=10 min via `existsSync`+`bun:sqlite`) isn't the *current* spam, but it IS a latent fnm-class bug (identical to the shipped fnm fix, commit `4cb3be3`) that prompts a fresh user once.
- **Agetor cannot stop the child's access** — the spawned claude loads only the `jubarteai` remote MCP (verified in `~/.claude.json`), so the accessor is claude-code itself / user-global plugins. Agetor's only lever is TCC responsibility.
- **The fix is `responsibility_spawnattrs_setdisclaim`** (private but ubiquitous — Claude Desktop ships a `disclaimer` helper doing exactly this; `torarnv/disclaim`, Qt's "Curious Case of the Responsible Process"). Spawned via a tiny signed C helper (lower-risk than bun:ffi argv/envp marshaling). No entitlement required; notarization does not enforce the private-API list (App-Store-only policy). **Reparenting to launchd does NOT reset responsibility** (confirmed — agetor's tmux server is already PPID 1 yet still blamed), so there is no non-private-API escape.
- **Spike verdict (research, cited):** disclaiming works, but a disclaimed child **loses the parent's inherited TCC grants** (Anthropic claude-code issue #64685 shows `git: Operation not permitted` inside `~/Documents` even with parent FDA). **Blast radius for this user ≈ zero:** all task workdirs are under `~/Projects/…` (not a TCC-protected folder), worktrees under `~/.agetor/` (unprotected). Protected folders are only Desktop/Documents/Downloads/iCloud/Removable/Network + FDA scope.
- **Structure:** all four tmux drivers thread `tmuxSocketArgs()`; codex/cursor/gemini share `spawnTmuxNewSession`; claude uses its own `tmux()`. fx (`src/bun/fx-acp.ts:2413`) is a plain `Bun.spawn`, no tmux. Prod tmux socket is currently the **shared default** (`tmuxSocketName()` returns `null`), which makes disclaim only best-effort — hence the dedicated-socket decision.
- **Build precedent:** agetor already compiles + ships a native arm64 helper (`AgetorNotifier.app` via `scripts/build-notifier.ts`, `vendor:notifier`, `electrobun.config.ts` `build.copy` `"vendor/notifier": "bin"`, `codesign:true, notarize:true`). The `disclaim` helper drops straight into that pattern.

## 3. Approach & key decisions

**Mechanism (decided over per-spawn wrapping):** give agetor a **dedicated, per-instance tmux socket** and **start that server once through the disclaim helper before any other tmux command** (`disclaim tmux -L <socket> start-server`). The server daemon inherits self-responsibility, so *every* session it later hosts (claude/codex/cursor/gemini) is self-responsible — no need to wrap each `new-session`. fx has no server, so its `Bun.spawn` argv is wrapped directly (`disclaim fx acp …`; the helper uses `POSIX_SPAWN_SETEXEC` so it exec-replaces itself, preserving Bun's pid + stdio pipes).

- **Dedicated socket is unconditional** (the enabler + isolation from the user's own terminal tmux). Socket name derived from the data-dir basename (`~/.agetor`→`agetor`, `~/.agetor-dev`→`agetor-dev`), so dev/release/custom dirs get separate servers. `NODE_ENV=test`→`agetor-test` and `AGETOR_TMUX_SOCKET` override are unchanged.
- **Disclaim toggle** (`preferences` key `disclaimSpawnedAgents`, default **on**, macOS only) gates only whether `start-server`/fx-spawn are disclaim-wrapped — *not* the socket — so toggling off never churns sessions. Also honored: `AGETOR_DISCLAIM_BIN` (test seam) and skip on non-darwin / helper-missing (fail-open to today's behavior).
- **`ensureDisclaimedServer()`** called (a) at boot before `reconcileOrphans()` (`index.ts:133`, `headless.ts:134`) and (b) defensively before each `new-session` (in `spawnTmuxNewSession` and before claude's `tmux(tmuxArgs)`), idempotent (`start-server` no-ops on a live server).
- **Cursor poller hardening:** the cross-app IDE-DB read runs only when `opts.force` (explicit user Refresh) **or** a prior Cursor snapshot already exists (grant already decided). The background sweep with no prior snapshot returns `unavailable` with actionable copy and touches nothing under `~/Library`. This eliminates the cold-start prompt while preserving background refresh after first consent (grant persists for the signed bun process).

**Decisions resting on spike evidence:** the disclaim tradeoff (§2, issue #64685) and reparent-doesn't-reset (§2). **Rests on reasoning, to verify manually:** that tmux's server daemonization preserves the disclaimed responsibility across its own fork (see §8 — the one load-bearing unknown a unit test can't cover; contingency: also wrap `new-session` with disclaim).

## 4. Work breakdown — implementation tasks

- **A — disclaim helper + build + resolver module.** Owns: `native/disclaim/disclaim.c` (≈40 lines: `posix_spawnattr_init` → `setflags(POSIX_SPAWN_SETEXEC)` → weak/dlsym `responsibility_spawnattrs_setdisclaim(attr,1)` → `posix_spawnp(argv[1], argv+1, envp)`; usage error if no args), `scripts/build-disclaim.ts` (clang `-arch arm64 -O2`, mirrors `build-notifier.ts`), `package.json` (`vendor:disclaim` script + prepend to `build`/`build:canary`/`build:stable`), `electrobun.config.ts` (`"vendor/disclaim": "bin"`), **new** `src/bun/disclaim.ts` (`resolveDisclaimBin()` packaged/dev/`AGETOR_DISCLAIM_BIN`; `disclaimEnabled()` = darwin && pref!=false && helper present; `disclaimArgv(argv)` passthrough-or-prepend). Acceptance: `vendor/disclaim/disclaim /bin/echo hi` prints `hi`; `disclaimArgv` unit-tested.
- **B — Cursor poller hardening.** Owns: `src/bun/usage/cursor-usage.ts` (thread `{ allowIdeRead }` into `fetchCursorQuota`/`discoverCursorCookie`/`readCursorIdeCookie`; when false, skip `existsSync`+DB entirely, return `unavailable` + "Click Refresh…" reason), `src/bun/usage/poller.ts` (provider type gains optional opts; `refreshOne` computes `allowIdeRead = force || harnessUsage.get(id)!=null` and passes it), plus `cursor-usage.test.ts`, `poller.test.ts`. Acceptance: background+no-snapshot never stats `~/Library`; force reads; snapshot-exists background reads.
- **C — socket + disclaimed server + spawn wiring.** Owns: `src/bun/tmux-resolution.ts` (prod `tmuxSocketName()` derivation; `ensureDisclaimedServer()` using `disclaim.ts`; call it in `spawnTmuxNewSession`), `src/bun/claude-tmux.ts` (call before its `new-session`), `src/bun/index.ts` + `src/bun/headless.ts` (call before `reconcileOrphans`), `src/bun/fx-acp.ts` (wrap `Bun.spawn` argv via `disclaimArgv`), `src/bun/tmux-resolution.test.ts`. Depends on A (`disclaim.ts`). Acceptance: socket name unit-tested across dev/release/test/override; ensureDisclaimedServer emits `disclaim tmux -L … start-server` when enabled, plain when off.
- **D — toggle UI + docs.** Owns: Settings "General" toggle writing `disclaimSpawnedAgents` via `api.setPreference` (same path as `theme`), `CLAUDE.md` (§5 socket change + a disclaim subsection). Disjoint from A/B/C. Feature works without it (default on).

## 5. Work breakdown — test tasks

Unit/integration (bun test), authored with each task above plus a fill-in pass: `disclaim.ts` (resolver precedence, enable gating incl. non-darwin, `disclaimArgv`), `tmux-resolution` (socket derivation, `ensureDisclaimedServer` command shape with disclaim on/off via `AGETOR_DISCLAIM_BIN=/bin/echo`), cursor gating, poller opts plumbing, a helper smoke (`disclaim /bin/echo`). **e2e: not applicable to the TCC behavior** — not observable in the headless/fake-driver Playwright harness; the existing suite runs as a **regression guard** only (tmux tests use `NODE_ENV=test`→`agetor-test`, unaffected by the prod socket rename).

## 6. Execution waves

- **Wave 1 (parallel, disjoint):** A ‖ B.
- **Wave 2 (parallel, disjoint; after A):** C ‖ D.
- **Wave 3:** review → fill-in tests → run → fix to green.

## 7. Blast radius & risks

- **Dedicated socket:** in-flight sessions on the old default socket at upgrade become unreachable → existing `orphaned→ready` path handles them non-destructively (user re-runs). Documented; cross-socket reattach migration is **out of scope** (§9).
- **Disclaim tradeoff:** agents in TCC-protected folders may need their own one-time grant — ~zero impact for this user (`~/Projects`). Documented in the toggle's help text.
- **tmux daemonization preserving disclaim** — the one unverifiable-in-unit-test assumption (§8).
- **Reversible:** toggle off returns to inherited responsibility on next server start; no persistent state, no migration.

## 8. Open questions / assumptions

- **Assumption (to verify in Phase 7 manual runbook, signed build):** starting the tmux server via `disclaim` makes hosted claude sessions self-responsible (prompt names claude/tmux, not Agetor, and persists). Verify with `log show --predicate 'subsystem=="com.apple.TCC"'` → responsible binary is no longer `sh.alamops.agetor` for a spawned-agent access. **Contingency if false:** additionally wrap each `new-session` argv with `disclaimArgv` (cheap; new-session is infrequent).
- Narrow self-correcting window: if the server dies mid-run and a control command (not new-session) auto-restarts it before the next `ensureDisclaimedServer`, that restart is non-disclaimed until the next new-session. Accepted + documented.
- Separate, NOT in scope: the `kTCCServiceAppleEvents` "hardened runtime … entitlement missing" lines from `AgetorNotifier` (Electrobun helper) — a *different* service/dialog than the screenshot, likely silently denied, not the reported spam.

## 9. Completeness ledger

- **In this run:** disclaim helper + build wiring (A); all five agent spawn paths covered — claude/codex/cursor/gemini via the disclaimed dedicated server, fx via wrapped `Bun.spawn` (C); dedicated per-instance socket + boot server start (C); Cursor poller cross-app read gated (B); reversible toggle (D); tests at every enabled layer; CLAUDE.md updated (D).
- **Out of scope (different ticket, with reason):** cross-socket reattach so in-flight sessions survive the one-time socket switch — the existing `orphaned→ready` path already handles unreachable sessions gracefully; building socket-straddling reattach is disproportionate to a one-time, non-destructive upgrade cost. The `AppleEvents`/notifier prompts — a different TCC service and dialog than the one reported.
- **Owner-deferred:** none (owner chose the thorough path).
