// The board card, rendered to static markup inside a DndContext. Geometry is
// proven separately by e2e/task-card-bounds.spec.ts; this pins the markup
// contract: roles and labels, the hooks e2e relies on, no fixed-width slot
// beside variable text, and the per-state action rows.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DndContext } from "@dnd-kit/core";
import { TaskCard } from "./TaskCard.tsx";
import { TaskCardMeta } from "./TaskCardMeta.tsx";
import { TaskCardIdentity, TaskCardStatus } from "./TaskCardStatus.tsx";
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
/** lucide's class on the Answer button's trailing arrow icon. */
const ARROW = "lucide-arrow-right";

describe("TaskCard markup", () => {
  test("the root is a labelled group with a focus outline, not a button", () => {
    const m = html(makeTask());
    expect(m).toContain('role="group"');
    expect(m).toContain('aria-label="Fix login redirect"');
    expect(m).toContain('tabindex="0"');
    // Whole class tokens: `cn`'s tailwind-merge 3 once dropped the
    // outline-style class beside `outline-2`, and a substring check passed.
    const root = m.match(/<div[^>]*role="group"[^>]*>/)![0];
    const classes = root.match(/class="([^"]*)"/)![1]!.split(/\s+/);
    expect(classes).toContain("focus-visible:[outline-style:solid]");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-ring");
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
    const longModel = "opencode-go/deepseek-v4.1-flash-preview-x";
    const cases = [
      makeTask({ pipelineId: "p1", pipelineRun: pipelineRun(), model: longModel, branchSource: "existing", checkoutBranch: "other" }),
      // A 25-character profile name and a long model: the identity line the
      // overhaul was about only renders its name on a non-pipeline task.
      makeTask({ agentProfile: { name: "Senior Frontend Reviewer!", harnessKind: "claude-code" } as Task["agentProfile"], model: longModel }),
    ];
    for (const task of cases) {
      const m = html(task);
      // The first text inside each shrink-0 element, past any leading child
      // tags, so a wrapper whose text sits in a child span is measured too.
      const withShrink0 = [...m.matchAll(/<(\w+)[^>]*class="([^"]*\bshrink-0\b[^"]*)"[^>]*>(?:<[^>]+>)*([^<]*)/g)];
      for (const [, tag, cls, text] of withShrink0) {
        if (tag === "svg") continue;
        // Allowed: the separator dot, the progress count, a short count/chip, the branch-drift chip, the repo name (bounded by max-w-[45%]), buttons and ⋯.
        expect(text!.length <= 16 || cls!.includes("max-w-[45%]") || tag === "button").toBe(true);
      }
    }
    // In the identity line only its icon may hold its width.
    const identity = html(cases[1]!).match(/<div data-part="identity"[\s\S]*?<\/div>/)![0];
    expect(identity).toContain("Senior Frontend Reviewer!");
    for (const [, tag] of identity.matchAll(/<(\w+)[^>]*class="[^"]*\bshrink-0\b/g)) expect(tag).toBe("svg");
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

  test("awaiting: Answer (N) on --warning-solid, with its trailing arrow, and no extra Stop icon", () => {
    const m = html(makeTask({ column: "running", pendingInteractionCount: 12 }));
    expect(m).toContain("Answer (12)");
    expect(m).toContain("bg-warning-solid text-warning-solid-foreground");
    // Alone in the row, Answer keeps the arrow that says "go answer it".
    expect(m).toContain(ARROW);
    expect(m).not.toContain(">Stop<");
    expect(buttonCount(m)).toBe(2);
  });

  // Answer (12) + Done + `⋯` overflow the 233 px row by 8 px with the arrow
  // (e2e/task-card-bounds.spec.ts "awaiting-review"), so the arrow drops
  // whenever Answer shares the row.
  test("awaiting in Review: Answer (12) and Done share the row, so Answer drops its arrow", () => {
    const m = html(makeTask({ column: "review", pendingInteractionCount: 12, hasOpenableRun: true }));
    expect(m).toContain("Answer (12)</button>");
    expect(m).toContain("> Done</button>");
    expect(m).not.toContain(ARROW);
    expect(buttonCount(m)).toBe(3);
  });

  test("a pipeline awaiting in Review has no Done until its run is done, so Answer keeps its arrow", () => {
    const m = html(makeTask({ column: "review", pendingInteractionCount: 3, pipelineId: "p1", pipelineRun: pipelineRun({ status: "running" }) }));
    expect(m).toContain("Answer (3)");
    expect(m).not.toContain("> Done</button>");
    expect(m).toContain(ARROW);
  });

  test("blocked with nothing counted reads Review, with the arrow", () => {
    const m = html(makeTask({ column: "blocked" }));
    expect(m).toContain('title="Agent is waiting on you — open the run panel"');
    expect(m).toMatch(/Review<svg[^>]*lucide-arrow-right/);
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
    expect(m).not.toContain("> Done</button>");
    expect(m).not.toContain("Mark this task as done");
    expect(m).not.toContain("task-card-pipeline-stop");
  });

  test("review: Open and a transparent Done", () => {
    const m = html(makeTask({ column: "review", hasOpenableRun: true }));
    expect(m).toContain("> Open</button>");
    expect(m).toContain("> Done</button>");
    // `⋯` is always bg-transparent too, so pin the class on Done itself: the
    // outline variant's bg-background is the dark-mode "hole" this replaced.
    expect(m).toMatch(/<button[^>]*\bbg-transparent" title="Mark this task as done"/);
  });

  test("archived: exactly one button besides ⋯, and the card is dimmed", () => {
    const m = html(makeTask({ column: "done", archivedAt: 5, hasOpenableRun: true }));
    expect(buttonCount(m)).toBe(2);
    expect(m).toContain("opacity-60");
    expect(m).toContain("cursor-default");
  });

  test("archived: the group is not aria-disabled, so its buttons are not announced disabled", () => {
    const root = html(makeTask({ column: "done", archivedAt: 5, hasOpenableRun: true })).match(/<div[^>]*role="group"[^>]*>/)![0];
    expect(root).not.toContain("aria-disabled");
    expect(root).toContain('aria-label="Fix login redirect (archived)"');
    // No drag instructions on a card that can't be dragged.
    expect(root).not.toContain("aria-roledescription");
    expect(root).not.toContain("aria-describedby");
    // A live card keeps them, and is not aria-disabled either.
    const live = html(makeTask()).match(/<div[^>]*role="group"[^>]*>/)![0];
    expect(live).toContain('aria-roledescription="draggable task"');
    expect(live).toContain("aria-describedby");
    expect(live).not.toContain("aria-disabled");
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

// The three lines between the title and the actions (plan §2.2): who does the
// work, the quiet counts plus meaning-carrying chips, and `repo · branch`.
const identity = (t: Task) => renderToStaticMarkup(<TaskCardIdentity task={t} />);
const status = (t: Task) => renderToStaticMarkup(<TaskCardStatus task={t} stacks={[]} limitStates={[]} />);
const meta = (t: Task) => renderToStaticMarkup(<TaskCardMeta task={t} homeDir="/Users/me" />);

describe("TaskCard identity line", () => {
  test("a plain task: agent, model display name and mode in one truncating span, with the full text as its tooltip", () => {
    const m = identity(makeTask());
    expect(m).toContain('title="claude-code · Opus 5.5 · auto"');
    expect(m).toContain('<span class="min-w-0 truncate"><span class="font-medium text-foreground">claude-code</span>');
    expect(m).toContain(">Opus 5.5 · auto</span>");
    // A plain agent is not a profile: no profile test id, no harness tooltip.
    expect(m).not.toContain("task-card-agent-profile");
  });

  test("no model and no mode: the name alone, with no dangling separator", () => {
    const m = identity(makeTask({ model: null, mode: null }));
    expect(m).toContain('title="claude-code"');
    expect(m).not.toContain(" · ");
  });

  test("a pipeline parent names no agent: model and mode only, and no agent icon", () => {
    const m = identity(makeTask({ pipelineId: "p1", pipelineRun: pipelineRun() }));
    expect(m).toContain('title="Opus 5.5 · auto"');
    expect(m).not.toContain("claude-code");
    expect(m).not.toContain("<svg");
  });

  test("a pipeline parent with no model or mode renders no identity line at all", () => {
    expect(identity(makeTask({ pipelineId: "p1", pipelineRun: pipelineRun(), model: null, mode: null }))).toBe("");
  });
});

describe("TaskCard status row", () => {
  test("a task with no counts renders an empty row that hides itself", () => {
    const m = status(makeTask());
    expect(m).toMatch(/^<div data-part="status" class="[^"]*\bempty:hidden\b[^"]*"><\/div>$/);
  });

  test("one of each reads in the singular", () => {
    const m = status(makeTask({
      runningSubagents: 1,
      openTerminalCount: 1,
      sentFiles: [{ path: "/a/b.md", sentAt: 1 }] as Task["sentFiles"],
    }));
    expect(m).toContain('title="1 background task running"');
    expect(m).toContain('title="1 open terminal"');
    expect(m).toContain('title="1 file sent · b.md"');
  });

  test("the sent-files tooltip names the five newest files, newest first", () => {
    const sentFiles = [1, 2, 3, 4, 5, 6].map((n) => ({ path: `/d/f${n}.md`, sentAt: n })) as Task["sentFiles"];
    const m = status(makeTask({ sentFiles }));
    expect(m).toContain('title="6 files sent · f6.md, f5.md, f4.md, f3.md, f2.md"');
    expect(m).toContain(">6</span>");
  });

  test("a finished todo list turns success; an unfinished one does not; an empty one is not shown", () => {
    const done = status(makeTask({ todoProgress: { completed: 4, total: 4 } }));
    expect(done).toMatch(/class="[^"]*\btext-success\b[^"]*" title="4 of 4 tasks done"/);
    const partial = status(makeTask({ todoProgress: { completed: 3, total: 4 } }));
    expect(partial).toContain('title="3 of 4 tasks done"');
    expect(partial).not.toContain("text-success");
    expect(status(makeTask({ todoProgress: { completed: 0, total: 0 } }))).not.toContain("tasks done");
  });

  test("a paused fx task shows the warning chip; the same pause while running does not", () => {
    const fxRecovery = { state: "paused", runId: "r1", pausedAt: 1, autoResume: null, autoResumeCount: 0 } as unknown as Task["fxRecovery"];
    const paused = status(makeTask({ column: "ready", fxRecovery }));
    expect(paused).toContain('data-testid="fx-paused-badge"');
    expect(paused).toContain("border-warning/40 text-warning");
    expect(paused).toContain(">paused</span>");
    expect(status(makeTask({ column: "running", fxRecovery }))).not.toContain("fx-paused-badge");
  });
});

describe("TaskCard repo · branch line", () => {
  const branched = { branch: "agetor/1f2e3d4c-fix-login", baseRef: "a1b2c3d4e5f6" };

  test("repo name and branch, with the home-abbreviated path, branch and short base in the tooltip", () => {
    const m = meta(makeTask(branched));
    expect(m).toContain('title="~/Projects/acme/web-dashboard\nagetor/1f2e3d4c-fix-login\nbase a1b2c3d"');
    expect(m).toContain(">web-dashboard</span>");
    expect(m).toContain('aria-hidden="true">·</span>');
    expect(m).toContain(">agetor/1f2e3d4c-fix-login</span>");
    expect(m).not.toContain("task-card-branch-drift");
  });

  test("a trailing slash on the workdir still yields the repo name", () => {
    expect(meta(makeTask({ ...branched, workdir: "/srv/acme/api/"}))).toContain(">api</span>");
  });

  test("no branch and no base: the repo alone, no separator", () => {
    const m = meta(makeTask({ branch: null, baseRef: null }));
    expect(m).toContain('title="~/Projects/acme/web-dashboard"');
    expect(m).toContain(">web-dashboard</span>");
    expect(m).not.toContain("·");
  });

  test("a base but no branch yet says so", () => {
    expect(meta(makeTask({ branch: null, baseRef: "a1b2c3d4e5f6" }))).toContain(">(not yet created)</span>");
  });

  test("a created branch the worktree moved off: the live branch and an info 'drifted' chip", () => {
    const m = meta(makeTask({ ...branched, branchSource: "created", checkoutBranch: "scratch" }));
    expect(m).toContain(">scratch</span>");
    expect(m).toMatch(/border-info\/40 text-info[^"]*"[^>]*data-testid="task-card-branch-drift" title="task branch: agetor\/1f2e3d4c-fix-login">drifted</);
  });

  test("an existing (PR) branch the worktree moved off: a warning 'not on PR head' chip", () => {
    const m = meta(makeTask({ ...branched, branchSource: "existing", checkoutBranch: "main" }));
    expect(m).toMatch(/border-warning\/40 text-warning[^"]*"[^>]*data-testid="task-card-branch-drift"[^>]*>not on PR head</);
  });

  test("the recorded checkout equal to the task branch is not drift", () => {
    expect(meta(makeTask({ ...branched, checkoutBranch: branched.branch }))).not.toContain("task-card-branch-drift");
  });

  test("multi-repository: the count and the names instead of repo · branch", () => {
    const m = meta(makeTask({
      ...branched,
      multiRepo: true,
      repositories: [
        { name: "api", path: "/p/api", worktreePath: "/w/api" },
        { name: "web", path: "/p/web", worktreePath: null },
        { name: "ios", path: "/p/ios", worktreePath: "/w/ios" },
      ] as Task["repositories"],
    }));
    expect(m).toContain('data-testid="task-card-repositories"');
    expect(m).toContain('title="api: /w/api\nweb: /p/web\nios: /w/ios"');
    expect(m).toContain(">3 repositories</span>");
    expect(m).toContain(">· api, web, ios</span>");
    expect(m).not.toContain("agetor/1f2e3d4c-fix-login");
  });
});
