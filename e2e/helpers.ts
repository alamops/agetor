import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { E2EBackend } from "./fixtures";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * Helpers shared across e2e/*.spec.ts. Parametrized by the worker's
 * `E2EBackend` (e2e/fixtures.ts) rather than the old static
 * E2E_API_PORT/E2E_API_TOKEN module constants — each worker now owns its own
 * backend, so there is no single fixed port/token pair to close over.
 */

export interface GotoAppOptions {
  /**
   * Defaults to `true`: before navigating, seeds `onboardingDismissed="true"`
   * directly against the backend this `url` points at, so the first-run
   * welcome dialog / "Getting started" checklist (docs/plans/onboarding-
   * first-run.md) never appears for a spec that isn't testing it. Every
   * fresh per-worker backend (e2e/fixtures.ts's `backend`) starts with that
   * preference absent — which is exactly the "show onboarding" state — so
   * without this default, theme/font-size/quote specs would get a welcome
   * dialog overlay blocking their first click. Only e2e/onboarding.spec.ts
   * needs the real first-run state, via `{ seedOnboardingDismissed: false }`.
   */
  seedOnboardingDismissed?: boolean;
}

/** Preference key onboarding's visibility logic reads
 *  (`ONBOARDING_DISMISSED_PREF` in src/mainview/lib/onboarding.ts) — kept as
 *  a literal here rather than imported so this file has no dependency on
 *  mainview source. */
const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";

/** Pulls `apiBase`/`token` out of a boot URL's `#api=<port>&token=<token>`
 *  hash. Used so `gotoApp` can seed a preference through `page.request`
 *  (available on `Page` without a separate `request` fixture) without
 *  widening its signature to take a full `E2EBackend` object — every
 *  existing caller already builds a plain url string (some, like font-
 *  size.spec.ts, append extra hash params of their own), so keeping `url`
 *  as the second parameter means zero edits to those call sites. */
function backendFromBootUrl(url: string): { apiBase: string; token: string } | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const port = params.get("api");
  const token = params.get("token");
  if (!port || !token) return null;
  return { apiBase: `http://127.0.0.1:${port}`, token };
}

/** Navigates to a boot URL and waits for real rendered content — the
 *  Settings button in the app bar — rather than a fixed sleep. Callers
 *  assemble the URL themselves (`backend.bootBase` plus any spec-specific
 *  hash params, e.g. font-size.spec's `&fontSize=`). See `GotoAppOptions`
 *  for the default onboarding-dismissal seeding. */
export async function gotoApp(page: Page, url: string, options: GotoAppOptions = {}): Promise<void> {
  const { seedOnboardingDismissed = true } = options;
  if (seedOnboardingDismissed) {
    const backend = backendFromBootUrl(url);
    if (backend) {
      const res = await page.request.put(`${backend.apiBase}/preferences/${ONBOARDING_DISMISSED_KEY}`, {
        headers: { authorization: `Bearer ${backend.token}` },
        data: { value: "true" },
      });
      if (!res.ok()) {
        throw new Error(
          `gotoApp: failed to seed ${ONBOARDING_DISMISSED_KEY} (${res.status()} ${await res.text()})`,
        );
      }
    }
  }
  await page.goto(url);
  await expect(headerSettingsButton(page)).toBeVisible();
}

/** The app bar's Settings button, by its `title` (exact). A role-name lookup
 *  ("Settings") is ambiguous — strict-mode violation — whenever a toast with
 *  its own "Settings" action button (e.g. the harness auto-enable toast) is
 *  also on screen; only the header button carries this title. */
export function headerSettingsButton(page: Page): Locator {
  return page.getByTitle("Settings", { exact: true });
}

/** Opens Settings → General (the default section on open — no tab click
 *  needed) and waits for the dialog to render. */
export async function openSettingsGeneral(page: Page): Promise<Locator> {
  await headerSettingsButton(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  return dialog;
}

/** Arrange-only helper: seeds a persisted preference directly through the
 *  API so a test starts from a known state, without that setup step itself
 *  being the thing under test. */
export async function putPreference(
  request: APIRequestContext,
  backend: E2EBackend,
  key: string,
  value: string,
): Promise<void> {
  const res = await request.put(`${backend.apiBase}/preferences/${key}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { value },
  });
  expect(res.ok()).toBeTruthy();
}

/** Reads back the full persisted-preferences object. */
export async function getPreferences(
  request: APIRequestContext,
  backend: E2EBackend,
): Promise<Record<string, string>> {
  const res = await request.get(`${backend.apiBase}/preferences`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  return (await res.json()) as Record<string, string>;
}

/**
 * Arrange-only helper for the per-harness usage tracker (docs/plans/harness-
 * usage-tracker.md): seeds a `harness_usage` snapshot directly into the
 * worker's isolated SQLite DB, bypassing the poller entirely.
 *
 * There is no ingestion route that works offline — `POST
 * /harnesses/:id/usage/refresh` hits the real provider (Anthropic/OpenAI/
 * Cursor) over the network — so a deterministic e2e test can't seed a known
 * meter through the HTTP API the way `putPreference` does. The app instead
 * boot-seeds the topbar tracker via `GET /usage`, which reads straight from
 * the `harness_usage` table (`src/bun/server.ts`'s `/usage` route, `db.ts`'s
 * `harnessUsage.getAll()`) with no other side effects — so writing the same
 * row this helper's backend counterpart (`harnessUsage.upsert`, `src/bun/db
 * .ts`) would write, directly via `bun:sqlite`, reproduces exactly what a
 * real poll would have persisted. Must run BEFORE `gotoApp` — App.tsx reads
 * `GET /usage` once, at mount.
 *
 * Opens and closes its own `Database` handle per call rather than caching
 * one on the backend fixture: this runs a handful of times per spec, well
 * off any hot path, and a short-lived handle can't outlive (and so can't
 * conflict with) the backend process's own WAL-mode connection to the same
 * file.
 */
export function seedHarnessUsage(backend: E2EBackend, quota: HarnessQuota): void {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    // The headless backend holds this file too. A write that arrives during
    // its transaction used to throw SQLITE_BUSY immediately; wait it out.
    db.exec("PRAGMA busy_timeout = 5000");
    db.run(
      `INSERT INTO harness_usage (harness_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      [quota.harnessId, JSON.stringify(quota), Date.now()],
    );
  } finally {
    db.close();
  }
}

/** Opens a short-lived handle on the backend's SQLite file for an
 *  arrange-only write — same reasoning (and busy_timeout) as
 *  `seedHarnessUsage` above. */
function withBackendDb<T>(backend: E2EBackend, fn: (db: Database) => T): T {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Arrange-only helper for the archived-history retention e2e
 * (docs/plans/non-blocking-session-restore.md, TT8): appends a `tool_use` row
 * and its paired `tool_result` row — `bytes` of text in the result's
 * `content`, so the persisted payload is a little over `bytes` — to `runId`'s
 * event stream, straight through `bun:sqlite`. No HTTP route can plant a
 * bulky `tool_result` (the fake drivers emit tiny ones), and the retention
 * pass only trims rows above `RETENTION_TRIM_BYTES` (4 KB), so the test needs
 * a deterministic oversized row. The two rows share `toolUseId`, so RunPanel
 * pairs them into one collapsed tool card exactly as it does for a real
 * transcript. Returns the ids so a spec can read the row back.
 */
export function seedArchivedToolResult(
  backend: E2EBackend,
  opts: { taskId: string; runId: string; bytes: number },
): { toolUseId: string; toolResultEventId: number } {
  const toolUseId = `toolu_retention_${opts.taskId.slice(0, 8)}`;
  const content = "retention-payload-".repeat(Math.ceil(opts.bytes / 18)).slice(0, opts.bytes);
  const toolUse = JSON.stringify({
    id: toolUseId,
    name: "Bash",
    input: { command: "cat big-output.txt", description: "print a large file" },
  });
  const toolResult = JSON.stringify({ toolUseId, content, isError: false });
  return withBackendDb(backend, (db) => {
    const now = Date.now();
    db.run("INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'tool_use', ?, ?)", [
      opts.runId,
      toolUse,
      now,
    ]);
    const res = db.run("INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'tool_result', ?, ?)", [
      opts.runId,
      toolResult,
      now + 1,
    ]);
    return { toolUseId, toolResultEventId: Number(res.lastInsertRowid) };
  });
}

/** Arrange-only helper: rewrites a task's `archived_at` to `msAgo`
 *  milliseconds in the past, so the retention pass sees it as archived for
 *  that long without the spec waiting out a real 30 days. */
export function backdateArchivedAt(backend: E2EBackend, taskId: string, msAgo: number): void {
  withBackendDb(backend, (db) => {
    const res = db.run("UPDATE tasks SET archived_at = ? WHERE id = ? AND archived_at IS NOT NULL", [
      Date.now() - msAgo,
      taskId,
    ]);
    if (res.changes !== 1) throw new Error(`backdateArchivedAt: task ${taskId} is not archived (changes=${res.changes})`);
  });
}

/** Arrange/assert helper: reads a single scalar via the backend's SQLite
 *  file (read-only use — counts for the restore spec). */
export function queryBackendScalar(backend: E2EBackend, sql: string, params: (string | number)[] = []): number {
  return withBackendDb(backend, (db) => {
    const row = db.query<{ n: number }, (string | number)[]>(sql).get(...params);
    return row?.n ?? 0;
  });
}

/**
 * Waits for a task's terminal pane to be live: `TerminalView`'s pane carries
 * `data-ready="true"` once the PTY has delivered its first output frame over
 * the WebSocket (xterm's canvas renders before anything arrives, so its mere
 * visibility proves nothing). `scope` is the run panel (or any container
 * holding the Terminal section). The default 20 s ceiling matches
 * `terminals.test.ts`'s `SHELL_READY_MS` — a cold login shell on a loaded box.
 */
export async function waitForTerminalReady(scope: Locator, timeoutMs = 20_000): Promise<Locator> {
  const pane = scope.locator('[data-testid="terminal-pane"][data-ready="true"]').first();
  await expect(pane).toBeAttached({ timeout: timeoutMs });
  return pane;
}

/**
 * Synthetic SSE frames for the webview's fetch-based event streams.
 *
 * The webview no longer creates `EventSource` objects (master-token plan,
 * D13/P8): every stream is a `fetch` whose body `openEventStream` reads, so a
 * spec can't dispatch a `MessageEvent` on a recorded source any more. This
 * pair of helpers is the replacement seam. `installSseInjector` wraps
 * `window.fetch` so a response for `pathname` (`/events`, `/app/events`) is
 * re-served through a `ReadableStream` the page keeps a handle on; the real
 * body is piped through unchanged, and `injectSseFrame` enqueues an extra
 * unnamed `data:` frame into every still-open stream — the same bytes, hence
 * the same `onMessage` path, a real SSE frame takes. A stream the reader
 * aborted (React's dev double-mount leaves one) is dropped from the registry,
 * so a frame is never delivered twice. Must run BEFORE `gotoApp`.
 */
export async function installSseInjector(page: Page, pathname: string): Promise<void> {
  await page.addInitScript((target) => {
    const w = window as unknown as {
      __sseInjectors?: Record<string, Set<ReadableStreamDefaultController<Uint8Array>>>;
    };
    w.__sseInjectors ??= {};
    const open = (w.__sseInjectors[target] ??= new Set());
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await nativeFetch(input, init);
      const raw = input instanceof Request ? input.url : String(input);
      if (new URL(raw, location.href).pathname !== target || !res.body) return res;
      const reader = res.body.getReader();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          open.add(c);
        },
        async pull(c) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              open.delete(c);
              c.close();
            } else if (value) c.enqueue(value);
          } catch (e) {
            open.delete(c);
            try {
              c.error(e);
            } catch { /* already closed */ }
          }
        },
        cancel(reason) {
          open.delete(controller);
          return reader.cancel(reason);
        },
      });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }) as typeof fetch;
  }, pathname);
}

/** Delivers `event` (JSON-encoded) as one unnamed SSE frame to every open
 *  stream `installSseInjector` recorded for `pathname`. */
export async function injectSseFrame(page: Page, pathname: string, event: Record<string, unknown>): Promise<void> {
  // Readiness, not a sleep: under a loaded full run the stream may not have
  // opened yet (or is between a drop and its reconnect) when the spec gets
  // here, so wait for the injector to hold an open stream first.
  await page
    .waitForFunction(
      (target) =>
        ((window as unknown as { __sseInjectors?: Record<string, Set<unknown>> }).__sseInjectors?.[target]?.size ?? 0) > 0,
      pathname,
      { timeout: 10_000 },
    )
    .catch(() => {
      /* fall through: the evaluate below reports the missing stream */
    });
  await page.evaluate(
    ({ target, data }) => {
      const open = (window as unknown as {
        __sseInjectors?: Record<string, Set<ReadableStreamDefaultController<Uint8Array>>>;
      }).__sseInjectors?.[target];
      if (!open || open.size === 0) throw new Error(`no open ${target} event stream recorded`);
      const bytes = new TextEncoder().encode(`data: ${data}\n\n`);
      for (const c of open) c.enqueue(bytes);
    },
    { target: pathname, data: JSON.stringify(event) },
  );
}

/**
 * Arrange-only helper for the harness-stack specs: writes the cooldown row a
 * limit settle would persist (`harness_limit_state`, migration 087). `model`
 * omitted (or `""`) is the whole-account row; a model id is a per-model row.
 * No HTTP route writes one without a real limit, so the board and Settings
 * read it from `/harnesses` after this. Call `removeLimitStates` to undo.
 */
export function seedLimitState(
  backend: E2EBackend,
  opts: { harnessId: string; untilMs: number; model?: string; message?: string | null; reason?: string },
): void {
  withBackendDb(backend, (db) => {
    db.run(
      `INSERT OR REPLACE INTO harness_limit_state
         (harness_id, model, reason, source, message, exhausted_until_ms, updated_at)
       VALUES (?, ?, ?, 'claude-pane', ?, ?, ?)`,
      [opts.harnessId, opts.model ?? "", opts.reason ?? "quota", opts.message ?? null, opts.untilMs, Date.now()],
    );
  });
}

/** Arrange/cleanup helper: removes every cooldown row of the given accounts. */
export function removeLimitStates(backend: E2EBackend, harnessIds: string[]): void {
  withBackendDb(backend, (db) => {
    for (const id of harnessIds) db.run("DELETE FROM harness_limit_state WHERE harness_id = ?", [id]);
  });
}

/** Number of cooldown rows an account has (assert helper). */
export function limitStateCount(backend: E2EBackend, harnessId: string, model?: string): number {
  return model === undefined
    ? queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM harness_limit_state WHERE harness_id = ?", [harnessId])
    : queryBackendScalar(
        backend,
        "SELECT COUNT(*) AS n FROM harness_limit_state WHERE harness_id = ? AND model = ?",
        [harnessId, model],
      );
}

/**
 * Arrange-only helper: inserts `count` `manual` swap-history rows for a stack,
 * newest first by `at`, so the History subpage has more than one page (50) to
 * "Load more" through. Titles are `seed-<n>`; the stack cascade removes them.
 */
export function seedSwapEvents(
  backend: E2EBackend,
  opts: { stackId: string; count: number; fromLabel: string; toLabel: string },
): void {
  withBackendDb(backend, (db) => {
    const base = Date.now() - 60 * 60_000;
    const ins = db.prepare(
      `INSERT INTO harness_swap_events
         (id, stack_id, task_title, from_label, to_label, trigger, reason, at)
       VALUES (?, ?, ?, ?, ?, 'manual', 'user', ?)`,
    );
    for (let i = 0; i < opts.count; i++) {
      ins.run(`e2e-seed-${opts.stackId}-${i}`, opts.stackId, `seed-${i}`, opts.fromLabel, opts.toLabel, base + i * 1000);
    }
  });
}

/* ───────────────── harness-stack arrange helpers (API-level) ───────────────── */

export function bearerHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

/**
 * Arrange-only: creates an alias account (`POST /harnesses`) whose home lives
 * under the worker's data dir, with the login evidence the kind's pre-flight
 * looks for (`.credentials.json` for Claude, `.codex/auth.json` for Codex).
 * Returns the account's config root (Claude: the home itself, Codex:
 * `<home>/.codex`). The label equals the id so a spec can address the row by
 * the id it chose.
 */
export async function createStackAccount(
  backend: E2EBackend,
  id: string,
  kind: "claude-code" | "codex" = "claude-code",
): Promise<string> {
  const home = path.join(backend.dataDir, "harnesses", id);
  mkdirSync(home, { recursive: true });
  let root = home;
  if (kind === "codex") {
    root = path.join(home, ".codex");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "auth.json"), "{}");
  } else {
    writeFileSync(path.join(home, ".credentials.json"), "{}");
  }
  const res = await fetch(`${backend.apiBase}/harnesses`, {
    method: "POST",
    headers: bearerHeaders(backend),
    body: JSON.stringify({ id, kind, label: id, home }),
  });
  if (!res.ok) throw new Error(`POST /harnesses -> ${res.status}: ${await res.text()}`);
  return root;
}

/** Arrange-only: `POST /harness-stacks`; returns the stack as the route answers. */
export async function createStackViaApi(
  backend: E2EBackend,
  label: string,
  kind: "claude-code" | "codex",
  members: string[],
  mirrorMode: "safe" | "full" = "safe",
): Promise<{ id: string; updatedAt: number; members: Array<{ harnessId: string }> }> {
  const res = await fetch(`${backend.apiBase}/harness-stacks`, {
    method: "POST",
    headers: bearerHeaders(backend),
    body: JSON.stringify({ label, kind, members, mirrorMode }),
  });
  if (!res.ok) throw new Error(`POST /harness-stacks -> ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { stack: { id: string; updatedAt: number; members: Array<{ harnessId: string }> } };
  return body.stack;
}

/** Reads `GET /harness-stacks` and returns the stacks (assert helper). */
export async function listStacks(
  backend: E2EBackend,
): Promise<Array<{ id: string; label: string; updatedAt: number; members: Array<{ harnessId: string }> }>> {
  const res = await fetch(`${backend.apiBase}/harness-stacks`, { headers: bearerHeaders(backend) });
  if (!res.ok) throw new Error(`GET /harness-stacks -> ${res.status}`);
  return ((await res.json()) as { stacks: never[] }).stacks;
}

/** Best-effort DELETE of every path (cleanup; never throws). */
export async function deleteAll(backend: E2EBackend, paths: string[]): Promise<void> {
  for (const p of paths) {
    await fetch(`${backend.apiBase}${p}`, { method: "DELETE", headers: bearerHeaders(backend) }).catch(() => {});
  }
}

/* ───────────── Select Projects (combined single/multi picker) ───────────── */

/** Generous readiness ceiling: the dialog's first open fetches `GET /projects`
 *  and a Save resolves every selected path's git root. */
const SELECT_PROJECTS_TIMEOUT = 30_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The Select Projects dialog (New Task, issue dialog). The accessible name is
 *  the dialog's own title, so both surfaces resolve the same way. */
export function selectProjectsDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Select projects" });
}

/** Opens the full-width Select Projects control inside `scope` and waits for
 *  the dialog. `scope` is the New Task aside or the issue dialog. */
export async function openSelectProjects(page: Page, scope: Locator): Promise<Locator> {
  const trigger = scope.getByTestId("select-projects-button");
  await expect(trigger).toBeVisible({ timeout: SELECT_PROJECTS_TIMEOUT });
  await trigger.click();
  const dialog = selectProjectsDialog(page);
  await expect(dialog).toBeVisible({ timeout: SELECT_PROJECTS_TIMEOUT });
  return dialog;
}

/** A project row's checkbox. Accepts an absolute path (exact) or a basename
 *  (matching the row's own project directory) so specs that only know their
 *  worker-unique project name keep working. */
function projectCheckbox(dialog: Locator, pathOrName: string): Locator {
  return projectCheckboxIn(dialog, pathOrName);
}

function projectCheckboxIn(root: Locator | Page, pathOrName: string): Locator {
  const anchor = pathOrName.startsWith("/") ? escapeRegExp(pathOrName) : `(?:.*/)?${escapeRegExp(pathOrName)}`;
  return root.getByLabel(new RegExp(`^Select ${anchor}$`));
}

/** Unchecks every row the user could uncheck (the auto-selected project is
 *  checked on open). */
async function clearProjects(dialog: Locator): Promise<void> {
  const boxes = dialog.locator('input[type="checkbox"]');
  const count = await boxes.count();
  for (let i = count - 1; i >= 0; i--) {
    const box = boxes.nth(i);
    if (await box.isDisabled()) continue;
    if (await box.isChecked()) await box.uncheck();
  }
}

/**
 * Opens the dialog, clears every row the user could uncheck (the auto-selected
 * project is checked on open), then checks `paths` in order — so the first path
 * is truly first in the saved selection (the server keeps the first entry per
 * git root). Saves and waits for the dialog to close.
 */
export async function chooseProjects(page: Page, scope: Locator, paths: string[]): Promise<void> {
  const dialog = await openSelectProjects(page, scope);
  for (const path of paths) {
    await expect(projectCheckbox(dialog, path)).toBeVisible({ timeout: SELECT_PROJECTS_TIMEOUT });
  }
  await clearProjects(dialog);
  for (const path of paths) await projectCheckbox(dialog, path).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: SELECT_PROJECTS_TIMEOUT });
}

/**
 * Selects exactly one project (clearing any auto-selected one first). Accepts
 * an absolute path or a registered project name — the latter searches the
 * dialog first, so specs can keep addressing a project by the name they
 * registered it under even when its directory basename differs.
 */
export async function selectProject(page: Page, scope: Locator, pathOrName: string): Promise<void> {
  if (pathOrName.startsWith("/")) {
    await chooseProjects(page, scope, [pathOrName]);
    return;
  }
  const dialog = await openSelectProjects(page, scope);
  await clearProjects(dialog);
  await dialog.getByTestId("select-projects-search").fill(pathOrName);
  // The search also matches a project's registered name, which the row's
  // visible text (basename + path) need not contain. A unique, worker-wide
  // project name must leave exactly one row; anything else is an ambiguous
  // test setup, not a selection to guess at.
  const rows = dialog.locator('[data-testid^="select-projects-row-"]');
  await expect(rows).toHaveCount(1, { timeout: SELECT_PROJECTS_TIMEOUT });
  await rows.first().locator('input[type="checkbox"]').check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: SELECT_PROJECTS_TIMEOUT });
}

/** One selected project's read-only `Branch · <project>` summary line in the
 *  form (`name` is the project's workspace slug). The line shows the base ref
 *  the Select Projects dialog saved, or "current branch". */
export function branchRow(scope: Locator, name: string): Locator {
  return scope.getByTestId(`branch-row-${name}`);
}

/** A project's row inside the open Select Projects dialog, by absolute path
 *  (exact) or basename — the same matching `chooseProjects` uses. */
export function dialogProjectRow(dialog: Locator, pathOrName: string): Locator {
  return dialog
    .locator('[data-testid^="select-projects-row-"]')
    // A page-rooted inner locator: `has` queries it relative to each row.
    .filter({ has: projectCheckboxIn(dialog.page(), pathOrName) });
}

/** The branch picker (label, Pull, Fetch, trigger) under one checked project
 *  in the open Select Projects dialog. */
export function dialogBranchPicker(dialog: Locator, pathOrName: string): Locator {
  return dialogProjectRow(dialog, pathOrName).getByTestId("select-projects-branch");
}

/**
 * Picks an existing branch in one checked project's picker inside the open
 * Select Projects dialog. The list opens in flow under the trigger and is
 * scoped by its `data-popover-open` marker so the trigger's own label can't be
 * mistaken for a list row. Does not Save.
 */
export async function pickDialogBranch(dialog: Locator, pathOrName: string, branch: string): Promise<void> {
  const picker = dialogBranchPicker(dialog, pathOrName);
  await expect(picker).toBeVisible({ timeout: SELECT_PROJECTS_TIMEOUT });
  const trigger = picker.getByTestId("branch-picker-trigger");
  await trigger.click();
  const popover = picker.locator("[data-popover-open]");
  await expect(popover).toBeVisible({ timeout: SELECT_PROJECTS_TIMEOUT });
  await popover.getByPlaceholder("Search branches…").fill(branch);
  await popover.getByText(branch, { exact: true }).click();
  await expect(popover).toBeHidden();
  await expect(trigger).toContainText(branch);
}

/**
 * Picks `branch` for one selected project the way a user does: open Select
 * Projects, choose it in that project's branch picker, Save. `pathOrName` is
 * the project's absolute path or basename.
 */
export async function selectBaseBranch(
  page: Page,
  scope: Locator,
  pathOrName: string,
  branch: string,
): Promise<void> {
  const dialog = await openSelectProjects(page, scope);
  await pickDialogBranch(dialog, pathOrName, branch);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: SELECT_PROJECTS_TIMEOUT });
}
