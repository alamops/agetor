# Manual QA — master token / agent-read hardening

Covers what the automated suites can't prove: WKWebView behavior in the real app, native dialogs, and macOS permission prompts. Automated coverage (typecheck, `bun test`, Playwright) is described in `docs/plans/master-token-agent-read.md`.

**Data dir.** Run everything below against the dev app and `~/.agetor-dev` only. Never point a step at `~/.agetor`, and never run the CLI steps against a production Agetor that happens to be open: the CLI talks to whichever core is listening on its configured port (`AGETOR_API_PORT`, default 4317). The dev app listens on 4318, so set `AGETOR_API_PORT=4318 AGETOR_DATA_DIR="$HOME/.agetor-dev"` for every `agetor` command here.

## Setup

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install
bun run dev:hmr        # Vite + Electrobun, data in ~/.agetor-dev, API on 4318
```

Have one small git project ready (call it `<repo>`), and one more inside `~/Documents` (`<docs-repo>`). Use the fake claude driver (`AGETOR_CLAUDE_DRIVER=fake`) for steps that only need a run to exist.

## A. Webview streaming and images (WKWebView)

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| A1 | Open the board, create a task on `<repo>` with isolation off, start it, open its run panel. | Messages stream in live (not only after a refresh). The panel shows no "Agetor is busy" strip. | |
| A2 | Leave the panel open while the task finishes. | The final message and status change appear without reloading; the card moves column. | |
| A3 | With the panel open, wait two minutes. | Streaming is still live. If it stalls, check the Web Inspector network tab for the `/tasks/:id/events` fetch: it should end and reconnect, not hang. | |
| A4 | Trigger a toast from `/events` (finish a run while another task's panel is open). | Toast appears. | |
| A5 | Open Web Inspector (right-click > Inspect) and filter the network tab for `token=`. | No request URL contains `token=`. The terminal WebSocket URL (A6) contains `ticket=`. | |
| A6 | Open a terminal tab in a task's panel. | A shell prompt appears. Type `echo hi`; output shows. | |
| A7 | In the terminal tab, run `exit`, then reopen a terminal tab. Also close and reopen the panel with a tab open. | Each open gets a fresh ticket and connects; no stuck "connecting". | |
| A8 | Ask the fake agent for a message containing a markdown image of a PNG on disk (see `e2e/markdown-images.spec.ts` for the prompt marker). | The image renders inline (it is a `blob:` image in the inspector), not a broken-image icon. | |
| A9 | Click that image. | It opens in the OS viewer (unchanged behavior). | |
| A10 | Run a task whose agent sends a file (`SendUserFile`; fake marker in `e2e/sent-files.spec.ts`). | The sent-files card shows an image thumbnail; non-image files show icons. | |
| A11 | Open the diff dialog on a task that changed a binary or image file. | The preview renders. | |
| A12 | Open a markdown message with ten or more local images. | All load; scrolling stays responsive (the webview fetches at most 3 at a time). | |

## B. Disclaim switch at launch

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| B1 | Quit the dev app. Run `sqlite3 ~/.agetor-dev/agetor.sqlite "update preferences set value='false' where key='disclaimSpawnedAgents'"` (or turn the Settings > General switch off, then quit). Relaunch with `bun run dev`. | Before the board appears, a native dialog titled "Permission isolation is off" asks whether to keep it off. Buttons: "Turn it back on" (default) and "Keep it off". | |
| B2 | Click **Turn it back on**. Open Settings > General. | The switch is on. `sqlite3 ~/.agetor-dev/agetor.sqlite "select value from preferences where key='disclaimSpawnedAgents'"` prints `true`. | |
| B3 | Repeat B1, press Escape / close the dialog. | Same as B2 (cancel = turn back on). | |
| B4 | Repeat B1, click **Keep it off**. | Switch shows off in Settings. Start a task: it runs (without isolation). Relaunch: the dialog appears again. | |
| B5 | While the dialog from B1 is up, check `ps -axo pid,command \| grep "tmux.*agetor-dev"`. | Any tmux server started in that window was started through the disclaim helper (its command line begins with `.../disclaim`). The switch stays on until you answer. | |
| B6 | Set the stored value to `false` again, then start the headless core with `AGETOR_DATA_DIR=~/.agetor-dev AGETOR_API_PORT=4319 bun src/bun/headless.ts` (stop the app first, or use another port). | No dialog. The log has one line saying the stored "off" is ignored on headless. | |
| B7 | With the app running and the switch on, run `AGETOR_API_PORT=4318 AGETOR_DATA_DIR="$HOME/.agetor-dev" bun src/cli/index.ts config disclaimSpawnedAgents false`. | Refused with a plain sentence saying it is only available in the Agetor app. Settings still shows the switch on. | |
| B8 | Same command with `true`. | Accepted. | |
| B9 | In Settings > General, read the label and help text under the switch. | Mentions agents and the programs Agetor runs in the background (git, harness checks), says only this switch turns it off and that Agetor asks again at next launch. | |
| B10 | Toggle the switch off then on in Settings with the app running. | Each change applies at once; no dialog until the next launch. | |

## C. Desktop-only actions that keep Agetor's identity

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| C1 | Settings > Harnesses: **Open terminal** for a harness. | Terminal.app opens running the harness command. On first use macOS may ask to let Agetor control Terminal; allow it. No prompt names `osascript` or another binary. | |
| C2 | In a task with a live claude session, **Open tmux**. | Terminal.app opens attached to the task's tmux session. | |
| C3 | Click **Reveal in Finder** on a sent-file tile and on the app's data folder entry, if present. | Finder opens with the item selected. In `ps` during the click the command is `.../disclaim /usr/bin/open -R ...`. | |
| C4 | Trigger a notification (finish a run with the window unfocused). | The banner is branded Agetor. If notifications were never granted for the dev build, the one-time prompt names Agetor. | |
| C5 | Open a second task's panel and click the notification for the first. | The first task's panel opens (notifier registration and click path intact). | |

## D. Protected folders under disclaim

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| D1 | With disclaim on, add `<docs-repo>` (inside `~/Documents`) as a project and open the board for it. | One macOS prompt names **git** (not Agetor) asking for Documents access. Allow it. | |
| D2 | Reload the board and let the git-status poll run for a minute. | No further prompts. Git status/branch info shows for the project. | |
| D3 | Deny the prompt instead (fresh grant state: `tccutil reset SystemPolicyDocumentsFolder`, repeat D1, click Don't Allow). | The project loads without crashing; git info is empty or shows an error; the app stays responsive. | |
| D4 | With the CLI token (default `agetor` usage, dev ports as above), run `agetor add "x" --workdir ~/Documents/<docs-repo>` while access is denied. | Refused with a path-not-accessible message, not a hang and not an Agetor-named TCC prompt. | |
| D5 | Start a task inside `<docs-repo>` with `@README.md` in the prompt. | The mention expands to an absolute path; no prompt names Agetor. | |

## E. Credentials and old clients

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| E1 | `cat ~/.agetor-dev/agetor-core.json` while the app runs. | Contains `port` and `token`. The token is not the one the webview uses (compare with `window.__AGETOR.token` in the Web Inspector console): they differ. | |
| E2 | `agetor ls` with the dev env vars. | Works. | |
| E3 | `agetor logs <id>` on a task with output. | Streams; no `token=` in the daemon log's request lines. | |
| E4 | `curl -s -H "Authorization: Bearer $(jq -r .token ~/.agetor-dev/agetor-core.json)" localhost:4318/files/preview?path=/etc/hosts -o /dev/null -w "%{http_code}\n"` | `403`. | |
| E5 | `ps eww -p $(pgrep -f "tmux.*agetor-dev" \| head -1) \| grep -c AGETOR_API_TOKEN` | `0`. | |

## Spike re-runs (automated, W4)

Run on a throwaway core: `AGETOR_DATA_DIR=$(mktemp -d)` and a free port. Never `~/.agetor`. The verification step fills the Result column; leave it blank until then.

| # | Spike | How | Expected | Result |
| --- | --- | --- | --- | --- |
| S1 | Desktop-only routes refuse the file token | For each route in the desktop-only set (`docs/plans/master-token-agent-read.md` §3), call it with the CLI token from `agetor-core.json` against an app-mode core and a headless core. | App mode: `403 desktop-only`. Headless: `501` for `headless501` routes, `403` for the rest. The master token reaches them. || Pass (2026-10-27). Throwaway headless core (port 4799, recording disclaim stub): file token → `POST /tasks/:id/terminals` 403, `GET /files/preview` 403, `POST /screenshots` 403; file token ≠ master; creds file mode 600. Every desktop-only route × both modes: `src/bun/route-policy-endpoint.test.ts` (21 pass). |
| S2 | Disclaim-off refused for the CLI token | `PUT /preferences/disclaimSpawnedAgents` with `"false"` and CLI token; then with the master. | CLI: `403`, value unchanged. Master: accepted (app mode). Headless: accepted but the core still disclaims. || Pass. Spike: file token `PUT … "false"` → 403, nothing stored. Master on app mode → stored and switch off; master on headless → stored, switch stays on (`route-policy-endpoint.test.ts`). |
| S3 | fsmonitor runs through the wrapper | Temp repo with `git config core.fsmonitor <script writing a marker>`; `AGETOR_DISCLAIM_BIN` set to a recording stub that logs argv then `exec "$@"`; call the git-status route. | The stub log contains `git ... status --porcelain`; the marker file exists. || Pass. Spike: git-status route with the file token → 200; the stub log shows `/usr/bin/git status --porcelain`; the planted fsmonitor marker exists, so the program ran under the disclaimed git. Also `core-spawn-disclaim.integration.test.ts`. |
| S4 | `?token=<master>` refused | `GET /events?token=<master>`, `GET /app/events?token=<master>` and `GET /tasks/:id/events?token=<master>`. | `401`. With `?token=<CLI token>` on those three SSE GETs: `200`; on any other route: `401`. || Pass. Spike: `?token=<master>` → 401 on `/tasks` and `/events`; `?token=<file token>` on `/tasks` → 401. All three SSE GETs: master → 401, CLI token → 200 (`route-policy-endpoint.test.ts`, `server-auth.test.ts`). |
| S5 | WebSocket ticket | `GET /terminals/:id/ws?token=<master>`; then with a ticket used twice. | First refused; ticket works once, second use refused. || Pass. `server-terminal-ws.test.ts` (7 pass) and `route-policy-endpoint.test.ts`: `?token=` with either token → 401; a ticket opens once; reuse, wrong terminal, expired and missing tickets refused; the CLI token can't mint one (403). |
| S6 | Env scrub | Start a core with `AGETOR_API_TOKEN` set; spawn a terminal tab and a tmux session; read the child env. | `AGETOR_API_TOKEN` absent in `process.env` of the core and in both children. || Pass. `api-config.ts` removes `AGETOR_API_TOKEN` from the core's env after reading it. A terminal tab spawned with the token put back into the parent env: the tab env has no `AGETOR_API_TOKEN`, and `TERM=xterm-256color`. tmux clients and the fsmonitor hook saw it unset (`core-spawn-disclaim.integration.test.ts`, `tmux-resolution.test.ts`). |
| S7 | Spawn allowlist | `bun test src/bun/core-spawn-allowlist.test.ts` | Passes; exempt sites are exactly `server.ts`×2 (osascript), `terminals.ts` (terminal-tab), `task-notifier.ts` (notifier). || Pass. `core-spawn-allowlist.test.ts` green; exempt sites are exactly `server.ts`×2 osascript, `terminals.ts`×1 terminal-tab, `task-notifier.ts`×1 notifier. |
| S8 | Disclaim overhead | Time 200 `coreSpawn(["/usr/bin/true"])` with and without the helper. | About 2-5 ms extra per spawn at p50. || Measured with `git status --porcelain` and `tmux display -p x` (200 runs each, loaded machine) instead of `/usr/bin/true`: the helper adds ~2 ms at p50 on a quiet round and ~5 ms on a noisy one; p95 +1 ms on the quiet round. |
