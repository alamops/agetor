import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures";
import { getPreferences, gotoApp, openSettingsGeneral } from "./helpers";
import { plainEncodedProjectPath } from "../src/shared/claude-session-meta.ts";

const home = mkdtempSync(path.join(tmpdir(), "cc-e2e-home-"));
const cwd = path.join(home, "repo");
const liveCwd = path.join(home, "live");
mkdirSync(cwd, { recursive: true });
mkdirSync(liveCwd, { recursive: true });

function plant(sessionId: string, dirCwd: string, body: string): void {
  const encoded = plainEncodedProjectPath(dirCwd);
  expect(encoded.length).toBeLessThanOrEqual(200);
  const dir = path.join(home, ".claude", "projects", encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: "user",
    uuid: `${sessionId}-user`,
    cwd: dirCwd,
    gitBranch: "main",
    timestamp: "2026-10-01T00:00:00.000Z",
    message: { role: "user", content: body },
  }) + "\n" + JSON.stringify({
    type: "assistant",
    uuid: `${sessionId}-assistant`,
    timestamp: "2026-10-01T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  }) + "\n");
}

plant("e2e-idle", cwd, "please fix the login");

const liveDir = path.join(home, ".claude", "projects", plainEncodedProjectPath(liveCwd));
mkdirSync(liveDir, { recursive: true });
writeFileSync(path.join(liveDir, "e2e-live.jsonl"), JSON.stringify({
  type: "user",
  uuid: "e2e-live-user",
  cwd: liveCwd,
  timestamp: "2026-10-01T00:00:00.000Z",
  message: { role: "user", content: "still open" },
}) + "\n");
const procStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
  env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  encoding: "utf8",
}).trim();
mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
writeFileSync(path.join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({
  sessionId: "e2e-live",
  pid: process.pid,
  procStart,
  kind: null,
}));
writeFileSync(path.join(home, "agents.json"), "[]");

test.use({
  backendEnv: {
    HOME: home,
    AGETOR_CLAUDE_AGENTS_JSON: path.join(home, "agents.json"),
    CLAUDE_CONFIG_DIR: "",
  },
});

test("header import lands the session in Review with history and no Run", async ({ page, freshBackend }) => {
  await gotoApp(page, freshBackend.bootBase);
  await page.getByRole("button", { name: "Import Claude Code sessions" }).click();
  const dialog = page.getByTestId("import-claude-sessions-dialog");
  await dialog.getByRole("button", { name: "Re-check" }).click();
  const row = dialog.locator("li", { hasText: "repo" }).first();
  await expect(row.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
  await row.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByText("please fix the login")).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
  const card = page.getByRole("button", { name: /please fix the login/ });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByTestId("run-origin-imported")).toBeVisible();
  await expect(page.getByText("please fix the login").first()).toBeVisible();
});

test("a live registry session cannot be imported", async ({ page, freshBackend }) => {
  await gotoApp(page, freshBackend.bootBase);
  await page.getByRole("button", { name: "Import Claude Code sessions" }).click();
  const dialog = page.getByTestId("import-claude-sessions-dialog");
  await dialog.getByRole("button", { name: "Re-check" }).click();
  const row = dialog.locator("li", { hasText: "live" });
  await expect(row.getByText("Close it in your terminal first")).toBeVisible();
  await expect(row.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("Settings → General turns the launch scan off", async ({ page, freshBackend, request }) => {
  await gotoApp(page, freshBackend.bootBase);
  const dialog = await openSettingsGeneral(page);
  const toggle = dialog.getByTestId("claude-sessions-launch-scan");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(async () => {
    const prefs = await getPreferences(request, freshBackend);
    return prefs["claudeSessions.launchScan"];
  }).toBe("0");
});
