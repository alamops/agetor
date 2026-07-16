# Plan — Grok privacy defaults (block repo-data upload)

| Field | Value |
| --- | --- |
| Date | 2026-07-16 |
| Source | /implement — public posts re: Grok Build uploading repo data by default; disable by default in agetor |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/21f644e90eb8-grok-build-code-integration (continuing) |
| Base SHA | 44d655b671e513849a0b7a5a6a975153dafad2ff (tree clean apart from this plan file) |

## 1. Objective & success criteria

Every grok spawn from agetor ships with xAI's repo-data-upload paths disabled via environment variables, while an explicit same-named env in a harness's env config still wins (owner decision: default, not hard block). Done = env asserted in tests, typecheck + grok suites green, CLAUDE.md documents it.

## 2. Context (source-verified, github.com/xai-org/grok-build @ c68e39f6)

- **Trace-upload pipeline** ("always-on upload queue", `xai-file-utils/src/upload_config.rs:1-2`): per-turn artifacts incl. `memory.tar.gz` (session logs) → GCS (`xai-grok-shell/src/upload/gcs.rs`); skip-list excludes dirs, NOT a file named `.env` (`upload_config.rs:49-81`). Gated by telemetry flags; **telemetry can be enabled remotely per account via server-pushed settings**. Matches the July-12 "cereblab" wire-capture reporting (entire tracked repo + history uploaded; retention toggle ineffective pre-fix). Auth-diagnostics uploads ride the same gate.
- **Session writeback sync**: `StorageMode` precedence CLI > env `GROK_STORAGE_MODE` > **remote `writeback_enabled` (server can silently flip it)** > default Local (`xai-grok-shell/src/config/mod.rs:777-811`). Backend *pull* on resume exists too; agetor's resume is disk-gated locally so `local` mode loses nothing.
- **Flag precedence** (`xai-grok-config-types/src/flags.rs:101-129`): `requirement > cli > env > config > managed > remote > default` — **env beats both user config and remote pushes**.
- **Sandbox cannot block it**: in-process HTTP is exempt from `restrict_network` by documented design (`docs/user-guide/18-sandbox.md:189-190`).
- **Env-only is the right vehicle**: writes nothing into the user's real `~/.grok` (default harness) and works identically for alias harnesses. `env_bool` accepts `0/false/no/off/disabled`.
- agetor surface: `harnessEnv(harness)` in `src/bun/agents.ts` builds the grok env (`GROK_HOME` mapping + harness `env` overrides); `spawnGrokViaTmux` forwards `opts.env` as tmux `-e` pairs; reattach spawns no process (n/a); `checkHarness`'s `--version` probe also uses `harnessEnv` (harmless).

## 3. Approach & decisions

- **D1**: inject `GROK_TELEMETRY_ENABLED=0`, `GROK_TELEMETRY_TRACE_UPLOAD=0`, `GROK_STORAGE_MODE=local` into `harnessEnv`'s grok branch **before** merging the harness's own `env` map, so a user's explicit same-named entry (Settings → harness env) overrides agetor's default (owner-approved). Verify the existing merge order supports this; adjust ordering only within the grok branch if needed.
- **D2**: no UI; documented in CLAUDE.md's grok bullet (what uploads, why env, override path). No change for claude-code/codex.
- **D3**: `GROK_STORAGE_MODE=local` included — resume is locally disk-gated already; losing backend pull is intentional (that path implies prior upload).

## 4. Work breakdown

- **T1** `src/bun/agents.ts` + `CLAUDE.md` — the injection (D1) + docs (D2).
- **TT1** `src/bun/agents.test.ts` — grok spawn env contains the three defaults; harness env_json override wins; claude-code/codex env untouched; existing grok env tests still pass.

## 5. Execution

T1 → typecheck → opus review of the diff → TT1 → run grok-related suites + full typecheck → commit(s).

## 6. Blast radius & risks

- Users who WANT xAI telemetry: supported via harness env override (D1).
- xAI could rename the env vars in a future release — the vars are harmless if unrecognized (ignored env); revisit on CLI updates. The repo is one squashed commit; the pre-fix gate wiring is inference, but env precedence is current-source fact.
- `checkHarness` probe now carries the vars — no-op for `--version`.

## 7. Assumptions

- A1: no agetor-level UI toggle needed (env override suffices).
- A2: the three var names are current as of c68e39f6; a live-binary smoke remains pending for the whole grok integration.
