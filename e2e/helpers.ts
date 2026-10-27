import { Database } from "bun:sqlite";
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
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}

/** Opens Settings → General (the default section on open — no tab click
 *  needed) and waits for the dialog to render. */
export async function openSettingsGeneral(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
