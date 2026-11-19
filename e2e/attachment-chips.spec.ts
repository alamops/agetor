import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the image attachment chip under a user bubble
 * (docs/plans/picked-image-preview-tcc.md §5, E1): an image attached with the
 * Files Picker whose preview the core can't read used to render as an amber
 * "Image not found" chip that neither previewed nor opened. Now:
 *
 *   1. blocked (403)  -> a neutral chip with an honest tooltip;
 *   2. ...whose click still reaches `/open-path` (the not-found dialog is NOT
 *      shown; the headless backend answers 501, so the "couldn't open"
 *      dialog proves the request went out);
 *   3. a proven 404   -> the amber chip and the not-found dialog, unchanged;
 *   4. a picked image that is blocked LATER still shows its thumbnail, from
 *      the preview twin `/refs/pick` wrote at pick time;
 *   5. a 500 or a 413 is a neutral chip with its own copy (only a 404 is
 *      amber), and still opens;
 *   6. a blocked chip whose `/open-path` answers 404 (the file really is
 *      gone) turns amber with the not-found dialog, and closing that dialog
 *      lets a later click ask again.
 *
 * Cases 5 and 6 fake the core's answer at the network boundary
 * (`page.route`), because a headless core can't produce a 500/413 for a 1x1
 * PNG or a 404 from `/open-path` (it answers 501 there).
 *
 * Headless backends can't produce macOS TCC, so `chmod 000` stands in for the
 * denial: `/files/preview` answers 403 for it in both disclaim modes
 * (src/bun/files-preview-endpoint.test.ts). The real-TCC behavior is covered
 * by the S1 spike and the live check (docs/plans/picked-image-preview-tcc-spike-pick.md).
 *
 * Every test plants its image under a UNIQUE name: twins are keyed by path and
 * `fakePickDir` is shared by the worker, so a reused name would hand a later
 * test an earlier one's twin.
 */

/** A real 1x1 transparent PNG (same bytes as `FAKE_PNG_1X1_BASE64` in
 *  src/bun/agents.ts — a literal, since src/bun can't be imported here). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const CONVERGE_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial" });

// `chmod 000` doesn't stop root, so the denial can't be staged there.
test.skip(typeof process.getuid === "function" && process.getuid() === 0, "chmod 000 does not block root");

interface PickedRef {
  path: string;
  isDirectory: boolean;
}

/** Plant a real PNG under a unique name and pick it through the master-token
 *  `POST /refs/pick` (the fake-dir seam), exactly what the Files Picker does. */
async function pickImage(
  request: APIRequestContext,
  backend: E2EBackend,
  label: string,
  opts: { blockBeforePick?: boolean } = {},
): Promise<PickedRef> {
  const name = `${label}-${randomUUID()}.png`;
  const [planted] = await backend.plantPicks({ [name]: PNG_1X1 });
  // Blocked BEFORE the pick, the core can't read the file when `/refs/pick`
  // tries to write its preview twin, so no twin exists (the stat still works).
  if (opts.blockBeforePick) chmodSync(planted!, 0o000);
  const res = await request.post(`${backend.apiBase}/refs/pick`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { mode: "files" },
  });
  expect(res.ok(), `POST /refs/pick -> ${res.status()}`).toBeTruthy();
  const { refs } = (await res.json()) as { refs: PickedRef[] };
  expect(refs).toHaveLength(1);
  expect(refs[0]!.path.endsWith(name)).toBe(true);
  return refs[0]!;
}

/** Plant several real PNGs under unique names and pick them all in one
 *  `POST /refs/pick`, returning the refs keyed by label. */
async function pickImages(
  request: APIRequestContext,
  backend: E2EBackend,
  labels: string[],
): Promise<Record<string, PickedRef>> {
  const names = Object.fromEntries(labels.map((l) => [l, `${l}-${randomUUID()}.png`]));
  await backend.plantPicks(Object.fromEntries(Object.values(names).map((n) => [n, PNG_1X1])));
  const res = await request.post(`${backend.apiBase}/refs/pick`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { mode: "files" },
  });
  expect(res.ok(), `POST /refs/pick -> ${res.status()}`).toBeTruthy();
  const { refs } = (await res.json()) as { refs: PickedRef[] };
  expect(refs).toHaveLength(labels.length);
  const out: Record<string, PickedRef> = {};
  for (const label of labels) {
    const ref = refs.find((r) => r.path.endsWith(names[label]!));
    expect(ref, `picked ref for ${label}`).toBeTruthy();
    out[label] = ref!;
  }
  return out;
}

/** CORS headers for a response the test fakes: the webview (Vite) calls the
 *  API on another origin, so without them the browser drops the stubbed
 *  answer and the app sees a network error instead. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, *",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/** Answer `GET /files/preview` with `status` for every path `matches`
 *  accepts; other previews go to the real core. */
async function stubPreviewStatus(page: Page, matches: (p: string) => boolean, status: number): Promise<void> {
  await page.route(
    (url) => url.pathname === "/files/preview" && matches(url.searchParams.get("path") ?? ""),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: CORS });
        return;
      }
      await route.fulfill({
        status,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({ error: `stubbed ${status}` }),
      });
    },
  );
}

/** Create + start a task whose first prompt references `ref` (isolation
 *  "none", a fresh mkdtemp workdir), the way the New Task form does. */
async function createTaskWithRef(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  ref: PickedRef | PickedRef[],
): Promise<void> {
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-attachment-chips-"));
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const references = Array.isArray(ref) ? ref : [ref];
  const created = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt: "look at the attached image", isolation: "none", workdir, references },
  });
  expect(created.ok(), `POST /tasks -> ${created.status()}: ${await created.text()}`).toBeTruthy();
  const task = (await created.json()) as { id: string };
  const started = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth });
  expect(started.ok(), `POST /tasks/${task.id}/start -> ${started.status()}`).toBeTruthy();
}

function runPanel(page: Page) {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** The attachment chip under the user bubble (`div.rounded-br-md`). */
function bubbleChip(panel: ReturnType<typeof runPanel>) {
  return panel.locator('.rounded-br-md [data-testid="attachment-image-chip"]');
}

test.describe("image attachment chip under a user bubble", () => {
  test("a preview the core can't read is a neutral chip with an honest tooltip, not 'not found'", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const ref = await pickImage(request, backend, "blocked", { blockBeforePick: true });
    const title = `attachment-chip-blocked ${randomUUID()}`;
    try {
      await createTaskWithRef(request, backend, title, ref);
      await gotoApp(page, backend.bootBase);
      const panel = await openTask(page, title);

      const chip = bubbleChip(panel);
      await expect(chip).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      await expect(chip).toHaveAttribute("data-preview-state", "denied", { timeout: CONVERGE_TIMEOUT });
      expect(await chip.getAttribute("class")).not.toContain("border-warning");
      await expect(chip).toHaveAttribute("title", /^Preview blocked by macOS privacy/);
      await expect(chip).toContainText(path.basename(ref.path));
      // It carries the path on the tooltip's second line.
      expect(await chip.getAttribute("title")).toContain(`\n${ref.path}`);
    } finally {
      chmodSync(ref.path, 0o600);
    }
  });

  test("clicking the blocked chip still reaches /open-path (not the not-found dialog)", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const ref = await pickImage(request, backend, "click", { blockBeforePick: true });
    const title = `attachment-chip-click ${randomUUID()}`;
    try {
      await createTaskWithRef(request, backend, title, ref);
      await gotoApp(page, backend.bootBase);
      const panel = await openTask(page, title);
      const chip = bubbleChip(panel);
      await expect(chip).toHaveAttribute("data-preview-state", "denied", { timeout: CONVERGE_TIMEOUT });

      const openRequest = page.waitForRequest((r) => r.url().includes("/open-path"), { timeout: CONVERGE_TIMEOUT });
      await chip.click();
      await openRequest;

      // The headless backend answers /open-path with 501, so the "couldn't
      // open" dialog proves the request went out and nothing declared the
      // file gone.
      await expect(page.locator("#attachment-open-error-title")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await expect(page.locator("#attachment-not-found-title")).toHaveCount(0);
    } finally {
      chmodSync(ref.path, 0o600);
    }
  });

  test("a deleted file is still the amber 'not found' chip, and a click opens the not-found dialog", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const ref = await pickImage(request, backend, "gone");
    const title = `attachment-chip-gone ${randomUUID()}`;
    rmSync(ref.path); // the pick-time twin survives, but a 404 never falls back
    await createTaskWithRef(request, backend, title, ref);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const chip = bubbleChip(panel);
    await expect(chip).toHaveAttribute("data-preview-state", "missing", { timeout: CONVERGE_TIMEOUT });
    expect(await chip.getAttribute("class")).toContain("border-warning");
    await expect(chip).toHaveAttribute("title", `Image not found: ${ref.path}`);

    await chip.click();
    const notFoundTitle = page.locator("#attachment-not-found-title");
    await expect(notFoundTitle).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(page.getByRole("dialog").filter({ has: notFoundTitle })).toContainText(ref.path);
  });

  test("a preview that fails another way (500, 413) is a neutral chip with its own copy, and still opens", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const { broken, huge } = await pickImages(request, backend, ["broken", "huge"]);
    const title = `attachment-chip-variants ${randomUUID()}`;
    await createTaskWithRef(request, backend, title, [broken!, huge!]);
    // The core can't produce these for a 1x1 PNG, so the answers are faked at
    // the network boundary; the chip's handling of them is what's under test.
    await stubPreviewStatus(page, (p) => p === broken!.path, 500);
    await stubPreviewStatus(page, (p) => p === huge!.path, 413);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const chips = bubbleChip(panel);
    await expect(chips).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });
    const errorChip = chips.filter({ hasText: path.basename(broken!.path) });
    const bigChip = chips.filter({ hasText: path.basename(huge!.path) });

    await expect(errorChip).toHaveAttribute("data-preview-state", "error", { timeout: CONVERGE_TIMEOUT });
    await expect(errorChip).toHaveAttribute("title", `Preview unavailable. Click to open.\n${broken!.path}`);
    expect(await errorChip.getAttribute("class")).not.toContain("border-warning");

    await expect(bigChip).toHaveAttribute("data-preview-state", "too-large", { timeout: CONVERGE_TIMEOUT });
    await expect(bigChip).toHaveAttribute("title", `Too large to preview. Click to open.\n${huge!.path}`);
    expect(await bigChip.getAttribute("class")).not.toContain("border-warning");

    // Neither claims the file is gone: a click goes to /open-path.
    const openRequest = page.waitForRequest((r) => r.url().includes("/open-path"), { timeout: CONVERGE_TIMEOUT });
    await errorChip.click();
    await openRequest;
    await expect(page.locator("#attachment-open-error-title")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(page.locator("#attachment-not-found-title")).toHaveCount(0);
  });

  test("a blocked chip whose /open-path proves the file gone turns amber, and closing the dialog lets it retry", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const ref = await pickImage(request, backend, "opened-gone", { blockBeforePick: true });
    const title = `attachment-chip-opened-gone ${randomUUID()}`;
    try {
      await createTaskWithRef(request, backend, title, ref);
      // The headless backend answers /open-path with 501; a desktop core
      // answers 404 for a path that vanished. Fake that 404.
      let openCalls = 0;
      await page.route(
        (url) => url.pathname === "/open-path",
        async (route) => {
          if (route.request().method() === "OPTIONS") {
            await route.fulfill({ status: 204, headers: CORS });
            return;
          }
          openCalls++;
          await route.fulfill({
            status: 404,
            headers: { ...CORS, "content-type": "application/json" },
            body: JSON.stringify({ error: `not found: ${ref.path}` }),
          });
        },
      );
      await gotoApp(page, backend.bootBase);
      const panel = await openTask(page, title);
      const chip = bubbleChip(panel);
      await expect(chip).toHaveAttribute("data-preview-state", "denied", { timeout: CONVERGE_TIMEOUT });

      await chip.click();
      const notFoundTitle = page.locator("#attachment-not-found-title");
      await expect(notFoundTitle).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await expect(page.getByRole("dialog").filter({ has: notFoundTitle })).toContainText(ref.path);
      await expect(page.locator("#attachment-open-error-title")).toHaveCount(0);
      await expect(chip).toHaveAttribute("data-preview-state", "missing");
      expect(await chip.getAttribute("class")).toContain("border-warning");
      expect(openCalls).toBe(1);

      // Closing the dialog forgets the "missing" mark: the chip goes back to
      // its honest blocked state, and a later click asks the core again.
      await page.getByRole("dialog").filter({ has: notFoundTitle }).getByRole("button", { name: "Close", exact: true }).click();
      await expect(notFoundTitle).toHaveCount(0);
      await expect(chip).toHaveAttribute("data-preview-state", "denied", { timeout: CONVERGE_TIMEOUT });
      await chip.click();
      await expect.poll(() => openCalls, { timeout: CONVERGE_TIMEOUT }).toBe(2);
    } finally {
      chmodSync(ref.path, 0o600);
    }
  });

  test("a picked image that is blocked later still shows its thumbnail, from the pick-time twin", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const ref = await pickImage(request, backend, "twin");
    const title = `attachment-chip-twin ${randomUUID()}`;
    chmodSync(ref.path, 0o000); // the twin was written at pick time, before this
    try {
      await createTaskWithRef(request, backend, title, ref);
      await gotoApp(page, backend.bootBase);
      const panel = await openTask(page, title);

      const chip = bubbleChip(panel);
      await expect(chip).toHaveAttribute("data-preview-state", "ok", { timeout: CONVERGE_TIMEOUT });
      const img = chip.locator("img");
      await expect(img).toHaveCount(1);
      await expect
        .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: CONVERGE_TIMEOUT })
        .toBeGreaterThan(0);
    } finally {
      chmodSync(ref.path, 0o600);
    }
  });
});
