import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";
import { connectPhone, seedDevice, startRemoteWorld } from "./remote-helpers";

/**
 * The run panel's "Phone attached to <task>" banner (docs/architecture/run-panel.md, plan UI2). A configure-level headless phone attaches to a
 * task's REAL tmux session (on a socket private to this spec), the banner appears with the phone's name, Detach removes it, the phone is told,
 * and the tmux session is still alive. Skips loudly without tmux; fails under CI=true.
 */
const TMUX = Bun.which("tmux");
const SOCKET = `agetor-e2e-term-${process.pid}`;
const world = startRemoteWorld({ ...(TMUX ? { AGETOR_TMUX_BIN: TMUX } : {}), AGETOR_TMUX_SOCKET: SOCKET });
const WORKDIR = mkdtempSync(path.join(tmpdir(), "agt-e2e-term-"));
const tmux = (...args: string[]) => spawnSync(TMUX ?? "tmux", ["-L", SOCKET, ...args]);

test.afterAll(() => {
  tmux("kill-server");
  world.close();
  rmSync(WORKDIR, { recursive: true, force: true });
});

test.describe("phone terminal banner", () => {
  test.use({ backendEnv: world.env });

  test("a phone's terminal shows a banner on its task; Detach ends it and the session survives", async ({ page, freshBackend }) => {
    if (!TMUX) {
      if (process.env.CI === "true") throw new Error("tmux is required in CI");
      test.skip(true, "SKIPPED LOUDLY: tmux is not installed, the phone terminal banner was not exercised");
    }
    const created = await page.request.post(`${freshBackend.apiBase}/tasks`, {
      headers: { authorization: `Bearer ${freshBackend.apiToken}` },
      data: { title: "Banner task", prompt: "p", agent: "claude-code", workdir: WORKDIR, isolation: "none" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const taskId = ((await created.json()) as { id: string }).id;
    const session = `agetor-${taskId.slice(0, 12)}`;
    expect(tmux("new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat").status).toBe(0);

    const dev = seedDevice(world, freshBackend, { name: "Ana's iPhone", level: "configure" });
    await expect.poll(() => world.relay.mailboxes().some((m) => m.core), { timeout: 30_000 }).toBe(true);
    await connectPhone(world, dev);

    await gotoApp(page, freshBackend.bootBase);
    await page.getByText("Banner task", { exact: true }).first().click();
    const panel = page.locator("aside").last();
    await expect(panel.locator("textarea")).toBeVisible();
    await expect(panel.getByTestId("phone-attached-banner")).toHaveCount(0);

    await dev.phone.terminal.attach(taskId, session);
    await dev.phone.next("terminal-attached");
    const banner = panel.getByTestId("phone-attached-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("Phone attached to");
    await expect(banner).toContainText("Banner task");
    await expect(banner.getByTestId("phone-attached-device")).toHaveText("Ana's iPhone");

    await banner.getByTestId("phone-attached-detach").click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    expect(await dev.phone.next<{ reason: string }>("terminal-closed")).toMatchObject({ reason: "mac-detach" });
    expect(tmux("has-session", "-t", `=${session}`).status).toBe(0);
  });
});
