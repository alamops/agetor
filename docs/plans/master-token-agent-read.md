# Plan — Keep Agetor's authority out of agents' reach (master-token agent-read)

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | `docs/plans/master-token-agent-read-investigation.md` (step 1), `docs/plans/master-token-agent-read-grill.md` (step 2, D1–D21), owner answers in this step (D22–D24 below), pipeline goal "Your own agents can read the master token…" |
| Flags | none |
| Gates | grilled + three planning questions answered by the owner (alamops); plan approval is the next gate |
| Branch | `fix/fix-the-master-token-read` (agetor task branch, kept) |
| Base SHA | `5b1d38c67cac0581d693dac2359756c7a05f4ef4` (clean tree except the three untracked plan docs) |

## 1. Objective & success criteria

**Objective.** The statement is valid (investigation §0). An agent running as the user can read `agetor-core.json` and gets a token with full authority, and the core also lends agents Agetor.app's macOS identity *without* the token, by running programs an agent can plant (grill G1–G3). This change:

1. splits the credential: the agent-readable file carries a **CLI-scoped token**; the app's **master token** stays in memory and is never sent in a URL;
2. enforces a **per-route policy table, deny by default**, so desktop-only routes refuse the CLI token and no HTTP route can pair a device or raise permissions;
3. runs **every program the core spawns** through one disclaim wrapper (small, listed exemptions), so no planted program inherits Agetor's TCC identity;
4. reads the disclaim switch **once at launch** (native confirm if stored "off"), and refuses "off" from the CLI token;
5. makes **CLI-callable routes that take a filesystem path** safe: for the CLI token, path checks and small reads happen in a disclaimed child, never in the core process (D24);
6. documents what is and isn't protected, and records the future pairing rules.

**Success criteria** (D21 plus D22–D24):

- `bun run typecheck`, `bun test` and the full Playwright suite pass. The three tests already failing on `main` (tmux-socket ×2, the reconcile-cancel test) are reported as pre-existing, not fixed here.
- The server refuses to start if any registered route or method lacks a policy entry; a test pins that every route is classified.
- With the CLI token: every desktop-only route returns `403 {error:"only available in the Agetor app", code:"desktop-only"}` on the app, and on headless returns the existing 501 where it 501s today (D12); every `AgetorClient` method returns neither 401 nor 403 against a real in-process core; `PUT /preferences/disclaimSpawnedAgents` with `"false"` returns 403; `?token=<master>` returns 401 on every route; `?token=<CLI token>` works only on the three legacy SSE GETs.
- No route path in any HTTP scope matches pairing/device/remote-access vocabulary (test).
- A static test fails on any raw `Bun.spawn`/`spawnSync`/`child_process` call under `src/bun` or `src/shared` outside the wrapper and the listed exemptions.
- With a recording `AGETOR_DISCLAIM_BIN` stub, a repo-configured `core.fsmonitor` program runs under the stub (git status path), and so do harness probes and tmux client calls.
- The webview makes no request whose URL contains `token=` (Playwright network audit). The terminal WebSocket uses a single-use ticket. Images render through `blob:` URLs.
- `agetor-core.json` contains the CLI token, never the master.
- For a CLI caller, a path the disclaimed probe can't access (EPERM) is refused with `403 {code:"path-not-accessible"}`; `/refs/resolve` and agent-discovery results for a CLI caller come from the disclaimed probe.
- The investigation/grill spikes, re-run on a throwaway core (never `~/.agetor`), now fail for the agent: desktop-only routes refuse the file token, disclaim-off is refused, the fsmonitor program runs through the wrapper.

## 2. Context & constraints

**Auth today** (all `src/bun/server.ts` unless noted)

- One token: `API_TOKEN = process.env.AGETOR_API_TOKEN ?? randomBytes(32)` (`src/bun/api-config.ts:83`). `tokenMatches` / `isAuthorized` / `unauthorized` / `authed` at `:422-455`; `isAuthorized` accepts a Bearer header **or** `?token=` on every route. `corsHeaders` allows `authorization` (`:411-420`).
- Routes are one inline `routes:` object passed to `Bun.serve` (`:1238`); 192 path keys (`grep -n -E '^\s+"/' src/bun/server.ts`), about 100 under `/github/*`. Values are either `authed(fn)` (all methods) or `{GET: authed(…), …}`. Unauthenticated: `/health` (`:1256`). Test-only `/test/block-event-loop` (`:3737`, registered only with `AGETOR_TEST_BLOCK_ROUTE=1`).
- The terminal WebSocket upgrade lives in the `fetch()` fallback and checks `isAuthorized` with `?token=` (`:7853-7872`).
- Native-only routes answer `notAvailableHeadless` (501) when `native` is absent (`:1155-1160`; uses at `:1548, 3793, 3813, 3817, 3824, 4660, 4701, 6015, 6058, 6082, 6132, 7458, 7507, 7590`). `startApiServer({native, hostname})` (`:1162`).
- `PUT /preferences/:key` stores any string except the retention key (`:3632-3660`).
- `refsFromPaths` stats caller-supplied absolute paths in-process (`:326-342`), used by `POST /refs/resolve` (`:6150`). `POST /projects` calls `existsSync(path)` (`:1277`). `/agent-discovery` stats `workdir` (`:5001`) and reads project capability files through `resolveProjectTree` (`src/bun/commands.ts:260-268`, `:811`).
- osascript is spawned by bare name (PATH lookup) at `:4850` (open-terminal) and `:5869` (open-tmux).

**Credential file and boot**

- `writeCoreCreds` writes `{port, token, pid, kind, version, startedAt}` 0600 (`src/bun/core-creds.ts:25-72`). Writers: app `src/bun/index.ts:383-394`, headless `src/bun/headless.ts:279-291`. Readers: CLI `discoverCore` (`src/cli/api-client.ts:130-134`), app handoff → `POST /daemon/shutdown` (`index.ts:351-360`), `probeLiveCore` → `/info` (`core-creds.ts:131-150`), `stopDaemon` (`src/cli/daemon/supervisor.ts:95-108`).
- App boot order: `rehydratePath()` (`index.ts:128`) → lag monitor (`:152`) → `ensureDisclaimedServer()` (`:157`) → pipeline runner + `reconcileOrphans` (`:164-165`) → `startApiServer` (`:343`) → `writeCoreCreds` (`:383`) → `BrowserWindow` with preload `window.__AGETOR` (`:557-563`) and `#api=…&token=…` hash (`:588`). Headless: `rehydratePath` (`headless.ts:154`), `ensureDisclaimedServer` (`:171`), creds (`:279`).
- `scripts/dev-headless.sh:205-223` writes the dev token with a plain `echo >` (0644).

**Clients**

- Webview reads the token at `src/mainview/lib/api.ts:354`, sends a header on `j()` calls, and puts the token in URLs for: terminal WS (`:1672`), `filePreviewUrl` (`:1881`), `taskDiffBlobUrl` (`:1891`), `pullBlobUrl` (`:1899-1908`), and four EventSources (`:2095, 2121, 2140, 2167`). Consumers: `App.tsx:1269, 1730`, `RunPanel.tsx:1167`, `TerminalView.tsx:159` (3-attempt reconnect loop), `SentFilesCard.tsx:108`, `MdImage.tsx:261` (candidate fallback via `onError`), `AttachmentChips.tsx:165`, `BinaryFilePreview.tsx:131-137` (`probeBlobStatus` on `onError`), `DiffDialog.tsx:929`, `GitHubDialog.tsx:9600`. `subscribeRun` has no caller. No CSP in `src/mainview/index.html`, so `blob:` images need no policy change.
- CLI: 68 `this.req(...)` calls plus `bundleReq` in `src/cli/api-client.ts` (some span lines, e.g. `:504-505`, `:645-647`); SSE via `streamSse` with `?token=` (`src/cli/sse.ts:36`) and a `data:`-only frame parser; supervisor `fetch` to `/daemon/shutdown`.
- e2e: Chromium only (`playwright.config.ts`), one headless backend per worker started with `AGETOR_API_TOKEN` (master) and booted via `#api=…&token=` (`e2e/fixtures.ts:325, 501`). `e2e/markdown-images.spec.ts:204-206` asserts the `<img src>` contains `/files/preview?path=`.

**Spawning and disclaim**

- Disclaim gate: `disclaimEnabled()` reads `disclaimSpawnedAgents` from SQLite on every call; only the literal `"false"` disables (`src/bun/disclaim.ts:90-95`); `disclaimAvailable()` is false under `NODE_ENV=test` unless `AGETOR_DISCLAIM_BIN` is set (`:67-79`). `disclaim.ts` imports `preferences` from `db.ts`.
- The helper exec-replaces with `posix_spawnp(argv[1], …, environ)` (`native/disclaim/disclaim.c:59-67`): PATH lookup uses the env it was given; an exec failure exits with a `disclaim: exec … failed` message instead of the synchronous ENOENT `Bun.spawn` throws.
- `Bun.spawn` without `env` gives the child Bun's **startup** env snapshot, not the live `process.env` (`src/bun/tmux-resolution.ts:144-156`).
- Raw spawn sites (non-test, `src/bun`): `worktree.ts:37, 69`; `clone.ts:1354`; `github.ts:546`; `ref-tree.ts:162, 208`; `agent-status.ts:90, 133, 177`; `claude-session-import.ts:722`; `claude-session-scan.ts:180, 328, 509`; `project-files.ts:84`; `agent-discovery.ts:63, 289`; `usage/creds.ts:84`; `login-path.ts:80, 128` (`node:child_process` `spawnSync`); `git-provider.ts:182` (`spawnSync` `ssh -G`, which evaluates `Match exec`); `index.ts:279` (lsregister), `:313` (`open -R`); `tmux-resolution.ts:189` (server start, disclaimed), `:225` (`new-session`); `claude-tmux.ts:1635` (every tmux client call); `fx-acp.ts:3389` (disclaimed); `terminals.ts:265` (PTY shell); `server.ts:4850, 5869` (osascript); `task-notifier.ts:102, 140` (notifier helper). Test helpers `clone-test-util.ts`, `github-test-util.ts` are not shipped code.
- tmux binary: `AGETOR_TMUX_BIN`, else `tmux_source="bundled"` → in-app binary, else `Bun.which("tmux", {PATH})` (`tmux-resolution.ts:66-71`). The PATH comes from the login shell, which an agent can edit; Homebrew's tmux is user-owned. Scraper cadence: one `capture-pane` per running task per second, decaying to 2 s / 10 s when idle (`claude-tmux.ts:4973, 6213-6232`); ask-card driving polls every 80–120 ms (`:2298-2468`).
- `Utils.showMessageBox` is a **synchronous** FFI call (`node_modules/electrobun/dist/api/bun/core/Utils.ts:235-259`, `ffi.request.showMessageBox`), buttons only. It blocks the Bun thread until answered, like `openFileDialog`.
- Settings toggle: `SettingsDialog.tsx:290-293, 377-378, 414-421, 1318-1334` (label "Isolate agent permissions from Agetor (macOS)").
- Capability discovery: `ref-tree.ts` `ProjectTree` interface (`:15-21`), `diskProjectTree` (`:34`), `refProjectTree(files)` builds a tree from a flat path→content map (`:86`), `DEFAULT_PATHSPECS` (`:299-302`, not exported); `commands.ts` `isDiscoveredCapabilityPath` (`:242`, private), `resolveProjectTree` (`:260`).

**Spike verdicts carried forward** (investigation §2, grill G1): S1 an Agetor-launched agent reads the live token (Agetor 1.0.3, uid 501); S1b no other leak; S2 a same-user process flips `disclaimSpawnedAgents` and stops the core (headless, bun 1.3.10); S3 it creates and starts an Auto task in any directory; S4 about 20 `AgetorClient` methods have no real-core test; G1 `git status --porcelain` runs a repo-configured `core.fsmonitor` program (Apple Git 2.54.0).

**Constraints.** Electrobun, not Electron. No sandbox (README). WKWebView caps ~6 HTTP/1.1 connections per host, two already permanent SSE streams. The CLI daemon tests bind fixed ports and stall under load: run `bun test src/cli` serialized. Never test against `~/.agetor`; dogfood with `~/.agetor-dev`.

## 3. Approach & key decisions

### Decisions added in this step

| # | Topic | Decision | Source |
| --- | --- | --- | --- |
| D22 | tmux client calls (revises D8) | **Disclaim every tmux client call** too, not just the server. Reason: with the default system tmux, the client binary comes from a PATH the agent can influence (login shell) or a user-owned Homebrew path; undisclaimed, a planted `tmux` would run with Agetor's identity on every `capture-pane`. Cost ≈ 1 extra exec per call at ≤ 1 call/s/task. | owner |
| D23 | README wording (D18) | Approved as proposed (text in T13). | owner |
| D25 | Orchestrator task-directory I/O (§8.1) | Owner chose **pull it into this branch** at plan approval. The core never reads, stats or writes inside a task's directory itself: `@`-mention resolution, the `.claude/settings.local.json` cleanup (`hook-installer.ts`) and the cursor plan-file write (`server.ts` plans approve) run in a **disclaimed child of Apple system tools** (`/bin/sh`, `/usr/bin/stat`, `/bin/realpath`, `/bin/cat`, `/bin/mkdir`, `/bin/mv`) whenever `disclaimEnabled()`; when disclaim is off or unavailable they stay in-process (same identity either way, the one switch D7). Applies to every caller, since the orchestrator can't tell who triggered a run. | owner (execution step) |
| D26 | Review-round fixes (pipeline Bug Fix step) | (a) **Path gate checks every spelling a handler can act on**: the walker gates each path value raw AND trimmed (`spellings()` in `route-policy.ts`), and `gateHarnessEnvPaths` does the same for env values — `createTask`/`PATCH /tasks/:id` trim `workdir` and `/projects/clone` trims `dest`, so `" /…/Documents"` used to read as a missing relative path to the probe while the handler acted on the protected absolute one. (b) **No undisclaimed fall-through**: while disclaiming, `coreSpawn`/`coreSpawnSync` throw/return the error a plain spawn would (`ENOENT`/`EACCES`, same `code`/`errno`/`syscall`/`path`) instead of spawning plain when the target or cwd doesn't resolve; a cwd stat error other than ENOENT/ENOTDIR (EPERM/EACCES under a protected folder) still goes through the helper. (c) **Agent discovery reads through disclaimed children for every caller** while the switch is on (`discovery-fs.ts`: per stage, one direct `find -L … -print0` per (depth, name) selector shape plus one direct `tar -L --null -T -` fed on stdin — no shell pipeline, so the 15 s timeout reaches the blocked process — only the files the parsers read; `~/.claude.json` via a disclaimed `stat`+`cat` with a stat-keyed cache); `callerProjectTree` archives only `shouldRead` files and warns when the 8 MB cap truncates. (d) **No-follow reads of agent-writable files** (`no-follow.ts`, `O_NOFOLLOW` on the final component): Claude transcripts, subagent files and the `sessions/` registry, the codex/cursor/gemini/antigravity run logs and exit files, the JSONL rebuild route, account-usage reads, the usage poller's codex rollouts and (while disclaiming, via `readAccountFileText`) the account files `readClaudeAccount` and the usage poller read — `.claude.json`, `.credentials.json`, codex `auth.json`; every such open is non-blocking and refuses a non-regular file, and agent-writable folders (`projects/`, `sessions/`, `subagents/`, `workflows/`, codex `sessions/`/`archived_sessions/`) are listed only after `isPlainDirBelow` checks their chain; the session scanner `lstat`s project dirs and transcripts and skips symlinks. (e) `tmux_source` via `PUT /preferences/:key` is desktop-only for the CLI token and validated + routed through `setTmuxSource` for the app. (f) `/daemon/shutdown` stays `app+cli` (owner decision) but on the app no longer deletes `agetor-core.json` before the quit-confirm — the `before-quit` handler removes it once the quit is allowed. (g) CORS answers carry `access-control-max-age: 600`; `AuthedImg` fetches only near the viewport (shared IntersectionObserver per scroll root), the fetch queue is LIFO and drops cancelled entries, and out-of-view images release their blob. (h) `POST /harnesses/:id/usage/refresh` is desktop-only: its forced refresh sets the usage poller's `allowIdeRead`, which opens Cursor's `state.vscdb` in the core's own process (a cross-app read under Agetor's name), and the stored ok/error snapshot keeps that read on for later sweeps; no CLI command calls it. The disclaimed `~/.claude.json` read refuses a non-regular file before `cat` (a FIFO would block it until the 15 s timeout) and a timed-out read answers the last value read; `readClaudeAccount` reads through `readAccountFileText` inside its stat-keyed cache. (i) **The usage poller's Cursor IDE-read consent lives in memory only**: a forced refresh (only the desktop-only route passes `force`) grants that harness the in-process `state.vscdb` read for later sweeps of THIS process; a stored `ok`/`error` `harness_usage` row no longer counts, because any agent can write `agetor.sqlite` (insert an `ok` row, enable the harness) — after a relaunch the background sweep skips the IDE read until the user refreshes that harness's usage again. (j) **Agent-chosen file bytes the webview fetches are read by a disclaimed child**: `/files/preview` (agent markdown images, `SendUserFile` tiles — the webview fetches them with the master token, so desktop-only didn't help) and the diff blob's new side go through `core-file-read.ts` (`openFileBytes`/`readFileBytes`: one `/bin/sh` → `/usr/bin/stat` → `exec /bin/cat` child per read while disclaiming, the body streamed and cut at the stat'd size, a short read errors the stream, `If-None-Match` answered before reading, an unreadable file answered 403 before any 200; in-process when the switch is off). The diff blob never follows a symlink at the final component (git shows a symlink as text, so the diff never asks for one). In-process discovery reads (`safeReadJsonCached`, the reader's `text`, `diskProjectTree`'s `read`) are non-blocking and regular-file-only (`readTextNonBlocking`), and a plain and an account-mode read share one cache entry while the switch is off. | owner (Bug Fix step: (c)/(d) "fix in this branch", (f) "keep, fix creds order") |
| D24 | Path-taking CLI routes | Owner asked for "safe support for CLI too" instead of making `/refs/resolve` desktop-only. Design: for the **CLI token**, every in-process filesystem check on a caller-named path is replaced or preceded by a check in a **disclaimed child of Apple system tools** (`/bin/sh`, `/usr/bin/stat`, `/usr/bin/tar`). Such a child has only the access any self-responsible process has, which is what an agent can already get by running the disclaim helper itself. The master token keeps today's in-process behavior. | owner (ask); planner (design) |

### Planner decisions (P)

| # | Decision | Basis |
| --- | --- | --- |
| P1 | Policy lives in a table module (`src/bun/route-policy.ts`) and is applied by a walker over the `routes` object; `authed()` stays as the "any valid token" gate. Rejected: adding a policy argument at ~300 `authed()` call sites (huge diff, no way to test coverage without starting the server, easy to miss methods on function-valued routes). The walker refuses to start the server on a missing entry, extra entry or method mismatch. | reasoning; D14 |
| P2 | Exempt spawns keep Agetor's identity only where the binary can't be swapped: `/usr/bin/osascript` by **absolute path** (SIP), the notifier helper and the disclaim helper (inside the signed app), terminal tabs (owner D8). Everything else, tmux clients included (D22), goes through the wrapper. `lsregister` and `open -R` are wrapped. | reasoning; D8, D22 |
| P3 | The wrapper always passes an explicit env (scrubbed live `process.env`), and when it disclaims it first resolves `argv[0]` (absolute path → must exist; bare name → `Bun.which` on the child env's PATH) and throws the same error shape `Bun.spawn` throws, so "binary not installed" handling keeps working. When disclaim is off or unavailable it calls `Bun.spawn` unchanged. | code read (`disclaim.c:67`, `tmux-resolution.ts:144-156`) |
| P4 | Disclaim state moves to memory in `disclaim.ts` (default **on**, no `db.ts` import); a separate `disclaim-switch.ts` does the launch read and confirm, so `core-spawn.ts` stays importable without opening the DB. | code read (`disclaim.ts:17`) |
| P5 | The launch confirm runs **before** `ensureDisclaimedServer()` in `index.ts`, so the answer applies before any agent host starts. Because `showMessageBox` blocks the Bun thread, nothing else is running yet. If it doesn't render that early (verified in manual QA), the fallback is right after window creation, wrapped in a `native message box` lag label; the switch stays on until answered either way. | code read; needs manual check (§8) |
| P6 | `?token=` is accepted only for the **CLI token**, only on `GET /events`, `GET /tasks/:id/events`, `GET /app/events` (the paths old CLIs use), flagged `legacyQueryToken` in the table. | D13; code read (`src/cli/sse.ts`) |
| P7 | Terminal WS tickets: `POST /terminals/:id/ws-ticket` (desktop-only) returns `{ticket, expiresAt}`; 32 random bytes hex, bound to the terminal id, single-use, 30 s TTL, in-memory; `GET /terminals/:id/ws?ticket=…` is the only accepted upgrade. | D13 |
| P8 | Webview SSE: one fetch-based reader (`openEventStream`) with the EventSource semantics callers rely on: named events, `onmessage` for unnamed frames, reconnect after a clean end or network error (honor `retry:`, else 1 s→10 s jittered backoff), **stop** on 401/403/404 (EventSource also stops on a non-200 status). A shared pure parser (`src/shared/sse-parse.ts`) backs both the webview and the CLI. | D13; code read |
| P9 | Images: `useAuthedObjectUrl(url)` fetches with the header, returns `{src, status}` (`loading` / `ok` / `missing` (404) / `too-large` (413) / `error`), with a refcounted cache that revokes an object URL 30 s after its last user. `<AuthedImg>` renders `<img src=blob:…>` and carries `data-src-url` for tests. `probeBlobStatus` is deleted (the hook already knows the status). | D13 |
| P10 | CLI-caller path gate (D24): table entries declare `pathParams` (`{in:"query"|"body", name, mode:"exists"|"nearest-ancestor"}`); for a CLI caller the walker probes each present value before the handler and refuses only when the probe reports **denied** (EPERM/EACCES or a 10 s timeout, e.g. a pending TCC prompt). "Missing" passes through so handlers keep their own not-found answers. Body params are read from `req.clone()`. `/refs/resolve` and agent-discovery use the probe's results directly. | reasoning: TCC answers EPERM, not ENOENT (verify in T4) |
| P11 | The `/health` and WS paths stay outside the table walker but are covered by the policy test explicitly. `/test/block-event-loop` is `app`. | code read |

### How the pieces fit

**Tokens and callers.** `api-config.ts` exports `API_TOKEN` (master, unchanged meaning, env override kept for e2e/dev) and a new `CLI_TOKEN` (random per launch, no override). After reading `AGETOR_API_TOKEN` it deletes it from `process.env`. `resolveCaller(req, policy)` returns `"app"` for a Bearer master, `"cli"` for a Bearer CLI token or (only with `legacyQueryToken`) `?token=<CLI token>`, else `null`; both compares stay constant-time. The walker stores the caller in a `WeakMap<Request, ApiCaller>`; handlers read it with `callerOf(req)`. Both boot paths write `CLI_TOKEN` into `agetor-core.json` under the existing `token` field (D3, A5).

**Policy table.** Shape (D14):

```ts
export type ApiCaller = "app" | "cli";
export interface PathParam { in: "query" | "body"; name: string; mode: "exists" | "nearest-ancestor" }
export interface RoutePolicy {
  callers: "public" | "app" | "app+cli";   // the master is always allowed except on "public" (no token needed)
  remote: "none";                          // Companion remote levels are added later
  headless501?: true;                      // CLI token on headless gets today's 501 instead of 403 (D12)
  legacyQueryToken?: true;                 // accept ?token=<CLI token> (old CLIs; SSE GETs only)
  pathParams?: readonly PathParam[];       // CLI caller: gate these paths via the disclaimed probe (D24)
  pathParamsExempt?: string;               // why a path-looking param needs no gate (e.g. "DB only")
}
export const ROUTE_POLICY: Record<string, RoutePolicy | Partial<Record<HttpMethod, RoutePolicy>>>;
```

Order of checks per request: OPTIONS untouched → `public` passes → no valid caller → 401 → `callers:"app"` and caller is `cli` → 501 if `headless501 && !native`, else 403 desktop-only → CLI caller with `pathParams` → gate (403 `path-not-accessible`) → handler.

**Desktop-only set** (`callers:"app"`; D9, plus P7/P11): `/tasks/:id/terminals` (GET, POST), `/terminals/:id` (DELETE), `/terminals/:id/ws-ticket` (POST, new), the WS upgrade, `/harnesses/:id/open-terminal`, `/tasks/:id/open-tmux`, `/files/preview`, `/tasks/:id/diff/blob`, `/open-path`, `/reveal-path`, `/open-external`, `/refs/pick`, `/refs/drag`, `/projects/pick`, `/bundle/pick-file`, `/bundle/export/save`, `POST /harnesses/:id/usage/refresh` (D26(h)), `/window/toggle-zoom`, `/window/focus`, `/app/force-quit`, `/updates/status|check|apply`, `/screenshots`, `/attachments`, `DELETE /notifications/:taskId`, `POST /tmux-source` (GET stays `app+cli`), `/test/block-event-loop`; plus the value rule `PUT /preferences/disclaimSpawnedAgents` = `"false"` (in the handler). Everything else is `app+cli`, including all of D9's "stay CLI-scoped" list and `/refs/resolve` (D24).

**Spawn wrapper.** `coreSpawn(argv, opts)` / `coreSpawnSync(file, args, opts)` in `src/bun/core-spawn.ts` replace every non-exempt raw spawn. Exempt sites carry a marker comment `// spawn-exempt(<category>): <reason>` on the line above, with category ∈ {`osascript`, `terminal-tab`, `notifier`}; the static test pins the exact (file, category) list, so a new exemption needs a test edit. `disclaimArgv` stops being called outside `core-spawn.ts` (the static test enforces that too), so the tmux server start and fx can't double-wrap. `tmuxClientEnv()` becomes `childEnv()`. On its first successful call per process, `ensureDisclaimedServer()` also runs `tmux set-environment -g -u AGETOR_API_TOKEN` (best effort), so a server started by an older build with the token in its env drops it.

**Disclaim switch.** In-memory, default on (`disclaim.ts`). `initDisclaimSwitch("app", deps)`: stored `"false"` → keep on, ask `confirmKeepOff()` (native message box; default and cancel button = turn it back on); "keep off" → switch off; otherwise write `"true"`. `initDisclaimSwitch("headless")`: always on, one log line if stored off (D6). `PUT /preferences/disclaimSpawnedAgents`: CLI caller + off value → 403 desktop-only (D4); app caller → store and apply immediately (D5); headless → store, stay on, log. Turning it off affects the next tmux server and every core spawn from then on; it never restarts a live tmux server.

Dialog copy (P5): title "Permission isolation is off"; message "Agents and Agetor's background programs would run with Agetor's macOS permissions."; detail "It was turned off in Settings, or by something that edited Agetor's database. Keep it off only if you turned it off yourself."; buttons "Turn it back on" (default, cancel), "Keep it off".

Settings copy (D7): label "Keep Agetor's macOS permissions away from agents (macOS)"; help "Agents and the programs Agetor runs in the background, such as git and harness checks, ask for macOS permissions under their own name instead of Agetor's, so a grant sticks after you allow it once. Only this switch can turn it off, and Agetor asks again at the next launch."

**Caller-aware filesystem (D24).** `src/bun/caller-fs.ts`:

```ts
export type ProbeKind = "dir" | "file" | "other" | "missing" | "denied";
export function probePaths(paths: readonly string[], caller: ApiCaller, opts?: { timeoutMs?: number }): Promise<ProbeKind[]>;
export function gateCallerPath(p: string, caller: ApiCaller, mode: "exists" | "nearest-ancestor"):
  Promise<null | { status: 403; error: string; code: "path-not-accessible" }>;
export function callerProjectTree(root: string, caller: ApiCaller, relRoots: readonly string[],
  shouldRead: (rel: string) => boolean): Promise<ProjectTree>;
```

App caller: in-process (`statSync`, `diskProjectTree`). CLI caller: `coreSpawn(["/bin/sh","-c",SCRIPT,"sh",...paths], {env: {...childEnv(), LC_ALL:"C"}})`. The script runs `/usr/bin/stat -L -f %HT -- "$p"` per path and prints one fixed token per line (`dir`, `file`, `other`, `missing`, `denied`), never the path; paths travel as argv (no shell interpolation), at most 256 per child; a timeout means `denied`. The tree uses `coreSpawn(["/usr/bin/tar","-c","-f","-","--format=pax","-L","--exclude",".git","--exclude","node_modules","-C",root,"--",...existingRoots])`, reads at most 8 MB of stdout (then kills the child and uses what parsed), parses with `src/bun/tar-read.ts` (ustar plus pax `x`/`g` records), filters with `shouldRead`, and builds `refProjectTree(map)`. When disclaim is off or unavailable, the child runs undisclaimed, same as in-process (the one switch, D7). Refusal copy: "This path isn't accessible to Agetor's CLI token (macOS protects it for other apps, or a permission prompt is waiting — answer it and try again)."

Path params to declare (T3 audits the full list; the policy test enforces it): `POST /projects` body `path`; `GET /projects/branches` query `path`; `POST /projects/fetch|pull|push` body `path`; `POST /projects/clone` body `dest` (nearest-ancestor); `GET /agent-discovery` query `workdir`; `GET /files/index` query `dir`; `POST /tasks` and `PATCH /tasks/:id` body `workdir`; `POST`/`PATCH /harnesses` body `bin`/`home` wherever the handler touches them in-process; every `/github/*` route reading query `path` or `dir`. Exempt with reasons: `GET|PUT /projects/settings` and `DELETE /projects` (DB only), `POST /refs/resolve` (results come from `probePaths`), `POST /claude-sessions/import` (the cwd comes from the transcript, gated in the handler via the importer's new `gateCwd` option).

**`?token=` removal.** CLI sends a header (`sse.ts`). Webview: SSE via `openEventStream`, terminal via ticket, images via `AuthedImg`. The master is never accepted in a query (P6).

**Evidence vs. reasoning.** Evidence: the spikes in §2 and the code anchors. Reasoning only, checked during execution: P5 placement (manual QA), TCC returning EPERM rather than ENOENT for a disclaimed probe (T4 acceptance), fetch streaming in WKWebView (manual QA), disclaim exec overhead (T1 acceptance), App Management protecting the packaged helpers (grill assumption).

### Interfaces pinned for parallel work

```ts
// src/bun/disclaim.ts (T1)
export const DISCLAIM_PREF_KEY = "disclaimSpawnedAgents";
export function isDisclaimOffValue(v: string | null | undefined): boolean;   // v === "false"
export function getDisclaimSwitch(): boolean;                                 // default true
export function setDisclaimSwitch(on: boolean): void;
export function disclaimEnabled(): boolean;                                   // darwin && switch && available
export function disclaimArgv(argv: string[]): string[];                       // core-spawn.ts + tests only
export function resolveDisclaimBin(): string; export function disclaimAvailable(): boolean;

// src/bun/core-spawn.ts (T1)
export const SCRUBBED_ENV_KEYS: readonly string[];                            // ["AGETOR_API_TOKEN"]
export function childEnv(extra?: Record<string, string | undefined>,
  base?: Record<string, string | undefined>): Record<string, string | undefined>;
export function coreSpawn(argv: string[], opts?: Parameters<typeof Bun.spawn>[1]): ReturnType<typeof Bun.spawn>;
export function coreSpawnSync(file: string, args: string[],
  opts?: import("node:child_process").SpawnSyncOptions): import("node:child_process").SpawnSyncReturns<string | Buffer>;

// src/bun/disclaim-switch.ts (T2)
export interface DisclaimSwitchDeps { readPref(): string | null; writePref(v: string): void;
  confirmKeepOff?: () => boolean | Promise<boolean>; log(msg: string): void }
export function initDisclaimSwitch(mode: "app" | "headless", deps: DisclaimSwitchDeps): Promise<void>;
export function applyDisclaimPreferenceWrite(mode: "app" | "headless", value: string, log: (m: string) => void): void;

// src/bun/api-config.ts (T3)
export const API_TOKEN: string; export const CLI_TOKEN: string;

// src/bun/route-policy.ts (T3) — RoutePolicy/ROUTE_POLICY as above, plus:
export function resolveCaller(req: Request, policy: RoutePolicy): ApiCaller | null;
export function callerOf(req: Request): ApiCaller | null;
export function applyRoutePolicy<T>(routes: T, opts: { headless: boolean;
  cors: (req: Request) => Record<string, string>;
  gate: (p: string, caller: ApiCaller, mode: PathParam["mode"]) => Promise<null | { status: 403; error: string; code: string }>;
  notAvailableHeadless: (req: Request) => Response }): T;
export function desktopOnlyResponse(req: Request, cors: (req: Request) => Record<string, string>): Response;

// src/bun/ref-tree.ts (T4) — rename DEFAULT_PATHSPECS and export it:
export const PROJECT_CAPABILITY_PATHSPECS: readonly string[];

// src/shared/sse-parse.ts (T5)
export interface SseFrame { event: string; data: string; retry?: number }   // event defaults to "message"
export function createSseParser(): { push(chunk: string): SseFrame[] };

// src/mainview/lib/sse-fetch.ts (T6)
export function openEventStream(url: string, handlers: { onMessage?(data: string): void;
  events?: Record<string, (data: string) => void>; onError?(e: unknown): void }): () => void;

// commands.ts (T7): DiscoveryOpts gains
//   projectTreeLoader?: (root: string, shouldRead: (rel: string) => boolean) => Promise<ProjectTree>;
// claude-session-import.ts (T9a): the import entry point gains
//   { gateCwd?: (cwd: string) => Promise<string | null> }   // non-null = refusal message for that session
// HTTP: POST /terminals/:id/ws-ticket → 201 {ticket: string, expiresAt: number}; 404 unknown terminal.
```

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Spawn wrapper and in-memory disclaim state | `src/bun/core-spawn.ts` (new), `src/bun/core-spawn.test.ts` (new), `src/bun/disclaim.ts`, `src/bun/disclaim.test.ts`, `src/bun/tmux-resolution.test.ts` (only if the disclaim change breaks it) | — | Pinned API exists. `disclaim.ts` no longer imports `db.ts`. Unit tests: env always explicit and scrubbed; wrapped argv = `[helper, resolvedAbs, ...rest]` with a recording `AGETOR_DISCLAIM_BIN`; missing absolute bin and PATH miss throw the same shapes as `Bun.spawn`; passthrough when unavailable/off/non-darwin; sync variant parity. Report a measured p50/p95 overhead of 200× `git status --porcelain` and `tmux -L <scratch> display -p x` with and without `vendor/disclaim/disclaim` (build it with `bun run vendor:disclaim`). |
| T2 | Launch-time disclaim switch | `src/bun/disclaim-switch.ts` (new), `src/bun/disclaim-switch.test.ts` (new) | T1 interface | Tests cover: app + stored off → switch on until `confirmKeepOff` resolves; keep-off → off; turn-on → pref written `"true"`; headless + stored off → stays on, logs once; `applyDisclaimPreferenceWrite` for app/headless, on/off values. |
| T3 | Two tokens, policy table, walker (defines `ApiCaller`) | `src/bun/route-policy.ts` (new), `src/bun/route-policy.test.ts` (new), `src/bun/api-config.ts`, `src/bun/api-config.test.ts` | — | `CLI_TOKEN` exported; `AGETOR_API_TOKEN` deleted from `process.env` after read; stale hooks/MCP wording in `api-config.ts:18-31, 68` rewritten. `ROUTE_POLICY` has an entry for every route key and method in `server.ts` (read-only audit), desktop-only set exactly as §3, `legacyQueryToken` on exactly the 3 SSE GETs, `headless501` on exactly the desktop-only routes whose handler 501s first without `native`, `pathParams`/`pathParamsExempt` per §3. Static/unit tests in `route-policy.test.ts` (see TT3). |
| T4 | Caller-aware filesystem helpers | `src/bun/caller-fs.ts` (new), `src/bun/caller-fs.test.ts` (new), `src/bun/tar-read.ts` (new), `src/bun/tar-read.test.ts` (new), `src/bun/ref-tree.ts` (export rename only) | T1 interface (`coreSpawn`, `childEnv`), T3 interface (`ApiCaller` type) | Pinned API exists; CLI path goes through `coreSpawn` with absolute `/bin/sh`, `/usr/bin/stat`, `/usr/bin/tar`. Tests: classification for dir/file/symlink/missing and a `chmod 000` parent (`denied`); paths with spaces, newlines, leading `-`; chunking above 256 paths; timeout → `denied`; `gateCallerPath` modes; `callerProjectTree` parity with `diskProjectTree` on a fixture with `.claude/skills/x/SKILL.md`, a symlinked skill dir, a >100-char path and a non-ASCII name; 8 MB cap. Report the exact `stat` stderr for a disclaimed probe of a TCC-protected path (e.g. `~/Library/Mail` without Full Disk Access) to confirm EPERM classifies as `denied`. |
| T5 | Shared SSE parser; CLI sends a header | `src/shared/sse-parse.ts` (new), `src/shared/sse-parse.test.ts` (new), `src/cli/sse.ts`, `src/cli/sse.test.ts` (new) | — | Parser handles `event:`, multi-line `data:`, `retry:`, comments, CRLF/CR, split chunks, frames without data. `streamSse` sends `authorization: Bearer`, never `?token=`, and still drops pings and non-`message` events. |
| T6 | Webview SSE via fetch, images via blob | `src/mainview/lib/sse-fetch.ts` (new), `src/mainview/lib/sse-fetch.test.ts` (new), `src/mainview/lib/authed-blob.ts` (new), `src/mainview/lib/authed-blob.test.ts` (new), `src/mainview/components/ui/authed-img.tsx` (new), `src/mainview/lib/api.ts`, `src/mainview/components/kanban/SentFilesCard.tsx`, `src/mainview/components/kanban/MdImage.tsx`, `src/mainview/components/kanban/AttachmentChips.tsx`, `src/mainview/components/kanban/BinaryFilePreview.tsx`, `e2e/markdown-images.spec.ts` | T5 interface | The four `subscribe*` functions keep their signatures and use `openEventStream` with a header. `filePreviewUrl`/`taskDiffBlobUrl`/`pullBlobUrl` return token-less URLs. Image consumers render `AuthedImg`; `MdImage` still walks candidates (non-ok status → next); `BinaryFilePreview` classifies from the hook; `probeBlobStatus` deleted, no caller left. `terminalSocketUrl` is untouched in this wave. The markdown-images spec asserts `data-src-url` instead of `src`. |
| T7 | Server integration (single owner of `server.ts`) | `src/bun/server.ts`, `src/bun/commands.ts` | W1 (T1–T6, T14) | `routes` wrapped by `applyRoutePolicy` (server refuses to start on a gap); single-token `tokenMatches`/`isAuthorized` replaced by the caller resolver; `authed()` = valid caller else 401. WS upgrade accepts only `?ticket=`; `POST /terminals/:id/ws-ticket` added. `PUT /preferences/:key`: value rule + `applyDisclaimPreferenceWrite(native ? "app" : "headless", …)`. `/refs/resolve` → `probePaths(paths, callerOf(req))`. `/agent-discovery` passes `projectTreeLoader` = `callerProjectTree(root, "cli", PROJECT_CAPABILITY_PATHSPECS, …)` for a CLI caller with no branch; `commands.ts` honours `projectTreeLoader`. `/claude-sessions/import` passes `gateCwd` for a CLI caller. osascript at `/usr/bin/osascript` with `env: childEnv()` and `spawn-exempt(osascript)` markers. No other raw spawn in `server.ts`. The cursor plan-approve write (`.cursor/plans/<slug>_<id>.plan.md`) and its worktree-exists check go through T14 (`taskDirExists`, `writeTaskDirFileAtomic`, D25). Stale comments fixed (`/health` hook wording, CORS, WS, `/daemon/shutdown`). |
| T9a | Wrap git, probe and helper spawns; async `@` expansion | `src/bun/worktree.ts`, `src/bun/clone.ts`, `src/bun/github.ts`, `src/bun/ref-tree.ts`, `src/bun/agent-status.ts`, `src/bun/claude-session-import.ts`, `src/bun/claude-session-scan.ts`, `src/bun/project-files.ts`, `src/bun/agent-discovery.ts`, `src/bun/usage/creds.ts`, `src/bun/login-path.ts`, `src/bun/git-provider.ts` | W1 | Every listed spawn uses `coreSpawn`/`coreSpawnSync`, keeping each site's stdio, timeout and kill behavior; `claude-session-import.ts` gains `gateCwd`; `project-files.ts` gains `expandAtReferencesDetailedAsync(text, cwd, resolve = resolveAtPathsInTaskDir)` (one batched resolver call per text, identical output to the sync form). Owned source only; broken tests go to TT9. |
| T9b | Wrap tmux and agent hosting; scrub env; mark exemptions | `src/bun/tmux-resolution.ts`, `src/bun/claude-tmux.ts`, `src/bun/fx-acp.ts`, `src/bun/terminals.ts`, `src/bun/task-notifier.ts` | W1 | `tmuxClientEnv` → `childEnv`; `ensureDisclaimedServer`, `spawnTmuxNewSession` and claude-tmux's `tmux()` use `coreSpawn` (D22); one-time `set-environment -g -u AGETOR_API_TOKEN`; `buildEnsureServerArgv` and fx no longer call `disclaimArgv`. `terminals.ts` uses `childEnv({TERM:"xterm-256color"})` with a `spawn-exempt(terminal-tab)` marker; `task-notifier.ts` sites get `spawn-exempt(notifier)` markers and `childEnv()`. Stale comment at `claude-tmux.ts:8121-8125` rewritten. |
| T10 | Boot wiring and creds | `src/bun/index.ts`, `src/bun/headless.ts`, `src/bun/core-creds.ts` (doc comments only), `scripts/dev-headless.sh` | W1 | Both boots write `CLI_TOKEN` to the creds file; the app's preload and hash keep `API_TOKEN`. App: `initDisclaimSwitch("app", {confirmKeepOff: native message box …})` before `ensureDisclaimedServer()` (P5); headless: `initDisclaimSwitch("headless")` before its `ensureDisclaimedServer()`. lsregister and `open -R` via `coreSpawn`. `dev-headless.sh` writes the token file 0600 (`umask 077` in a subshell, then `chmod 600` on an existing file). |
| T11 | Webview terminal ticket; Settings copy | `src/mainview/lib/api.ts`, `src/mainview/components/kanban/TerminalView.tsx`, `src/mainview/components/settings/SettingsDialog.tsx` | T7 interface (ticket route) | `terminalSocketUrl(id)` is async: POSTs the ticket route, returns `ws://…/terminals/:id/ws?ticket=…`; `TerminalView` mints a fresh ticket per connect and reconnect, keeping the 3-attempt loop. Settings label and help per §3. |
| T12 | CLI error wording | `src/cli/commands/config.ts`, `src/cli/api-client.ts` | T7 interface (403 body) | `agetor config disclaimSpawnedAgents false` against a core prints "only available in the Agetor app" plus "change it in Settings → General", exits non-zero; `ApiError` exposes the body's `code`. Any 403 `desktop-only` or `path-not-accessible` from any command prints its message plainly. No other behavior change. |
| T14 | Disclaimed task-directory I/O helpers (D25) | `src/bun/task-dir-fs.ts` (new), `src/bun/task-dir-fs.test.ts` (new) | T1 interface (`coreSpawn`, `childEnv`, `disclaimEnabled`) | API: `resolveAtPathsInTaskDir(cwd, items: {rel: string; isDir: boolean}[]): Promise<(string \| null)[]>` with exactly `resolveAtPath`'s semantics (safe-rel check in-process first, existence, directory-ness, realpath containment under realpath(cwd), trailing `/` on a dir); `taskDirExists(p): Promise<boolean>`; `readTaskDirFile(p, maxBytes): Promise<{kind:"ok"; text} \| {kind:"missing"} \| {kind:"error"; message}>`; `writeTaskDirFileAtomic(p, content, {mkdirParent})`. Disclaimed path: one `coreSpawn` child per call (`/bin/sh -c SCRIPT sh …args`, content on stdin, paths as argv, fixed-token output, never interpolated), 10 s timeout. In-process path when `!disclaimEnabled()`. Tests cover both paths (recording `AGETOR_DISCLAIM_BIN` stub that `exec "$@"`), spaces/newlines/leading `-` in names, symlink escaping cwd, missing cwd, atomic write leaves no temp file, oversized read. |
| T15 | Route orchestrator task-directory I/O through T14 (D25) | `src/bun/orchestrator.ts`, `src/bun/hook-installer.ts`, `src/bun/hook-installer.test.ts` (on demand) | T14, T9a (`expandAtReferencesDetailedAsync` in `project-files.ts`) | `startTask`/`sendInput` use the async expansion (resolver = `resolveAtPathsInTaskDir`); `applyAgetorSettings` reads/writes `settings.local.json` and checks `cwd` through T14 (merge logic unchanged, still atomic, still refuse-on-malformed). No other behavior change. |
| T13 | Docs | `README.md`, `CLAUDE.md`, `docs/plans/companion-pairing-requirements.md` (new), `.claude/CLAUDE.md` (delete), `docs/qa/master-token-agent-read-qa.md` (new) | W2 | README: approved Security-model bullets (D23 text below); `agetor-core.json` lines say "CLI token"; container note: desktop-only routes (terminals, file preview…) refuse the file token with 403; stale "agent hooks" wording at `README.md:316` fixed. CLAUDE.md: Stack-and-architecture token paragraph (two tokens, policy table, legacy SSE query, WS ticket, `blob:` images), TCC-disclaim paragraph (one switch covers core spawns, launch confirm, headless always on, wrapper + exemption list + static test, D22), D24 caller-fs, env scrub, and three "Things that will trip you up" bullets (every route needs a policy entry or the server won't start; every spawn uses `coreSpawn`; path params need `pathParams`). Companion doc per D15. QA checklist for W4. `.claude/CLAUDE.md` removed (D19; its whole content is the stale `ask_user` text). |

**README Security-model text (D23, approved):**

> - **Agents run with your privileges.** (unchanged)
> - **Your agents can read the CLI's token.** `agetor-core.json` holds the token the `agetor` CLI uses. Any program running as you, your agents included, can read it, just as it can read your other files. That token only does what the CLI does: create and drive tasks, answer prompts, manage harnesses, agents and pipelines. It can't open terminal tabs, show your files in the app, use the native dialogs, or turn off permission isolation. Those need the app's own token, which is never written to disk.
> - **Agetor's macOS permissions stay with Agetor.** Agents and every program Agetor starts in the background (git, harness checks) run as responsible for themselves, so they don't inherit the permissions you granted Agetor, such as Automation or Documents. Only Settings in the app can turn this off, and Agetor asks you again at the next launch.
> - **Only local, authenticated access.** (unchanged, "the token" → "its tokens")
> - Untrusted text / Minimal network use: unchanged.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TT1 | unit | T1 | (inside T1) `core-spawn.test.ts`, `disclaim.test.ts` | as T1 |
| TT2 | unit | T2 | (inside T2) `disclaim-switch.test.ts` | as T2 |
| TT3 | unit / static | T3 | (inside T3) `route-policy.test.ts`, `api-config.test.ts` | (a) every `server.ts` route key (regex scan) has an entry, and no entry lacks a route; (b) desktop-only set equals §3; (c) no path in any scope has a segment matching `pair`, `pairing`, `device(s)`, `remote`, `remote-access`, and no route other than the allowlisted `/fx-permissions/:id/answer` ends in `permission(s)`; (d) every route the CLI calls is `app+cli` for that method, extracted from `src/cli/api-client.ts` (`req`, multi-line `req`, `bundleReq`), `src/cli/sse.ts` callers, `src/cli/daemon/supervisor.ts`, `core-creds.ts` `/info` and `index.ts` `/daemon/shutdown`, with a floor of ≥ 65 extracted routes so a refactor can't empty it; (e) `legacyQueryToken` only on the 3 SSE GETs; (f) source scan: every `app+cli` route whose handler text reads `path|dir|workdir|cwd|dest|home|bin|paths` from query or body declares `pathParams` or `pathParamsExempt`; (g) walker unit tests with fake handlers: 401, 403 desktop-only, 501 headless, gate refusal, master-in-query 401, legacy CLI query accepted only where flagged, startup throw on missing/extra/mismatched entries. |
| TT4 | unit | T4 | (inside T4) `caller-fs.test.ts`, `tar-read.test.ts` | as T4 |
| TT5 | unit | T5 | (inside T5) `sse-parse.test.ts`, `src/cli/sse.test.ts` | as T5; `sse.test.ts` asserts the request has the header and no `token=` (local `Bun.serve` stub) |
| TT6 | unit | T6 | (inside T6) `sse-fetch.test.ts`, `authed-blob.test.ts` | stubbed `fetch` streams: named + unnamed events, reconnect after clean end, `retry:` honored, stop on 401/403/404, close aborts; cache refcount, revoke after grace, status mapping 404/413/other |
| TT7 | integration (bun, in-process server) | T7 | `src/bun/server-auth.test.ts`, `src/bun/server-blob.test.ts`, `src/bun/server-events-anchor.test.ts`, `src/bun/server-rebuild-byte-budget.test.ts`, `src/bun/server-sse-initial-frame.test.ts`, `src/bun/db-events-paging.test.ts`, `src/bun/files-preview-endpoint.test.ts`, `src/bun/claude-subagents.integration.test.ts`, `src/bun/headless-routes.test.ts` (on demand), `src/bun/terminals.test.ts` (on demand) | Same wave as T7. `?token=<master>` usages become headers; "accepts ?token=" tests become "rejects ?token= for the master" plus "accepts ?token= for the CLI token on /events". Everything green after T7. |
| TT9 | static + integration | T9a, T9b | `src/bun/core-spawn-allowlist.test.ts` (new), `src/bun/core-spawn-disclaim.integration.test.ts` (new), `src/bun/tmux-resolution.test.ts`; on demand: `agent-status.test.ts`, `login-path.test.ts`, `git-provider.test.ts`, `worktree.test.ts`, `fx-acp.test.ts`, `task-notifier.test.ts`, `claude-session-import.test.ts`, `claude-session-scan.test.ts`, `clone.test.ts` | Static: scans non-test `src/bun/**/*.ts` and `src/shared/**/*.ts` (excluding `*-test-util.ts`) for `Bun.spawn(`, `Bun.spawnSync(`, `spawnSync(`, `child_process` imports, `execFile`, `Bun.$`; only `core-spawn.ts` and marker-annotated lines pass; the (file, category) list is pinned (`server.ts`×2 osascript, `terminals.ts`×1 terminal-tab, `task-notifier.ts`×1 notifier — the plan said ×2, but the file has one raw spawn; the other call goes through its injected `spawn` seam); `disclaimArgv(` appears only in `core-spawn.ts`. Integration with a recording-stub `AGETOR_DISCLAIM_BIN` (logs argv, then `exec "$@"`): a temp repo with `core.fsmonitor` = a script writing a marker → `hasUncommittedChanges()` → the stub log shows `git … status --porcelain` and the marker exists; a harness probe (`checkAgent` with a stub bin) and a tmux client call (`AGETOR_TMUX_BIN` = a stub) appear in the stub log; the tmux client env lacks `AGETOR_API_TOKEN` when the parent had it. `bun test` runs every file in one process, so each test saves and restores `AGETOR_DISCLAIM_BIN`, `AGETOR_TMUX_BIN` and the disclaim switch it changes. |
| TT10 | integration | T10 | `src/bun/daemon-boot.test.ts`, `src/bun/daemon-handoff.test.ts`, `src/bun/core-creds.test.ts` (on demand) | The headless creds file token equals `CLI_TOKEN` and differs from `API_TOKEN`; the handoff still stops a daemon via its file token; a headless boot with stored `disclaimSpawnedAgents=false` logs the always-on line. |
| TT15a | integration (bun) | T3, T7 end to end | `src/bun/route-policy-endpoint.test.ts` (new) | Starts `startApiServer` headless (one port) and with `makeTestNative` (app mode, another port): for every desktop-only route+method, CLI token → 403 desktop-only (app) or 501/403 per `headless501` (headless), master → not 401/403; for each `headless501` route, master on headless also gets 501 (the flag is truthful; skip `/refs/pick` when the fake-pick seam is set). WS: ticket single-use, expired, wrong terminal, missing → refused; `?token=` on the WS path → refused. Disclaim value rule for CLI/app/headless. Path gate: with `probePaths` returning `denied` for a `chmod 000` dir, a CLI `POST /projects` → 403 `path-not-accessible`, master → today's answer. `/health` unauthenticated; `/info` CLI-scoped. |
| TT15b | integration (CLI → real core) | T7 + CLI | `src/cli/cli-scope-daemon.test.ts` (new), `src/cli/agent-profile-daemon.test.ts`, `src/cli/bundle-daemon.test.ts` | New test enumerates `Object.getOwnPropertyNames(AgetorClient.prototype)` and requires a call-table row for each method; each call with `CLI_TOKEN` against an in-process core returns neither 401 nor 403 (404/400 for missing fixtures is fine). Covers the S4 gap (`startTask`, `sendInput`, `cancelRun`, answer routes, pipeline routes, notifications, DB tools, files index, issue thread). The two existing daemon tests switch from `API_TOKEN` to `CLI_TOKEN`. Ports distinct from existing CLI tests; run serialized. |
| TT14 | e2e (Playwright) | T6, T11, T7 | `e2e/no-query-token.spec.ts` (new) | With `page.on("request"/"websocket")`: open a task with a fake run, open a terminal tab, render a markdown image and a sent-file thumbnail, receive a toast from `/events`; assert no request or WebSocket URL contains `token=`, the terminal socket URL contains `ticket=`, images have `blob:` sources, and the run panel streams. |
| V1 | verification (W4) | whole change | `docs/qa/master-token-agent-read-qa.md` (results section) | Typecheck, `bun test` (CLI serialized) and full Playwright green on the final tree; the spike re-runs and the manual QA checklist in §6 W4 pass, with results written into the QA doc; any failure goes back to the owning task, not into a follow-up. |

**E2e decision: applies.** The change alters user-visible webview flows that cross the webview → core boundary (SSE streaming, terminal WebSocket, image loading) and the CLI → core boundary (covered by TT15b against a real core). Existing specs exercise SSE on every page; `terminal-drift.spec.ts` exercises the terminal; `markdown-images.spec.ts` and `sent-files.spec.ts` exercise images; TT14 adds the network audit. Chromium can't show WKWebView-specific behavior (fetch streaming, connection cap), so W4 adds a manual pass in the dev app.

**Run recipe**

- Setup: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`; `bun install` (already done in this worktree); `bun run vendor:disclaim` for T1's measurement and manual QA.
- `bun run typecheck`.
- `bun test` for everything except `src/cli`; then `bun test src/cli` alone (fixed ports; check `uptime`, don't run beside another suite). Known pre-existing failures on `main`: tmux-socket ×2 and the reconcile-cancel test.
- E2e: `bun node_modules/@playwright/test/cli.js test` (Playwright starts Vite on 5173; each worker spawns its own headless backend with fake drivers and `AGETOR_API_TOKEN`). One Playwright run at a time.
- Throwaway core for spike re-runs (D21): `AGETOR_DATA_DIR=<tmp> AGETOR_API_PORT=<port> AGETOR_DAEMON_IDLE_MS=60000 AGETOR_CLAUDE_DRIVER=fake AGETOR_{CLAUDE,TMUX,CODEX,CURSOR,GEMINI,FX,ANTIGRAVITY}_BIN=/bin/echo AGETOR_DISCLAIM_BIN=<recording stub> bun src/bun/headless.ts`; call it with the token from `<tmp>/agetor-core.json`.
- Manual QA: `bun run dev:hmr` (package scripts pin `AGETOR_DATA_DIR=$HOME/.agetor-dev`); never `~/.agetor`.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| W1 | T1, T2, T3, T4, T5, T6, T14 | New modules exist with green unit tests; the CLI and webview send headers (the server already accepts them); nothing in `server.ts` or the spawn sites changed. Typecheck + `bun test` + the markdown-images spec green. Checkpoint commit. |
| W2 | T7, T9a, T9b, T10, T11, T12, TT7, TT9, TT10 (then T15, which needs T9a's async expansion) | The breaking changes land together with the callers and tests they break: master-in-query rejection (T7) with the webview terminal ticket (T11) and the server tests (TT7); the spawn migration (T9a/T9b) with the static and stub tests (TT9); the creds token switch (T10) with TT10. Typecheck + full `bun test` green. Checkpoint commit. |
| W3 | T13, TT14, TT15a, TT15b | New coverage and docs. Typecheck + full `bun test` + full Playwright green. Checkpoint commit. |
| W4 | V1 (verification, single agent) | Re-run the spikes on a throwaway core (desktop-only routes refuse the file token; disclaim-off refused; fsmonitor via the stub; `?token=<master>` refused); manual QA in the dev app per `docs/qa/master-token-agent-read-qa.md` (WKWebView SSE streams, terminal tab, images, launch dialog with a stored `false` in `~/.agetor-dev`, Settings copy, Open terminal / Open tmux via `/usr/bin/osascript`, Reveal in Finder via disclaimed `open -R`, notifier registration, a `~/Documents` project under disclaimed git). Results recorded in the QA doc. |

Ownership check: no path appears twice within a wave. `api.ts` is T6 in W1 and T11 in W2; `ref-tree.ts` is T4 in W1 and T9a in W2; `tmux-resolution.test.ts` is T1 in W1 and TT9 in W2. `server.ts` and `commands.ts` belong only to T7.

## 7. Blast radius & risks

- **Every request path.** The walker wraps all 192 routes. A missing entry stops the server from starting, which every server test catches; TT3/TT15a pin coverage. Typing: the wrapped routes object may need a cast to Bun's `routes` type; handlers already take `req: any` through `authed()`.
- **CLI breakage.** A CLI route left `app` would fail only at runtime; TT3(d) and TT15b (every `AgetorClient` method against a real core) close that.
- **Older installed CLIs** read the new file and get the CLI token; their `?token=` on SSE stays accepted (P6). A new CLI against an older core reads the master and uses headers, which older cores accept.
- **App⇄daemon handoff** uses the daemon's file token on `/daemon/shutdown` (`app+cli`).
- **Headless container users** who drove terminals, file preview, screenshots or attachments with the file token now get 403 (D12); documented in README.
- **Webview streaming in WKWebView.** Fetch-body streaming replaces EventSource; Chromium e2e can't prove WKWebView behaves the same. Manual QA in W4. If WKWebView buffers the body, the contingency (same branch) is a short-lived single-use SSE ticket in the URL, mirroring P7; that is a fix within this plan, not a deferral.
- **Connection budget** unchanged in count (one fetch per former EventSource); CORS preflights for header-carrying GETs are short.
- **Image memory**: object URLs are refcounted and revoked; MdImage candidate retries fetch at most each candidate once.
- **Spawn behavior change**: wrapped spawns now get the live, scrubbed `process.env` instead of Bun's startup snapshot (likely fixes Finder-launch PATH gaps; anything relying on the snapshot changes). ENOENT parity is pinned by T1 tests.
- **Disclaim overhead** on git-status polls, scraper `capture-pane`, harness probes: ~1 exec each, measured in T1.
- **TCC prompts**: disclaimed git, sh, stat, tar or tmux touching a protected folder may show a one-time prompt naming that binary (accepted in D1). A probe waiting on a prompt times out after 10 s and the CLI request is refused with copy that says so.
- **Launch dialog** blocks the Bun thread while shown (synchronous FFI); placed before services start (P5).
- **Dev builds**: the helper resolves from the repo and fails open when missing; the dev token file is still readable by same-user agents at 0600. Dev is not a target (grill).
- **Rollback**: revert the branch. No DB migration; the creds file shape is unchanged; a stored `disclaimSpawnedAgents` value keeps its meaning.
- **Sibling paths**: `src/bun/github-tokens.ts:86` mirrors `writeCoreCreds` (comment only, untouched); `src/cli/notify.ts` posts `/notifications` (`app+cli`, 501 headless as today); the TUI uses `AgetorClient` (covered by TT15b).

## 8. Open questions / assumptions

Decide first at plan approval:

1. **Resolved (D25): pulled into this branch** — tasks T14/T15, T7 for the plan-file write. Original note: **Task-directory I/O stays in the core process (residual).** D24 gates caller-named paths at the request: a CLI-token `POST /tasks`/`PATCH /tasks/:id` workdir must pass the disclaimed probe. After that, the orchestrator still touches the task's directory in-process during runs: `@`-mention existence checks (`resolveAtPath` in `sendInput`/`startTask`), stripping stale entries from `.claude/settings.local.json`, writing cursor plan files on approve. For a task the user created in the app inside a protected folder, a CLI-token caller can trigger those touches. They are existence checks on names the caller picks and writes of Agetor-owned files, and the agent that works there needs its own access to the folder anyway. Moving orchestrator task-directory I/O into disclaimed children is an architecture change; this plan documents it as a residual (README/CLAUDE.md) rather than doing it. **Owner to confirm or pull it in.**
2. **Agent-discovery for CLI callers reads via `tar`.** Parity with the live-disk tree is pinned by T4 tests; a skill symlinked to a very large tree is truncated at 8 MB.

Carried from the grill (unchanged): the packaged app's helpers can't be tampered with (App Management); the launch dialog can't be answered by an agent (no Accessibility for disclaimed agents); disclaim costs little per spawn (now measured in T1); TCC prompts for disclaimed tools in protected folders are acceptable; older CLIs keep working (A5, P6); the webview's in-memory master stays out of reach (A6).

New, checked during execution: `showMessageBox` renders before the first `BrowserWindow` (P5; fallback defined); a disclaimed probe of a TCC-protected path reports EPERM, not ENOENT (T4); WKWebView streams fetch bodies for `text/event-stream` (W4 manual QA; contingency in §7).

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| CLI token in `agetor-core.json`; master in memory only (D3) | in this run | T3, T10, TT10 |
| `AGETOR_API_TOKEN` keeps meaning "master" for e2e/dev | in this run | T3 |
| Policy table, deny by default, startup refusal on gaps (D14) | in this run | T3, T7, TT3, TT15a |
| Desktop-only routes + 403/501 refusals (D9, D11, D12) | in this run | T3, T7, TT15a |
| Terminal WS ticket route + webview use (D13) | in this run | T7, T11, TT14, TT15a |
| Webview SSE without `?token=` (D13) | in this run | T6, TT6, TT14 |
| Webview images via `blob:` (D13) | in this run | T6, TT6, TT14 |
| `probeBlobStatus` orphaned by the image change | in this run (deleted) | T6 |
| Unused `subscribeRun` | in this run (converted with the others, signature kept) | T6 |
| CLI SSE header (D13) | in this run | T5, TT5 |
| Legacy `?token=` for the CLI token on 3 SSE GETs (D13) | in this run (kept, deprecated) | T3, TT15a; removal later is a separate ticket once old CLIs are gone (grill) |
| Master never accepted in a query; tests using it updated | in this run | T7, TT7 |
| Disclaim value rule for the CLI token (D4) | in this run | T7, TT15a |
| `agetor config disclaimSpawnedAgents false` prints the desktop-only error | in this run | T12 |
| Launch-time read + native confirm (D5); headless always on (D6) | in this run | T2, T10, TT2, TT10, W4 QA |
| One switch covers core spawns; Settings copy (D7) | in this run | T1, T11 |
| Spawn wrapper for every core spawn, exemptions, static test (D1, D8) | in this run | T1, T9a, T9b, T7, TT9 |
| tmux client calls disclaimed (D22) | in this run | T9b, TT9 |
| osascript by absolute path | in this run | T7 |
| `lsregister` / `open -R` wrapped | in this run | T10, W4 QA |
| `ssh -G` and login-shell `spawnSync` wrapped | in this run | T9a |
| ENOENT parity for wrapped spawns | in this run | T1 |
| Env scrub for every child incl. exempt sites (D16) | in this run | T1, T9b, T7, TT9 |
| Stale tmux-server env cleared (`set-environment -g -u`) | in this run | T9b |
| Dev token file 0600 (D17) | in this run | T10 |
| Caller-aware path gate for CLI routes (D24) | in this run | T3, T4, T7, TT3(f), TT15a |
| `/refs/resolve` safe for the CLI (D24) | in this run | T4, T7 |
| Agent-discovery live tree safe for the CLI (D24) | in this run | T4, T7 |
| Claude-session import cwd gate (D24) | in this run | T9a, T7 |
| Orchestrator task-directory I/O in disclaimed children (D25) | in this run | T14, T15, T9a, T7 |
| Real-core CLI coverage for mocked routes (S4, D21) | in this run | TT15b |
| Fsmonitor/probe/tmux through the wrapper (D21) | in this run | TT9, V1 |
| Spike re-run on a throwaway core (D21) | in this run | V1 |
| README security model + creds lines + container note + stale hooks text (D18, D23) | in this run | T13 |
| CLAUDE.md architecture, disclaim, trip-ups (D18) | in this run | T13 |
| Stale comments in `api-config.ts`, `claude-tmux.ts:8121-8125`, `server.ts` `/health` (D18) | in this run | T3, T9b, T7 |
| Delete `.claude/CLAUDE.md` (D19) | in this run | T13 |
| Companion pairing requirements doc (D15) | in this run (doc only) | T13 |
| Manual QA checklist + results | in this run | T13 (checklist), V1 (results) |
| Native pairing UI and device registry | out of scope | Companion v1 feature; nothing to pair with yet (owner, D2) |
| Disclaiming terminal tabs | out of scope | Owner kept tabs on Agetor's identity (D8) |
| "Open terminal" running a swapped harness `bin` in Terminal.app | out of scope (accepted residual) | Owner, D20 |
| Hardening git with `-c core.fsmonitor=` and similar | out of scope | Superseded by the wrapper (grill) |
| `POST /tasks` 500 on unparseable JSON | out of scope | Unrelated bug, separate ticket (grill) |
| `~/.agetor/github-tokens.json` readable by agents | out of scope | Different credential, no escalation beyond the user's own git access (investigation K18) |
| Sandboxing agents | out of scope | Product direction (investigation A2) |
