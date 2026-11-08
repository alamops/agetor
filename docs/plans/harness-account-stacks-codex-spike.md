# Spike — Codex `CODEX_HOME` isolation (harness stacks T00)

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| CLI | `codex-cli 0.166.0` (`command -v codex`) |
| Opt-in test | `src/bun/codex-home-spike.test.ts` (`AGETOR_REAL_CODEX=1`) |
| Feeds | T11 (codex env), T12 (rollout transfer / `thread_history`) |

The harness-stack plan (`docs/plans/harness-account-stacks.md` §4.2 T00) needed
four answers before Codex could join a stack. This is the evidence and the
recommendation.

## Verdict — drop the codex `HOME` override

**`CODEX_HOME` alone isolates codex.** With a fresh `HOME` and a fresh
`CODEX_HOME`, `codex` reads and writes only under `CODEX_HOME`; it does not see
the real `~/.codex` login. Therefore `harnessEnv` emits only
`CODEX_HOME=<home>/.codex` for a Codex account, and the account keeps the
user's real `HOME` (so `~/.gitconfig`, `~/.ssh`, `~/.config/gh` etc. remain
available). This changes every Codex alias, not only stack members.

Commands (values are a temp dir; no token is printed):

```sh
TMP=$(mktemp -d); HOME_DIR=$(mktemp -d)
env -i HOME="$HOME_DIR" PATH="…" CODEX_HOME="$TMP" codex --version
# codex-cli 0.166.0
find "$TMP" -maxdepth 2        # only $TMP/tmp/arg0-macos (argv0 bookkeeping)

env -i HOME="$HOME_DIR" PATH="…" CODEX_HOME="$TMP" codex login status
# Not logged in            <- the real ~/.codex/auth.json was NOT read

env -i HOME="$HOME_DIR" PATH="…" CODEX_HOME="$TMP" codex mcp list
# No MCP servers configured yet.   <- the real config.toml was NOT read
```

## Q2 — stale `thread_history_*.sqlite` shadowing a copied rollout

**Not proven on this machine: it needs a real login (the owner's explicit
`AGETOR_REAL_CODEX=1`).** What is known from the binary:

- `thread_history_1.sqlite` is a projection DB;
- `codex migrate-rollouts --apply` exists and is the documented repair;
- `codex exec resume <uuid>` resolves a thread id (S2 in the investigation
  proved `thread.started` is emitted before a 401).

Implementation follows the plan's "contingency, never silent" rule: the Codex
adapter copies the rollout to the same relative path under the destination
`CODEX_HOME`, then, when the destination already contains
`thread_history_*.sqlite`, runs `codex migrate-rollouts --apply` via
`coreSpawn` with a 30 s timeout. A migration failure is a warning; if the
resume then fails the swap blocks with a clear message. A task is never
silently restarted on a fresh session.

## Q3 — where Codex stores MCP OAuth

The binary exposes `mcp_oauth_credentials_store = "auto"` with modes
`file | keyring | auto | ephemeral`, and a `mcp-oauth-locks/` dir. It does not
expose a stable standalone filename for the file mode (`strings` shows the
store abstraction and "OAuth file disappeared", not a path).

**Decision (deviation, §8 of the plan): do not copy MCP OAuth tokens.** The
mirror copies `config.toml`'s MCP *definitions*; the swap status line warns
that MCP sign-in may need repeating on the backup. Copying a credential store
we cannot name or validate would violate the "never copy credentials" rule.

## Q4 — `[projects.*]` trust for a fresh `CODEX_HOME`

**Not verified.** The mirror deliberately never copies `[projects.*]` trust
entries (directory trust is per-account and security-sensitive), and the swap
does not add one. If codex refuses an untrusted cwd, the failure is the
provider's own message on the successor run; the task blocks visibly and the
user can add trust on that account. A follow-up can add exactly the task
worktree's entry if this becomes common.

## Consequences

- T11: codex `harnessEnv` drops `HOME` (done; tests updated).
- T12: rollout copy + best-effort `migrate-rollouts` (done).
- T04/T16: the security review records the MCP-OAuth deviation.
- `src/bun/codex-home-spike.test.ts` reproduces the proven part against the
  real binary when `AGETOR_REAL_CODEX=1`, and skips loudly otherwise.
