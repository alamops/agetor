import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, waitForTerminalReady } from "./helpers";

/**
 * Network audit for the master-token plan (docs/plans/master-token-agent-read
 * .md, TT14, D13): the webview must never put a token in a URL. Every request
 * and WebSocket the page makes while it streams a run, shows a toast from
 * `GET /events`, renders a sent-file thumbnail and a markdown image, and opens
 * a terminal is recorded with `page.on("request")` / `page.on("websocket")`,
 * and the audit asserts:
 *
 *   - no request URL and no WebSocket URL contains `token=` (the boot URL's
 *     `#api=…&token=…` is a fragment — never sent on the wire — so it is
 *     stripped before the check);
 *   - the terminal socket is `ws://…/terminals/:id/ws?ticket=…`, minted by
 *     `POST /terminals/:id/ws-ticket`;
 *   - the SSE streams (`/events`, `/tasks/:id/events`) are plain `fetch`es that
 *     carry the token in an `Authorization` header, and no `EventSource` is
 *     ever constructed;
 *   - images render as `blob:` object URLs, with the token-less route they were
 *     fetched from in `data-src-url`;
 *   - the run panel still streams (the fake run's text appears) and the
 *     `files-sent` toast still arrives over `/events`.
 *
 * Chromium can't show WKWebView-specific streaming behaviour; that is the
 * manual QA in the plan's W4.
 */

const FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER = "__agetor_fake_claude_sent_files__";
const FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER = "__agetor_fake_claude_md_image__";

// `SHELL=/bin/sh` for the same reason terminal-drift.spec.ts pins it: the
// assertion is about the manager + socket, not the developer's login shell.
test.use({ backendEnv: { SHELL: "/bin/sh" } });

const CONVERGE_TIMEOUT = 20_000;

interface TaskRow {
  id: string;
  title: string;
}

async function createAndStart(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  marker: string,
): Promise<{ task: TaskRow; workdir: string }> {
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-no-query-token-"));
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt: `${marker} ${title}`, isolation: "none", workdir },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;
  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth });
  expect(startRes.ok(), `start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();
  return { task, workdir };
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Records the text of every sonner toast the moment it mounts (the same
 *  observer sent-files.spec.ts uses — a task's single toast slot is replaced
 *  within milliseconds when the fake turn settles). */
async function installToastLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __toastLog: string[]; __eventSourceCount: number };
    w.__toastLog = [];
    const seen = new WeakSet<Element>();
    new MutationObserver(() => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        if (seen.has(el)) continue;
        const text = el.textContent ?? "";
        if (!text) continue;
        seen.add(el);
        w.__toastLog.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });

    // The webview must not construct a single `EventSource` any more.
    w.__eventSourceCount = 0;
    const Native = window.EventSource;
    if (Native) {
      class Counting extends Native {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          w.__eventSourceCount += 1;
        }
      }
      window.EventSource = Counting as unknown as typeof EventSource;
    }
  });
}

/** A recorded URL without its fragment: the boot URL's `#api=…&token=…` never
 *  reaches the network, only the part before `#` does. */
function wireUrl(url: string): string {
  return url.split("#")[0]!;
}

test("the webview never sends a token in a URL (SSE, images, terminal socket)", async ({ page, request, freshBackend }) => {
  test.setTimeout(120_000);
  const backend = freshBackend;

  const requests: { url: string; headers: Promise<Record<string, string>> }[] = [];
  const sockets: string[] = [];
  page.on("request", (r) => {
    // Draining headers inside the listener keeps them readable later.
    requests.push({ url: wireUrl(r.url()), headers: r.allHeaders().catch(() => ({}) as Record<string, string>) });
  });
  // Vite's own HMR socket (`ws://localhost:5173/?token=…`) is the dev server's
  // credential, not the API's — only sockets to the Agetor core are audited.
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).port === String(backend.apiPort)) sockets.push(ws.url());
  });

  // --- toast over /events ------------------------------------------------
  await installToastLog(page);
  const globalEventsRequested = page.waitForRequest((r) => new URL(r.url()).pathname === "/events");
  await gotoApp(page, backend.bootBase);
  await globalEventsRequested;

  const sentTitle = `no-query-token-sent ${randomUUID()}`;
  const sent = await createAndStart(request, backend, sentTitle, FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER);
  const names = (text: string) => text.includes(sentTitle) || text.includes(`Task ${sent.task.id.slice(0, 7)}`);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as unknown as { __toastLog: string[] }).__toastLog)).some(
          (t) => t.includes("2 files sent to you") && names(t),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  // --- run panel streams + sent-file thumbnail as a blob: image ----------
  const sentPanel = await openTask(page, sentTitle);
  await expect(sentPanel.getByText("Done.", { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  const pngTile = sentPanel.locator(`[data-testid="sent-file-tile"][data-kind="image"]`).first();
  const thumb = pngTile.locator("img");
  await expect(thumb).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
  await expect(thumb).toHaveAttribute("src", /^blob:/);
  const thumbUrl = await thumb.getAttribute("data-src-url");
  expect(thumbUrl, "thumbnail must record the route it was fetched from").toContain("/files/preview?path=");
  expect(thumbUrl).not.toContain("token=");
  await expect.poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // --- terminal tab: ticket-authenticated WebSocket ----------------------
  await sentPanel.locator('[data-testid="terminals-section"] > summary').click();
  await sentPanel.locator('[data-testid="terminal-open"]').first().click();
  await waitForTerminalReady(sentPanel);
  await expect.poll(() => sockets.some((u) => /\/terminals\/[^/]+\/ws\?/.test(u))).toBe(true);

  // --- markdown image as a blob: image -----------------------------------
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  const mdTitle = `no-query-token-md ${randomUUID()}`;
  const md = await createAndStart(request, backend, mdTitle, FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER);
  const mdPanel = await openTask(page, mdTitle);
  await expect(mdPanel.getByText("Here are the screenshots.", { exact: true })).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
  const mdImages = mdPanel.locator('[data-testid="md-image"]');
  await expect(mdImages).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });
  for (let i = 0; i < 2; i++) {
    await expect(mdImages.nth(i)).toHaveAttribute("src", /^blob:/);
    const url = await mdImages.nth(i).getAttribute("data-src-url");
    expect(url, `md image ${i} source route`).toContain("/files/preview?path=");
    expect(url).not.toContain("token=");
  }
  expect(md.task.id).toBeTruthy();

  // --- the audit ------------------------------------------------------------
  const seen = await Promise.all(requests.map(async (r) => ({ url: r.url, headers: await r.headers })));
  expect(seen.length).toBeGreaterThan(0);
  const withToken = seen.filter((r) => /[?&]token=/i.test(r.url) || /token=/i.test(new URL(r.url).search));
  expect(withToken.map((r) => r.url), "no request URL may carry token=").toEqual([]);
  expect(sockets.filter((u) => /token=/i.test(u)), "no WebSocket URL may carry token=").toEqual([]);

  // The terminal socket redeemed a ticket minted over an authenticated POST.
  const termSocket = sockets.find((u) => /\/terminals\/[^/]+\/ws\?/.test(u));
  expect(termSocket, "a terminal WebSocket was opened").toBeTruthy();
  expect(new URL(termSocket!).protocol).toBe("ws:");
  expect(new URL(termSocket!).searchParams.get("ticket")).toBeTruthy();
  const ticketReq = seen.find((r) => /\/terminals\/[^/]+\/ws-ticket$/.test(new URL(r.url).pathname));
  expect(ticketReq, "POST /terminals/:id/ws-ticket was requested").toBeTruthy();
  expect(ticketReq!.headers.authorization).toMatch(/^Bearer /);

  // The SSE streams are header-authenticated fetches.
  for (const re of [/^\/events$/, /^\/tasks\/[^/]+\/events$/]) {
    const stream = seen.find((r) => re.test(new URL(r.url).pathname));
    expect(stream, `a ${re} stream was opened`).toBeTruthy();
    expect(stream!.headers.authorization, `${re} carries an Authorization header`).toMatch(/^Bearer /);
  }

  // Image fetches carry the header too (the bytes are not served to <img src>).
  const previewReqs = seen.filter((r) => new URL(r.url).pathname === "/files/preview");
  expect(previewReqs.length).toBeGreaterThan(0);
  for (const r of previewReqs) expect(r.headers.authorization).toMatch(/^Bearer /);

  const eventSources = await page.evaluate(() => (window as unknown as { __eventSourceCount: number }).__eventSourceCount);
  expect(eventSources, "the webview must not construct EventSource objects").toBe(0);
});
