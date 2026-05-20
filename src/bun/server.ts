import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Utils } from "electrobun/bun";
import pkg from "../../package.json" with { type: "json" };
import { API_TOKEN, getApiPort } from "./api-config.ts";
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
import { createTask, deleteTask, startTask, cancelRun, reconcileTaskSession, sendInput, subscribe, subscribeGlobal } from "./orchestrator.ts";
import { checkAllHarnesses } from "./agent-status.ts";
import { prepareClaudeHarnessHome } from "./harness-setup.ts";
import { applyUpdate, checkForUpdate, getUpdateSnapshot } from "./updater.ts";
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
  getCurrentPermissionMode,
  jsonlPathFor,
  mapJsonlEventToChunks,
  markTmuxPromptAnswered,
  sessionExists,
} from "./claude-tmux.ts";
import { listBranches, hasUncommittedChanges } from "./worktree.ts";
import { listAvailableCommands } from "./commands.ts";
import { getDiscoveredModels, refreshDiscoveredModels } from "./agent-discovery.ts";
import { getMainWindow } from "./window.ts";
import {
  SAFE_TOOLS,
  answerApproval,
  answerAskQuestions,
  answerPlanApproval,
  answerQuestion,
  answerTmuxPrompt,
  findTmuxPromptById,
  formatAskQuestionsReason,
  formatPlanApprovalReason,
  listPendingForTask,
  lookupAllowRule,
  makeHookResponse,
  registerApproval,
  registerAskQuestions,
  registerPlanApproval,
  registerQuestion,
  type AskQuestion,
  type AskQuestionsAnswer,
  type ApprovalAnswer,
  type PlanApprovalAnswer,
  type QuestionAnswer,
} from "./interactions.ts";
import { MODEL_EFFORT_SUPPORT } from "../shared/types.ts";
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

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    status: init?.status,
  });

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
  "title", "prompt", "agent", "workdir", "column", "mode", "model", "effort",
]);

function filterPatch(raw: unknown): Partial<Task> {
  if (!raw || typeof raw !== "object") return {};
  const patch: Partial<Task> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_PATCH_FIELDS.has(k as keyof Task)) (patch as Record<string, unknown>)[k] = v;
  }
  return patch;
}

/** Defensively parse claude's AskUserQuestion tool input. Skips malformed
 *  questions/options rather than failing the whole interception — keeps
 *  the UI usable even if a future claude release tweaks the shape. */
function parseAskQuestionsInput(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== "string" || !qq.question.trim()) continue;
    const optionsRaw = Array.isArray(qq.options) ? qq.options : [];
    const options = optionsRaw
      .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>) : null))
      .filter((o): o is Record<string, unknown> => o !== null && typeof o.label === "string")
      .map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : undefined,
      }));
    out.push({
      question: qq.question,
      header: typeof qq.header === "string" ? qq.header : undefined,
      multiSelect: Boolean(qq.multiSelect),
      options,
    });
  }
  return out;
}

function parseExitPlanInput(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { plan?: unknown }).plan === "string") {
    return (input as { plan: string }).plan;
  }
  return "(claude did not provide a plan body)";
}

export function startApiServer() {
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

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    development: false,
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
          const paths = await Utils.openFileDialog({
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
        DELETE: authed(async (req) => {
          const { path: p } = (await req.json().catch(() => ({}))) as { path?: string };
          if (!p) return json({ error: "path required" }, { status: 400, headers: corsHeaders(req) });
          projects.delete(p);
          return new Response(null, { status: 204, headers: corsHeaders(req) });
        }),
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
          json(getUpdateSnapshot(), { headers: corsHeaders(req) })),
      },
      "/updates/check": {
        POST: authed(async (req) => {
          await checkForUpdate();
          return json(getUpdateSnapshot(), { headers: corsHeaders(req) });
        }),
      },
      "/updates/apply": {
        POST: authed((req) => {
          // Status check runs synchronously here — not inside applyUpdate —
          // so the 409 reaches the client. An earlier shape wrapped a void
          // applyUpdate() call in try/catch, but async functions never throw
          // synchronously, so that catch was dead code and stale-button
          // clicks silently 200'd while the actual rejection became an
          // unhandled promise inside the bun process.
          const snap = getUpdateSnapshot();
          if (snap.status !== "ready") {
            return json(
              { error: `no update is ready to apply (status: ${snap.status})` },
              { status: 409, headers: corsHeaders(req) },
            );
          }
          // applyUpdate quits + relaunches; the HTTP response races against
          // process exit. Void on purpose — the webview drops its connection
          // when the process goes away.
          void applyUpdate();
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
              if (typeof v === "string") env[k] = v;
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
            // Native-install claude validates `$HOME/.local/bin/claude` exists
            // on every launch and errors out otherwise. When the user gives
            // this harness its own HOME but no BIN, pre-link the system
            // binary into the new HOME so the integrity check passes.
            if (created.kind === "claude-code" && created.home && !created.bin) {
              prepareClaudeHarnessHome(created.home);
            }
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
              if (typeof v === "string") env[k] = v;
            }
            patch.env = env;
          }
          try {
            const updated = harnesses.update(req.params.id, patch);
            // Same rationale as the POST handler: if a claude-code alias
            // gains (or changes) a custom HOME without an explicit BIN, make
            // sure the native-install integrity-check path exists.
            if (updated.kind === "claude-code" && updated.home && !updated.bin && "home" in body) {
              prepareClaudeHarnessHome(updated.home);
            }
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

      // Slash commands + skills available to the picked agent in the picked
      // project. The new-task form queries this whenever agent/workdir/branch
      // change so the prompt textarea can offer `/…` autocomplete.
      "/agent-commands": {
        GET: authed(async (req) => {
          const url = new URL(req.url);
          const agent = url.searchParams.get("agent") as AgentKind | null;
          const workdir = url.searchParams.get("workdir");
          const branch = url.searchParams.get("branch");
          if (agent !== "claude-code" && agent !== "codex") {
            return json({ error: "agent required" }, { status: 400, headers: corsHeaders(req) });
          }
          return json(
            await listAvailableCommands({ agent, workdir, branch }),
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
          reconcileTaskSession(req.params.id, before, updated);
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

      "/tasks/:id/runs": {
        GET: authed((req) => json(runs.listForTask(req.params.id), { headers: corsHeaders(req) })),
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
          const ok = Utils.openPath(abs);
          return json({ opened: ok, path: abs }, { headers: corsHeaders(req) });
        }),
      },

      // ─── Interactions: tool-call approvals (from the PreToolUse hook) ───
      "/approvals": {
        POST: authed(async (req) => {
          const url = new URL(req.url);
          const taskId = url.searchParams.get("taskId");
          if (!taskId) {
            return json({ error: "taskId required" }, { status: 400, headers: corsHeaders(req) });
          }
          // The hook script POSTs claude's verbatim PreToolUse payload —
          // we read tool_name + tool_input out of it.
          const payload = (await req.json().catch(() => ({}))) as {
            tool_name?: string;
            tool_input?: unknown;
          };
          const toolName = payload.tool_name ?? "unknown";
          // Resolve the current run id for this task. If there isn't one
          // (race: agetor restarted between spawn and first tool call), fall
          // back to "ask" so claude pops its TUI modal.
          const task = tasks.get(taskId);
          const runId = task?.runId;
          if (!runId) {
            return json(makeHookResponse({ decision: "deny", reason: "no active run" }), {
              headers: corsHeaders(req),
            });
          }
          // Defense-in-depth: claude's built-in interactive tools must
          // always go through the UI intercept, never the safe-tool nor
          // saved-rule auto-allow paths — auto-allowing them lets claude
          // pop its invisible TUI modal and the run hangs exactly like
          // pre-intercept. A stale rule (manual SQL fix, future refactor,
          // accidental "Allow always" path that used to route through the
          // generic ApprovalCard) shouldn't be able to disable the safety.
          const ALWAYS_INTERCEPT = new Set(["AskUserQuestion", "ExitPlanMode"]);
          // Plan mode is the user explicitly opting into "stop and ask
          // before any write". A saved allow-rule from a prior non-plan
          // run must not silently bypass that — otherwise the kanban
          // shows "Agent is working…" while claude is actually paused on
          // its plan-mode confirmation dialog inside tmux (see
          // docs/can-we-apply-both-* plan). Read-only tools keep their
          // fast-path even here: they can't mutate the workspace, so
          // the plan-mode safety doesn't apply.
          const PLAN_MODE_INTERCEPT = new Set([
            "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash",
          ]);
          const currentMode = getCurrentPermissionMode(taskId);
          const planModeForce = currentMode === "plan" && PLAN_MODE_INTERCEPT.has(toolName);
          // Fast paths: safe tools and previously-saved rules auto-allow,
          // except for the always-intercept set above. The allow-rule lookup
          // now reads `.claude/settings.local.json` `permissions.allow` and
          // matches per the claude pattern syntax (see claude-permissions.ts).
          if (!ALWAYS_INTERCEPT.has(toolName) && !planModeForce &&
              (SAFE_TOOLS.has(toolName) ||
               lookupAllowRule({ taskId, toolName, toolInput: payload.tool_input }) === "allow")) {
            return json(makeHookResponse({ decision: "allow" }), { headers: corsHeaders(req) });
          }
          // ─── Claude built-in interactive tools ─────────────────────────
          // AskUserQuestion / ExitPlanMode are tools whose body is "block
          // until the human answers in the TUI". Agetor can't see that
          // modal (claude runs detached in tmux), so we intercept here,
          // route to a structured InteractionCard, and return the user's
          // answer back to claude as the hook's `permissionDecisionReason`
          // (decision: deny). Claude reads the reason as if it were the
          // modal's output and continues.
          if (toolName === "AskUserQuestion") {
            const questions = parseAskQuestionsInput(payload.tool_input);
            if (questions.length === 0) {
              // Malformed input — let claude's own TUI handle it (fail open).
              return json(makeHookResponse({ decision: "ask" }), { headers: corsHeaders(req) });
            }
            const { req: registered, answer } = registerAskQuestions({ taskId, runId, questions });
            const ans = await answer;
            return json(
              makeHookResponse({ decision: "deny", reason: formatAskQuestionsReason(registered, ans) }),
              { headers: corsHeaders(req) },
            );
          }
          if (toolName === "ExitPlanMode") {
            const plan = parseExitPlanInput(payload.tool_input);
            const { answer } = registerPlanApproval({ taskId, runId, plan });
            const ans = await answer;
            return json(
              makeHookResponse({ decision: "deny", reason: formatPlanApprovalReason(ans) }),
              { headers: corsHeaders(req) },
            );
          }
          // Otherwise register and hold until the UI answers.
          const { answer } = registerApproval({
            taskId,
            runId,
            toolName,
            toolInput: payload.tool_input,
          });
          const decision = await answer;
          return json(makeHookResponse(decision), { headers: corsHeaders(req) });
        }),
      },

      "/approvals/:id/answer": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as Partial<ApprovalAnswer>;
          // The UI only ever issues allow / deny — `ask` is reserved for
          // the server's internal fail-open path on malformed requests.
          if (body.decision !== "allow" && body.decision !== "deny") {
            return json(
              { error: "decision must be 'allow' or 'deny'" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          const ok = answerApproval(req.params.id, {
            decision: body.decision,
            reason: body.reason,
            remember: Boolean(body.remember),
            // Optional pattern-keyed entry from the UI's granularity chooser.
            // Server-side derive picks the most-specific scope if absent.
            entry: typeof body.entry === "string" ? body.entry : undefined,
          });
          return json({ ok }, { headers: corsHeaders(req) });
        }),
      },

      // ─── Interactions: clarifying questions (from the ask_user MCP tool) ──
      "/questions": {
        POST: authed(async (req) => {
          const url = new URL(req.url);
          const taskId = url.searchParams.get("taskId");
          if (!taskId) {
            return json({ error: "taskId required" }, { status: 400, headers: corsHeaders(req) });
          }
          const body = (await req.json().catch(() => ({}))) as {
            question?: string;
            choices?: string[];
            multi?: boolean;
          };
          if (typeof body.question !== "string" || body.question.trim() === "") {
            return json(
              { error: "question required" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          const task = tasks.get(taskId);
          const runId = task?.runId;
          if (!runId) {
            return json(
              { selected: [], custom: "(no active run to ask)" } satisfies QuestionAnswer,
              { headers: corsHeaders(req) },
            );
          }
          const { answer } = registerQuestion({
            taskId,
            runId,
            question: body.question,
            choices: body.choices,
            multi: body.multi,
          });
          return json(await answer, { headers: corsHeaders(req) });
        }),
      },

      "/questions/:id/answer": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as Partial<QuestionAnswer>;
          const selected = Array.isArray(body.selected) ? body.selected : [];
          const custom = typeof body.custom === "string" ? body.custom : undefined;
          if (selected.length === 0 && (!custom || !custom.trim())) {
            return json(
              { error: "selected or custom required" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          const ok = answerQuestion(req.params.id, { selected, custom });
          return json({ ok }, { headers: corsHeaders(req) });
        }),
      },

      // ─── Interactions: claude built-in AskUserQuestion (intercepted) ──
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
          const ok = answerAskQuestions(req.params.id, { answers: sanitised });
          return json({ ok }, { headers: corsHeaders(req) });
        }),
      },

      // ─── Interactions: claude built-in ExitPlanMode (intercepted) ─────
      "/plan-approvals/:id/answer": {
        POST: authed(async (req) => {
          const body = (await req.json().catch(() => ({}))) as Partial<PlanApprovalAnswer>;
          if (body.choice !== "approve_implement" && body.choice !== "approve_ask" && body.choice !== "reject") {
            return json(
              { error: "choice must be 'approve_implement', 'approve_ask', or 'reject'" },
              { status: 400, headers: corsHeaders(req) },
            );
          }
          const revision = typeof body.revision === "string" ? body.revision : undefined;
          const ok = answerPlanApproval(req.params.id, { choice: body.choice, revision });
          return json({ ok }, { headers: corsHeaders(req) });
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
          const body = (await req.json().catch(() => ({}))) as { key?: unknown };
          const key = typeof body.key === "string" ? body.key : "";
          if (!key) {
            return json({ error: "key required" }, { status: 400, headers: corsHeaders(req) });
          }
          const pending = findTmuxPromptById(req.params.id);
          if (!pending) {
            // Either the prompt was auto-cancelled (scraper saw the pane
            // change) or the id is unknown. Either way return ok:false so
            // the UI can drop the card on its next poll.
            return json({ ok: false }, { headers: corsHeaders(req) });
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
          const delivered = dismissTmuxPrompt(pending.taskId, key);
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
          // Resolve the harness so we read from the alias's HOME-derived
          // claude config dir (multi-account); built-ins resolve to
          // `homedir()` via the `home: null` branch inside jsonlPathFor.
          const harness = harnesses.getByIdOrKind(task.agent);
          const jsonlPath = jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null);
          if (!existsSync(jsonlPath)) {
            return json({ events: [], reason: `JSONL not found at ${jsonlPath}` }, { headers: corsHeaders(req) });
          }
          // Parse every line via the same mapper live tailing uses so the
          // output shape is identical to streamed events.
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
          const text = readFileSync(jsonlPath, "utf8");
          for (const line of text.split("\n")) {
            if (line.trim()) mapJsonlEventToChunks(line, onChunk);
          }
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
            const enc = new TextEncoder();
            const send = (e: RunEvent | { type: "ping" }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
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
            const enc = new TextEncoder();
            const send = (e: GlobalEvent | { type: "ping" }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            };
            const unsubscribe = subscribeGlobal((e) => send(e));
            const ping = setInterval(() => send({ type: "ping" }), 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(ping);
              unsubscribe();
              controller.close();
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
          Utils.showNotification({
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
            const enc = new TextEncoder();
            const send = (e: AppEvent | { type: "ping" }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            };
            const unsubscribe = subscribeAppEvents((e) => send(e));
            const ping = setInterval(() => send({ type: "ping" }), 15_000);
            req.signal.addEventListener("abort", () => {
              clearInterval(ping);
              unsubscribe();
              controller.close();
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
            try { Utils.quit(); } catch { /* electrobun internals may throw on second quit; safe to swallow */ }
          }, 0);
          return json({ ok: true }, { headers: corsHeaders(req) });
        }),
      },

      "/tasks/:id/events": authed((req) => {
        const taskId = req.params.id;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (e: RunEvent | { type: "ping" }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
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
    fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
      return json({ error: "not found" }, { status: 404, headers: corsHeaders(req) });
    },
  });

  console.log(`[agetor] api listening on http://127.0.0.1:${server.port}`);
  return server;
}
