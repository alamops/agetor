// The board card, rendered to static markup inside a DndContext. Geometry is
// proven separately by e2e/task-card-bounds.spec.ts; this pins the markup
// contract: roles and labels, the hooks e2e relies on, no fixed-width slot
// beside variable text, and the per-state action rows.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DndContext } from "@dnd-kit/core";
import { TaskCard } from "./TaskCard.tsx";
import { newStep } from "../../../shared/pipeline.ts";
import type { PipelineRunState, Task } from "../../../shared/types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Fix login redirect",
    prompt: "# Spec\n\nThe login page loops after sign-in.",
    column: "backlog",
    agent: "claude-code",
    workdir: "/Users/me/Projects/acme/web-dashboard",
    isolation: "worktree",
    taskType: "task",
    branch: "agetor/1f2e3d4c-fix-login",
    branchSource: "created",
    worktreePath: null,
    baseRef: "a1b2c3d4e5f6",
    prUrl: null,
    mode: "auto",
    model: "opus-5.5",
    effort: null,
    speed: "off",
    opencodeServer: "shared",
    maxMode: false,
    references: [],
    backlog: [],
    draft: null,
    plans: [],
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...over,
  };
}

const noop = () => {};
function html(task: Task, extra: Partial<Parameters<typeof TaskCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <DndContext>
      <TaskCard
        task={task}
        homeDir="/Users/me"
        onStart={noop}
        onCancel={noop}
        onOpen={noop}
        onOpenAttention={noop}
        onReviewPipeline={noop}
        onMarkDone={noop}
        onContextMenu={noop}
        {...extra}
      />
    </DndContext>,
  );
}

const steps = [newStep({ id: "s1", name: "Plan" }), newStep({ id: "s2", name: "Implement" })];
function pipelineRun(over: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "p1",
    pipelineName: "My Implementation Pipeline",
    snapshot: { graph: { steps, edges: [], startStepId: "s1" }, maxSteps: 25, profiles: {}, capturedAt: 0 },
    status: "running",
    active: [{ stepId: "s2", taskId: "t2", seq: 2 }],
    joins: {},
    blocked: [],
    history: [
      { seq: 1, stepId: "s1", taskId: "t1", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: null, nextStepIds: [] },
      { seq: 2, stepId: "s2", taskId: "t2", startedAt: 1, endedAt: null, outcome: null, handoff: null, nextStepIds: [] },
    ],
    stepCount: 2,
    startedAt: 0,
    endedAt: null,
    ...over,
  };
}
const buttonCount = (m: string) => (m.match(/<button\b/g) ?? []).length;

describe("TaskCard markup", () => {
  test("the root is a labelled group with a focus outline, not a button", () => {
    const m = html(makeTask());
    expect(m).toContain('role="group"');
    expect(m).toContain('aria-label="Fix login redirect"');
    expect(m).toContain('tabindex="0"');
    expect(m).toContain("focus-visible:outline");
    expect(m).toContain("cursor-grab");
    expect(m).toContain('data-task-id="task-1"');
    expect(m).not.toContain('role="button"');
  });

  test("the pipeline card renders the hat and no profile or harness name", () => {
    const m = html(makeTask({ pipelineId: "p1", pipelineRun: pipelineRun(), agentProfile: undefined }));
    expect(m).toContain('data-testid="task-card-pipeline"');
    expect(m).toContain("My Implementation Pipeline");
    expect(m).not.toContain("task-card-agent-profile");
    expect(m).not.toContain(">claude-code<");
  });

  test("a saved profile shows its name with the harness as the tooltip", () => {
    const m = html(makeTask({ agentProfile: { name: "Helper", harnessKind: "cursor" } as Task["agentProfile"] }));
    expect(m).toContain('data-testid="task-card-agent-profile"');
    expect(m).toContain(">Helper<");
    expect(m).toContain('title="claude-code"');
  });

  test("the preview is the plain first paragraph, and no <p> renders when it is empty", () => {
    expect(html(makeTask())).toContain(">The login page loops after sign-in.</p>");
    expect(html(makeTask())).not.toContain("# Spec");
    expect(html(makeTask({ prompt: "   " }))).not.toContain("line-clamp-2");
  });

  test("no fixed-width slot around variable text", () => {
    const m = html(makeTask({
      pipelineId: "p1",
      pipelineRun: pipelineRun(),
      model: "opencode-go/deepseek-v4.1-flash",
      branchSource: "existing",
      checkoutBranch: "other",
    }));
    // The pipeline name, the title and the identity text must be free to wrap/truncate.
    const withShrink0 = [...m.matchAll(/<(\w+)[^>]*class="([^"]*\bshrink-0\b[^"]*)"[^>]*>([^<]*)</g)];
    for (const [, tag, cls, text] of withShrink0) {
      if (tag === "svg") continue;
      // Allowed: the separator dot, the progress count, a short count/chip, the branch-drift chip, the repo name (bounded by max-w-[45%]), buttons and ⋯.
      expect(text!.length <= 16 || cls!.includes("max-w-[45%]") || tag === "button").toBe(true);
    }
    expect(m).not.toMatch(/data-testid="task-card-agent-profile"[^>]*shrink-0/);
  });

  test("⋯ is a labelled menu button whose aria-expanded follows menuOpen", () => {
    const closed = html(makeTask());
    expect(closed).toContain('aria-label="More actions"');
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('data-testid="task-card-more"');
    expect(html(makeTask(), { menuOpen: true })).toContain('aria-expanded="true"');
  });

  test("no ⋯ without a menu handler", () => {
    expect(html(makeTask(), { onContextMenu: undefined })).not.toContain("task-card-more");
  });

  test("no literal palette or shared-destructive classes on the card", () => {
    const states = [
      makeTask(),
      makeTask({ column: "running" }),
      makeTask({ column: "blocked", pendingInteractionCount: 12 }),
      makeTask({ column: "review", pipelineId: "p1", pipelineRun: pipelineRun({ status: "review", humanSteps: [{ stepId: "s2", seq: 3, startedAt: 2, arrivals: [] }] }) }),
    ];
    for (const t of states) {
      const m = html(t);
      expect(m).not.toMatch(/amber-|bg-destructive|text-destructive/);
    }
  });
});

describe("TaskCard actions", () => {
  test("backlog: Run and ⋯", () => {
    const m = html(makeTask());
    expect(m).toContain("Run");
    expect(buttonCount(m)).toBe(2);
  });

  test("running: Stop on --danger", () => {
    const m = html(makeTask({ column: "running" }));
    expect(m).toContain("Stop");
    expect(m).toContain("bg-danger text-danger-foreground");
  });

  test("awaiting: Answer (N) on --warning-solid and no extra Stop icon", () => {
    const m = html(makeTask({ column: "running", pendingInteractionCount: 12 }));
    expect(m).toContain("Answer (12)");
    expect(m).toContain("bg-warning-solid text-warning-solid-foreground");
    expect(m).not.toContain(">Stop<");
    expect(buttonCount(m)).toBe(2);
  });

  test("gate pending: Review and Open, no Stop, no Done", () => {
    const m = html(makeTask({
      column: "review",
      pipelineId: "p1",
      pipelineRun: pipelineRun({ status: "review", active: [], humanSteps: [{ stepId: "s2", seq: 3, startedAt: 2, arrivals: [] }] }),
    }));
    expect(m).toContain('data-testid="task-card-pipeline-review"');
    expect(m).toContain("Open");
    expect(m).not.toContain("Stop");
    expect(m).not.toContain(">Done<");
    expect(m).not.toContain("task-card-pipeline-stop");
  });

  test("review: Open and a transparent Done", () => {
    const m = html(makeTask({ column: "review", hasOpenableRun: true }));
    expect(m).toContain("Done");
    expect(m).toContain("bg-transparent");
  });

  test("archived: exactly one button besides ⋯, and the card is dimmed", () => {
    const m = html(makeTask({ column: "done", archivedAt: 5, hasOpenableRun: true }));
    expect(buttonCount(m)).toBe(2);
    expect(m).toContain("opacity-60");
    expect(m).toContain("cursor-default");
  });

  test("the awaiting card keeps the shared ring and glow", () => {
    const m = html(makeTask({ column: "blocked" }));
    expect(m).toContain("ring-warning/60");
    expect(m).toContain("animate-awaiting-pulse");
  });
});

describe("TaskCard hooks e2e relies on", () => {
  test("status stats keep their titles and test ids", () => {
    const m = html(makeTask({
      runningSubagents: 3,
      openTerminalCount: 2,
      todoProgress: { completed: 7, total: 12 },
      sentFiles: [{ path: "/a/b.md", sentAt: 1 }] as Task["sentFiles"],
    }));
    expect(m).toContain('title="3 background tasks running"');
    expect(m).toContain('title="2 open terminals"');
    expect(m).toContain('title="7 of 12 tasks done"');
    expect(m).toContain(">7/12<");
    expect(m).toContain('data-testid="sent-files-badge"');
  });

  test("multi-repository, drift chip and the unread dot", () => {
    const multi = html(makeTask({
      repositories: [
        { name: "api", path: "/p/api", worktreePath: "/w/api" },
        { name: "web", path: "/p/web", worktreePath: "/w/web" },
      ] as Task["repositories"],
      multiRepo: true,
    }));
    expect(multi).toContain('data-testid="task-card-repositories"');
    const drift = html(makeTask({ checkoutBranch: "other", branchSource: "existing", unread: true }));
    expect(drift).toContain('data-testid="task-card-branch-drift"');
    expect(drift).toContain("not on PR head");
    expect(drift).toContain("data-card-overlay");
    expect(html(makeTask({ unread: true }), { isOpen: true })).not.toContain("data-card-overlay");
  });
});
