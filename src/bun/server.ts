import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WebSocketHandler } from "bun";
import pkg from "../../package.json" with { type: "json" };
import { API_TOKEN, getApiPort } from "./api-config.ts";
import { removeCoreCreds } from "./core-creds.ts";
import {
  tasks,
  runs,
  projects,
  preferences,
  harnesses,
  HarnessBuiltinError,
  HarnessInUseError,
  dataDir,
} from "./db.ts";
import { archiveTask, createTask, deleteTask, startTask, cancelRun, reconcileTaskSession, sendInput, subscribe, subscribeGlobal, unarchiveTask } from "./orchestrator.ts";
import { checkAllHarnesses } from "./agent-status.ts";
import {
  buildHarnessTerminalCommand,
  harnessEnv,
  isValidEnvKey,
  resolveBin,
  toTerminalAppleScript,
} from "./agents.ts";
import type { UpdaterSnapshot } from "./updater.ts";
import {
  bundledTmuxAvailable,
  bundledTmuxPath,
  getTmuxSource,
  resolveTmuxBin,
  setTmuxSource,
  type TmuxSource,
} from "./tmux-resolution.ts";
import {
  dismissTmuxPrompt,
  jsonlPathFor,
  rebuildEventsFromJsonl,
  markTmuxPromptAnswered,
  resolveAskCard,
  sendModalKeys,
  sessionExists,
  sessionNameFor,
} from "./claude-tmux.ts";
import { planAskAnswers } from "./claude-questions.ts";
import { getTaskDiff, hasUncommittedChanges, listBranches } from "./worktree.ts";
import {
  attachSocket,
  closeTerminal,
  createTerminal,
  detachSocket,
  getTerminal,
  listTerminals,
  writeTerminal,
  resizeTerminal,
  type TerminalSocketData,
} from "./terminals.ts";
import { listAgentCapabilities } from "./commands.ts";
import { getDiscoveredModels, refreshDiscoveredModels } from "./agent-discovery.ts";
import { getMainWindow } from "./window.ts";
import {
  answerTmuxPrompt,
  findTmuxPromptById,
  getAskQuestionsById,
  listPendingForTask,
  type AskQuestionsAnswer,
} from "./interactions.ts";
import { MODEL_EFFORT_SUPPORT, TASK_TYPES } from "../shared/types.ts";
import type { AgentKind, AppEvent, GlobalEvent, RunEvent, Task, TaskReference } from "../shared/types.ts";
import { armForceQuit, broadcastAppEvent, subscribeAppEvents } from "./quit-guard.ts";

// Re-export so existing call sites (index.ts → webview URL) keep working.
// `API_PORT` is a module-load snapshot for index.ts's BrowserWindow URL.
// The actual `Bun.serve` bind reads the env again inside `startApiServer`,
// so tests that share a process but set `AGETOR_API_PORT` between file
// imports (notifications.test.ts + server-auth.test.ts) each bind their
// own port — the cached module state doesn't trap them on one value.
export { API_TOKEN };
export const API_PORT = getApiPort();

// Origins allowed on responses. Re-populated inside `startApiServer` once
// the runtime port is known. Kept as a mutable Set so handlers can close
// over the binding at module load and still see the correct values.
const ALLOWED_ORIGINS = new Set<string>();

// Count of attached SSE clients across /events, /runs/:id/events,
// /tasks/:id/events and /app/events. The headless CLI daemon reads this to
// decide when it's safe to idle-shutdown: a connected CLI keeps the core alive
// even with no running task. Best-effort — incremented when a stream opens,
// decremented on the request abort.
let attachedClients = 0;
export function attachedClientCount(): number {
  return attachedClients;
}

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    status: init?.status,
  });

// Turn raw path strings into references: keep only existing absolute paths,
// dedupe, and read directory-ness from the filesystem (authoritative — more
// reliable than the webview's view). The stat filter also discards the bogus
// fragments produced when Electrobun's native open-panel returns its picks as
// a comma-joined string and a chosen path itself contains a comma: the split
// pieces don't exist on disk, so they fall out here rather than reaching the
// prompt as broken refs. (A comma path still can't be attached via the panel —
// that's a bridge limitation — but it fails safe instead of corrupting.)
function refsFromPaths(rawPaths: unknown[]): TaskReference[] {
  const refs: TaskReference[] = [];
  const seen = new Set<string>();
  for (const entry of rawPaths) {
    if (typeof entry !== "string") continue;
    const abs = entry.trim();
    if (!abs || !path.isAbsolute(abs) || seen.has(abs)) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // gone / unreadable / comma-split fragment — skip rather than 500
    }
    seen.add(abs);
    refs.push({ path: abs, isDirectory: st.isDirectory() });
  }
  return refs;
}

// We bind to 127.0.0.1 so CORS is mostly belt-and-suspenders. We still echo
// the calling origin so the Vite HMR webview (http://localhost:5173) can call
// us during dev — but never `*`. Foreign origins are also blocked by the token
// gate, so this is defense-in-depth. Populated inside `startApiServer` once
// the runtime port is known.

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-credentials": "true",
  };
}

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (header === `Bearer ${API_TOKEN}`) return true;
  // Fallback for EventSource, which can't set headers.
  const url = new URL(req.url);
  return url.searchParams.get("token") === API_TOKEN;
}

function unauthorized(req: Request): Response {
  return json(
    { error: "unauthorized" },
    { status: 401, headers: corsHeaders(req) },
  );
}

// We type the wrapper loosely so Bun's per-route param typing (it infers
// `params.id` as `string` for the pattern `/:id`) flows through unchanged.
// Under `noUncheckedIndexedAccess`, a generic `Record<string,string>` would
// otherwise become `string | undefined` and force needless guards.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function authed<F extends (req: any) => Response | Promise<Response>>(fn: F): F {
  return ((req: Request) => (isAuthorized(req) ? fn(req) : unauthorized(req))) as F;
}

/** Fields callers may patch on a task. Everything else is server-managed. */
const ALLOWED_PATCH_FIELDS = new Set<keyof Task>([
  "title", "prompt", "agent", "workdir", "column", "mode", "model", "effort", "taskType",
]);

function filterPatch(raw: unknown): Partial<Task> {
  if (!raw || typeof raw !== "object") return {};
  const patch: Partial<Task> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_PATCH_FIELDS.has(k as keyof Task)) (patch as Record<string, unknown>)[k] = v;
  }
  return patch;
}

/**
 * Native-host capabilities the API needs but that only exist inside the
 * Electrobun app: file/folder dialogs, OS notifications, open-in-Finder /
 * open-in-browser, the self-updater, and app quit. The Electrobun entry
 * (`index.ts`) injects a real implementation built from `electrobun/bun` +
 * `updater.ts`; the headless CLI daemon injects nothing, so the handful of
 * routes that need these return 501. Keeping them behind this interface is
 * what lets `server.ts` load without importing `electrobun/bun`.
 */
export interface ApiNative {
  openFileDialog(opts: {
    startingFolder: string;
    canChooseFiles: boolean;
    canChooseDirectory: boolean;
    allowsMultipleSelection: boolean;
  }): Promise<string[]>;
  openPath(p: string): boolean;
  openExternal(url: string): boolean;
  showNotification(n: {
    title: string;
    body?: string;
    subtitle?: string;
    silent?: boolean;
  }): void;
  quit(): void;
  updates: {
    snapshot(): UpdaterSnapshot;
    check(): Promise<void>;
    apply(): Promise<void>;
  };
}

/** 501 for native-only routes when running headless (no Electrobun host). */
const notAvailableHeadless = (req: Request) =>
  json(
    { error: "not available in headless mode" },
    { status: 501, headers: corsHeaders(req) },
  );

export function startApiServer(deps: { native?: ApiNative } = {}) {
  const native = deps.native;
  // Read the port fresh — supports tests that import server.ts after setting
  // AGETOR_API_PORT and rely on the bind to honour their override even when
  // a sibling test file imported the module first.
  const PORT = getApiPort();
  ALLOWED_ORIGINS.clear();
  ALLOWED_ORIGINS.add(`http://localhost:${PORT}`);
  ALLOWED_ORIGINS.add("http://localhost:5173");
  ALLOWED_ORIGINS.add("http://127.0.0.1:5173");
  // Electrobun's bundled `views://` scheme sends Origin: views://<viewName>
  // (not the `null` originally documented here). Without this entry, every
  // packaged-build fetch returns 200 from the server but WebKit rejects the
  // response in the renderer with "Origin views://mainview is not allowed by
  // Access-Control-Allow-Origin" — so the UI silently sees every API call
  // reject and falls back to empty data (e.g. `v?`, empty harnesses list).
  // The auth token still gates the actual request body.
  ALLOWED_ORIGINS.add("views://mainview");

  // Terminal-tab byte stream. Typed explicitly so `Bun.serve` infers the
  // socket's `data` shape (TerminalSocketData) — that's what makes
  // `server.upgrade(req, { data })` and `ws.data.terminalId` type-check.
  // Text frames are JSON control messages (resize); binary frames are raw
  // keystrokes fed straight to the PTY's stdin.
  const terminalWebSocket: WebSocketHandler<TerminalSocketData> = {
    open(ws) {
      // Replay recent output, then stream live. If the terminal is already
      // gone (closed/exited between upgrade and open), drop the socket.
      if (!attachSocket(ws.data.terminalId, ws)) ws.close();
    },
    message(ws, message) {
      if (typeof message === "string") {
        try {
          const msg = JSON.parse(message) as { t?: string; cols?: number; rows?: number };
          if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
            resizeTerminal(ws.data.terminalId, msg.cols, msg.rows);
          }
        } catch { /* ignore malformed control frames */ }
        return;
      }
      writeTerminal(ws.data.terminalId, message as Uint8Array);
    },
    close(ws) {
      detachSocket(ws.data.terminalId, ws);
    },
  };

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    development: false,
    websocket: terminalWebSocket,
    routes: {
      // Unauthenticated probes only — never returns data.
      // `app: "agetor"` is a self-identifier the PreToolUse hook script
      // greps for before trusting the response, so a different service
      // happening to listen on the same port (4317 is OTLP gRPC's default,
      // for example) and returning 200 won't accidentally pass the bypass
      // check. Keep this string stable.
      "/health": (req) => json({ ok: true, app: "agetor" }, { headers: corsHeaders(req) }),

      "/defaults": {
        GET: authed((req) =>
          json(
            { home: homedir(), cwd: process.cwd(), dataDir },
            { headers: corsHeaders(req) },
          )),
      },

      "/projects": {
        GET: authed((req) => json(projects.list(), { headers: corsHeaders(req) })),
        // Register a project by absolute path — the headless/CLI equivalent of
        // the native folder picker at /projects/pick.
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { path?: unknown; name?: unknown };
          const p = typeof body.path === "string" ? body.path.trim() : "";
          if (!p) return json({ error: "path required" }, { status: 400, headers: corsHeaders(req) });
          if (!path.isAbsolute(p)) {
            return json({ error: "path must be absolute" }, { status: 400, headers: corsHeaders(req) });
          }
          if (!existsSync(p)) {
            return json({ error: `path does not exist: ${p}` }, { status: 404, headers: corsHeaders(req) });
          }
          const name =
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : path.basename(p) || p;
          return json(projects.upsert(p, name), { headers: corsHeaders(req) });
        }),
        DELETE: authed(async (req) => {
          const { path: p } = (await req.json().catch(() => ({}))) as { path?: string };
          if (!p) return json({ error: "path required" }, { status: 400, headers: corsHeaders(req) });
          projects.delete(p);
          return new Response(null, { status: 204, headers: corsHeaders(req) });
        }),
      },

      // Opens a native folder picker and registers whatever the user chose.
      // Returns the newly-added project; returns `{ project: null }` on cancel
      // so the client can distinguish cancel from error.
      "/projects/pick": {
        POST: authed(async (req) => {
          let startingFolder = homedir();
          try {
            const body = await req.json().catch(() => null);
            if (body && typeof (body as { startingFolder?: unknown }).startingFolder === "string") {
              startingFolder = (body as { startingFolder: string }).startingFolder;
            }
          } catch { /* no body is fine */ }
          if (!native) return notAvailableHeadless(req);
          const paths = await native.openFileDialog({
            startingFolder,
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          // The native bridge returns a comma-joined string of paths; an empty
          // first element means "user cancelled".
          const picked = paths.find((p) => p && p.length > 0);
          if (!picked) {
            return json({ project: null }, { headers: corsHeaders(req) });
          }
          const project = projects.upsert(picked, path.basename(picked) || picked);
          return json({ project }, { headers: corsHeaders(req) });
        }),
        // Removal-by-path lives on `DELETE /projects` (used by both the webview
        // and the CLI); /projects/pick is the native add-picker only.
      },

      "/projects/branches": {
        GET: authed(async (req) => {
          const url = new URL(req.url);
          const dir = url.searchParams.get("path");
          if (!dir) return json({ error: "path required" }, { status: 400, headers: corsHeaders(req) });
          return json(await listBranches(dir), { headers: corsHeaders(req) });
        }),
      },

      // Cross-session UI preferences. Currently used by NewTaskForm to
      // remember model + effort per agent (keys: `lastModel:<agent>` /
      // `lastEffort:<agent>`). Values are opaque strings — the meaning
      // lives in whichever caller writes them.
      "/preferences": {
        GET: authed((req) => json(preferences.list(), { headers: corsHeaders(req) })),
      },
      "/preferences/:key": {
        PUT: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { value?: unknown };
          if (typeof body.value !== "string") {
            return json({ error: "value (string) required" }, { status: 400, headers: corsHeaders(req) });
          }
          preferences.set(req.params.key, body.value);
          return new Response(null, { status: 204, headers: corsHeaders(req) });
        }),
      },

      // App info — currently just the version. Read at module-load time
      // from the bundled package.json so the value tracks releases without
      // a CI-time env injection step.
      "/info": {
        GET: authed((req) =>
          json({ version: pkg.version }, { headers: corsHeaders(req) })),
      },

      // Double-clicking the custom app bar in App.tsx hits this route to
      // toggle the macOS "zoom" affordance. Electrobun's drag region only
      // wires startWindowMove/stopWindowMove on mousedown/mouseup, so the
      // native double-click-to-zoom gesture never reaches AppKit — the
      // webview emulates it through here.
      "/window/toggle-zoom": {
        POST: authed((req) => {
          const win = getMainWindow();
          if (!win) {
            return json(
              { error: "no main window" },
              { status: 503, headers: corsHeaders(req) },
            );
          }
          if (win.isFullScreen()) {
            return json(
              { ok: true, skipped: "fullscreen" },
              { headers: corsHeaders(req) },
            );
          }
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      // Auto-update surface. The webview reads `/updates/status` on
      // open (SSE is live-only — no replay — so a freshly-opened client
      // needs a one-shot fetch to render current state), and POSTs
      // `/updates/check` / `/updates/apply` for the manual menu item +
      // the banner's "Restart now" button.
      "/updates/status": {
        GET: authed((req) =>
          native
            ? json(native.updates.snapshot(), { headers: corsHeaders(req) })
            : notAvailableHeadless(req)),
      },
      "/updates/check": {
        POST: authed(async (req) => {
          if (!native) return notAvailableHeadless(req);
          await native.updates.check();
          return json(native.updates.snapshot(), { headers: corsHeaders(req) });
        }),
      },
      "/updates/apply": {
        POST: authed((req) => {
          if (!native) return notAvailableHeadless(req);
          // Status check runs synchronously here — not inside applyUpdate —
          // so the 409 reaches the client. An earlier shape wrapped a void
          // applyUpdate() call in try/catch, but async functions never throw
          // synchronously, so that catch was dead code and stale-button
          // clicks silently 200'd while the actual rejection became an
          // unhandled promise inside the bun process.
          const snap = native.updates.snapshot();
          if (snap.status !== "ready") {
            return json(
              { error: `no update is ready to apply (status: ${snap.status})` },
              { status: 409, headers: corsHeaders(req) },
            );
          }
          // applyUpdate quits + relaunches; the HTTP response races against
          // process exit. Void on purpose — the webview drops its connection
          // when the process goes away.
          void native.updates.apply();
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      // tmux source: which binary drives the claude-code harness. The UI
      // reads this to render the install dialog + settings toggle. Writing
      // here flips the preference; the next `checkAllHarnesses()` call
      // (polled on `/agents` every 2s) reflects the change.
      "/tmux-source": {
        GET: authed((req) =>
          json(
            {
              source: getTmuxSource(),
              bundledAvailable: bundledTmuxAvailable(),
              bundledPath: bundledTmuxPath(),
              resolvedBin: resolveTmuxBin(),
            },
            { headers: corsHeaders(req) },
          )),
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { source?: unknown };
          if (body.source !== "system" && body.source !== "bundled") {
            return json(
              { error: "source must be 'system' or 'bundled'" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          // Reject if bundled is requested but the binary isn't present in
          // this build. The dialog already disables that option client-side,
          // so this is belt-and-suspenders: prevents the preference from
          // falling out of sync with reality if any future client misses the
          // disabled check.
          if (body.source === "bundled" && !bundledTmuxAvailable()) {
            return json(
              { error: "bundled tmux is not available in this build" },
              { status: 409, headers: corsHeaders(req) },
            );
          }
          setTmuxSource(body.source as TmuxSource);
          return json({ ok: true, source: body.source }, { headers: corsHeaders(req) });
        }),
      },

      // Per-harness availability + version. Replaces the per-kind `/agents`
      // endpoint: each registered harness (built-in or alias) is probed
      // with its own binary path + env so multi-account aliases report
      // their own status independently.
      "/harnesses": {
        GET: authed(async (req) =>
          json(
            { harnesses: harnesses.list(), statuses: await checkAllHarnesses() },
            { headers: corsHeaders(req) },
          )),
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as {
            id?: unknown;
            kind?: unknown;
            label?: unknown;
            home?: unknown;
            bin?: unknown;
            env?: unknown;
          };
          if (typeof body.id !== "string" || !body.id.trim()) {
            return json({ error: "id required" }, { status: 400, headers: corsHeaders(req) });
          }
          if (body.kind !== "claude-code" && body.kind !== "codex") {
            return json(
              { error: "kind must be 'claude-code' or 'codex'" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          if (body.kind === "codex") {
            return json(
              { error: "Codex support is coming soon — new codex harnesses can't be created right now." },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          if (typeof body.label !== "string" || !body.label.trim()) {
            return json({ error: "label required" }, { status: 400, headers: corsHeaders(req) });
          }
          // Reject paths that aren't absolute — relative paths would resolve
          // against the agetor process cwd, which is rarely what the user
          // intends and is a footgun.
          const home = body.home == null || body.home === ""
            ? null
            : typeof body.home === "string" ? body.home : undefined;
          const bin = body.bin == null || body.bin === ""
            ? null
            : typeof body.bin === "string" ? body.bin : undefined;
          if (home === undefined) {
            return json({ error: "home must be a string or null" }, { status: 400, headers: corsHeaders(req) });
          }
          if (bin === undefined) {
            return json({ error: "bin must be a string or null" }, { status: 400, headers: corsHeaders(req) });
          }
          if (home && !path.isAbsolute(home)) {
            return json({ error: "home must be an absolute path" }, { status: 400, headers: corsHeaders(req) });
          }
          if (bin && !path.isAbsolute(bin)) {
            return json({ error: "bin must be an absolute path" }, { status: 400, headers: corsHeaders(req) });
          }
          const env: Record<string, string> = {};
          if (body.env && typeof body.env === "object" && !Array.isArray(body.env)) {
            for (const [k, v] of Object.entries(body.env)) {
              if (typeof v !== "string") continue;
              if (!isValidEnvKey(k)) {
                return json(
                  { error: `invalid env var name "${k}" — names must match [A-Za-z_][A-Za-z0-9_]*` },
                  { status: 400, headers: corsHeaders(req) },
                );
              }
              env[k] = v;
            }
          }
          if (harnesses.get(body.id)) {
            return json({ error: `harness "${body.id}" already exists` }, { status: 409, headers: corsHeaders(req) });
          }
          try {
            const created = harnesses.insert({
              id: body.id.trim(),
              kind: body.kind,
              label: body.label.trim(),
              home,
              bin,
              env,
            });
            return json(created, { headers: corsHeaders(req) });
          } catch (e) {
            return json({ error: (e as Error).message }, { status: 400, headers: corsHeaders(req) });
          }
        }),
      },

      "/harnesses/:id": {
        GET: authed((req) => {
          const h = harnesses.get(req.params.id);
          return h
            ? json(h, { headers: corsHeaders(req) })
            : json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
        }),
        PATCH: authed(async (req) => {
          const current = harnesses.get(req.params.id);
          if (!current) {
            return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
          }
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          // `enabled` is the one carve-out from built-in immutability: users
          // can soft-delete Claude Code / Codex without being able to rename
          // them or retarget the binary. Validate the *whole* patch up front
          // so a mixed `{enabled, label}` body on a built-in returns a single
          // 400 instead of half-applying the toggle and then erroring.
          const hasConfigPatch =
            typeof body.label === "string" ||
            "home" in body ||
            "bin" in body ||
            (body.env && typeof body.env === "object" && !Array.isArray(body.env));
          if (hasConfigPatch && current.isBuiltin) {
            return json(
              { error: "built-in harnesses can't be edited — create an alias instead" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          if (typeof body.enabled === "boolean") {
            if (body.enabled && current.kind === "codex") {
              return json(
                { error: "Codex support is coming soon — it can't be enabled right now." },
                { status: 400, headers: corsHeaders(req) },
              );
            }
            harnesses.setEnabled(req.params.id, body.enabled);
          }
          if (!hasConfigPatch) {
            return json(harnesses.get(req.params.id), { headers: corsHeaders(req) });
          }
          const patch: Parameters<typeof harnesses.update>[1] = {};
          if (typeof body.label === "string") patch.label = body.label.trim();
          if ("home" in body) {
            if (body.home == null || body.home === "") patch.home = null;
            else if (typeof body.home === "string" && path.isAbsolute(body.home)) patch.home = body.home;
            else return json({ error: "home must be absolute or null" }, { status: 400, headers: corsHeaders(req) });
          }
          if ("bin" in body) {
            if (body.bin == null || body.bin === "") patch.bin = null;
            else if (typeof body.bin === "string" && path.isAbsolute(body.bin)) patch.bin = body.bin;
            else return json({ error: "bin must be absolute or null" }, { status: 400, headers: corsHeaders(req) });
          }
          if (body.env && typeof body.env === "object" && !Array.isArray(body.env)) {
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(body.env)) {
              if (typeof v !== "string") continue;
              if (!isValidEnvKey(k)) {
                return json(
                  { error: `invalid env var name "${k}" — names must match [A-Za-z_][A-Za-z0-9_]*` },
                  { status: 400, headers: corsHeaders(req) },
                );
              }
              env[k] = v;
            }
            patch.env = env;
          }
          try {
            const updated = harnesses.update(req.params.id, patch);
            return json(updated, { headers: corsHeaders(req) });
          } catch (e) {
            if (e instanceof HarnessBuiltinError) {
              return json({ error: e.message }, { status: 400, headers: corsHeaders(req) });
            }
            return json({ error: (e as Error).message }, { status: 400, headers: corsHeaders(req) });
          }
        }),
        DELETE: authed((req) => {
          try {
            harnesses.delete(req.params.id);
            return new Response(null, { status: 204, headers: corsHeaders(req) });
          } catch (e) {
            if (e instanceof HarnessInUseError) {
              return json(
                { error: e.message, taskIds: e.taskIds },
                { status: 409, headers: corsHeaders(req) },
              );
            }
            if (e instanceof HarnessBuiltinError) {
              return json({ error: e.message }, { status: 400, headers: corsHeaders(req) });
            }
            return json({ error: (e as Error).message }, { status: 400, headers: corsHeaders(req) });
          }
        }),
      },

      // Blast-radius probe for the disable-confirmation UI. Returns the
      // running task ids (so we can warn "N tasks are still using this")
      // plus the total task count for context.
      "/harnesses/:id/usage": {
        GET: authed((req) => {
          const h = harnesses.get(req.params.id);
          if (!h) {
            return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
          }
          return json(harnesses.usage(req.params.id), { headers: corsHeaders(req) });
        }),
      },

      // Resolve a harness's environment for `agetor harness shell` — the CLI
      // execs a shell with this env applied (drift-free: reuses harnessEnv).
      // Headless-safe (no native bridge), unlike open-terminal below.
      "/harnesses/:id/shell-env": {
        GET: authed((req) => {
          const harness = harnesses.getByIdOrKind(req.params.id);
          if (!harness) {
            return json({ error: "harness not found" }, { status: 404, headers: corsHeaders(req) });
          }
          return json(
            {
              env: harnessEnv(harness),
              // Only an absolute bin override needs to join PATH (mirrors
              // buildHarnessTerminalCommand); the default agent is on PATH.
              binDir: harness.bin && path.isAbsolute(harness.bin) ? path.dirname(harness.bin) : null,
              launch: path.basename(resolveBin(harness)),
              kind: harness.kind,
            },
            { headers: corsHeaders(req) },
          );
        }),
      },

      // Open a configured shell for this harness in a new Terminal.app window.
      // The harness's home-derived vars (CLAUDE_CONFIG_DIR for claude-code,
      // HOME + CODEX_HOME for codex), its custom env, and its binary's
      // directory on PATH are all exported, then the window is left at an
      // interactive prompt. This is the supported way to authenticate or
      // inspect a multi-account alias: `claude /login` run in this shell
      // writes credentials against the alias's own config dir, exactly as a
      // real run would. macOS-only (osascript + Terminal.app), same as
      // `/tasks/:id/open-tmux`.
      "/harnesses/:id/open-terminal": {
        POST: authed(async (req) => {
          const harness = harnesses.getByIdOrKind(req.params.id);
          if (!harness) {
            return json({ error: "harness not found" }, { status: 404, headers: corsHeaders(req) });
          }
          const script = toTerminalAppleScript(buildHarnessTerminalCommand(harness));
          const proc = Bun.spawn(["osascript", "-e", script], {
            stdout: "ignore",
            stderr: "pipe",
          });
          // Await the launch so the UI gets real feedback. `do script` returns
          // as soon as Terminal accepts the command (it does NOT wait for the
          // shell command to finish), so this resolves in well under a second
          // on success and fails fast when Automation permission is denied.
          // A 5s ceiling guards against a wedged osascript holding the
          // response open.
          const exit = await Promise.race([
            proc.exited,
            Bun.sleep(5000).then(() => "timeout" as const),
          ]);
          if (exit === "timeout") {
            // Assume it's still coming up rather than reporting a false error.
            return json({ ok: true }, { headers: corsHeaders(req) });
          }
          if (exit !== 0) {
            const detail = (await new Response(proc.stderr).text()).trim();
            console.warn(
              `[agetor] osascript exited ${exit} while opening a terminal for harness "${harness.id}": ${detail}`,
            );
            return json(
              {
                error:
                  `Couldn't open Terminal (osascript exited ${exit}).` +
                  (detail ? ` ${detail}` : "") +
                  " Check System Settings → Privacy & Security → Automation.",
              },
              { status: 502, headers: corsHeaders(req) },
            );
          }
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      // Legacy alias — UI still polls /agents for the header dots. Now
      // returns the per-harness shape so each alias appears as its own dot.
      "/agents": {
        GET: authed(async (req) =>
          json(await checkAllHarnesses(), { headers: corsHeaders(req) })),
      },

      // Per-agent dynamic data discovered from the CLI: model list (and
      // anything else we learn to probe later). Cached in-memory and refreshed
      // on demand via POST.
      "/agent-models": {
        GET: authed((req) =>
          json(
            {
              "claude-code": getDiscoveredModels("claude-code"),
              "codex": getDiscoveredModels("codex"),
            },
            { headers: corsHeaders(req) },
          )),
        POST: authed(async (req) => {
          await refreshDiscoveredModels();
          return json(
            {
              "claude-code": getDiscoveredModels("claude-code"),
              "codex": getDiscoveredModels("codex"),
            },
            { headers: corsHeaders(req) },
          );
        }),
      },

      // Slash commands/skills (for the `/…` autocomplete) and MCP/skill/plugin
      // extensions (for the prompt-top picker) for the picked harness in the
      // picked project. The new-task form and run panel query this whenever
      // harness/workdir/branch change. Bundled into one response so discovery
      // runs once per refresh instead of resolving the repo root and walking
      // the skills tree twice.
      //
      // The `agent` query param is a harness id (or, for built-ins, the bare
      // AgentKind — they share the same value). Resolving via getByIdOrKind
      // lets us look up the harness's home, so an aliased multi-account
      // harness reads its own per-harness commands/skills instead of the
      // system home's.
      "/agent-discovery": {
        GET: authed(async (req) => {
          const url = new URL(req.url);
          const agentParam = url.searchParams.get("agent");
          const workdir = url.searchParams.get("workdir");
          const branch = url.searchParams.get("branch");
          if (!agentParam) {
            return json({ error: "agent required" }, { status: 400, headers: corsHeaders(req) });
          }
          const harness = harnesses.getByIdOrKind(agentParam);
          if (!harness) {
            return json({ error: "agent required" }, { status: 400, headers: corsHeaders(req) });
          }
          return json(
            await listAgentCapabilities({
              agent: harness.kind,
              workdir,
              branch,
              harnessHome: harness.home,
            }),
            { headers: corsHeaders(req) },
          );
        }),
      },

      "/tasks": {
        GET: authed((req) => json(tasks.list(), { headers: corsHeaders(req) })),
        POST: authed(async (req) => {
          const body = (await req.json()) as Partial<Task> & {
            baseRef?: string;
            references?: TaskReference[];
          };
          if (!body.title || !body.prompt) {
            return json(
              { error: "title and prompt required" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          // Sanitize references: keep only entries with a non-empty string
          // `path` of reasonable length; coerce `isDirectory` to boolean.
          // Cap the array so a runaway client can't bloat the SQLite row.
          // Bad entries are dropped silently rather than 400-ing the whole
          // request (paths inline as plain text — partial intake is fine).
          const MAX_REFS = 100;
          const MAX_PATH_LEN = 4096;
          const references: TaskReference[] = Array.isArray(body.references)
            ? body.references
                .slice(0, MAX_REFS)
                .flatMap((r): TaskReference[] => {
                  if (!r || typeof r !== "object") return [];
                  const p = (r as { path?: unknown }).path;
                  if (typeof p !== "string" || !p) return [];
                  if (p.length > MAX_PATH_LEN) return [];
                  return [{ path: p, isDirectory: Boolean(r.isDirectory) }];
                })
            : [];
          const result = await createTask({
            ...body,
            title: body.title,
            prompt: body.prompt,
            references,
          });
          if ("error" in result) {
            return json({ error: result.error }, { status: 400, headers: corsHeaders(req) });
          }
          return json(result.task, { headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id": {
        GET: authed((req) => {
          const t = tasks.get(req.params.id);
          return t
            ? json(t, { headers: corsHeaders(req) })
            : json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
        }),
        PATCH: authed(async (req) => {
          const before = tasks.get(req.params.id);
          if (!before) {
            return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
          }
          // Archived rows are frozen — the UI hides every mutator (drag is
          // disabled, action buttons are stripped, the composer is replaced
          // by a footer). Enforce it server-side too so a direct API caller
          // (or a stale tab racing the timestamp flip) can't drag the row
          // back to a live column and re-trigger session reconciliation.
          if (before.archivedAt != null) {
            return json(
              { error: "task is archived — unarchive it before editing" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          const patch = filterPatch(await req.json());
          // Prevent workdir from being swapped after a worktree has been
          // materialized. The worktree is registered against the original repo;
          // changing workdir would make removeWorktree run git ops against the
          // wrong repo, leaking the .git/worktrees/<id> registration.
          if ("workdir" in patch && patch.workdir !== before.workdir && before.worktreePath !== null) {
            return json(
              { error: "workdir cannot be changed once a worktree exists — delete the task to start fresh with a new workdir" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          // Validate `agent` resolves to a real harness — otherwise the
          // kanban shows a stuck row whose AgentSelect can't reflect its
          // own value and whose startTask fails downstream with the same
          // (less obvious) error. Catch it at the boundary.
          if (typeof patch.agent === "string" && !harnesses.getByIdOrKind(patch.agent)) {
            return json(
              { error: `unknown harness: ${patch.agent}` },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          // Enforce the "model is always set, effort is set unless the
          // model declines it" invariant at the PATCH boundary so direct
          // API callers can't reintroduce nulls that `buildCommand` would
          // later throw on. The UI never sends nulls here; this is the
          // belt to the migration's suspenders.
          if ("model" in patch) {
            if (patch.model === null || patch.model === "") {
              return json(
                { error: "model cannot be cleared" },
                { status: 400, headers: corsHeaders(req) },
              );
            }
          }
          if (
            "taskType" in patch
            && !TASK_TYPES.some((t) => t.id === patch.taskType)
          ) {
            return json(
              { error: `unknown taskType: ${patch.taskType}` },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          if ("effort" in patch && patch.effort === null) {
            const resolvedAgent = typeof patch.agent === "string" ? patch.agent : before.agent;
            const resolvedKind = harnesses.getByIdOrKind(resolvedAgent)?.kind ?? null;
            const resolvedModel =
              typeof patch.model === "string" ? patch.model : before.model;
            if (resolvedKind && resolvedModel) {
              const support = MODEL_EFFORT_SUPPORT[resolvedKind][resolvedModel];
              const modelDeclinesEffort = Array.isArray(support) && support.length === 0;
              if (!modelDeclinesEffort) {
                return json(
                  { error: `effort cannot be cleared for model "${resolvedModel}"` },
                  { status: 400, headers: corsHeaders(req) },
                );
              }
            }
          }
          const updated = tasks.update(req.params.id, patch);
          if (!updated) {
            return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
          }
          // Mirror behavioural changes onto a live claude session via slash
          // commands so the conversation context survives a model/mode/effort
          // change. Agent changes wipe the session — different harness entirely.
          // Fire-and-forget: the mode-change path now verifies via the JSONL
          // event before resolving, which can take up to 4.5s on the
          // exhaust-retries path. The PATCH response payload only carries the
          // updated Task row (already in hand); the verify outcome reaches
          // the user through the `status` SSE events that
          // `emitModeChangeStatus` writes. Blocking the response would add
          // unbounded latency for no benefit. `.catch` keeps an unexpected
          // throw from becoming an unhandledRejection — every failure mode
          // the function knows about already surfaces via SSE.
          reconcileTaskSession(req.params.id, before, updated).catch((err: unknown) => {
            console.error("reconcileTaskSession failed:", err);
          });
          return json(updated, { headers: corsHeaders(req) });
        }),
        DELETE: authed(async (req) => {
          await deleteTask(req.params.id);
          return new Response(null, { status: 204, headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/start": {
        POST: authed(async (req) => {
          const result = await startTask(req.params.id);
          return "error" in result
            ? json(result, { status: 400, headers: corsHeaders(req) })
            : json(result, { headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/archive": {
        POST: authed((req) => {
          const result = archiveTask(req.params.id);
          return "error" in result
            ? json(result, { status: 400, headers: corsHeaders(req) })
            : json(result.task, { headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/unarchive": {
        POST: authed((req) => {
          const result = unarchiveTask(req.params.id);
          return "error" in result
            ? json(result, { status: 400, headers: corsHeaders(req) })
            : json(result.task, { headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/runs": {
        GET: authed((req) => json(runs.listForTask(req.params.id), { headers: corsHeaders(req) })),
      },

      // Everything the task's worktree changed vs its pinned base ref. Returns
      // a friendly `note` (empty `files`) when there's no worktree or no diff.
      "/tasks/:id/diff": {
        GET: authed(async (req) => {
          const t = tasks.get(req.params.id);
          if (!t) return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
          return json(await getTaskDiff(t), { headers: corsHeaders(req) });
        }),
      },

      // Open the task's claude-code tmux session in a new Terminal.app window.
      // The session name is deterministic (`agetor-<taskId-prefix>`) so we can
      // look it up without consulting the run row. We probe tmux availability
      // and session liveness up-front so the UI gets a clear, distinct error
      // for each failure mode instead of an empty Terminal that immediately
      // errors with "can't find session".
      "/tasks/:id/open-tmux": {
        POST: authed((req) => {
          const task = tasks.get(req.params.id);
          if (!task) {
            return json({ error: "task not found" }, { status: 404, headers: corsHeaders(req) });
          }
          const harness = harnesses.getByIdOrKind(task.agent);
          if (harness?.kind !== "claude-code") {
            return json(
              { error: "tmux attach is only available for claude-code tasks" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          const sessionName = sessionNameFor(task.id);
          // Distinguish "tmux missing" from "session missing" — both would
          // otherwise look like sessionExists() === false and tell the user
          // to restart the task, which doesn't help when the real problem
          // is the tmux binary itself. Mirror the resolution path used by
          // checkHarness so the same install hint applies.
          const tmuxBin = resolveTmuxBin();
          const tmuxPath = path.isAbsolute(tmuxBin)
            ? (existsSync(tmuxBin) ? tmuxBin : null)
            : Bun.which(tmuxBin, { PATH: process.env.PATH });
          if (!tmuxPath) {
            return json(
              {
                error: "tmux binary not found — install tmux (brew install tmux) or enable the bundled tmux in Settings",
                sessionName,
                reason: "tmux-missing",
              },
              { status: 503, headers: corsHeaders(req) },
            );
          }
          if (!sessionExists(task.id)) {
            return json(
              {
                error: `no live tmux session "${sessionName}" — start (or send a message to) the task first`,
                sessionName,
                reason: "session-missing",
              },
              { status: 404, headers: corsHeaders(req) },
            );
          }
          // AppleScript `do script` runs the string through `/bin/bash`, so
          // we escape anything bash would interpret inside double-quotes:
          // backslash, dollar, backtick, and the double-quote itself. Without
          // this, a tmux bin path containing `$` (legal but unusual) would
          // silently misbehave. Session names are server-generated and only
          // contain `agetor-<hex>` so they don't strictly need escaping, but
          // we apply the same helper for symmetry.
          const shellEscape = (s: string) => s.replace(/(["\\$`])/g, "\\$1");
          const script =
            `tell application "Terminal" to do script "exec \\"${shellEscape(tmuxPath)}\\" attach -t \\"${shellEscape(sessionName)}\\""\n` +
            `activate application "Terminal"`;
          const proc = Bun.spawn(["osascript", "-e", script], {
            stdout: "ignore",
            stderr: "ignore",
          });
          // Don't block on the AppleScript — Terminal.app opening shouldn't
          // hold the HTTP response open. Log non-zero exits so users with
          // Automation permissions revoked have a breadcrumb in the console.
          void proc.exited.then((code) => {
            if (code !== 0) {
              console.warn(
                `[agetor] osascript exited ${code} while attaching to tmux session "${sessionName}" — check System Settings → Privacy & Security → Automation`,
              );
            }
          });
          return json({ ok: true, sessionName }, { headers: corsHeaders(req) });
        }),
      },

      // Whether the task's working tree has uncommitted changes. Drives the
      // "Commit & push" action in the run panel, which only makes sense to
      // show when there's actually something to commit. `ignored: true` means
      // we couldn't tell (not a git repo, dir missing, git failed) — the UI
      // treats that as "don't offer the action" rather than guessing.
      "/tasks/:id/git-status": {
        GET: authed(async (req) => {
          const t = tasks.get(req.params.id);
          if (!t) {
            return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
          }
          const dir = t.worktreePath ?? t.workdir;
          const result = await hasUncommittedChanges(dir);
          if (result === null) {
            return json({ hasChanges: false, ignored: true }, { headers: corsHeaders(req) });
          }
          return json({ hasChanges: result, ignored: false }, { headers: corsHeaders(req) });
        }),
      },

      "/runs/:id/cancel": {
        POST: authed((req) =>
          json({ cancelled: cancelRun(req.params.id) }, { headers: corsHeaders(req) })),
      },

      // Forward a line of user input to the running agent's stdin. Returns
      // `{ delivered: false }` (HTTP 200) when there's no active run or the
      // stdin pipe is already closed — the UI surfaces that as a hint rather
      // than treating it as an error.
      // Open a file or directory with the OS default application via
      // Electrobun's native bridge. Accepts either an absolute path or a path
      // relative to a task's cwd (caller passes `taskId` so the server can
      // resolve). We require the resolved path to exist before forwarding —
      // openPath on a missing path silently no-ops on macOS, which would look
      // like a broken button.
      "/open-path": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as {
            path?: string;
            taskId?: string;
          };
          const raw = typeof body.path === "string" ? body.path.trim() : "";
          if (!raw) {
            return json({ error: "path required" }, { status: 400, headers: corsHeaders(req) });
          }
          let abs = raw;
          if (!path.isAbsolute(abs)) {
            const t = body.taskId ? tasks.get(body.taskId) : null;
            const cwd = t?.worktreePath ?? t?.workdir;
            if (!cwd) {
              return json(
                { error: "relative path requires a taskId with a known cwd" },
                { status: 400, headers: corsHeaders(req) },
              );
            }
            abs = path.resolve(cwd, abs);
          }
          if (!existsSync(abs)) {
            return json(
              { error: `path does not exist: ${abs}` },
              { status: 404, headers: corsHeaders(req) },
            );
          }
          if (!native) return notAvailableHeadless(req);
          const ok = native.openPath(abs);
          return json({ opened: ok, path: abs }, { headers: corsHeaders(req) });
        }),
      },

      // Open a URL in the OS default browser via Electrobun's native bridge.
      // Restricted to http(s)/mailto so an attacker-controlled prompt can't
      // launch `file://` or custom-scheme handlers from a webview click.
      "/open-external": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { url?: string };
          const raw = typeof body.url === "string" ? body.url.trim() : "";
          if (!raw) {
            return json({ error: "url required" }, { status: 400, headers: corsHeaders(req) });
          }
          if (!/^(https?|mailto):/i.test(raw)) {
            // Don't echo the raw URL — keeps user-supplied content out of any
            // downstream log line that might pick the response body up.
            return json(
              { error: "unsupported url scheme (only http, https, mailto)" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          if (!native) return notAvailableHeadless(req);
          const ok = native.openExternal(raw);
          return json({ opened: ok, url: raw }, { headers: corsHeaders(req) });
        }),
      },

      // Open a native macOS open-panel and return whatever the user picked as
      // file/folder references. This is the reliable way to get absolute
      // paths into the prompt: WKWebView never populates the non-standard
      // `File.path`, so an `<input type=file>` can't expose a real path — the
      // native panel does. `mode` constrains the panel to files or
      // directories; `refsFromPaths` stats each pick for authoritative
      // directory-ness and drops anything that doesn't exist.
      "/refs/pick": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as {
            mode?: "files" | "folder";
            startingFolder?: string;
          };
          const mode = body.mode === "folder" ? "folder" : "files";
          const startingFolder =
            typeof body.startingFolder === "string" && body.startingFolder.trim()
              ? body.startingFolder
              : homedir();
          if (!native) return notAvailableHeadless(req);
          const paths = await native.openFileDialog({
            startingFolder,
            canChooseFiles: mode === "files",
            canChooseDirectory: mode === "folder",
            allowsMultipleSelection: true,
          });
          // The native bridge returns a comma-joined string; an empty first
          // element means the user cancelled.
          return json({ refs: refsFromPaths(paths) }, { headers: corsHeaders(req) });
        }),
      },

      // Resolve a list of absolute paths (extracted from a drag/drop's
      // file:// URLs) into references. We stat each to set `isDirectory`
      // authoritatively and to drop anything that no longer exists, rather
      // than trusting the webview's view of directory-ness.
      "/refs/resolve": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { paths?: unknown };
          const raw = Array.isArray(body.paths) ? body.paths : [];
          return json({ refs: refsFromPaths(raw) }, { headers: corsHeaders(req) });
        }),
      },

      // Persist a screenshot blob to `${dataDir}/screenshots/` and return its
      // absolute path. Backs the textarea drag/drop + paste flows on the
      // webview — macOS floating-thumbnail drags and clipboard pastes carry
      // an image blob with no filesystem path, so the only way to give an
      // agent an absolute path to read is to write the bytes out first.
      "/screenshots": {
        POST: authed(async (req) => {
          const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
          const allowed: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
          };
          const ext = allowed[ctype.split(";")[0].trim()];
          if (!ext) {
            return json(
              { error: `unsupported content-type: ${ctype || "(missing)"}` },
              { status: 415, headers: corsHeaders(req) },
            );
          }
          const MAX = 25 * 1024 * 1024;
          // Reject oversized uploads via Content-Length before allocating
          // the body — a buggy client shouldn't be able to pin RAM by
          // streaming gigabytes only to see a 413 at the end. Clients
          // omitting the header still hit the post-read check below.
          const claimed = Number(req.headers.get("content-length") ?? "");
          if (Number.isFinite(claimed) && claimed > MAX) {
            return json(
              { error: `image exceeds ${MAX} bytes` },
              { status: 413, headers: corsHeaders(req) },
            );
          }
          const buf = await req.arrayBuffer();
          if (buf.byteLength > MAX) {
            return json(
              { error: `image exceeds ${MAX} bytes` },
              { status: 413, headers: corsHeaders(req) },
            );
          }
          if (buf.byteLength === 0) {
            return json({ error: "empty body" }, { status: 400, headers: corsHeaders(req) });
          }
          const dir = path.join(dataDir, "screenshots");
          mkdirSync(dir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
          const id = crypto.randomUUID().slice(0, 8);
          const basename = `screenshot-${ts}-${id}.${ext}`;
          const abs = path.join(dir, basename);
          await Bun.write(abs, buf);
          return json({ path: abs, basename }, { headers: corsHeaders(req) });
        }),
      },

      // ─── Interactions: claude built-in AskUserQuestion (scraper-sourced) ──
      // The native modal is live on the tmux pane; there's no promise. Plan
      // the keystrokes from the user's picks and drive them into the modal
      // (planAskAnswers + sendModalKeys), or, for a custom/free-text answer,
      // Esc the modal and post the answer as a normal follow-up turn. Then
      // drop the card.
      "/ask-questions/:id/answer": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as Partial<AskQuestionsAnswer>;
          const answers = Array.isArray(body.answers) ? body.answers : [];
          // Light-weight shape check — sub-arrays normalised, strings trimmed.
          const sanitised = answers.map((a) => ({
            selected: Array.isArray(a?.selected) ? a.selected.filter((s): s is string => typeof s === "string") : [],
            custom: typeof a?.custom === "string" ? a.custom : undefined,
          }));
          if (sanitised.length === 0) {
            return json({ error: "answers required" }, { status: 400, headers: corsHeaders(req) });
          }
          const pending = getAskQuestionsById(req.params.id);
          if (pending && pending.source === "scraper") {
            const specs = pending.questions.map((q) => ({
              question: q.question,
              multiSelect: !!q.multiSelect,
              options: q.options.map((o) => o.label),
            }));
            const plan = planAskAnswers(specs, sanitised);
            let ok = false;
            if (plan.mode === "drive") {
              ok = await sendModalKeys(pending.taskId, plan.keys);
            } else {
              // Custom/free-text (or anything we can't drive): dismiss the
              // native modal, then deliver the answer as a follow-up turn —
              // mirrors claude's own "Type something." → REPL behaviour.
              await sendModalKeys(pending.taskId, ["Escape"]);
              // Give claude a beat to tear the modal down and return to the
              // REPL prompt before the paste lands, so it isn't eaten by the
              // dismissing modal.
              await Bun.sleep(150);
              ok = sendInput(pending.runId, plan.text).delivered;
            }
            // Drop the card. `resolveAskCard` also clears the session's
            // `askCardId` tracker, so if a drive FAILED and the modal is still
            // on the pane the scraper re-collects a fresh card on its next tick
            // (without clearing it, the `!askCardId` gate would block
            // re-registration and strand the modal with no card).
            resolveAskCard(req.params.id, pending.taskId);
            return json({ ok }, { headers: corsHeaders(req) });
          }
          // No scraper-sourced card matched this id (and there are no
          // hook-sourced ask cards any more) — nothing to drive.
          return json({ ok: false }, { headers: corsHeaders(req) });
        }),
      },

      // ─── Interactions: tmux pane scraper (catch-all REPL prompts) ────
      // The scraper detects modals the PreToolUse hook never sees
      // (plan-mode safety dialogs that bypass hooks, `/login`, model
      // picker, …). Answering ships the chosen key — typically a single
      // digit — back into the tmux pane via send-keys so claude reads
      // it as the user's keypress and dismisses the modal.
      "/tmux-prompts/:id/answer": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { key?: unknown; reject?: unknown };
          const pending = findTmuxPromptById(req.params.id);
          if (!pending) {
            // Either the prompt was auto-cancelled (scraper saw the pane
            // change) or the id is unknown. Either way return ok:false so
            // the UI can drop the card on its next poll.
            return json({ ok: false }, { headers: corsHeaders(req) });
          }
          // Reject: the user wants none of the options. Esc the modal and drop
          // the card. Once no card is pending the message box re-enables, so
          // the user sends their redirect as a normal, separate turn — no
          // in-flight Esc-then-send interrupt (which is what corrupts the run
          // accounting). The modal having been Esc'd, the message reaches claude.
          if (body.reject === true) {
            if (!sessionExists(pending.taskId)) {
              return json(
                { ok: false, error: "tmux session is gone — cancel the run and start a new one" },
                { status: 410, headers: corsHeaders(req) },
              );
            }
            await sendModalKeys(pending.taskId, ["Escape"]);
            markTmuxPromptAnswered(pending.taskId, pending.fingerprint);
            const ok = answerTmuxPrompt(req.params.id, { key: "__external__" });
            return json({ ok }, { headers: corsHeaders(req) });
          }
          const key = typeof body.key === "string" ? body.key : "";
          if (!key) {
            return json({ error: "key required" }, { status: 400, headers: corsHeaders(req) });
          }
          // Reject anything not in the recorded choice set — the request
          // ships the exact keys we want the user to be able to send, and
          // the UI is the only legitimate caller, so an unknown key here
          // is an attempt to inject arbitrary keystrokes. Letting it
          // through would let any code that reaches this endpoint type
          // into the user's REPL.
          if (!pending.choices.some((c) => c.key === key)) {
            return json(
              { error: `key '${key}' is not one of the registered choices` },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          // Drive tmux FIRST. If the session is gone or send-keys
          // fails, we must not resolve the interaction — doing so would
          // remove the card from the UI while leaving claude paused on
          // the modal. The user clicks "Yes", the card vanishes, and
          // nothing actually happens. Surface the failure so the UI
          // can leave the card up for retry.
          if (!sessionExists(pending.taskId)) {
            return json(
              { ok: false, error: "tmux session is gone — cancel the run and start a new one" },
              { status: 410, headers: corsHeaders(req) },
            );
          }
          const delivered = await dismissTmuxPrompt(pending.taskId, key, {
            choices: pending.choices,
            cursorIndex: pending.cursorIndex,
          });
          if (!delivered) {
            return json(
              { ok: false, error: "failed to deliver keystroke to tmux" },
              { status: 500, headers: corsHeaders(req) },
            );
          }
          // Stamp the fingerprint as just-answered before resolving so
          // the next scrape tick (which may catch the modal still on
          // screen mid-repaint) doesn't register a ghost duplicate. See
          // `markTmuxPromptAnswered` for why this is two-step.
          markTmuxPromptAnswered(pending.taskId, pending.fingerprint);
          const ok = answerTmuxPrompt(req.params.id, { key });
          return json({ ok }, { headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/interactions/pending": {
        GET: authed((req) =>
          json(listPendingForTask(req.params.id), { headers: corsHeaders(req) })),
      },

      "/runs/:id/input": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as { line?: string };
          const line = typeof body.line === "string" ? body.line : "";
          if (!line.trim()) {
            return json(
              { error: "line required" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          return json(
            sendInput(req.params.id, line),
            { headers: corsHeaders(req) },
          );
        }),
      },

      // Rebuild a run's events directly from claude's on-disk JSONL session
      // transcript. Lets the UI recover data that pre-refactor truncation
      // permanently destroyed in run_events (the old mapper capped each
      // tool_use chunk at 500 chars before persisting). Read-only on the
      // disk file; no mutation of run_events.
      //
      // Wrapped in an outer try/catch so any thrown error surfaces as a
      // proper JSON 500 — bare throws inside a Bun.serve route handler
      // close the connection mid-flight and the webview reports the
      // unhelpful "Load failed" with no diagnostic info.
      // NOTE: object-style with explicit GET so OPTIONS preflight requests
      // fall through to the global fetch handler (which returns CORS
      // headers + 200). A bare `authed(...)` would gate OPTIONS on the
      // bearer header — preflight doesn't carry it, so authed would 401
      // and WebKit's fetch rejects with the unhelpful "Load failed".
      "/runs/:id/rebuild-events": { GET: authed((req) => {
        try {
          const run = runs.get(req.params.id);
          if (!run) return json({ error: "run not found" }, { status: 404, headers: corsHeaders(req) });
          if (!run.claudeSessionId) return json({ events: [], reason: "run has no claude session id" }, { headers: corsHeaders(req) });
          const task = tasks.get(run.taskId);
          if (!task) return json({ error: "task not found" }, { status: 404, headers: corsHeaders(req) });
          // Reconstruct the cwd claude was launched against. Worktree tasks
          // had cwd = worktreePath; isolation=none had cwd = workdir.
          const cwd = task.worktreePath ?? task.workdir;
          // Resolve the harness so we read from the alias's CLAUDE_CONFIG_DIR
          // (multi-account); built-ins resolve to `~/.claude/projects/…` via
          // the `configDir: null` branch inside jsonlPathFor.
          const harness = harnesses.getByIdOrKind(task.agent);
          const jsonlPath = jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null);
          if (!existsSync(jsonlPath)) {
            return json({ events: [], reason: `JSONL not found at ${jsonlPath}` }, { headers: corsHeaders(req) });
          }
          // Drive the JSONL through the same staging pipeline live tailing
          // uses, so the rebuilt event stream contains "turn complete"
          // banners (emitted by firePendingEndTurn when a turn is confirmed
          // real) in the same positions the live stream produced them. Going
          // through mapJsonlEventToChunks directly would emit zero banners.
          const baseTs = run.startedAt;
          let i = 0;
          const events: RunEvent[] = [];
          const onChunk = (stream: RunEvent["stream"], data: string) => {
            events.push({
              runId: run.id,
              taskId: run.taskId,
              stream,
              data,
              // Synthetic monotonically-increasing ts so the client's dedup
              // can preserve order. Anchored at run.startedAt to look
              // natural alongside any stored status events.
              ts: baseTs + i++,
            });
          };
          rebuildEventsFromJsonl(readFileSync(jsonlPath, "utf8"), onChunk);
          return json({ events, source: jsonlPath }, { headers: corsHeaders(req) });
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          console.error("[agetor] /runs/:id/rebuild-events failed:", e);
          return json(
            { error: `rebuild failed: ${msg}` },
            { status: 500, headers: corsHeaders(req) },
          );
        }
      }) },

      "/runs/:id/events": authed((req) => {
        const runId = req.params.id;
        const stream = new ReadableStream({
          start(controller) {
            attachedClients++;
            const enc = new TextEncoder();
            const send = (e: RunEvent | { type: "ping" }) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              } catch {
                // Client went away mid-send (replay or a live event landing on a
                // closed controller). Swallow so `start` never throws before the
                // abort handler is registered — that handler owns the cleanup
                // (unsubscribe + attachedClients--), and letting `start` throw
                // would leak both the subscription and the attached-client count
                // (which would then permanently block the daemon's idle-shutdown).
              }
            };
            // Subscribe BEFORE reading the stored history snapshot so any
            // live event fired between the snapshot read and the subscribe
            // call isn't dropped. Live events are buffered until the
            // replay finishes; client-side dedup (ts|stream|data-prefix)
            // collapses anything that lands in both lists.
            let buffer: RunEvent[] | null = [];
            const unsubscribe = subscribe((e) => {
              if (e.runId !== runId) return;
              if (buffer) buffer.push(e);
              else send(e);
            });
            for (const ev of runs.events(runId)) {
              send({
                runId,
                taskId: "",
                stream: ev.stream as RunEvent["stream"],
                data: ev.data,
                ts: ev.ts,
              });
            }
            const drained = buffer;
            buffer = null;
            for (const ev of drained) send(ev);
            const ping = setInterval(() => send({ type: "ping" }), 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(ping);
              unsubscribe();
              controller.close();
              attachedClients--;
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            ...corsHeaders(req),
          },
        });
      }),
      // App-wide lifecycle stream — run-status terminal transitions + column
      // changes. Live-only (no replay): subscribers get events from the
      // moment they connect. Drives the toast hook in the webview. The
      // persisted `run_events` table still backs per-task replay used by
      // RunPanel — different mechanism, different shape.
      "/events": authed((req) => {
        const stream = new ReadableStream({
          start(controller) {
            attachedClients++;
            const enc = new TextEncoder();
            const send = (e: GlobalEvent | { type: "ping" }) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              } catch {
                // Client went away mid-send (replay or a live event landing on a
                // closed controller). Swallow so `start` never throws before the
                // abort handler is registered — that handler owns the cleanup
                // (unsubscribe + attachedClients--), and letting `start` throw
                // would leak both the subscription and the attached-client count
                // (which would then permanently block the daemon's idle-shutdown).
              }
            };
            const unsubscribe = subscribeGlobal((e) => send(e));
            const ping = setInterval(() => send({ type: "ping" }), 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(ping);
              unsubscribe();
              controller.close();
              attachedClients--;
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            ...corsHeaders(req),
          },
        });
      }),

      // Bridge from webview to native macOS notifications. The webview can't
      // call electrobun's FFI directly — it lives in WKWebView and the
      // notification machinery is in the Bun process. Caps every field at a
      // reasonable length so a runaway client can't push huge strings into
      // the OS notification queue.
      "/notifications": {
        POST: authed(async (req) => {
          if (!native) return notAvailableHeadless(req);
          const body = (await req.json().catch(() => ({}))) as {
            title?: unknown;
            body?: unknown;
            subtitle?: unknown;
            silent?: unknown;
          };
          const MAX_LEN = 256;
          const trunc = (v: unknown): string | undefined =>
            typeof v === "string" && v.length > 0 ? v.slice(0, MAX_LEN) : undefined;
          const title = trunc(body.title);
          if (!title) {
            return json(
              { error: "title required" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          native.showNotification({
            title,
            body: trunc(body.body),
            subtitle: trunc(body.subtitle),
            silent: Boolean(body.silent),
          });
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      // App-level SSE channel. Currently used by the QuitConfirmDialog so the
      // main process can ask the webview "are you sure?" when Cmd+Q lands
      // while runs are active. Live-only (no replay) — events are transient
      // and short-lived.
      "/app/events": authed((req) => {
        const stream = new ReadableStream({
          start(controller) {
            attachedClients++;
            const enc = new TextEncoder();
            const send = (e: AppEvent | { type: "ping" }) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              } catch {
                // Client went away mid-send (replay or a live event landing on a
                // closed controller). Swallow so `start` never throws before the
                // abort handler is registered — that handler owns the cleanup
                // (unsubscribe + attachedClients--), and letting `start` throw
                // would leak both the subscription and the attached-client count
                // (which would then permanently block the daemon's idle-shutdown).
              }
            };
            const unsubscribe = subscribeAppEvents((e) => send(e));
            const ping = setInterval(() => send({ type: "ping" }), 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(ping);
              unsubscribe();
              controller.close();
              attachedClients--;
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            ...corsHeaders(req),
          },
        });
      }),

      // Confirm-on-quit follow-up. The QuitConfirmDialog POSTs here when the
      // user picks "Quit anyway"; we arm the force-quit flag and re-issue
      // Utils.quit(), which fires `before-quit` again — index.ts sees the
      // flag and allows the second pass through. Token-gated so a foreign
      // page that knows the port can't forcibly close the app.
      "/app/force-quit": {
        POST: authed((req) => {
          if (!native) return notAvailableHeadless(req);
          // Only the first call queues Utils.quit() — subsequent POSTs
          // (rapid double-click on "Quit anyway", a buggy/looping caller,
          // etc.) short-circuit. Electrobun's own `isQuitting` guard is a
          // backstop, but no point spawning extra timers + log-spamming in
          // the meantime.
          const armed = armForceQuit();
          if (!armed) {
            return json({ ok: true, alreadyArmed: true }, { headers: corsHeaders(req) });
          }
          // The HTTP response races process exit. Send synchronously, then
          // queue the quit to fire on the next tick so the response actually
          // reaches the webview before the renderer is torn down. (Even if
          // it doesn't, the client doesn't care — its EventSource just drops.)
          setTimeout(() => {
            try { native.quit(); } catch { /* electrobun internals may throw on second quit; safe to swallow */ }
          }, 0);
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      // Shut the core down gracefully. Used for the app⇄daemon port handoff
      // (the app POSTs this to a running cli-daemon before binding) and by
      // `agetor daemon stop`. Removes the creds file, then quits via the
      // native host if present (app mode) or exits the process (headless).
      // Token-gated like every other mutating route; the setTimeout(…, 0) lets
      // the 200 flush before the process goes away (same pattern as force-quit).
      "/daemon/shutdown": {
        POST: authed((req) => {
          setTimeout(() => {
            removeCoreCreds(dataDir);
            if (native) native.quit();
            else process.exit(0);
          }, 0);
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      // Terminal tabs for a task. State lives in-memory in terminals.ts; the
      // live byte stream runs over the WebSocket at /terminals/:id/ws (handled
      // in `fetch` below, since Bun's routes API doesn't do upgrades).
      "/tasks/:id/terminals": {
        GET: authed((req) => json(listTerminals(req.params.id), { headers: corsHeaders(req) })),
        POST: authed(async (req) => {
          const result = await createTerminal(req.params.id);
          if ("error" in result) {
            return json(
              { error: result.error },
              { status: result.notFound ? 404 : 400, headers: corsHeaders(req) },
            );
          }
          return json(result, { status: 201, headers: corsHeaders(req) });
        }),
      },
      "/terminals/:id": {
        DELETE: authed((req) => {
          const ok = closeTerminal(req.params.id);
          return ok
            ? new Response(null, { status: 204, headers: corsHeaders(req) })
            : json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/events": authed((req) => {
        const taskId = req.params.id;
        const stream = new ReadableStream({
          start(controller) {
            attachedClients++;
            const enc = new TextEncoder();
            const send = (e: RunEvent | { type: "ping" }) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              } catch {
                // Client went away mid-send (replay or a live event landing on a
                // closed controller). Swallow so `start` never throws before the
                // abort handler is registered — that handler owns the cleanup
                // (unsubscribe + attachedClients--), and letting `start` throw
                // would leak both the subscription and the attached-client count
                // (which would then permanently block the daemon's idle-shutdown).
              }
            };
            // Unified task-level stream: one scrollback per task, merging
            // events across every run. Subscribe before replay (same race
            // protection as the per-run endpoint).
            let buffer: RunEvent[] | null = [];
            const unsubscribe = subscribe((e) => {
              if (e.taskId !== taskId) return;
              if (buffer) buffer.push(e);
              else send(e);
            });
            for (const ev of runs.eventsForTask(taskId)) {
              send({
                runId: ev.runId,
                taskId,
                stream: ev.stream as RunEvent["stream"],
                data: ev.data,
                ts: ev.ts,
              });
            }
            const drained = buffer;
            buffer = null;
            for (const ev of drained) send(ev);
            const ping = setInterval(() => send({ type: "ping" }), 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(ping);
              unsubscribe();
              controller.close();
              attachedClients--;
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            ...corsHeaders(req),
          },
        });
      }),
    },
    fetch(req, server) {
      if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
      // WebSocket upgrade for a terminal tab's live byte stream. The routes API
      // can't upgrade, so we match it here. Token-gated via `?token=` like the
      // SSE endpoints (WebSockets can't set the Authorization header).
      const url = new URL(req.url);
      const wsMatch = url.pathname.match(/^\/terminals\/([^/]+)\/ws$/);
      if (wsMatch) {
        if (!isAuthorized(req)) return unauthorized(req);
        const terminalId = decodeURIComponent(wsMatch[1]!);
        // Reject unknown ids before upgrading, rather than upgrading then
        // immediately closing the socket in the `open` handler.
        if (!getTerminal(terminalId)) {
          return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
        }
        const upgraded = server.upgrade(req, { data: { terminalId } });
        // `upgrade` returns true and assumes responsibility for the response.
        if (upgraded) return undefined;
        return json({ error: "websocket upgrade failed" }, { status: 426, headers: corsHeaders(req) });
      }
      return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
    },
  });

  console.log(`[agetor] api listening on http://127.0.0.1:${server.port}`);
  return server;
}
