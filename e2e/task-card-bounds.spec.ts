import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";
import { checkBoardCards, type CardCheckResult } from "./card-checks";
import { newStep } from "../src/shared/pipeline.ts";
import type { PipelineRunState, PipelineStepRecord, Task } from "../src/shared/types.ts";

/**
 * Guardrail for the kanban `TaskCard` (layout C1, docs/architecture/task-card.md):
 * every child of every card stays inside the card, in every state, in light and
 * dark, in Chromium and WebKit (the `webkit` project, playwright.config.ts).
 *
 * It drives the REAL board. Each state is a real task created over the API
 * (`isolation: "none"`, a temp dir: no git, no worktree, no agent), and the
 * board's `GET /tasks` response is merged with fixture fields for the
 * server-managed state a fake run would otherwise need: pipeline run, counts,
 * stack state, pending interactions, unread, archive. The producers of those
 * fields have their own specs (todo-progress, sent-files, fx-recovery,
 * pipelines-run, harness-stack-swap, unread-indicator).
 *
 * The strings are the worst cases from the design gate: a 128-character title,
 * a 25-character profile name, a 31-character model id, a 26- and a
 * 68-character pipeline name, a 60-character step name. They are synthetic.
 *
 * Checks live in `./card-checks.ts` (bounds, row spill, sibling overlap,
 * squeezed text, uncut hat and title, 24x24 targets, aria-labels, nested
 * buttons, contrast >= 4.5:1). Each state is screenshotted to
 * `test-results/task-card-bounds/<browser>-<theme>-<state>.png` and attached.
 */

test.describe.configure({ mode: "serial" });

const LONG_TITLE =
  "Refactor src/mainview/components/kanban/TaskCard.tsx so the pipeline hat, chips and action row never overflow the narrow card".slice(0, 128);
const PROFILE_25 = "Exemplars Helper (Cursor)";
const MODEL_LONG = "opencode-go/deepseek-v4.1-flash";
const PIPE_26 = "My Implementation Pipeline";
const PIPE_LONG = "Implementation Pipeline With A Very Long Descriptive Name (No Video)";
const STEP_60 = "Code Review against the investigation brief and grill record";
const WORKDIR = "/Users/me/Projects/acme";

const STEPS = Array.from({ length: 10 }, (_, i) => newStep({ id: `s${i + 1}`, name: i === 2 ? "Implementing" : i === 5 ? STEP_60 : `Step ${i + 1}` }));
const rec = (seq: number, stepId: string, outcome: PipelineStepRecord["outcome"] = "succeeded", taskId: string | null = `t${seq}`): PipelineStepRecord => ({
  seq, stepId, taskId, startedAt: seq, endedAt: outcome ? seq + 1 : null, outcome, handoff: null, nextStepIds: [],
});
function run(over: Partial<PipelineRunState>): PipelineRunState {
  return {
    pipelineId: "pipe-1",
    pipelineName: PIPE_26,
    snapshot: { graph: { steps: STEPS, edges: [], startStepId: "s1" }, maxSteps: 25, profiles: {}, capturedAt: 1 },
    status: "running",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: 0,
    endedAt: null,
    ...over,
  };
}
const LOOP_IDS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s6", "s6", "s9"];
const loopHistory = () => LOOP_IDS.map((id, i) => rec(i + 1, id));

const ALL_COUNTS: Partial<Task> = {
  runningSubagents: 3,
  openTerminalCount: 2,
  todoProgress: { completed: 7, total: 12 },
  sentFiles: ["/tmp/a/report.md", "/tmp/a/notes.md", "/tmp/b.png", "/tmp/c.txt"].map((p, i) => ({
    path: p, size: 1, mediaType: null, isImage: false, sentAt: i + 1, runId: "r1",
  })),
  fxRecovery: { state: "paused", runId: "r1", pausedAt: 1, autoResume: { at: Date.now() + 5 * 60_000, attempt: 1, max: 3, delaySec: 300 }, autoResumeCount: 0 } as Task["fxRecovery"],
};
const STACK = (over: Record<string, unknown> = {}) => ({
  harnessState: { stackId: "stack-x", position: 0, count: 2, tried: [], pendingSwap: null, allExhausted: null, lastMove: null, ...over } as unknown as Task["harnessState"],
});
const PROFILE = { id: "p", name: PROFILE_25, harness: "claude-code", harnessKind: "cursor", harnessLabel: "Cursor", model: MODEL_LONG, effort: null, mode: "auto" } as unknown as Task["agentProfile"];

/** One entry per state: the title it is seeded under, and the fields merged
 *  into the `GET /tasks` row. */
const STATES: { key: string; patch: Partial<Task> }[] = [
  { key: "backlog", patch: { title: "Fix login redirect loop", prompt: "The login page sends the user back to itself after a successful sign-in when the session cookie is set on a subdomain.", model: "opus-5.5", mode: "auto", workdir: `${WORKDIR}/web-dashboard`, branch: null, baseRef: "a1b2c3d4" } },
  { key: "ready-worst", patch: { title: LONG_TITLE, taskType: "bug", column: "ready", agentProfile: PROFILE, model: MODEL_LONG, mode: "auto", ...ALL_COUNTS, ...STACK(), workdir: `${WORKDIR}/agetor-companion-mobile-app`, branch: "agetor/1f2e3d4c-refactor-taskcard-so-the-pipeline-hat-chips", checkoutBranch: "main", branchSource: "existing", baseRef: "a1b2c3d4", prompt: "Every child of the card must stay inside the card box in every state, with the longest names we have seen in a real database." } },
  { key: "running", patch: { title: "Spike: can WKWebView lay out the card like Chromium?", taskType: "spike", column: "running", runId: "run-1", hasOpenableRun: true, model: "opus-5.5", mode: "auto", runningSubagents: 3, todoProgress: { completed: 7, total: 12 }, ...STACK({ scheduledSwitch: { requestedAt: 1 }, count: 1 }), workdir: `${WORKDIR}/agetor`, branch: "agetor/9a8b7c6d-spike-wkwebview-layout", baseRef: "a1b2c3d4" } },
  { key: "awaiting", patch: { title: LONG_TITLE, column: "running", pendingInteractionCount: 12, unread: true, agentProfile: PROFILE, model: MODEL_LONG, mode: "auto", ...ALL_COUNTS, ...STACK({ position: 1 }), workdir: `${WORKDIR}/agetor`, branch: "fix/agetor-card-ui-improvement", baseRef: "a1b2c3d4", prompt: "The agent asked twelve questions about the layout contract and is waiting for your answers before it continues." } },
  { key: "review", patch: { title: "Add keyboard dragging between board columns", column: "review", hasOpenableRun: true, runId: "run-2", model: "gpt-6-codex", mode: "auto", workdir: `${WORKDIR}/agetor`, branch: "feature/keyboard-drag-between-columns", checkoutBranch: "other-branch", baseRef: "a1b2c3d4", prompt: "Space picks the card up, the arrow keys move it to the next column, and Escape puts it back." } },
  { key: "done", patch: { title: "Dark-mode Done button looks like a hole", taskType: "bug", column: "done", hasOpenableRun: true, runId: "run-3", model: "sonnet-5.5", mode: "plan", workdir: `${WORKDIR}/agetor`, branch: "fix/done-button-dark", baseRef: "a1b2c3d4" } },
  { key: "archived", patch: { title: "Old experiment with a wider board column", column: "done", archivedAt: 1_700_000_000_000, hasOpenableRun: true, runId: "run-4", workdir: `${WORKDIR}/agetor`, branch: "spike/wider-columns", baseRef: "a1b2c3d4" } },
  { key: "multi-repo", patch: { title: "Rename the shared task type across the API, web and mobile apps", multiRepo: true, repositories: [{ path: "/p/api-gateway", name: "api-gateway", branch: "b", branchSource: "created", worktreePath: "/w/api-gateway", baseRef: null, checkoutBranch: null, prUrl: null }, { path: "/p/web-dashboard", name: "web-dashboard", branch: "b", branchSource: "created", worktreePath: "/w/web-dashboard", baseRef: null, checkoutBranch: null, prUrl: null }, { path: "/p/mobile-companion", name: "mobile-companion", branch: "b", branchSource: "created", worktreePath: "/w/mobile-companion", baseRef: null, checkoutBranch: null, prUrl: null }], model: "opus-5.5", mode: "auto" } },
  { key: "screenshot-markdown", patch: { title: "Acme Sync - Keep the inbox watched for the whole session", column: "review", hasOpenableRun: true, prompt: "# Spec — keep the inbox watched\n| Field | Value |\n| --- | --- |\n| Owner | me |\n\n```bash\nrm -rf /\n```\n\nAgents miss **peer messages** between turns because nothing watches the [inbox](https://example.com) while idle.", workdir: `${WORKDIR}/acme-sync`, branch: "feature/acme-sync-inbox-session-watch", baseRef: "a1b2c3d4" } },
  { key: "pipe-running", patch: { title: LONG_TITLE, column: "running", unread: true, pipelineId: "pipe-1", pipelineRun: run({ pipelineName: PIPE_LONG, status: "running", history: [rec(1, "s1"), rec(2, "s2"), rec(3, "s3", null)], active: [{ stepId: "s3", taskId: "t3", seq: 3 }] }), model: MODEL_LONG, mode: "auto", ...ALL_COUNTS, ...STACK(), workdir: `${WORKDIR}/agetor`, branch: "fix/agetor-card-ui-improvement", baseRef: "a1b2c3d4", hasOpenableRun: false } },
  { key: "pipe-gate", patch: { title: "Ship the inbox watcher behind a setting", column: "review", pipelineId: "pipe-1", pipelineRun: run({ status: "review", history: [...[1, 2, 3, 4, 5].map((n) => rec(n, `s${n}`)), rec(6, "s6", null, null)], humanSteps: [{ stepId: "s6", seq: 6, startedAt: 6, arrivals: [] }] }), model: "opus-5.5", mode: "auto", ...STACK(), workdir: `${WORKDIR}/acme-sync`, branch: "feature/acme-sync-inbox-session-watch", baseRef: "a1b2c3d4" } },
  { key: "pipe-done", patch: { title: "Acme Sync - Keep the inbox watched for the whole session", column: "review", pipelineId: "pipe-1", pipelineRun: run({ pipelineName: "Zebra Pipeline (No Audio)", status: "done", history: loopHistory() }), model: "opus-5.5", mode: "auto", ...STACK(), workdir: `${WORKDIR}/acme-sync`, branch: "feature/acme-sync-inbox-session-watch", checkoutBranch: "main", baseRef: "a1b2c3d4" } },
  { key: "pipe-blocked", patch: { title: "Bug fix flow for the drag-and-drop regression", taskType: "bug", column: "blocked", pipelineId: "pipe-1", pipelineRun: run({ status: "blocked", history: [rec(1, "s1"), rec(2, "s2"), rec(3, "s3"), rec(4, "s4", null)], active: [{ stepId: "s4", taskId: "t4", seq: 4 }], blocked: [{ taskId: "t4", stepId: "s4", kind: "handoff-missing", message: "Bug Fix ended without a handoff" }] }), model: "opus-5.5", mode: "auto", workdir: `${WORKDIR}/agetor`, branch: "fix/drag-drop-same-column", baseRef: "a1b2c3d4" } },
];

const OUT_DIR = path.join("test-results", "task-card-bounds");

async function seed(request: import("@playwright/test").APIRequestContext, backend: E2EBackend): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const suffix = randomUUID().slice(0, 8);
  for (const s of STATES) {
    const res = await request.post(`${backend.apiBase}/tasks`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      data: { title: `bounds ${s.key} ${suffix}`, prompt: "seed", isolation: "none", workdir: tmpdir(), agent: "claude-code" },
    });
    expect(res.ok(), `POST /tasks (${s.key}) -> ${res.status()}`).toBeTruthy();
    ids.set(((await res.json()) as { id: string }).id, s.key);
  }
  return ids;
}

async function mergeFixtures(page: Page, backend: E2EBackend, byId: Map<string, string>): Promise<void> {
  const patches = new Map(STATES.map((s) => [s.key, s.patch]));
  await page.route(`${backend.apiBase}/tasks`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const rows = (await response.json()) as Task[];
    const merged = rows.map((t) => {
      const key = byId.get(t.id);
      return key ? { ...t, ...patches.get(key) } : t;
    });
    await route.fulfill({ response, json: merged });
  });
}

function report(results: CardCheckResult[], byId: Map<string, string>): string {
  return results
    .filter((r) => r.fails.length > 0)
    .map((r) => `[${r.theme}] ${byId.get(r.taskId) ?? r.taskId}:\n  - ${r.fails.join("\n  - ")}`)
    .join("\n");
}

for (const theme of ["light", "dark"] as const) {
  test(`every card state stays inside its card — ${theme}`, async ({ page, request, backend, browserName }, testInfo) => {
    test.setTimeout(180_000);
    mkdirSync(OUT_DIR, { recursive: true });
    await page.setViewportSize({ width: 1680, height: 1400 });
    const byId = await seed(request, backend);
    await putPreference(request, backend, "theme", theme);
    await mergeFixtures(page, backend, byId);
    await gotoApp(page, backend.bootBase);
    // The board hides archived cards by default.
    await page.getByTitle("Filter by archive state").selectOption("all");
    // No animation or transition while measuring (the awaiting pulse, hover).
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;caret-color:transparent!important}" });

    for (const s of STATES) {
      await expect(page.locator(`[data-task-id="${[...byId].find(([, k]) => k === s.key)![0]}"]`)).toBeVisible({ timeout: 15_000 });
    }
    // Let the fixture-driven rows settle (two polls) before measuring.
    await page.waitForTimeout(2_500);

    // The backend is shared by this file's tests: measure only this test's cards.
    const results = (await page.evaluate(checkBoardCards)).filter((r) => byId.has(r.taskId));
    expect(results.length, "every seeded card was measured").toBe(STATES.length);
    expect(report(results, byId), "card geometry, labels and contrast").toBe("");

    // The pipeline hat names the whole pipeline and never the old 13/10.
    const done = page.locator(`[data-task-id="${[...byId].find(([, k]) => k === "pipe-done")![0]}"]`);
    await expect(done.getByTestId("task-card-pipeline")).toContainText("Zebra Pipeline (No Audio)");
    await expect(done.getByTestId("task-card-pipeline")).toContainText("✓ Done");
    await expect(done.getByTestId("task-card-pipeline")).not.toContainText("13/10");
    // Raw markdown never reaches the preview.
    const md = page.locator(`[data-task-id="${[...byId].find(([, k]) => k === "screenshot-markdown")![0]}"]`);
    await expect(md.locator('[data-part="preview"]')).toHaveText("Agents miss peer messages between turns because nothing watches the inbox while idle.");

    for (const [id, key] of byId) {
      const file = path.join(OUT_DIR, `${browserName}-${theme}-${key}.png`);
      await page.locator(`[data-task-id="${id}"]`).screenshot({ path: file });
      await testInfo.attach(`${browserName}-${theme}-${key}`, { path: file, contentType: "image/png" });
    }
  });
}
