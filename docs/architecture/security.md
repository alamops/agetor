# API security: tokens, route policy, path gate and macOS TCC disclaim

> Moved from `CLAUDE.md`, where this was the localhost-API paragraph of “Stack and architecture” plus the “macOS TCC responsibility (disclaim)” bullet of “Claude session lifecycle”. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

The browser ↔ main connection is intentionally a localhost HTTP API (`Bun.serve` on `AGETOR_API_PORT`, default `4317`), not Electrobun's RPC.

**The API binds to `127.0.0.1` by default** — the desktop app always does; only the headless core (`headless.ts`) honors `AGETOR_API_HOST`, validated by `resolveApiHost()` in `api-config.ts` to `127.0.0.1`/`localhost`, `0.0.0.0` or `::` (anything else refuses to start, because every client — webview, CLI, creds probes
— connects over `127.0.0.1`, which `localhost`/`::1` (IPv6-only under Bun on macOS) or a specific interface IP would break), and passed to `startApiServer({ hostname })`, which logs a one-line plain-HTTP/cleartext-token warning for a wildcard bind — and gates every route (except `/health`) on one of **two per-launch random tokens** from `src/bun/api-config.ts`, compared in constant time (`timingSafeEqual` in `route-policy.ts`'s `resolveCaller`) since a wildcard bind makes them network-reachable (`docs/plans/master-token-agent-read.md`, which holds the rationale and decisions D1–D26).

**Why two:** any program running as the user — an agent included — can read `~/.agetor/agetor-core.json`, so a token in that file can't also be the app's own authority.
The **master token** (`API_TOKEN`) lives in memory only: it reaches the webview through the `preload` script (`window.__AGETOR`) and, on the Vite dev path, the `#api=…&token=…` hash fragment (**not** query string — the bundled `views://` scheme handler treats anything after the scheme as a literal file path and would otherwise look for a file named `mainview/index.html?api=…`); e2e and local debugging set it with `AGETOR_API_TOKEN`, which `api-config.ts` **deletes from `process.env` as it reads it** so no child inherits it.
The **CLI token** (`CLI_TOKEN`, random per launch, no env override) is the only one written to `agetor-core.json` — still under the old `token` field, so already-installed CLIs keep working — and so the headless daemon's file carries the CLI token too.

**What each token reaches is `ROUTE_POLICY` in `src/bun/route-policy.ts`**, one entry per route+method of `server.ts`'s `routes:` object, **deny by default**: `applyRoutePolicy` wraps every handler (the walker also answers CORS preflight itself on function-valued routes, because header auth makes every webview request preflight), resolves the caller (`app` = master, `cli` = CLI token) and refuses at the door, and `startApiServer` **throws at startup** on a route with no entry, an entry with no route, or per-method keys that don't match (`route-policy.test.ts` scans `server.ts` for the same facts).
`callers: "app+cli"` is everything `AgetorClient` calls; `callers: "app"` is the desktop-only set (terminals and their WebSocket, `/files/preview`, `/tasks/:id/diff/blob`, `/open-path`, `/reveal-path`, `/open-external`, `/refs/pick`, `/refs/drag`, `/projects/pick`, `/projects/repo-root` (the Select Projects dialog's git-root lookup; no CLI or TUI caller, so it declares no `pathParams`), `/bundle/pick-file`, `/bundle/export/save`, `POST /harnesses/:id/usage/refresh` (a forced refresh grants the usage poller's in-process read of Cursor's IDE database
— for this launch only: the consent is kept in memory, never inferred from the agent-writable `harness_usage` table), `/window/*`, `/app/force-quit`, `/updates/*`, `/screenshots`, `/attachments`, `DELETE /notifications/:taskId`, `POST /tmux-source`, `/harnesses/:id/open-terminal`, `/tasks/:id/open-tmux`, `POST /background` (turning "Keep Agetor running in the background" ON) and `POST /background/open-settings`, both flagged `headless501` (their handlers answer 501 on a headless core unless `AGETOR_FAKE_LOGIN_ITEM=1`;
the flag only changes the CLI token's answer, 501 headless vs 403 `desktop-only` on the app), and the test-only `/test/block-event-loop`), which answer the CLI token `403 {code: "desktop-only"}` on the app; on a **headless** core the 14 routes flagged `headless501` keep their pre-existing `501` for every caller, and the rest of the desktop-only set (they work headless) answer the CLI token `403` while the master still reaches them.
Three value-level rules sit in handlers rather than the table: `PUT /preferences/disclaimSpawnedAgents` with an "off" value is refused for the CLI token (and on a headless core the stored value is accepted but ignored — see the disclaim paragraph); `PUT /preferences/tmux_source` is refused for the CLI token (it would sidestep the desktop-only `POST /tmux-source`) and, for the app, validated and applied through `setTmuxSource` so the cached source stays in sync;
and `POST /daemon/shutdown` stays `app+cli` (`agetor daemon stop` quits the app through its normal quit-confirm, as a complete quit (`requestQuitCompletely`) so a parked supervisor doesn't take the port back; optional body `{mode?: "stop"|"handoff"}`, absent or invalid = `stop`, where `handoff` is the app taking the port from a headless core
— see [always-on-host.md](always-on-host.md)), deleting `agetor-core.json` itself only on a headless core — on the app the `before-quit` handler removes it once the quit is allowed, so a cancelled quit doesn't strand the CLI; the **background routes** ([always-on-host.md](always-on-host.md)) are `GET /background[?fresh=1]`, `DELETE /background` and `POST /background/start` `app+cli` (read, turn off, start now), `POST /background` and `POST /background/open-settings` desktop-only (above), and `GET`/`DELETE /remote-access` `app+cli`
— turning remote access ON has no HTTP route at all: `PUT /preferences/remoteAccess` refuses every value but `"off"` for **every** caller, the app included (`403 {code:"native-only"}`; `"off"` behaves like `DELETE /remote-access`), and the only way on is the native Agetor › Remote Access… message box;
the other pair/device/remote-access routes the Companion app will need are in **no** HTTP scope (`docs/plans/companion-pairing-requirements.md`; `route-policy.test.ts` TT3(c) bans those path segments except `REMOTE_ACCESS_ALLOWLIST = { "/remote-access": ["GET", "DELETE"] }` and asserts that entry has exactly those two methods;
the `remote` field of each entry is where Companion levels go later).
`POST /app/force-quit` also takes an optional `{completely?: boolean}`.

**Credentials never ride a URL, with one exception:** the master is never accepted in a query string; `?token=<CLI token>` is still accepted (`legacyQueryToken`) on exactly the three SSE GETs that older installed CLIs open that way (the current CLI sends `Authorization` — `src/cli/sse.ts` over the shared parser in `src/shared/sse-parse.ts`), deprecated.
The terminal WebSocket can't carry a header, so the webview first `POST /terminals/:id/ws-ticket` (desktop-only, header-authed) and opens `/terminals/:id/ws?ticket=…`: a 32-byte single-use ticket, short-lived, bound to that terminal, consumed even on a mismatch; the upgrade lives in `fetch()` and accepts nothing else.
`src/mainview/lib/api.ts` echoes the master as `Authorization: Bearer …` on fetches; **every SSE stream goes through `openEventStream`** (`src/mainview/lib/sse-fetch.ts`: a streaming `fetch` with the header, reconnect with `retry:` honored, stop on 401/403/404 — not `EventSource`), and **every `<img>` backed by a byte-serving route** (`/files/preview`, diff and PR blobs) goes through `AuthedImg` (`components/ui/authed-img.tsx` over `lib/authed-blob.ts`: fetch with the header, show a ref-counted `blob:` URL, at most 3 concurrent fetches, revoke after a grace period; it fetches only once near the viewport — one shared IntersectionObserver per scroll root, `300px` margin — the queue is LIFO and never starts a cancelled entry, an image out of view releases its blob (1 s while loading, 20 s once loaded), and `loading="eager"` opts out).
CORS answers carry `access-control-max-age: 600` so each URL's preflight is cached.
A site the user happens to visit can't read either token, so even with `ACAO` set permissively, drive-by CSRF can't drive an agent run.

**CLI-caller path gate (D24):** a route that takes a filesystem path from the request declares it as `pathParams` (`{in: "query"|"body", name, mode: "exists"|"nearest-ancestor", itemField?}`; `itemField` means `name` is an array of objects and each entry's `itemField` holds the path, as in `POST /tasks`'s `repositories[].path`, which the route-policy test pins as `body.repositories[].path(exists)`) in its policy entry, and for the CLI caller the walker probes each present value — raw AND trimmed, since handlers trim (`createTask`'s `workdir`, `/projects/clone`'s `dest`) and `" /…/Documents"` would otherwise read as a missing relative path (D26) — in a **disclaimed child of Apple system tools** (`src/bun/caller-fs.ts`: `/bin/sh`, `/usr/bin/stat`, then a read-access test, because macOS TCC answers `stat(2)` on a protected path but denies the read) *before* the handler runs, refusing `403 path-not-accessible` only when the probe says denied (EPERM/EACCES or a 10 s timeout, e.g. a pending prompt) — a missing path passes through so handlers keep their own not-found answers.
`/refs/resolve` for the CLI answers from those probe results directly (a denied path drops like a failing stat), agent discovery's live project tree is read through `callerProjectTree` (a disclaimed `find -L … -print0` filtered by `shouldRead`, then `tar -L --null -T -`, parsed by `src/bun/tar-read.ts`;
a truncation at the 8 MB cap is logged) — and while the disclaim switch is on, ALL of agent discovery reads through disclaimed children for every caller, the app included (`src/bun/discovery-fs.ts`, D26: user/harness-home trees, settings, `installed_plugins.json`, plugin install dirs, codex/cursor config, and `~/.claude.json` via a disclaimed `stat`+`cat` behind a stat-keyed cache;
each `load()` stage is one direct `find -L` per (depth, name) selector shape, run in parallel, plus one `tar`, under one 15 s budget whose timeout is logged — claude-code adds a second stage for its active plugins and the `.claude.json` child, the other kinds need one stage), and `/claude-sessions/import`, `/claude-sessions/checkout` and `/opencode-sessions/import` pass a `gateCwd` for a CLI caller;
harness `home`/`bin` and absolute-path `env` values are gated the same way. `POST`/`PATCH /harnesses` first refuse any `..` component in `home`, `bin` and the config-root env values (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HOME`) with a 400, refuse (400, every caller) a non-blank config-root env value that is not absolute as given (relative, `~`, leading whitespace — a consumer would resolve it against the core's cwd), and store `home` and those values exactly as given (the stored `home`/`CLAUDE_CONFIG_DIR` spelling is the string Claude hashes into its keychain item), so the probe and every consumer see the same string; `home` and those env values are gated `nearest-ancestor` (a missing nested root under a protected folder is refused, since the stack mirror may create it) and `bin` stays `exists`. The harness-stack routes take no path from the request but act on stored roots, so for the CLI caller `POST`/`PATCH /harness-stacks` probe every member's `effectiveHome` (and, for Claude, the `.claude.json` directory) in the handler and refuse `403 path-not-accessible` (no `pathParams` entry); a CLI-token same-stack account switch through `PATCH /tasks/:id` re-runs the same probe for both the current and the target member.
The app caller is never gated and keeps today's in-process behavior.
A route whose path field needs no gate says why with `pathParamsExempt`.

**macOS TCC responsibility (disclaim)** — on macOS every child agetor spawns would otherwise inherit agetor's TCC *responsible-process* identity, so when a child reads another app's `~/Library/Application Support/<App>` the OS prompts *"Agetor would like to access data from other apps"* (`kTCCServiceSystemPolicyAppData`) — and the grant never sticks, because the responsible identity (agetor) ≠ the accessor binary (e.g.
`claude`).
Fix: a tiny signed helper (`vendor/disclaim/disclaim`, built from `native/disclaim/` by `scripts/build-disclaim.ts`, resolved by `src/bun/disclaim.ts`) calls the private `responsibility_spawnattrs_setdisclaim` (via `posix_spawn` + `POSIX_SPAWN_SETEXEC`, exec-replacing so the caller's pid + stdio survive) to make a spawned process TCC-responsible for *itself*.

**It covers agents AND the core's own background programs** (`docs/plans/master-token-agent-read.md`): disclaiming only agents left a hole, because a program an agent can plant — a repo's `core.fsmonitor` that `git status` runs on every git-status poll, a harness `bin` the `/harnesses` probe runs every 15 s, a binary earlier on a login-shell PATH — would still run as a child of the core with Agetor's identity.
So **every process the core launches goes through one wrapper, `coreSpawn` / `coreSpawnSync` in `src/bun/core-spawn.ts`**, which is the only caller of `disclaimArgv`: it resolves `argv[0]` itself first (so a missing binary still fails as the synchronous ENOENT `Bun.spawn` throws, not as the helper's exit 127 — while disclaiming, an unresolved target or a missing cwd THROWS that same error (ENOENT/EACCES, same `code`/`errno`/`syscall`/`path`; `coreSpawnSync` returns spawnSync's failure shape) and is never spawned undisclaimed; a cwd stat error other than ENOENT/ENOTDIR still goes through the helper), builds the child env with `childEnv(extra)` — the **live** `process.env` (never Bun's startup snapshot) overlaid with `extra` and scrubbed of `SCRUBBED_ENV_KEYS` (`AGETOR_API_TOKEN`), so the master can't reach any child — and runs the child through the helper when the switch is on.

**tmux clients are disclaimed too (D22), not just the server**: with the default system tmux the client binary comes from a PATH an agent can influence, and an undisclaimed planted `tmux` would run with Agetor's identity on every `capture-pane` (≈1 extra exec per call).
The server is still started once through the helper by `ensureDisclaimedServer()` (`disclaim tmux -L <socket> start-server` at boot, before `reconcileOrphans`, and before each `new-session`), on the dedicated per-instance tmux socket (see boot reconciliation in [task-lifecycle.md](task-lifecycle.md)).

**Exemptions** are marked `// spawn-exempt(<category>): <reason>` at the call site and pinned by `src/bun/core-spawn-allowlist.test.ts`, which scans non-test `src/bun/**` and `src/shared/**` for `Bun.spawn(`, `Bun.spawnSync(`, `spawnSync(`, `child_process`, `execFile` and `Bun.$` and fails on anything outside `core-spawn.ts` that is not on the pinned list of four sites: `/usr/bin/osascript` (`server.ts` ×2 — "Open terminal" / "Open tmux" drive Terminal.app with Agetor's own Automation grant; spawned by absolute path, SIP-protected, so PATH can't swap it), the terminal-tab PTY shell (`terminals.ts` — the user's own interactive shell keeps Agetor's identity, owner decision D8; desktop-only routes), and the notifier helper (`task-notifier.ts` — inside the signed app bundle, needs Agetor's notification identity).
The disclaim helper itself and `lsregister`/`open -R` (wrapped, so Reveal in Finder runs disclaimed) are not exemptions; adding one needs an edit to that test in the same change.

**One switch (D7)**: `disclaimSpawnedAgents` (Settings → General, whose label says it also covers Agetor's background programs) now lives **in memory** (`disclaim.ts` `getDisclaimSwitch`/`setDisclaimSwitch`, default on) and is **read from storage once, at launch** by `initDisclaimSwitch` (`src/bun/disclaim-switch.ts`, called from `index.ts` and `headless.ts` before `ensureDisclaimedServer()`): the SQLite file is writable by any agent, so a stored "off" is only a *request*.
In the app the switch stays **on** while a native message box (`Utils.showMessageBox`, buttons only, so an agent can't answer it without the Accessibility permission disclaimed agents lack) asks "Turn it back on" (default and cancel, which also rewrites the pref to `true`) or "Keep it off"; **headless ignores a stored "off" and always disclaims**, logging one line; a Settings change in the app applies immediately via `applyDisclaimPreferenceWrite`; and `PUT /preferences/disclaimSpawnedAgents` with an off value is **refused for the CLI token** (so `agetor config disclaimSpawnedAgents false` returns the desktop-only error), turning it on is allowed everywhere.
When the switch is off, non-darwin or the helper is missing, `coreSpawn` is a plain `Bun.spawn` with the scrubbed env (today's inherited-responsibility behavior); `AGETOR_DISCLAIM_BIN` is the test seam, and `disclaimAvailable()` is false under `NODE_ENV=test` without it.

**Task-directory I/O (D25):** the core never reads, stats or writes inside a task's directory in its own process when the switch is on — `@`-mention resolution in `startTask`/`sendInput` (`expandAtReferencesDetailedAsync`), the `.claude/settings.local.json` cleanup in `hook-installer.ts` and the cursor plan-file write on approve go through `src/bun/task-dir-fs.ts`, which runs one disclaimed child of Apple system tools (`/bin/sh`, `/usr/bin/stat`, `/bin/realpath`, `/bin/cat`, `/bin/mkdir`, `/bin/mv`; paths as argv, content on stdin) per call and stays in-process when the switch is off; this applies to every caller because the orchestrator can't tell who triggered a run.
Measured overhead of the extra exec is ~2–5 ms per spawn at p50.
Tradeoff (unchanged in kind, wider in reach): a disclaimed child no longer inherits agetor's own TCC grants, so an agent whose cwd sits under a protected folder (Documents/Desktop/Downloads/Full Disk Access) needs its own one-time grant, and so do disclaimed `git` and the harness probes for a project there — expect a one-time prompt naming git.

**No-follow reads (D26):** files an agent can rewrite but the core reads in-process — Claude transcripts, subagent files and the `sessions/` registry, the codex/cursor/gemini/antigravity/copilot/opencode run logs and exit files (copilot's usage file and `session-state/<id>/plan.md` too, the latter behind `isPlainDirBelow`), the JSONL rebuild route, account-usage reads, the usage poller's codex rollouts, and (while disclaiming) the account files `readClaudeAccount` and the usage poller read
— `.claude.json`, `.credentials.json`, codex `auth.json`, through `readAccountFileText` — open their final component with `O_NOFOLLOW | O_NONBLOCK` and refuse a non-regular file (`src/bun/no-follow.ts`: `READ_NOFOLLOW`, `openReadNoFollow`, `readTextNoFollow`, `readAccountFileText`), so a planted symlink into a protected folder fails with ELOOP instead of being read under Agetor's identity and a planted FIFO can't block the main thread;
folders an agent can rewrite (`projects/`, `sessions/`, a session's `subagents/`, `workflows/`, codex `sessions/`/`archived_sessions/`) are listed only after `isPlainDirBelow` confirms the chain below the config dir holds no symlink, and the walks below them skip symlinked entries.
A symlinked parent dir (a dotfiles `~/.claude`) is still followed.
Use these helpers for any new in-process read of an agent-writable file.

**Agent-chosen bytes the webview fetches (D26(j))** — `/files/preview` (agent markdown images, `SendUserFile` tiles, the attachment chips under a user bubble) and the diff blob's new side — go through `src/bun/core-file-read.ts` (`openFileBytes`/`readFileBytes`), which while disclaiming streams them from a disclaimed `stat` + `exec cat` child (body cut at the stat'd size, a short read errors the stream, 403 for an unreadable file before any 200; `/files/preview` reads a streamed body whole through `settleFileBytes` before answering — Bun 1.3.10 ends a chunked response cleanly when its stream errors, so a truncated image would otherwise reach the webview as a whole 200 — and refuses an image over `MAX_FILE_PREVIEW_BYTES` (50 MB) with 413) and never follows a final-component symlink for the diff blob; never `Bun.file`/`statSync` such a path in the core.
The price is that inside a macOS-protected folder (`~/Desktop`, `~/Documents`, `~/Downloads`, …) the disclaimed reader is denied, without a prompt, so the route answers 403.
The webview reads a 403 as `denied` (`statusForHttp`, `src/mainview/lib/authed-blob.ts`) and shows an **honest chip**: a neutral one that says the preview is blocked by macOS privacy and still opens the file through `/open-path` (LaunchServices has the access the core lacks), never the amber "not found" chip, which is for a proven 404 only (`src/mainview/lib/preview-copy.ts` is the one source of the copy; `AttachmentChips`, `MdImage`, `SentFilesCard` and `BinaryFilePreview` all use it).
The one thing that restores a thumbnail is a **preview twin**, below.
**Preview twins (`src/bun/preview-twins.ts`, `docs/plans/picked-image-preview-tcc.md`):** when the *user* names an image in a protected folder, the core copies it into `<dataDir>/previews/<sha256(exact path string)>.<ext>` and `/files/preview` serves that copy when, and only when, the original read is `denied`.
Why the core may read it at that moment: the Files Picker panel, a Finder drop and a paste all run in Agetor's own process, which holds the user's intent grant (`com.apple.macl`) for exactly the files the user chose (spike S1, `docs/plans/picked-image-preview-tcc-spike-pick.md`: no prompt for pick or drag).
- **Three gestures, each pinned to a user action, and nothing else writes a twin.** `/refs/pick` (files mode, the native panel and the e2e fake-dir seam); `/refs/drag` (the webview sends `names`, the basenames of the `File`s the drop carried, and only non-uploadable image types — heic, svg, bmp, ico, avif; png/jpg/gif/webp are uploaded as screenshots — whose basename is in `names` are twinned, which narrows the "agent rewrites the drag pasteboard mid-drag" race); `/refs/resolve`, only when `callerOf(req) === "app"` **and** the body carries `previewTwins: true`, which only `api.resolveCapturedRefs` sends and only `capture-refs` calls (a drop or paste whose `file://` URLs the webview recovered); like `/refs/drag` it also takes `names` and twins only a path whose basename one of them vouches for. `capture-refs` rung 1 reads `file://` lines out of `text/plain` as well, so an agent's output dragged out of the transcript can name a protected path, but a text drop carries no `File`, so it sends no `names` and gets a reference (a stat) and never a twin. Every other caller of `/refs/resolve` (`SentFilesCard`, handoff artifact chips, the `@`-scope highlighter) names *agent-chosen* paths with the app token and no user action, so it uses `api.resolveRefs`, which never sends the flag; the CLI token never gets a twin. **Never call `writePreviewTwin*` from any other route**: `preview-twins-callers.test.ts` pins the call sites.
- **The write never follows a symlink and never writes through a redirected folder.** The original is opened `O_NOFOLLOW | O_NONBLOCK` and must be a regular file of at most 25 MB; `previews/` is created without `recursive` and checked with `isPlainDirBelow` before every write and sweep; the bytes go to a `wx` temp file that is `rename`d over the final name, which replaces a planted symlink instead of writing through it. All file I/O is async (`fs/promises`); the only sync call is `isPlainDirBelow`'s `lstat` of `previews/`, once per write and per sweep.
- **The read is the same disclaimed reader, never follows a symlink, and runs only on `denied`.** A readable original always wins; `missing`, `too-large` and `error` never fall back. So a twin an agent planted can only show a regular, non-protected file, the same posture as any agent markdown image.
- **A 500 MB cache, oldest write time first.** Swept at boot (`index.ts`, `headless.ts`) and after each write; sweeps coalesce. A twin is a pick-time snapshot (a file edited later shows the pick-time bytes while the original is unreadable; a re-pick refreshes it). Nothing deletes `previews/` on task delete (path-keyed, shared by tasks, capped).
- **Accepted residuals.** An agent can put a file reference on the general clipboard; if the user then pastes it **and** the paste carries a `File` of the same basename (a Finder copy does not reach this route at all: WKWebView delivers its bytes, which are uploaded), the core copies that file into `previews/`, where the agent can read it (owner-accepted 2026-11-18, planning answer P1; narrowed by `names` after code review). The drag-pasteboard race is narrowed by `names`, not closed. The check-then-use timing race on `previews/` is the one `no-follow.ts` already documents.
**The OpenCode server (`opencode-server.ts`, `opencode-http.ts`; [harness-opencode.md](harness-opencode.md)):** for OpenCode 2.x, agetor runs one `opencode serve` per harness and talks to it over HTTP.
It is a second local API on the machine, so it follows the same rules as agetor's own: loopback only, authenticated, and no credential in a URL.
The server binds `127.0.0.1` on a port the OS picks (`--port 0`); the client refuses any server URL that is not a plain `http:` loopback address with no userinfo, uses `redirect: "error"` (the manager's own health probe uses `redirect: "manual"`, so neither follows a redirect), and never sends the password anywhere else, so a corrupted or planted state file cannot send it off the machine.
Auth is HTTP Basic `opencode:<password>`, and **the password is generated by agetor** (32 random bytes per start), not chosen or printed by OpenCode.
It is handed to the server as `OPENCODE_PASSWORD` through a 0600 env file that the launching `sh` sources and deletes before it `exec`s the server, so it is never in any process's argv (tmux's `-e` would put it in `ps`).
It lives in the 0600 state file `dataDir/opencode-servers/<harnessId>.json` (in a 0700 directory that must be a plain directory owned by the current user), in the server's environment and in the `Authorization` header, plus the transient 0600 env file the launching `sh` deletes right after sourcing it, and nowhere else: no log, event, error message or URL carries it, and every message built from server or log text is redacted first, by the one redactor (`redactSecrets` in `opencode-http.ts`: the raw password, its base64 form and `password=`, `Authorization`, `Basic` and `Bearer` patterns, keys and values in double or single quotes included, and the password part of a URL userinfo). Every request's response body read from the server, the manager's health probe included, goes through one 32 MiB cap (`readCappedText`); the SSE event stream has no total cap, only a per-frame one: a single frame or unterminated line over 16 Mi characters (`MAX_SSE_PENDING_CHARS`) ends the stream with an error.

**Live-verified residual: OpenCode passes `OPENCODE_PASSWORD` into the environment of the shell tools it runs.** An approved agent command can therefore read the password and call the server's API, for example to answer its own permission prompts.
This is no escalation over what the agent already has, since an approved shell command already runs as the same user with the same files, but it means **Ask mode is a consent prompt, not a sandbox**: it shows the user what the agent asks to do, and does not stop an agent that has been allowed to run commands from acting around it.
The Plan agent's no-edit rule and Auto's silent approval carry the same caveat.
The state file's password does not widen this: any same-user process, an agent included, can already read it.

**A planted state file must not become an attack.** The state file is data an agent could have written, so:
(1) it is read no-follow (`openReadNoFollow`) and treated as absent unless it is a regular file owned by this user, no broader than 0600, under 16 KiB, filed under the name its own harness id gives, with a loopback `http:` url and a tmux session name that is exactly the one this harness would get (a null session is read only under the test host, and adopted only when the file's host pid is a live child this process spawned; any other such file is not trusted: never adopted and its pid never signalled, the file kept while that pid is alive, since it may be an earlier core's server and the file holds the only copy of its password, and removed through the guarded remove once the pid is dead), and the 0700 server directory itself is re-checked (a plain directory owned by this user, its realpath equal to its parent's plus its own name, and its device and inode and its parent's the ones this process first saw) right before every write, every log read and every unlink batch, the stop paths included, and an operation on a directory that no longer checks out is refused; the check and the syscall after it are separate steps, so a swap landing between them is not caught (a check-then-use race), and the no-follow open and the owner and 0600 checks on what is read limit what such a swap can do;
(2) **no pid read from it, or reported by the server about itself, is ever signalled.** A pid is signalled only if it is a live child this core spawned for the test host, or the pid of that harness's own tmux pane or a descendant of it, and never this process or one of its ancestors; stopping a tmux-hosted server is `kill-session` on the exact session name first;
(3) a server is declared dead, and its tmux session killed and state deleted, only with positive proof (the host is provably gone, the connection was refused, or a 401 that persists across a re-probe); a timeout, reset or odd answer leaves a possibly busy server alone, and a busy server is never restarted (the caller gets “not responding” instead); every tmux and `ps` call the manager makes is bounded (the shared `start-server` preamble of a launch is waited for only within the launch's budget, though its children are not killed when that runs out), and a timeout is a failed call, never proof of death; a stop counts as done only when tmux says the session is gone and every pid it may signal is dead, the synchronous quit included (it reads the pane pids and their descendants, runs `kill-session`, needs a bounded `has-session` to say the session is gone, then waits at most 1 s in all for those pids, `syncStopWaitMs`), so a stop that is not confirmed (a sync quit whose `kill-session` failed, whose session is still listed, or whose server outlived that wait; an async stop whose tmux calls time out; a failed start whose host would not stop) keeps the server's state file, its password included, for the next sweep, `ensure` or boot to judge.
Every spawn (the tmux launch, the process-table read, the tmux queries) goes through `coreSpawn`. The server's environment is the tmux server's global environment (launched with the core's `childEnv()`; under the direct test host, `childEnv()` of the scrubbed environment) plus the harness env minus `SCRUBBED_ENV_KEYS`, so the master token is never in it, and the disclaim switch applies as for any other agent child.

**Who can answer the cards.** `POST /fx-permissions/:id/answer` and `POST /ask-questions/:id/answer` are `app+cli` in `ROUTE_POLICY`, so a holder of the CLI token (any agent can read that token file) can answer an OpenCode Ask card, or Reject it with a reason, just as the password above lets a shell tool call the server directly. That is consistent with Ask mode being a consent prompt, not a sandbox.
The routes validate what they relay: a `message` (a Reject reason, at most 4096 characters) is accepted only on an OpenCode card and only with `reject`, and is a 400 on an fx card; `cancel` is a 400 on an OpenCode card, because it is reserved for the core's own Stop and delete sweep and a dropped card would leave the server blocked.
A Reject with no reason is relayed with a one-space `message`, because OpenCode stops the whole turn on an empty one; that byte is the only text agetor adds to any reply ([pasted-content.md](pasted-content.md)).

Residual (D20): "Open terminal" runs the harness `bin` in Terminal.app under Terminal's identity; the user triggers it from the app and sees the command.
See `docs/plans/stop-agetor-tcc-appdata-spam.md` for the original agent-only change and `docs/qa/master-token-agent-read-qa.md` for the manual pass.

## Remote levels and the device caller

Spec: `docs/specs/remote-readiness-spec.md` (as amended by the grill); plan: `docs/plans/remote-readiness.md`. A phone is a third kind of caller, `device`, and it is the most restricted of the three.

- **The `remote` field.** Every `ROUTE_POLICY` entry says `remote: "none"` (never reachable from a phone) or a `RemotePolicy { level, stepUp, rate, since: 1 }`. `level` is the lowest device level that may call it (`observe < respond < operate < configure`, `packages/remote-protocol/src/levels.ts`; the level is chosen in the native pairing window and signed into the registry entry, so no route can raise it). `stepUp` is `none`, `unlock` (the unlock window, only while the task runs without asking) or `signed` (a signed decision over the exact content). `rate` is `normal`, `heavy` or `stop` (never limited). `since` is the protocol version that opened the route. A route's step-up is the ceiling for its calls: the router (`remote/router.ts`, `remote/route-classes.ts`) may relax it to `none` for a call it classifies as removal (a bare reject or skip), and may raise a call's level or refuse it, never lower the level.
- **Startup checks.** `applyRoutePolicy` throws when a remote policy sits on an `app` or `public` route, or lacks a known `level`, `stepUp`, `rate` or `since` (`remotePolicyProblem`). `route-policy-remote.test.ts` pins the exact v1 set (`METHOD route → level/stepUp/rate`), so opening, closing or changing a route shows up in review. The set is deny by default: `GET /tasks` and the other reads at `observe`; answers, cancels, follow-ups and the signed approvals at `respond`; `POST /tasks/:id/switch-account` at `operate`. The configure-level terminal is a session operation, not a route.
- **The device mark (invariant 7).** `resolveCaller` returns `app`, `cli` or `null` and never `device`. A request becomes a device request only through `markDeviceRequest(req, principal)`, which writes a module-private `WeakMap` in `route-policy.ts`. Only `src/bun/remote/router.ts` may import it (a test scans `src/` and fails on any other importer), and the router calls it only after a Noise session authenticated the phone. A clone or a copy of a request drops the mark.
- **The device branch of `wrapHandler`** runs before the token checks, in this order: (1) a route that is not `app+cli`, or has `remote: "none"` → 403 `not-remote`; (2) the device's level is below the route's → 403 `level`; (3) a route with `pathParams` → the same path gate the CLI token passes (`403 path-not-accessible`; `caller-fs.ts` treats every caller but `app` as untrusted and probes in a disclaimed child); (4) `callers.set(req, "device")` and the handler runs, so `callerOf(req) === "device"` for audit entries and toasts. The boot gate and the policy walker wrap the very handlers the router calls (`src/bun/route-table.ts`), so nothing is skipped.
- **Never remote.** No route pairs a device, turns remote access on or raises a level (D19; `REMOTE_ACCESS_ALLOWLIST` in `route-policy.test.ts`), and no `app` route is reachable from a phone at any level.

## core.log contents and redaction

`<dataDir>/logs/core.log` (`src/bun/core-log.ts`; behavior in [core-responsiveness.md](core-responsiveness.md#corelog)) holds everything the core, the database worker and the transcript worker print through `console.*`, and every event-loop stall of 1 s or more (the lag line names a label, a task id and a run id, never a message body). It exists because the packaged app sends the core's stdio to `/dev/null`. A log is a file any same-user process can read, so:

- **The file is 0600 in a 0700 directory** (`logs/`, with an explicit `chmod` because `mkdir`'s mode is masked by the umask and ignored for an existing directory). Rotation keeps three files, all created 0600.
- **Every line is redacted before it is queued** (`redactLogText`): first the registered literal secrets, then `Bearer <anything>` of any length, `token=…` / `access_token: …` values, then `redactSecrets` from `opencode-http.ts` (the password forms: `password=`, `OPENCODE_PASSWORD`, `Authorization`, `Basic <b64>`, URL userinfo, quoted keys and values). Boot registers the master token and the CLI token (`registerLogSecret`, `index.ts` and `headless.ts`), and the OpenCode server manager registers each server's password when it generates or reads one. A secret under 6 characters is not registered.
- **A secret registered late is still removed.** A line remembers the secret generation it was redacted under. When a new secret was registered since, the literal pass runs again over the batch at flush time, before the write. So a token that appears in a line queued just before its registration never reaches the disk.
- **Redaction runs before truncation.** A line is cut at 16 KB after redaction, so a secret that straddles the cap is already `[redacted]` and cannot leak its prefix. Text over 256 KB is cut before redaction only to bound its cost, backing off to the last whitespace so a token is not split.
- **The OpenCode password never reaches it**: it is registered as a literal secret, so even a line that dumps it, in its raw or its base64 `opencode:<password>` form, is replaced. This is the second line of defense, not permission to log it. The rule in [Rules that apply everywhere](../../CLAUDE.md#rules-that-apply-everywhere) stands: the password lives only in the 0600 state file, the server's env file and the `Authorization` header, and never in argv, a log, a URL or an error message.
- The worker threads' console output is forwarded to the main thread and goes through the same redactor, so a worker cannot write around it.

Do not log a credential, a prompt or a transcript line on the strength of the redactor. It catches the shapes above; it cannot know every secret.

## Worker threads: same process, same identity

The database worker and the transcript worker (`core-worker.ts`) are threads of the core process, not child processes. They are not spawned through `coreSpawn`, they inherit the process's macOS TCC responsible-process identity, and they run no external program. So nothing about the disclaim rules changes: a TCC prompt still names Agetor, a spawn of an agent or a core helper still goes through `coreSpawn` / `coreSpawnSync` with the disclaim helper, and the allowlist test is unchanged. A new thread that read a user's protected folder in its own process would need the same care as the main thread (D25, D26 above).

- **`AGETOR_CORE_WORKER_ENTRY` is honored only under test or e2e.** `worker-entry.ts` uses it only when `NODE_ENV=test` or `AGETOR_E2E_HARNESS_SEAMS=1`. In a release run the variable is ignored, because the path it names is run as code inside the core process.
- **The transcript worker's `allowedRoot` is a confinement boundary.** It reads files whose paths come from the main thread, and the paths are built from agent-writable directories. So every call carries the subagents or workflows directory the watcher already validated, and the handler refuses, with no read attempted, unless the path is absolute, NUL-free, has no `..` segment, lies directly under that root, and every directory component below the root is a real directory and not a symlink (`isPlainDirBelow`). The file itself is opened with `O_NOFOLLOW` (the no-follow rules in **No-follow reads (D26)** above), and a symlink, FIFO or other non-regular file reads as nothing. A caller that omits `allowedRoot` gets the legacy behavior (any absolute path) and is a bug: the watcher always passes it.
- **Message validation.** The database worker resolves a module and a method only as own properties of the module table, with the method a function, so `constructor` and `__proto__` never resolve, and an op name only as an own key of the op registry. Test-only ops (`__test.*`) and the test-only crash and migrate-delay hooks are refused outside `NODE_ENV=test`. Nothing in either worker evaluates code from a message.

## Harness-stack mirror and session transfer

Every source is an agent-writable harness home, so mirror/transfer reads open
with `openReadNoFollow` (`O_NOFOLLOW | O_NONBLOCK`, regular file only, never a
FIFO) — the mirror's merge readers wrap it in their local `readTextIfRegular`,
and the copy path uses `copyRegularFile` with the same `READ_NOFOLLOW` flags —
and every write is a sibling temp file, fsync, rename, 0600 (0700 dirs).
Directory walks `lstat` each entry and skip symlinks/FIFOs/devices (the one
exception: a *top-level* symlink in Claude `skills/`/`commands/`/`agents/` or
Codex `skills/`/`prompts/` is recreated as an absolute link to its target,
resolved lexically — lstat + readlink per component, never `realpath`, nothing
below a macOS-protected home folder is stat'ed, no bytes are read through it —
and a dangling or looping target, a target at or above either account root, a
never-copy/credential path, a `.git` path or a target in a protected home folder
(`Desktop`, `Documents`, `Downloads`, …) is refused; a real backup entry is never
replaced); copies
merge additively into the destination (a backup's own files survive) without
traversing a destination symlink; caps are 64 MB and 5,000 entries per tree,
and a config merge reads at most 8 MB.

Harness credential files are **never** copied: `.credentials.json`,
`auth.json`, session stores/transcripts, Codex `thread_history_*.sqlite`,
`state_*.sqlite`, session/log caches and `mcp-oauth-locks/`. **`.git` is never copied
anywhere in a mirrored tree**: a marketplace clone keeps its remote URL (and
any embedded access token) in `.git/config`, so the payload is mirrored without
the repository metadata. Each harness's installed plugin payload
(`plugins/cache/`) *is* copied so a backup can load its plugins from its own
home; Claude's two plugin registries (`installed_plugins.json`,
`known_marketplaces.json`) are merged with every absolute path rewritten from
the primary's config root to the destination's, never copied raw. The primary's
provider **and cloud** login env keys are stripped from a mirrored
`settings.json` by shape (any credential segment — `API_KEY`/`TOKEN`/
`SECRET`/`PASSWORD`/`KEY`/`CREDENTIAL` — whatever the vendor), together with
every provider/login **selector** (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`/…,
`ANTHROPIC_BASE_URL` and the per-cloud `*_BASE_URL`s, `CLAUDE_CODE_SKIP_*_AUTH`,
`AWS_ROLE_ARN`/`AWS_PROFILE`, …) and the login-selecting settings keys
(`apiKeyHelper`, `forceLoginOrgUUID`, `aws*`, `gcpAuthRefresh`,
`forceLoginMethod`, `proxyAuthHelper`); a backup's own value survives and the
process environment is not modified. On the Codex side the login-bearing
`config.toml` keys (`model_provider`, `forced_login_method`,
`forced_chatgpt_workspace_id`, `preferred_auth_method`,
`cli_auth_credentials_store`, `mcp_oauth_credentials_store`,
`mcp_enterprise_managed_auth`, `chatgpt_base_url`, `openai_base_url`) and every
`[model_providers.*]` table (which can carry a bearer token or auth headers)
are never imported; the backup's own survive, including the login keys of its
own `[profiles.*]`, in any TOML form (an inline primary profile naming a login
key is dropped whole). The Codex `[projects.*]` trust entries are never inherited.
Codex MCP OAuth tokens are not copied (no stable standalone store file) and the
swap warns that sign-in may need repeating. Static MCP/plugin tool
configuration — including any token an MCP server definition carries in its
`env`/`headers` — **is** mirrored: the owner sanctioned tool auth crossing
accounts, never the harness's own login (`docs/plans/harness-account-stacks-grill.md`).
`safe` mirror mode skips settings hooks, permissions and every setting that
runs a command (Claude Code's own list: `apiKeyHelper`, `awsAuthRefresh`,
`awsCredentialExport`, `fileSuggestion`, `gcpAuthRefresh`, `otelHeadersHelper`,
`policyHelpers`, `processWrapper`, `proxyAuthHelper`, `statusLine`,
`subagentStatusLine`; Codex: `notify`); plugins and MCP servers are still
mirrored. Before any other I/O, mirror, transfer and cleanup resolve each
account root lexically and refuse one that lands in a protected home folder its
stored path did not name (a root swapped for a symlink after it was gated).
Mirror and transfer refuse two accounts whose config roots are the same
directory by realpath (a symlinked alias included), and `PATCH /harnesses/:id`
refuses re-pointing a stack member onto another member's root.

Copied session files are recorded in `harness_session_handoffs` — only files
the copy created (a destination that already existed is never recorded), and
session/thread ids must be plain file names. The database is agent-writable,
so cleanup trusts a recorded path only when it lies below the destination
account's config root, matches a handoff shape **for the row's recorded session
id** (Claude `projects/<enc>/<sid>.jsonl`, `…/<sid>/{subagents,tool-results,
mcp-tasks}/…` or `file-history/<sid>/…`; Codex
`sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl`), so a row can only reach files of
the session it names (the session id is a claim too), has no symlinked
component and is a regular file (a row whose column is not the session column
of its account's kind is dropped, its paths never acted on, by task cleanup
and account delete alike);
it unlinks files only (never a recursive delete) and then prunes only empty plain
directories inside those shapes. A path outside the account's current root is
*retained* (the row is kept), never followed. Session transcripts are copied
with no size cap, in asynchronous 1 MiB chunks; the destination is checked one
path component at a time (`destinationState`) and the source's directory chain
is `lstat`-checked before any leaf is stat'ed. Full behaviour: [harness-stacks.md](harness-stacks.md).

`harness_orphaned_copies` rows (copies no handoff row can clean up any more)
and `harness_mirror_sources` rows (the folders each backup's last mirror read
and wrote) are **untrusted** the same way: the SQLite file is agent-writable.

- An **orphan row** is trusted for at most this: deleting one regular file of
  a handoff shape of the account's own kind for the row's session (a
  `claude_session_id` row only on a Claude account, a `codex_session_id` row
  only on a Codex account; any other column is forgotten unread,
  `columnMatchesHarness`), below the account's **current** root, with no
  symlinked component (the handoff cleanup rules,
  `removeCopiedPathsDetailed`), and only for a session no live handoff row of
  that account holds, no transfer onto it has in flight, and no task still
  resumes on that account (a task whose runs recorded the session and for which
  `findSessionIdForHarness` still returns it, `liveOnRunsOfHarness`). So a
  planted row deletes nothing an Agetor task still resumes on that account. It
  can still name a session file of that shape under the account's own root
  that the user ran in the CLI outside Agetor (no Agetor run knows it, so it
  is not live to Agetor), or a dead session's copy, and remove that file. Its
  `created_at` never stalls the monotonic stamp: the seed reads integer stamps
  only, clamped to a day ahead of the clock.
- A **mirror-sources row** is only compared and checked for existence, never
  read from or written into: its folders are resolved lexically and never
  stat'ed inside a macOS-protected folder (such a folder counts as existing).
  A planted row can at most make that backup's mirror skip, make its Restore
  refuse, make an edit of the account ask for confirmation (409
  `mirror-records`), or make a mirror or a Restore drop that same account's own mirror
  records and saved originals under `<dataDir>/mirror-backups/<id>/` (removed
  by `removeMirrorBackups` or `removeFolderBackups`, which never follow a
  link), after which the mirror treats that account as new in its own current
  folder, where every file it already has counts as preexisted and is backed
  up before an overwrite. A recorded folder that is gone (even one that only
  vanished, such as an unmounted volume) counts as moved for good, so its
  records and saved originals are dropped, not kept for a folder nothing can
  restore into. The row's folders are never a write or delete target.

### Mirror provenance, the backup store and the widened stripper

`harness_mirror_provenance` rows (what a mirror wrote into a backup account) are
**untrusted data**, like the handoff rows, because the database is
agent-writable. A row's `path`, `key`, `value_hash` and `backup_ref` are claims, and so is a
created-file marker: Restore removes a merged file only for a merge-spec path,
only while the file's text hashes to the marker's, and only when removing the
rows' unedited keys leaves it empty.
Every removal and every Restore re-checks the path before touching the disk: it
must have a mirror-allowlist shape (`isMirrorCopyShape`: below a `copy` entry,
not a never-copy path, no `..`/absolute/backslash/NUL), lie below the account's
config root with no symlinked component (`isPlainPathUnder`), be a regular file
(a link row: a symlink), and its *current* hash must still equal the recorded
one; the account root itself must not have been redirected into a protected
folder (`rootsRedirectRefusal`). A row that fails is dropped, not obeyed. A
backup ref is never read from a row: it is recomputed from the account id and the
relative path, and must stay inside the backup store.

The **backup store** (`<dataDir>/mirror-backups/<harnessId>/{files,modes,links,
keys}`) holds originals the mirror replaced, which can include secrets (an `env`
value it overwrote). It lives under the data directory and never inside an
account root, which an agent writes; directories are 0700, files 0600, writes
are atomic, a symlinked or non-directory component is refused, an original is
saved before the overwrite (a failed backup aborts the write), and the whole
directory is removed with the account or once a Restore leaves no rows. Agetor's
own data directory is also a **forbidden symlink target**: a dotfile link
resolving at, inside or above it is refused, because it holds the core token file
and these originals.

The **credential stripper** is wider than the original shape rule, and
case-insensitive: whole-segment `APIKEY`, `PASS`, `PASSWD`, `PAT`, `AUTH`,
`HEADERS`, `COOKIE(S)`, `SESSION`, `DSN`, `WEBHOOK`, `CONNECTION` and
`PASSPHRASE` join the original credential segments; any `settings.json` `env`
value that is a URL with userinfo (`scheme://user:pw@host`) is dropped whatever
its name; an `extraKnownMarketplaces` or plugin-registry entry whose URL carries
userinfo is dropped; Codex `shell_environment_policy.set.<credential-shaped
name>` and every `otel…headers` are dropped. The backup's own values survive.
Safe mode additionally refuses every `env` variable that runs a command when
set (`NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`, `DYLD_*`, `GIT_ASKPASS`,
`EDITOR`, anything ending `_HELPER` or `_COMMAND`, …).

**Dotfile-symlinked configs.** The primary's top-level `CLAUDE.md`,
`AGENTS.md`, `settings.json`, `config.toml` and `.claude.json` may be symlinks
into a dotfiles repo. They are resolved lexically (never `realpath`, nothing
stat'ed below a protected folder), must end in the entry's own extension, must
be a regular file, and are refused when they point at an account root or its
ancestors, a never-copy or credential path, a `.git` path, a secret-bearing home
folder (`.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.netrc`, `.docker`,
`.git-credentials`, `.npmrc`, `.kube`, `.config/gcloud`, `.pypirc`), a protected
folder, or the data directory. A symlinked file on the **backup** side is
skipped, never replaced by a regular file.

**Routes.** `GET /harness-stacks/:id/history`, `DELETE
/harnesses/:id/limit-state`, `POST /harness-stacks/mirror-preview`, `POST
/harnesses/:id/mirror-restore` and `POST`/`DELETE /tasks/:id/switch-account` are
`app+cli` and take ids, never paths, so none declares `pathParams`. The three
that reach an account's config root for a CLI-token caller — preview (every
member), restore (the account) and switch POST (the task's account and every
member) — probe those roots through the CLI path gate first
(`gateStackMemberRoots`, 403 `path-not-accessible`), like stack create/edit and
a same-stack account PATCH. History and cooldown clear touch no files. The
preview returns key and file names only, never values, and its path gate runs
before the draft is validated (validation resolves the account roots and reads
login evidence inside them in the core's process). The backup store never
follows a symlink: each ref is resolved by `lstat`-ing every component from
`mirror-backups/` down, a symlinked or non-directory parent reads as missing
(writes refuse it), and removal uses Bun's recursive `fs.rm`, which walks by
file descriptor with `O_NOFOLLOW` (Zig `deleteTree`), so a folder swapped for a
link mid-delete is refused, not followed. Never use `/bin/rm -rf` or a
path-based walk for an agent-writable tree: on macOS both can be redirected out
of it ([harness-stacks.md](harness-stacks.md#mirror-provenance-backups-preview-and-restore)).

## Multiple repositories in one task

A task created against two or more repositories (and still multi after removals leave one, `Task.multiRepo`) runs at a per-task workspace root `<dataDir>/worktrees/<task-id>` holding one linked worktree per repository; the whole feature is [multi-repo-tasks.md](multi-repo-tasks.md). Its security-relevant rules:

- **Path gate.** `POST /tasks` declares `body.workdir` and `body.repositories[].path` (`itemField: "path"`), so the CLI caller's D24 probe covers every selected repository path. The walker reads `repositories` only when it is an array and each entry's `path` only when the entry is an object; anything else yields no value, and the handler then answers its own 400. There is no product cap on the count; the gate's own per-request limit (`MAX_GATED_VALUES`, 256 probed paths, else `403 too-many-paths`) bounds what one CLI request can make the core probe. `GET /projects/repo-root` is `app` (desktop-only) and takes no `pathParams`: only the webview's Select Projects dialog calls it.
- **Ownership boundary.** Every path preparation or teardown acts on is derived, never trusted from the row: the workspace is accepted only as exactly `<WORKTREES_DIR>/<task.id>` or `<WORKTREES_DIR>/<pipelineParentId>` (`workspacePathFor`), and a stored repository checkout only as exactly `<WORKTREES_DIR>/<owner>/<entry name>` with no `.`/`..` segments (`isOwnedRepositoryCheckoutPath`); anything else is refused and never removed. A directory is treated as a repository's checkout only when git proves it (toplevel is that directory, common dir equals the source repository's). A directory holding any `.git` entry that can't be proved is refused, never cleared; only a directory with no `.git` entry is ever deleted to make room for a checkout. `DELETE /worktrees/:id` refuses any id whose task id still has a row, nested and case-variant names included. `PATCH /tasks/:id` refuses any change to a multi row's `workdir`.
- **Workspace-root I/O (D25).** The workspace root is the agent's cwd. Teardown's "holds only agetor's scratch" check and the scratch removal (`taskDirWorkspaceHasOnlyScratch`, `removeTaskDirWorkspaceIfOnlyScratch` in `src/bun/task-dir-fs.ts`) always run in a child process, disclaimed when the switch is on: the script `cd -P`s into the root and then into `.claude`, checks `pwd -P` after each step, and removes only `settings.local.json` (a regular file), then the empty `.claude` and the empty root with relative `rm` and `/bin/rmdir`. A symlink anywhere on the way makes it keep everything. Unlike the read helpers it stays a child even with the switch off, because the answer feeds a delete and only a shell pinned to the verified directory can act on it without following a swapped-in symlink. Preparation's "does this directory hold a `.git`" check goes through `taskDirLexists` (no-follow; a failed check counts as yes). The boot sweep's scratch check is asynchronous for the same reason.
- **Codex writable roots.** A multi task's codex sandbox escalation is decided from the task row's own checkouts (`codexWorkspaceRepos`), each verified against its source repository's git common dir; the workspace is never scanned for child checkouts, so a checkout an agent plants there can't widen the sandbox on the next turn ([harness-codex.md](harness-codex.md)).
- **Auto-trust of a task's own checkouts (owner decisions D1, D14).** Claude's startup `Adding a new directory:` dialog is answered by agetor for the directories it passed as `--add-dir` for that spawn, while `claude_auto_trust_repositories` is on (default). The boundary is `matchAddDirAutoTrust`: the startup variant with the exact `Yes, add it` label, an armed, held or cut-off footer at the bottom of the pane, and a path equal to one of this spawn's `autoTrustDirectories` (produced only by `withTaskRepositoryRoots`, empty when the preference is off); only the boot poller's startup window calls it, so a transcript quoting the dialog cannot trigger it. The preference itself is a request, not a boundary: **the CLI token may set it either way** (no value-level refusal was added, by owner decision D14, who accepted that any process holding the CLI token can turn it back on, as the SQLite file is agent-writable anyway). Trusting a checkout trusts its whole source repository for that claude session, which is what the user asked for by selecting the repository.
- **Pull-request planning (`GET /github/pull-targets`).** `app+cli` with `GH_QUERY` (`?path=` is path-gated for the CLI token like every `/github/*` GET). It is read-only: the repository's forge identity, remotes, default branch, up to 1,000 branch names and per-head existence come from the forge's REST API with the token the PR needs anyway (never `git ls-remote`, no `git fetch`), and the stored-base staleness comes from local `git merge-base --is-ancestor` calls through `coreSpawn` (5 s timeout, `GIT_TERMINAL_PROMPT=0`). Every name that can reach a git argv or a forge URL (`head`, `storedBase`, `liveHead`) is checked with `validateBranchName` and a leading-`-` check at the route (400) and again in `pr-targets.ts`, and `storedBaseSha` must be hex. The agent's reply is untrusted text: a PR link or `Repository:` label can only attribute a proposal to a repository the task already has (the link's host and `owner/name` must equal that repository's remote identity), never select a repository, a remote or a path; an extra head (a branch other than the live checkout) opens a PR only after an explicit tick and only when the forge lists it. No route turns remote access on.
- **Prompt text.** The `Repositories:` block is the documented exception to the no-machine-text rule: one `- <name>: <path> (branch <branch>)` line per repository, no product name, built by `composeRunPrompt` (`src/shared/launch-prompt.ts`) and only for a multi task (`isMultiRepoTask`, a one-repository multi task included), never for a single-repository task.
- **Repository removal.** `DELETE /tasks/:id/repositories/:name` is `app+cli` (`AgetorClient.removeTaskRepository`, `agetor edit --remove-repo`) with no `pathParams` and no `pathParamsExempt`: `:name` is a repository's workspace name looked up in the row's own set, never a path, and the request carries no body. The checkout it detaches is located with the same owned-path rules as teardown above (`locateRepositoryCheckout`); a stored path that isn't agetor's exact shape is left alone, a dirty or unreadable checkout refuses the removal (409 `dirty`), the branch is never deleted, and with the source repository gone nothing on disk is touched. Its status line names only the repository and its branch, no product name.

## Enter-only and OAuth-code answers (`POST /tmux-prompts/:id/answer`)

The route stays `app+cli` and its body is a closed allow-list: exactly one of `{key}` (validated against the card's recorded choices), `{reject:true}`, `{enter:true}` (only on an `answerKind:"enter"` card) or `{code}` (only on an `answerKind:"code"` card, after `validateOAuthCode`: one line, at most 512 characters, no control character). Anything else is a 400; no refusal echoes a submitted code (an unknown `{key}` on a choice card names the key it refused). Every answer, `{reject:true}` included, goes through `answerTmuxPromptInPane`, which re-reads the live pane and refuses (409 `dialog-changed`, nothing typed) unless the same dialog is still on screen: the same cursor-free identity for a parsed menu, the same fingerprint for an Enter-only, OAuth-code or unparsable ("Open in Terminal") card. A reject is a single `Escape`, and only after that check, because an Escape on a pane that moved on would interrupt claude's turn; a failed send is a 500 and the card stays. A `{code}` is refused (409 `field-not-empty`, a fixed sentence, nothing typed) when the prompt's field already holds text, since typing appends; and the pane is read again after the code goes in, with no Enter unless the same prompt is still there. A card is claimed while an answer is delivered to it, so a second answer for the same card in flight is a 409 (`code: "answer-in-flight"`) that types nothing; the CLI and TUI tell it from "the prompt changed" by that `code`. The "just answered" stamp goes on the session that received the keys, never on a session the task respawned into meanwhile.

**The OAuth code is accepted from the app, `agetor answer` and the TUI alike (owner decision D15).** The recommendation was the desktop app only; the owner chose full parity knowing that an agent holding the CLI token could submit a code for an account it controls. The text is typed with `tmux send-keys -l` and then Enter, so it is briefly in a `tmux` argv (a same-user process can already read the pane through the tmux socket, so this adds no exposure). It is never persisted or shown back: every pane capture is masked with `redactPaneSecrets` (the `Paste code here if prompted >` line and the wrapped continuation lines under it) before a matcher cuts a card window out of it, `registerTmuxPrompt` masks every card's `paneText` again, the boot-timeout pane dump and the stall watchdog's excerpt are masked, no `run_events` row, status line, log or error carries the code, the answer promise resolves with the sentinel `__code__`, and the route's success body is `{ok: true}` (plus `held: true` when claude refused a confirm) — a refusal carries only a fixed sentence. Free text is accepted on that one card kind and nowhere else. Continue (`{enter:true}`) carries no text and is never sent automatically.
