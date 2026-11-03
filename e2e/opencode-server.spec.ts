import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the OpenCode v2 SERVER driver (docs/plans/opencode-server-
 * driver.md §1 criteria 1, 3, 4, 7; §5 e2e). Unlike e2e/opencode-harness.spec.ts
 * (which sets `AGETOR_OPENCODE_DRIVER=fake` and so always takes the legacy
 * `opencode run` transport), these tests leave that variable unset: the core
 * talks HTTP + SSE to a fake `opencode serve` (src/bun/fixtures/opencode/
 * fake-serve.ts), reached through the stand-in binary stub-opencode.sh and
 * hosted as a direct child (`AGETOR_OPENCODE_SERVER_HOST=direct`, no tmux).
 *
 * Every test gets its own backend (`freshBackend` + `backendEnv`), because the
 * worker-shared `backend` is pinned to the fake `run` transport. The scenario
 * is picked by a marker in the prompt text (see the fake-serve.ts header).
 *
 * - (a) a v2 task runs to Review with an assistant reply;
 * - (b) steer: a follow-up sent mid-turn lands in the SAME run;
 * - (c) Ask mode permission card: Allow once / Reject with reason / Reject empty;
 * - (d) question card: pick an option / Skip with a reason / Skip empty;
 * - (e) Stop interrupts a running turn.
 */

/** Literal copies of the fake server's markers (specs can't import src/bun/*). */
const MARK = {
  steer: "__agetor_fake_oc_steer__",
  permission: "__agetor_fake_oc_permission__",
  question: "__agetor_fake_oc_question__",
  slow: "__agetor_fake_oc_slow__",
} as const;

/** Server-side progress waits get headroom: the e2e machine is often loaded. */
const CONVERGE_TIMEOUT = 45_000;

const STUB_OPENCODE = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "bun", "fixtures", "opencode", "stub-opencode.sh");

/** `AGETOR_OPENCODE_DRIVER` is blank (the code only matches the literal
 *  "fake"), which is how a spec switches off the fixture's default. */
function serverEnv(speed: string): Record<string, string> {
  return {
    AGETOR_OPENCODE_DRIVER: "",
    AGETOR_OPENCODE_BIN: STUB_OPENCODE,
    AGETOR_OPENCODE_SERVER_HOST: "direct",
    // The e2e backend does not run under NODE_ENV=test; the manager honors
    // the direct host only under it or with this flag (opencode-server.ts).
    AGETOR_E2E_OPENCODE_DIRECT_HOST: "1",
    FAKE_OC_SPEED: speed,
    // One heartbeat is plenty; keeps a quiet stream from looking dead.
    FAKE_OC_HEARTBEAT_MS: "2000",
  };
}

const suffix = randomUUID().slice(0, 8);

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function api<T = any>(backend: E2EBackend, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${backend.apiBase}${url}`, {
    method,
    headers: { ...auth(backend), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json().catch(() => ({}))) as T;
}

async function enableOpencode(backend: E2EBackend): Promise<void> {
  await api(backend, "PATCH", "/harnesses/opencode", { enabled: true });
}

async function registerProject(backend: E2EBackend, name: string): Promise<string> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  await api(backend, "POST", "/projects", { path: dir, name });
  return dir;
}

interface MadeTask {
  id: string;
  title: string;
}

async function createTask(
  backend: E2EBackend,
  title: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<MadeTask> {
  const workdir = await registerProject(backend, `opencode-server-${title}`);
  const task = await api<{ id: string }>(backend, "POST", "/tasks", {
    title,
    prompt,
    agent: "opencode",
    workdir,
    isolation: "none",
    ...extra,
  });
  return { id: task.id, title };
}

async function startTask(backend: E2EBackend, id: string): Promise<void> {
  await api(backend, "POST", `/tasks/${id}/start`);
}

const getTask = (backend: E2EBackend, id: string) => api<Record<string, any>>(backend, "GET", `/tasks/${id}`);
const getRuns = (backend: E2EBackend, id: string) => api<Array<Record<string, any>>>(backend, "GET", `/tasks/${id}/runs`);

async function waitForColumn(backend: E2EBackend, id: string, column: string): Promise<void> {
  await expect
    .poll(async () => (await getTask(backend, id)).column, { timeout: CONVERGE_TIMEOUT, message: `task column -> ${column}` })
    .toBe(column);
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, backend: E2EBackend, title: string): Promise<Locator> {
  await gotoApp(page, backend.bootBase);
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea").first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(panel.getByTestId("transcript-loading")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
  return panel;
}

/** Types a follow-up into the run panel's composer and sends it. */
async function sendFollowUp(panel: Locator, text: string): Promise<void> {
  const textarea = panel.getByTestId("send-textarea");
  await expect(textarea).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await textarea.fill(text);
  const send = panel.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await send.click();
}

test.describe("OpenCode v2 server driver (fake opencode serve)", () => {
  test.describe("default pace", () => {
    test.use({ backendEnv: serverEnv("0.05") });

    test("(a) a v2 task runs on the server transport to Review with an assistant reply", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-basic ${suffix}`;
      const prompt = `hello server ${suffix}`;
      const task = await createTask(backend, title, prompt);
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      await expect(panel.getByText(`ACK: ${prompt}`, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await waitForColumn(backend, task.id, "review");

      const runs = await getRuns(backend, task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("succeeded");
      // The fake driver mints ids starting `ses_fake`; the fake server's start
      // with `ses_` + other characters. Either way the id is the server's.
      expect(String(runs[0]!.opencodeSessionId)).toMatch(/^ses_/);
      expect(String(runs[0]!.opencodeSessionId)).not.toMatch(/^ses_fake/);
    });

    test("(c) Ask mode: Allow once runs the tool and the turn completes", async ({ page, freshBackend: backend }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-allow ${suffix}`;
      const task = await createTask(backend, title, `${MARK.permission} run echo hi`, { mode: "ask" });
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      const card = panel.getByTestId("permission-card");
      await expect(card).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      await expect(card).toHaveAttribute("data-harness", "opencode");
      await expect(card).toContainText("OpenCode is requesting permission");
      await expect(card.getByTestId("permission-option-reject")).toBeVisible();
      await expect(card.getByTestId("permission-option-always")).toBeVisible();

      await card.getByTestId("permission-option-once").click();
      await expect(panel.getByText("The command ran: hi", { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await expect(panel.getByTestId("permission-card")).toHaveCount(0);
      await waitForColumn(backend, task.id, "review");
      expect((await getRuns(backend, task.id))[0]!.status).toBe("succeeded");
    });

    test("(c) Ask mode: Reject with a typed reason blocks Allow and the turn continues to Review", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-reject-reason ${suffix}`;
      const task = await createTask(backend, title, `${MARK.permission} run echo hi`, { mode: "ask" });
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      const card = panel.getByTestId("permission-card");
      await expect(card).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      const once = card.getByTestId("permission-option-once");
      const always = card.getByTestId("permission-option-always");
      await expect(once).toBeEnabled();
      await expect(always).toBeEnabled();
      await expect(card.getByTestId("permission-reason-hint")).toHaveCount(0);

      const reason = `not now ${suffix}`;
      await card.getByTestId("permission-reason").fill(reason);
      // A typed reason can only go with Reject: both Allow buttons lock.
      await expect(card.getByTestId("permission-reason-hint")).toBeVisible();
      await expect(once).toBeDisabled();
      await expect(always).toBeDisabled();
      await expect(card.getByTestId("permission-option-reject")).toBeEnabled();

      await card.getByTestId("permission-option-reject").click();
      await expect(panel.getByText(`The command was rejected: ${reason}`, { exact: true })).toBeVisible({
        timeout: CONVERGE_TIMEOUT,
      });
      await waitForColumn(backend, task.id, "review");
      expect((await getRuns(backend, task.id))[0]!.status).toBe("succeeded");
    });

    test("(c) Ask mode: an empty Reject skips the action and the turn continues to Review", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-reject-empty ${suffix}`;
      const task = await createTask(backend, title, `${MARK.permission} run echo hi`, { mode: "ask" });
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      const card = panel.getByTestId("permission-card");
      await expect(card).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      await expect(card).toContainText("Leave empty to skip this action");
      await card.getByTestId("permission-option-reject").click();

      // The driver sends OpenCode a single space (no words of its own), so the fake
      // takes it as a reason: the tool is refused and the model answers with the
      // rejection. The turn is not stopped.
      await expect(panel.getByText(/The command was rejected:/)).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await expect(panel.getByTestId("permission-card")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
      await waitForColumn(backend, task.id, "review");
      const runs = await getRuns(backend, task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("succeeded");
    });

    test("(d) question card: picking an option answers it and the reply names the pick", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-question ${suffix}`;
      const task = await createTask(backend, title, `${MARK.question} ask me something`);
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      const card = panel.getByTestId("ask-questions-card");
      await expect(card).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      await expect(card).toContainText("Which color do you pick?");
      await expect(card.getByTestId("ask-questions-custom-0")).toBeVisible();

      await card.getByText("Blue", { exact: true }).click();
      await card.getByRole("button", { name: "Review answers →" }).click();
      await card.getByRole("button", { name: "Submit answers" }).click();

      await expect(panel.getByText("You picked Blue.", { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await expect(panel.getByTestId("ask-questions-card")).toHaveCount(0);
      await waitForColumn(backend, task.id, "review");
      expect((await getRuns(backend, task.id))[0]!.status).toBe("succeeded");
    });

    test("(d) question card: Skip with a typed reason lets the turn continue", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-skip-reason ${suffix}`;
      const task = await createTask(backend, title, `${MARK.question} ask me something`);
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      const card = panel.getByTestId("ask-questions-card");
      await expect(card).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      const reason = `skip this ${suffix}`;
      await card.getByTestId("ask-questions-skip-reason").fill(reason);
      await card.getByTestId("ask-questions-skip").click();

      await expect(panel.getByText(`The question was declined: ${reason}`, { exact: true })).toBeVisible({
        timeout: CONVERGE_TIMEOUT,
      });
      await waitForColumn(backend, task.id, "review");
      expect((await getRuns(backend, task.id))[0]!.status).toBe("succeeded");
    });

    test("(d) question card: Skip with an empty reason sends an empty answer and the turn continues to Review", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-skip-empty ${suffix}`;
      const task = await createTask(backend, title, `${MARK.question} ask me something`);
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      const card = panel.getByTestId("ask-questions-card");
      await expect(card).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
      await card.getByTestId("ask-questions-skip").click();

      // An empty Skip is a form reply with no answer (not a dismissal): the
      // model carries on and says it got none.
      await expect(panel.getByText("You gave no answer.", { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await expect(panel.getByTestId("ask-questions-card")).toHaveCount(0);
      await waitForColumn(backend, task.id, "review");
      expect((await getRuns(backend, task.id))[0]!.status).toBe("succeeded");
    });

    test("(e) Stop interrupts a running turn: the card goes to Ready and the run is cancelled", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(120_000);
      await enableOpencode(backend);
      const title = `oc-server-stop ${suffix}`;
      const task = await createTask(backend, title, `${MARK.slow} run the long command`);
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      // The shell tool never ends on its own: wait until the tool card shows
      // so the interrupt lands mid-tool.
      await expect(panel.getByRole("button", { name: /shell/ }).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      expect((await getTask(backend, task.id)).column).toBe("running");

      await panel.getByRole("button", { name: "Stop", exact: true }).click();
      await waitForColumn(backend, task.id, "ready");
      await expect
        .poll(async () => (await getRuns(backend, task.id))[0]?.status, { timeout: CONVERGE_TIMEOUT })
        .toBe("cancelled");
      expect(await getRuns(backend, task.id)).toHaveLength(1);
      await expect(panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
    });
  });

  test.describe("slow pace (steer window)", () => {
    // The steer scenario's tool step lasts 1.5 s x FAKE_OC_SPEED: 6 s here, so
    // the UI round trip of a follow-up reliably lands inside it.
    test.use({ backendEnv: serverEnv("4") });

    test("(b) steer: a follow-up sent mid-turn lands in the SAME run and the reply answers it", async ({
      page,
      freshBackend: backend,
    }) => {
      test.setTimeout(150_000);
      await enableOpencode(backend);
      const title = `oc-server-steer ${suffix}`;
      const task = await createTask(backend, title, `${MARK.steer} run the long command`);
      await startTask(backend, task.id);

      const panel = await openTask(page, backend, title);
      // The turn is in its long step once the shell card shows.
      await expect(panel.getByRole("button", { name: /shell/ }).first()).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      expect((await getTask(backend, task.id)).column).toBe("running");

      const steer = `also mention pineapple ${suffix}`;
      await sendFollowUp(panel, steer);

      // The steer is a user bubble in the running transcript...
      await expect(panel.getByText(steer, { exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      // ...and the model's final reply carries it (the fake appends delivered
      // steers as `[steer: <text>]`).
      await expect(panel.getByText(new RegExp(`^Done\\. \\[steer: .*${steer}.*\\]$`))).toBeVisible({
        timeout: CONVERGE_TIMEOUT,
      });
      await waitForColumn(backend, task.id, "review");

      // Same run: no second run row, and it settled normally.
      const runs = await getRuns(backend, task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("succeeded");
    });
  });
});
