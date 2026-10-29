# Grill — agents can read the core's master API token

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | `docs/plans/master-token-agent-read-investigation.md` (pipeline step 1), plus grounding and one spike in this step |
| Mode | interactive, answered by the owner (alamops) in three passes |
| Flags | none |

## New evidence from this step

The investigation framed the problem as "the token gives agents more than plain same-user access" (its K10). This step found that the core also gives agents Agetor.app's macOS identity **without the token**, because it runs programs an agent can plant:

- **G1 — git `core.fsmonitor` (proven).** Spike: in a scratch repo, `git config core.fsmonitor <script>` and then `git status --porcelain` → the script ran twice (Apple Git 2.54.0). The core runs exactly that command (`hasUncommittedChanges`, `src/bun/worktree.ts:100-106`, called from the git-status route at `src/bun/server.ts:5920`) through a plain `Bun.spawn(["git", …])` (`worktree.ts:36-42`). An agent can write `core.fsmonitor` into the task repo's `.git/config`. The script then runs as a child of the core, under Agetor's TCC responsibility. Other git config keys that run programs (clean/smudge filters, textconv, hooks on `git commit` in the commit-and-push route) work the same way.
- **G2 — harness probes (code-read).** `GET /harnesses` (polled every 15 s by the webview) runs `checkAllHarnesses()` (`server.ts:3903`), which spawns `[bin, "--version"]` and `[bin, "--help"]` straight from the core (`src/bun/agent-status.ts:90, 133, 177`). `bin` lives in SQLite and is editable through harness CRUD or a direct database write.
- **G3 — the disclaim switch (code-read).** `disclaimEnabled()` reads `disclaimSpawnedAgents` from SQLite on every spawn (`src/bun/disclaim.ts:90-95`). An agent can write the row directly and kill the tmux server, so the next server starts undisclaimed.
- **G4 — only three spawns are disclaimed today:** the tmux server (`src/bun/tmux-resolution.ts:166`), fx (`src/bun/fx-acp.ts:3389`), and the helper itself (`disclaim.ts:103`).
- **G5 — a Keychain key can't guard on-disk state.** The investigation proposed a MAC keyed by an app-only Keychain item (brief §4.10). Keychain ACLs check the calling binary's code signature, and an agent can run Agetor's own signed `bun` binary with a script of its own and pass that check. A same-user agent can forge anything stored on disk. Only the user being present can make a stored value trustworthy. (This reasoning was not run as a spike.)

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Goal / acceptance bar | What does "fixed" mean, given G1–G3? | **Close every path.** No agent path, with or without the token, may obtain Agetor.app's macOS identity. Token and route rules **plus** every program the core spawns goes through one disclaim wrapper. Accepted tradeoff: disclaimed git and harness probes in ~/Documents or ~/Desktop projects may trigger a one-time macOS prompt for that binary. | owner |
| D2 | Branch scope | What goes in? | **Full hardening, no pairing:** token split, a route policy table and its test, desktop-only routes, `?token=` removed from both the CLI **and** the webview, stripping `AGETOR_API_TOKEN` from child env, dev token file at 0600, docs. Native pairing waits for the Companion app; its rules are recorded in docs (D15). | owner |
| D3 | Credential shape | One token or two, which field? | **Two tokens, same field.** The master stays in memory only: the webview gets it through preload and the hash, e2e and dev through `AGETOR_API_TOKEN`. A new per-launch **CLI token** is written to `agetor-core.json` under the existing `token` field, so older installed CLIs keep working (investigation A5). Headless keeps its own master: random, or the env override. | owner |
| D4 | Disclaim switch, write path | How does turning it off work? | **Native-only.** Turning it **off** is possible only from the app's Settings, which uses the master token. The CLI token is refused (value-level rule: turning it **on** is allowed everywhere). `agetor config disclaimSpawnedAgents false` returns the desktop-only error. | owner |
| D5 | Disclaim switch, stored value | How is a stored "off" trusted? (G5 corrected D4's first framing, the Keychain MAC) | **Confirm at launch.** The core reads the switch only at launch and keeps it in memory. A change in Settings applies immediately. If storage says "off" at launch, a native dialog (`Utils.showMessageBox`, buttons only) asks whether to keep it off; the default button turns it back on, and the switch stays **on until the user answers**. A direct SQLite write does nothing until a relaunch, and then the user sees the dialog. | owner |
| D6 | Disclaim switch on headless | Headless can't show a dialog | Headless **ignores a stored "off" and always disclaims**, and logs one line saying so. | owner (default accepted) |
| D7 | One switch | Does the switch cover the core's own programs too? | **One switch.** "Off" (confirmed at launch) restores today's behavior for agents **and** core spawns. Reword the Settings label and help to say it also covers Agetor's background programs. | owner |
| D8 | Spawn-wrapper exemptions | What keeps Agetor's identity? | **osascript and terminal tabs.** "Open terminal" and "Open tmux" need Agetor's Automation grant, and both become desktop-only. Terminal tabs (`terminals.ts:265`) stay undisclaimed as the user's own shell and are reachable only from the app after this change. Also exempt: tmux **client** calls (the server is already disclaimed), the notifier helper bundle, and the disclaim helper itself. A static test fails on any raw `Bun.spawn`/`spawnSync` outside the wrapper's allowlist. *(Against the recommendation, which was osascript only: a claude or codex the user starts in a tab gets Agetor's permissions.)* | owner (tabs); default (rest) |
| D9 | Desktop-only routes | Which routes need the master? | Master only: terminals and their WS upgrade, `/harnesses/:id/open-terminal`, `/tasks/:id/open-tmux`, `/files/preview`, `/tasks/:id/diff/blob`, `/open-path`, `/reveal-path`, `/open-external`, `/refs/pick`, `/refs/drag`, `/projects/pick`, `/bundle/pick-file`, `/bundle/export/save`, `/window/*`, `/app/force-quit`, `/updates/*`, `/screenshots`, `/attachments`, `DELETE /notifications/:taskId`, `POST /tmux-source`, and `PUT /preferences/disclaimSpawnedAgents` with the value `false`. **Stay CLI-scoped:** everything `AgetorClient` calls, including `POST /notifications` (`agetor logs --notify`), other `/preferences` keys, harness CRUD and `/harnesses/:id/shell-env`, `/db/*`, `/bundle/export`, `/bundle/import*`, `/daemon/shutdown` (the app↔daemon handoff), `/info`, `/github/*`. | owner (default accepted) |
| D10 | Harness CRUD | Keep it CLI-scoped? | **Yes.** Once D1 disclaims the probes, a planted `bin` runs as the same user without Agetor's identity, which an agent can already do. | default accepted (follows from D1) |
| D11 | Refusal, app | What does the CLI token get on a desktop-only route? | On the **app**: `403 {error: "only available in the Agetor app", code: "desktop-only"}`. The CLI prints it as a plain sentence. | owner |
| D12 | Refusal, headless | Headless split | Routes that answer **501 on headless today keep 501** for every caller. Desktop-only routes that **work on headless** (terminals, `/files/preview`, `/tasks/:id/diff/blob`, `/screenshots`, `/attachments`, `/tmux-source`, disclaim-off) answer the CLI token with **403 desktop-only**; the master (e2e, dev) still reaches them. *(Against the first recommendation, which was a uniform 403.)* | owner |
| D13 | `?token=` | Replace query-string auth how? | The **master is never accepted in a query string.** The **CLI token** is still accepted on SSE GETs for older installed CLIs (deprecated), and the new CLI sends a header (`src/cli/sse.ts:36`). Webview: SSE through a fetch reader with a header, the terminal WS through a single-use short-lived ticket minted by an authed POST, `<img>` routes through fetch → `blob:` URL. | owner (default accepted) |
| D14 | Policy shape | How are scopes expressed? | A **per-route policy entry at `authed()`** (`server.ts:453`), shaped as `{callers: webview \| cli, remote: none, …}`, **deny by default**, with a test that every route has an entry. The Companion phone's remote levels become extra fields later. The Companion spike agent proposed this; there is **no `hook` caller**, since hooks were removed in #54. | owner (default accepted); peer proposal |
| D15 | Future pairing rules | Record them now? | Write `docs/plans/companion-pairing-requirements.md`: pairing, enabling remote access and raising a device's permissions are **native-only** (a Swift helper or an RPC window, never HTTP and never the webview); the code is **shown on the phone and typed on the Mac**; revoke and disable may be HTTP/CLI; device-registry integrity needs **the user to be present**, because a Keychain MAC alone is bypassable (G5). | owner (default accepted) |
| D16 | Env hygiene | Strip the token from children? | Strip `AGETOR_API_TOKEN` (and the CLI token, if it is ever exported) from the env of every child: tmux clients, terminal tabs, fx, and anything that goes through the wrapper. | owner (default accepted) |
| D17 | Dev token file | `dev-headless.sh` writes it 0644 | Write it **0600**. | owner (default accepted) |
| D18 | Docs | Which docs change? | README security model (it must say plainly that agents can read the CLI credential and what that credential can't reach), CLAUDE.md "Stack and architecture" and the disclaim paragraph, stale hooks/MCP text in `api-config.ts:18-31, 68` and `claude-tmux.ts:8121-8125`. **README wording is reviewed at plan time.** | owner (default accepted) |
| D19 | Stale `.claude/CLAUDE.md` | It tells agents to use an `ask_user` MCP tool that #54 removed | **Delete those instructions** in this branch. | owner (default accepted) |
| D20 | "Open terminal" residual | It runs the harness `bin` in Terminal.app, under Terminal's identity, and an agent could swap `bin` | **Accepted residual.** The user triggers it from the app and sees the command in the Terminal window. | owner (default accepted) |
| D21 | Acceptance | What does "done" mean? | `bun run typecheck`, `bun test` and the **full Playwright suite** pass. A new policy test checks that every route is classified, every `AgetorClient` route is CLI-scoped, no pair/device/permission route sits in any HTTP scope, and desktop-only routes return 403 (or 501 per D12). CLI routes that tests used to mock (investigation S4: `startTask`, `sendInput`, `cancelRun`, the answer routes, the pipeline routes, notifications, DB tools, the files index, the issue thread) run against a real core with the file token. The spawn-wrapper static test (D8) passes. The spikes are re-run on a throwaway core (never `~/.agetor`): desktop-only routes refuse the file token, disclaim-off is refused, and the fsmonitor program from G1 runs through the disclaim wrapper (verified with an `AGETOR_DISCLAIM_BIN` recording stub). | owner (default accepted) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Token split, CLI token in the file (D3) | in this change | — |
| Route policy table, deny by default, and its test (D14, D21) | in this change | — |
| Desktop-only routes (D9, D11, D12) | in this change | — |
| Value-level disclaim-off refusal (D4) | in this change | — |
| Read the switch at launch plus a native confirm (D5); headless always on (D6) | in this change | — |
| One disclaim wrapper for every core spawn, its allowlist and a static test (D1, D7, D8) | in this change | — |
| `?token=` out of the CLI (header) | in this change | — |
| `?token=` out of the webview: SSE, terminal WS ticket, `blob:` images (D13) | in this change | owner chose the full option over deferring it to Companion Phase 0 |
| Old-CLI `?token=` compatibility on SSE for the CLI token (D13) | in this change (kept, deprecated) | removing it is a later ticket once old CLIs are gone, and not unfinished work: the CLI token is agent-readable anyway |
| Env strip (D16), dev token at 0600 (D17) | in this change | — |
| Docs (D18), stale `.claude/CLAUDE.md` (D19) | in this change | — |
| Companion pairing requirements doc (D15) | in this change (doc only) | — |
| Settings label and help reworded for the one switch (D7) | in this change | — |
| Real CLI coverage for routes that were mocked (D21) | in this change | — |
| Native pairing UI and device registry | out of scope | Companion v1 feature; nothing to pair with yet (owner, D2) |
| Disclaiming terminal tabs | out of scope | owner decided tabs keep Agetor's identity (D8) |
| Hardening git with `-c core.fsmonitor=…` and similar overrides | out of scope | superseded by the spawn wrapper (D1); a planted program still runs, but only as the same user |
| `POST /tasks` answering 500 to unparseable JSON instead of 400 | out of scope | unrelated bug, separate ticket |
| `~/.agetor/github-tokens.json` readable by agents | out of scope | a different credential with no escalation beyond the user's own git-host access (investigation K18) |
| Sandboxing agents | out of scope | product direction (investigation A2) |

## Assumptions still open

- **The packaged app's own helpers can't be tampered with.** `disclaimArgv` fails open when the helper is missing (`disclaim.ts:85-89`). In the packaged app, macOS App Management protection blocks a disclaimed agent from replacing or deleting files inside the signed `Agetor.app` bundle. *If wrong:* an agent could delete or replace `vendor/disclaim/disclaim` and every spawn would silently run undisclaimed, so the wrapper would have to fail closed for core spawns. Dev builds that run from the repo are not protected and are not a target.
- **The launch-time dialog can't be forged or answered by an agent.** `Utils.showMessageBox` is native; an agent can't click it without the Accessibility permission, which disclaimed agents don't inherit. *If wrong:* D5 gives no protection.
- **Disclaim costs little per spawn.** The helper exec-replaces itself (`POSIX_SPAWN_SETEXEC`), so each git or probe spawn pays one extra exec of a few milliseconds. Not measured. *If wrong:* hot paths such as the git-status poll may need batching, or a narrower wrapper.
- **The prompt for disclaimed git in protected folders is acceptable to users.** It is the same tradeoff task agents already have (CLAUDE.md, TCC disclaim). Not measured for git specifically. *If wrong:* the default for the one switch may need revisiting before release.
- **Older installed CLIs.** An old CLI reading the new file gets the CLI token and works for CLI routes. It still sends `?token=` on SSE, which D13 keeps accepting for the CLI token.
- **The webview's in-memory master stays out of agents' reach** (investigation A6) until a webview compromise. This is why D15 keeps pairing native-only.
