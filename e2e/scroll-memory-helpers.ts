import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Shared helpers for the board scroll-position memory specs
 * (docs/plans/board-scroll-position.md, T3). Not a spec file (no `.spec.`
 * in the name), so Playwright never collects it.
 *
 * Three groups:
 *  - REST seeding (plain backlog tasks, agent profiles, pipelines, pipeline
 *    tasks, retry/restart). The request shapes mirror
 *    `e2e/pipelines-run.spec.ts`, whose own helpers are module-private.
 *  - Board scroller primitives: read/write the `.kanban-scroll` offsets and
 *    wait until the app's React `onScroll` has had a chance to save them.
 *  - In-page geometry: whether a card/column is inside the scroller's
 *    CLIENT box (the 10px horizontal scrollbar is excluded), and a card's
 *    rect in scroll-content coordinates.
 */

/** Mirrors `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER` in `src/bun/agents.ts`. */
export const FAKE_CLAUDE_HANDOFF_PROMPT_MARKER = "__agetor_fake_claude_handoff__";

/** Authorization + JSON content-type headers for direct REST calls. */
export function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

/** The subset of the `/tasks` JSON shape these helpers (and specs) read. */
export interface TaskRow {
  id: string;
  title: string;
  column: string;
  pendingInteractionCount?: number;
  pipelineId: string | null;
  pipelineParentId?: string | null;
  pipelineRun: {
    status: string;
    startedAt: number | null;
    active: { stepId: string; taskId: string }[];
    blocked: { taskId: string | null; stepId: string | null; kind: string; message: string }[];
    history: { seq?: number; stepId: string; taskId: string; outcome: string | null; startedAt: number }[];
  } | null;
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} -> ${res.status}: ${await res.text()}`);
}

/**
 * Creates `count` plain tasks titled `<titlePrefix> <n>` (1-based) over REST.
 * `isolation: "none"` in the OS temp dir, never started, so they land in
 * the backlog column.
 */
export async function createPlainTasksRest(
  backend: E2EBackend,
  count: number,
  titlePrefix: string,
): Promise<TaskRow[]> {
  const rows: TaskRow[] = [];
  for (let i = 1; i <= count; i++) {
    const res = await fetch(`${backend.apiBase}/tasks`, {
      method: "POST",
      headers: auth(backend),
      body: JSON.stringify({
        title: `${titlePrefix} ${i}`,
        prompt: `Plain task ${i}`,
        isolation: "none",
        workdir: tmpdir(),
      }),
    });
    await expectOk(res, "POST /tasks");
    rows.push((await res.json()) as TaskRow);
  }
  return rows;
}

/** Creates a claude-code agent profile over REST and returns its id. */
export async function createProfileRest(backend: E2EBackend, name: string): Promise<string> {
  const res = await fetch(`${backend.apiBase}/agent-profiles`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({ name, harness: "claude-code", model: "opus-5", instructions: "", skills: [] }),
  });
  await expectOk(res, "POST /agent-profiles");
  return ((await res.json()) as { id: string }).id;
}

/** Builds one pipeline step for `createPipelineRest` (choose/any defaults, no delegation). */
export function makeStep(input: { id: string; name: string; agentProfileId: string; instructions?: string }) {
  return {
    id: input.id,
    name: input.name,
    instructions: input.instructions ?? "",
    agentProfileId: input.agentProfileId,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [] as string[], cap: null as number | null },
    transition: "choose" as "choose" | "all",
    join: "any" as "any" | "all",
  };
}

/**
 * Creates a pipeline over REST and returns its id. Steps are spaced out
 * left-to-right (300px apart) — `makeStep` defaults every position to the
 * origin, which would stack REST-built nodes on top of each other.
 */
export async function createPipelineRest(
  backend: E2EBackend,
  name: string,
  steps: ReturnType<typeof makeStep>[],
  edges: { from: string; to: string }[],
  maxSteps = 25,
): Promise<string> {
  const positionedSteps = steps.map((s, i) => ({ ...s, position: { x: i * 300, y: 0 } }));
  const res = await fetch(`${backend.apiBase}/pipelines`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({
      name,
      description: "",
      graph: {
        steps: positionedSteps,
        edges: edges.map((e) => ({ id: randomUUID(), from: e.from, to: e.to, label: "" })),
        startStepId: steps[0]?.id ?? null,
      },
      maxSteps,
    }),
  });
  await expectOk(res, "POST /pipelines");
  return ((await res.json()) as { id: string }).id;
}

/** Creates (does not start) a pipeline parent task over REST. */
export async function createPipelineTaskRest(
  backend: E2EBackend,
  title: string,
  pipelineId: string,
  prompt: string,
): Promise<TaskRow> {
  const res = await fetch(`${backend.apiBase}/tasks`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({ title, prompt, isolation: "none", workdir: tmpdir(), pipelineId }),
  });
  await expectOk(res, "POST /tasks");
  return (await res.json()) as TaskRow;
}

/** `POST /tasks/:id/start`. */
export async function startTaskRest(backend: E2EBackend, id: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}/start`, { method: "POST", headers: auth(backend) });
  await expectOk(res, `POST /tasks/${id}/start`);
}

/** `GET /tasks/:id`. */
export async function getTaskRest(backend: E2EBackend, id: string): Promise<TaskRow> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  await expectOk(res, `GET /tasks/${id}`);
  return (await res.json()) as TaskRow;
}

/**
 * Polls `GET /tasks/:id` until `pred` holds and returns that row. Fails
 * (via `expect(...).toPass`) after `timeoutMs`.
 */
export async function waitForPipelineRest(
  backend: E2EBackend,
  id: string,
  pred: (t: TaskRow) => boolean,
  timeoutMs = 30_000,
): Promise<TaskRow> {
  let last: TaskRow | null = null;
  await expect(async () => {
    last = await getTaskRest(backend, id);
    expect(pred(last)).toBe(true);
  }).toPass({ timeout: timeoutMs });
  return last!;
}

/** `POST /tasks/:id/pipeline/retry` (no body: retries every stuck execution). */
export async function retryPipelineRest(backend: E2EBackend, id: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}/pipeline/retry`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({}),
  });
  await expectOk(res, `POST /tasks/${id}/pipeline/retry`);
}

/** `POST /tasks/:id/pipeline/restart` (fresh run; clears history). */
export async function restartPipelineRest(backend: E2EBackend, id: string): Promise<void> {
  const res = await fetch(`${backend.apiBase}/tasks/${id}/pipeline/restart`, {
    method: "POST",
    headers: auth(backend),
  });
  await expectOk(res, `POST /tasks/${id}/pipeline/restart`);
}

/**
 * Opens the board and waits until the app's single global-events
 * stream (`GET /events`) has been requested — toasts are live-only,
 * so a task started before the subscription exists never toasts. Waits on
 * the REQUEST, not a response (same as pipelines-run.spec.ts).
 */
export async function gotoAppSubscribed(page: Page, backend: E2EBackend): Promise<void> {
  const globalEventsRequested = page.waitForRequest((r) => new URL(r.url()).pathname === "/events");
  await gotoApp(page, backend.bootBase);
  await globalEventsRequested;
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/** The board's only scroller (scrolls both axes). */
export function boardScroller(page: Page): Locator {
  return page.locator(".kanban-scroll");
}

/** A board card by task id (`data-task-id` on the card root). */
export function boardCardById(page: Page, id: string): Locator {
  return page.locator(`[data-task-id="${id}"]`);
}

// ---------------------------------------------------------------------------
// Scroll primitives
// ---------------------------------------------------------------------------

export interface ScrollOffsets {
  left: number;
  top: number;
}

export interface ScrollRange {
  maxLeft: number;
  maxTop: number;
  clientWidth: number;
  clientHeight: number;
}

/** Current `scrollLeft`/`scrollTop` of the element. */
export async function readScroll(loc: Locator): Promise<ScrollOffsets> {
  return loc.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
}

/** Max scroll offsets (`scrollWidth - clientWidth`, …) and the client size. */
export async function scrollRange(loc: Locator): Promise<ScrollRange> {
  return loc.evaluate((el) => ({
    maxLeft: el.scrollWidth - el.clientWidth,
    maxTop: el.scrollHeight - el.clientHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }));
}

/**
 * Writes `scrollLeft`/`scrollTop` (an omitted axis is left alone). When
 * either value actually changed, waits for that element's next `scroll`
 * event and then two animation frames, so the app's React `onScroll` handler
 * has run and saved the offsets; resolves anyway if no scroll event arrives
 * within ~1s. Returns the actual (browser-clamped) offsets, and returns
 * immediately when nothing changed.
 */
export async function scrollToOffsets(
  loc: Locator,
  offsets: { left?: number; top?: number },
): Promise<ScrollOffsets> {
  return loc.evaluate(
    (el, { left, top }) =>
      new Promise<{ left: number; top: number }>((resolve) => {
        const beforeLeft = el.scrollLeft;
        const beforeTop = el.scrollTop;
        let done = false;
        let timer = 0;
        const finish = () => {
          if (done) return;
          done = true;
          el.removeEventListener("scroll", onScroll);
          window.clearTimeout(timer);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve({ left: el.scrollLeft, top: el.scrollTop })),
          );
        };
        const onScroll = () => finish();
        el.addEventListener("scroll", onScroll);
        if (left !== undefined) el.scrollLeft = left;
        if (top !== undefined) el.scrollTop = top;
        if (el.scrollLeft === beforeLeft && el.scrollTop === beforeTop) {
          done = true;
          el.removeEventListener("scroll", onScroll);
          resolve({ left: el.scrollLeft, top: el.scrollTop });
          return;
        }
        timer = window.setTimeout(finish, 1000);
      }),
    { left: offsets.left, top: offsets.top },
  );
}

// ---------------------------------------------------------------------------
// Geometry (measured in the page)
// ---------------------------------------------------------------------------

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Visibility {
  /** "none": no positive-area overlap (touching edges count as none, and a
   *  missing element is "none" with `target: null`); "full": the target lies
   *  entirely inside the view; otherwise "partial". */
  state: "full" | "partial" | "none";
  /** The element's viewport rect, or null when it isn't in the DOM. */
  target: Rect | null;
  /** The board scroller's CLIENT box in viewport coordinates (excludes the
   *  scrollbar and border). */
  view: Rect;
}

type VisibilityTarget = { kind: "card"; id: string } | { kind: "column"; label: string };

function measureVisibility(page: Page, target: VisibilityTarget): Promise<Visibility> {
  return page.evaluate((t) => {
    const scroller = document.querySelector(".kanban-scroll");
    if (!scroller) throw new Error("board scroller (.kanban-scroll) not found");
    const sr = scroller.getBoundingClientRect();
    const view = {
      left: sr.left + scroller.clientLeft,
      top: sr.top + scroller.clientTop,
      right: sr.left + scroller.clientLeft + scroller.clientWidth,
      bottom: sr.top + scroller.clientTop + scroller.clientHeight,
    };
    let el: Element | null = null;
    if (t.kind === "card") {
      el = document.querySelector(`[data-task-id="${t.id}"]`);
    } else {
      const heading = Array.from(scroller.querySelectorAll("h2")).find(
        (h) => (h.textContent ?? "").trim() === t.label,
      );
      el = heading ? heading.closest(".w-72") : null;
    }
    if (!el) return { state: "none" as const, target: null, view };
    const r = el.getBoundingClientRect();
    const rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const overlapW = Math.min(rect.right, view.right) - Math.max(rect.left, view.left);
    const overlapH = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
    if (!(overlapW > 0 && overlapH > 0)) return { state: "none" as const, target: rect, view };
    const full =
      rect.left >= view.left && rect.right <= view.right && rect.top >= view.top && rect.bottom <= view.bottom;
    return { state: full ? ("full" as const) : ("partial" as const), target: rect, view };
  }, target);
}

/** How much of the card `taskId` is inside the board scroller's client box. */
export function cardVisibility(page: Page, taskId: string): Promise<Visibility> {
  return measureVisibility(page, { kind: "card", id: taskId });
}

/**
 * How much of the column labelled `label` is inside the board scroller's
 * client box. The column is the closest `.w-72` ancestor of the `h2` whose
 * text equals `label` (the column root in `Column.tsx` is `flex w-72 …`).
 */
export function columnVisibility(page: Page, label: string): Promise<Visibility> {
  return measureVisibility(page, { kind: "column", label });
}

/**
 * The card's rect in scroll-content coordinates: its viewport rect minus the
 * scroller's client-box origin, plus the current scroll offsets. Throws when
 * the card isn't in the DOM.
 */
export async function contentRect(page: Page, taskId: string): Promise<Rect> {
  const rect = await page.evaluate((id) => {
    const scroller = document.querySelector(".kanban-scroll");
    if (!scroller) throw new Error("board scroller (.kanban-scroll) not found");
    const card = document.querySelector(`[data-task-id="${id}"]`);
    if (!card) return null;
    const sr = scroller.getBoundingClientRect();
    const originX = sr.left + scroller.clientLeft;
    const originY = sr.top + scroller.clientTop;
    const r = card.getBoundingClientRect();
    return {
      left: r.left - originX + scroller.scrollLeft,
      top: r.top - originY + scroller.scrollTop,
      right: r.right - originX + scroller.scrollLeft,
      bottom: r.bottom - originY + scroller.scrollTop,
    };
  }, taskId);
  if (!rect) throw new Error(`contentRect: no card with data-task-id="${taskId}"`);
  return rect;
}
