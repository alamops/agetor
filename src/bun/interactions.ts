import { randomUUID } from "node:crypto";

/**
 * In-process registry for user interactions claude needs to drive through
 * agetor's UI: scraper-sourced AskUserQuestion / ExitPlanMode modals, and
 * unstructured tmux-pane prompts. Each follows the same shape — a localhost
 * POST or a scraper-driven send-keys sequence that we hold open via a Promise
 * (or a no-op resolve) until the user answers.
 *
 * Everything here is in-memory. Pending interactions don't survive an agetor
 * restart, by design: on boot we kill / reattach `agetor-*` tmux sessions, so
 * the children waiting on these promises are re-derived from the live pane
 * rather than persisted.
 */

export type InteractionKind =
  | "ask_questions"   // claude built-in AskUserQuestion (scraper-sourced)
  | "tmux_prompt";    // unstructured in-REPL prompt detected by scraping the tmux pane

/* ────────────────────────────────────────────────────────────────────────── *
 * Claude built-in AskUserQuestion (scraper-sourced).
 *
 * AskUserQuestion's tool body is "block until the human answers in the TUI".
 * Since agetor drives claude detached in tmux, that native Ink modal is
 * invisible to the user. The scraper in `claude-tmux.ts` detects it on the
 * pane, pairs it with the structured `questions` it saw in the JSONL tool_use,
 * and surfaces it as a structured card. The answer is driven back as keystrokes
 * (`planAskAnswers` + `sendModalKeys`); there is no blocking hook curl.
 * ────────────────────────────────────────────────────────────────────────── */

/** One question inside an AskUserQuestion tool call (claude code shape). */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** `preview` is the multi-line code/text block claude attaches to an option
   *  (rendered as a side box in the TUI). Two sources populate it: the JSONL
   *  tool_use (available only after the modal is answered), and the live pane
   *  scrape, which grows the pane and walks each option to read its panel
   *  (see `collectAskQuestionsFromPane`). */
  options: Array<{ label: string; description?: string; preview?: string }>;
}

export interface AskQuestionsRequest {
  kind: "ask_questions";
  id: string;
  taskId: string;
  runId: string;
  questions: AskQuestion[];
  createdAt: number;
  /**
   * How the answer is delivered back to claude. Only `"scraper"` exists now:
   * the native modal is detected on the tmux pane and the answer is driven
   * back as keystrokes (`planAskAnswers` + `sendModalKeys`), then the card is
   * removed via `resolveScrapedAskQuestions`. Registered by
   * `registerScrapedAskQuestions`.
   */
  source?: "scraper";
  /** Pane fingerprint — used by the scraper for two-tick stability, dup
   *  suppression, and auto-cancel when the modal leaves the pane. */
  fingerprint?: string;
}

export interface AskQuestionsAnswer {
  /** One entry per question in `AskQuestionsRequest.questions`, same order.
   *  Each may contain selected option labels and/or a free-text custom
   *  answer. At least one of `selected` / `custom` must be non-empty per
   *  question. */
  answers: Array<{ selected: string[]; custom?: string }>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tmux pane scraper (catch-all for prompts the hook never sees).
 *
 * Some Claude REPL prompts — plan-mode safety dialogs that bypass hooks,
 * `acceptEdits` + Bash, `/login`, model picker, auth re-prompts — never
 * surface through PreToolUse. The scraper in `claude-tmux.ts` regex-matches
 * the visible pane and registers one of these for each detected prompt.
 * Answering ships the choice's `key` (typically `"1"`/`"2"`/`"3"` for
 * numbered modals or `"y"`/`"n"` for y/N prompts) back to claude via
 * `tmux send-keys` so the modal dismisses without the user touching tmux.
 * ────────────────────────────────────────────────────────────────────────── */

export interface TmuxPromptChoice {
  /** The literal keystroke(s) to send. Numbered modals expect a single
   *  digit; y/N prompts expect a single letter.
   *
   *  RESERVED: keys starting with `__` are sentinels for the resolver
   *  (`__external__` for scraper-detected dismissals, `__cancelled__`
   *  for run-teardown). `registerTmuxPrompt` rejects choices using a
   *  reserved key so a future matcher can't accidentally collide. */
  key: string;
  /** Display label shown on the UI button. */
  label: string;
}

export interface TmuxPromptRequest {
  kind: "tmux_prompt";
  id: string;
  taskId: string;
  runId: string;
  /** Verbatim trailing slice of the tmux pane that matched a known prompt
   *  signature. Rendered as monospace in the UI so the user sees exactly
   *  what claude is asking. */
  paneText: string;
  choices: TmuxPromptChoice[];
  /** 0-based index of the choice the scraper saw as currently selected
   *  (the `❯`/`›` cursor line) at registration time. The dismissal path
   *  uses this to compute how many `Down`/`Up` arrow presses to send
   *  before Enter — claude's Ink select-input only responds to arrow
   *  keys, not digit hotkeys. Permission modals default the cursor to
   *  option 1 (index 0), but selection modals (model picker, auth re-
   *  prompts) open with the cursor on the *current* value, which can be
   *  anywhere. Undefined for prompts where arrow nav doesn't apply
   *  (y/N modals — the literal `y`/`n` keystroke goes in directly). */
  cursorIndex?: number;
  /** Stable hash of the matched block — used to debounce duplicate
   *  registrations across consecutive scrapes and to detect external
   *  dismissal (the prompt disappeared from the pane). */
  fingerprint: string;
  createdAt: number;
}

export interface TmuxPromptAnswer {
  /** Must equal one of the keys advertised on the request. The route
   *  validates this before sending keystrokes to tmux. The sentinel
   *  `"__external__"` is reserved for the scraper's auto-cancel path
   *  (the prompt vanished from the pane on its own — e.g. user
   *  attached to tmux and answered directly). */
  key: string;
}

export type AnyRequest =
  | AskQuestionsRequest
  | TmuxPromptRequest;

interface AskQuestionsEntry {
  req: AskQuestionsRequest;
  resolve: (answer: AskQuestionsAnswer) => void;
}
interface TmuxPromptEntry {
  req: TmuxPromptRequest;
  resolve: (answer: TmuxPromptAnswer) => void;
}

const askQuestions = new Map<string, AskQuestionsEntry>();
const tmuxPrompts = new Map<string, TmuxPromptEntry>();

type BroadcastFn = (req: AnyRequest) => void;
let broadcast: BroadcastFn = () => { /* installed by the orchestrator */ };

/** Carries the bare minimum the UI needs to drop a card whose interaction
 *  has been resolved server-side (auto-cancel from the scraper, tear-down
 *  from `cancelPendingForTask`, route-driven answer, …). The UI filters
 *  its local interactions array on `id`. */
export interface InteractionResolved {
  id: string;
  taskId: string;
  runId: string;
  kind: InteractionKind;
}

type ResolveBroadcastFn = (res: InteractionResolved) => void;
let broadcastResolved: ResolveBroadcastFn = () => { /* installed by the orchestrator */ };

/**
 * The orchestrator hands us its event emitter so we can fan out new
 * interactions on the same SSE stream the UI is already subscribed to.
 * Kept as a setter (rather than a constructor dep) because this module is
 * imported by the server before the orchestrator's listener is registered.
 */
export function setBroadcaster(fn: BroadcastFn): void {
  broadcast = fn;
}

/**
 * Companion to `setBroadcaster` for the *removal* side: every `answer*`
 * call and `cancelPendingForTask` path emits one of these so the UI can
 * drop the resolved card without waiting for a polling refresh. Without
 * this, scraper auto-cancel and run-cancellation leave stale cards in
 * the run panel until the user closes and reopens it.
 */
export function setResolvedBroadcaster(fn: ResolveBroadcastFn): void {
  broadcastResolved = fn;
}

/** Internal helper — every answer* / cancel* path that deletes from one
 *  of the maps should call this with the request it removed so the UI
 *  hears about it. */
function fanoutResolved(req: AnyRequest): void {
  broadcastResolved({ id: req.id, taskId: req.taskId, runId: req.runId, kind: req.kind });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * AskUserQuestion — scraper-sourced.
 *
 * Claude renders its native Ink modal in the tmux pane. The scraper detects
 * it, pairs it with the structured `questions` it already saw in the JSONL
 * tool_use, and registers it here. There is no blocking curl to resolve — the
 * answer route plans a keystroke sequence and drives it back into the pane,
 * then calls `resolveScrapedAskQuestions` to drop the card. The registry
 * entry's `resolve` is therefore a no-op.
 * ────────────────────────────────────────────────────────────────────────── */

export function registerScrapedAskQuestions(args: {
  taskId: string;
  runId: string;
  questions: AskQuestion[];
  fingerprint: string;
}): AskQuestionsRequest {
  const id = randomUUID();
  const req: AskQuestionsRequest = {
    kind: "ask_questions",
    id,
    taskId: args.taskId,
    runId: args.runId,
    questions: args.questions,
    createdAt: Date.now(),
    source: "scraper",
    fingerprint: args.fingerprint,
  };
  // No awaiter — the answer is driven via send-keys, not a promise resolve.
  askQuestions.set(id, { req, resolve: () => { /* scraper-sourced: no hook promise */ } });
  broadcast(req);
  return req;
}

/** Fetch a pending ask_questions request by id — the answer route needs the
 *  `questions` (to plan keystrokes) and `source` (to pick drive vs hook). */
export function getAskQuestionsById(id: string): AskQuestionsRequest | null {
  return askQuestions.get(id)?.req ?? null;
}

/** Every pending ask_questions request for a task. Used by the scraper to (a)
 *  gate registration (don't add a second card when one is already pending —
 *  e.g. a hook-sourced card during the 600s-timeout leak window) and (b)
 *  auto-cancel a scraper card once its fingerprint leaves the pane. */
export function activeAskQuestionsForTask(taskId: string): AskQuestionsRequest[] {
  const out: AskQuestionsRequest[] = [];
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) out.push(e.req);
  return out;
}

/** Find a pending scraper-sourced ask_questions for the task by fingerprint —
 *  lets the scraper skip re-registering a modal that's already on a card. */
export function findScrapedAskQuestionsByFingerprint(
  taskId: string,
  fingerprint: string,
): AskQuestionsRequest | null {
  for (const e of askQuestions.values()) {
    if (e.req.taskId === taskId && e.req.fingerprint === fingerprint) return e.req;
  }
  return null;
}

/** Remove a scraper-sourced ask_questions card after its answer has been
 *  driven into the pane (or it was auto-cancelled). Idempotent; broadcasts
 *  the resolution so the UI drops the card. */
export function resolveScrapedAskQuestions(id: string): boolean {
  const entry = askQuestions.get(id);
  if (!entry) return false;
  askQuestions.delete(id);
  fanoutResolved(entry.req);
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tmux pane scraper interactions
 * ────────────────────────────────────────────────────────────────────────── */

export function registerTmuxPrompt(args: {
  taskId: string;
  runId: string;
  paneText: string;
  choices: TmuxPromptChoice[];
  cursorIndex?: number;
  fingerprint: string;
}): { id: string; req: TmuxPromptRequest; answer: Promise<TmuxPromptAnswer> } {
  // Defend the reserved-key namespace — `__external__` / `__cancelled__`
  // must be unambiguously sentinels, not legitimate user keystrokes.
  for (const c of args.choices) {
    if (c.key.startsWith("__")) {
      throw new Error(
        `registerTmuxPrompt: choice key '${c.key}' is reserved (keys starting with '__' are sentinels)`,
      );
    }
  }
  const id = randomUUID();
  const req: TmuxPromptRequest = {
    kind: "tmux_prompt",
    id,
    taskId: args.taskId,
    runId: args.runId,
    paneText: args.paneText,
    choices: args.choices,
    cursorIndex: args.cursorIndex,
    fingerprint: args.fingerprint,
    createdAt: Date.now(),
  };
  const answer = new Promise<TmuxPromptAnswer>((resolve) => {
    tmuxPrompts.set(id, { req, resolve });
  });
  broadcast(req);
  return { id, req, answer };
}

export function answerTmuxPrompt(id: string, answer: TmuxPromptAnswer): boolean {
  const entry = tmuxPrompts.get(id);
  if (!entry) return false;
  tmuxPrompts.delete(id);
  entry.resolve(answer);
  fanoutResolved(entry.req);
  return true;
}

/** Look up a pending tmux_prompt by id — used by the route handler to
 *  validate the key against the recorded choices before sending
 *  keystrokes to tmux. */
export function findTmuxPromptById(id: string): TmuxPromptRequest | null {
  return tmuxPrompts.get(id)?.req ?? null;
}

/** Find a pending tmux_prompt for the task by its content fingerprint —
 *  used by the scraper to skip re-registering an already-pending prompt. */
export function findTmuxPromptByFingerprint(
  taskId: string,
  fingerprint: string,
): TmuxPromptRequest | null {
  for (const entry of tmuxPrompts.values()) {
    if (entry.req.taskId === taskId && entry.req.fingerprint === fingerprint) {
      return entry.req;
    }
  }
  return null;
}

/** List the ids of every active tmux_prompt for this task. The scraper
 *  uses this to auto-cancel prompts whose fingerprints disappeared from
 *  the pane (the user dismissed them from a real tmux attach). */
export function activeTmuxPromptsForTask(taskId: string): TmuxPromptRequest[] {
  const out: TmuxPromptRequest[] = [];
  for (const entry of tmuxPrompts.values()) {
    if (entry.req.taskId === taskId) out.push(entry.req);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Shared helpers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve every pending interaction for this task with a synthetic
 * "cancelled" answer so subprocess waiters unblock immediately. Called from
 * cancelRun (Stop button) and deleteTask — if we just kill the tmux session
 * without doing this first, the in-flight curl / MCP children would hang
 * until their HTTP timeout instead of returning cleanly.
 */
export function cancelPendingForTask(taskId: string, reason: string): void {
  for (const [id, entry] of askQuestions) {
    if (entry.req.taskId !== taskId) continue;
    askQuestions.delete(id);
    entry.resolve({
      answers: entry.req.questions.map(() => ({ selected: [], custom: reason })),
    });
    fanoutResolved(entry.req);
  }
  for (const [id, entry] of tmuxPrompts) {
    if (entry.req.taskId !== taskId) continue;
    tmuxPrompts.delete(id);
    // Sentinel — the route handler reads this and skips the send-keys
    // step so we don't inject random keystrokes into a session that's
    // already being torn down.
    entry.resolve({ key: "__cancelled__" });
    fanoutResolved(entry.req);
  }
}

export function listPendingForTask(taskId: string): AnyRequest[] {
  const out: AnyRequest[] = [];
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) out.push(e.req);
  for (const e of tmuxPrompts.values()) if (e.req.taskId === taskId) out.push(e.req);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Cheap counter used by `tasks.list()` / `tasks.get()` to surface the
 *  pending-interaction badge on each kanban card without serializing the
 *  full payloads. Linear scan over the small in-memory Maps. */
export function countPendingForTask(taskId: string): number {
  let n = 0;
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) n++;
  for (const e of tmuxPrompts.values()) if (e.req.taskId === taskId) n++;
  return n;
}

/** Test-only handle for asserting the registry state. */
export const __testing = {
  askQuestionsSize: () => askQuestions.size,
  tmuxPromptsSize: () => tmuxPrompts.size,
  reset() {
    askQuestions.clear();
    tmuxPrompts.clear();
    broadcast = () => { /* reset */ };
    broadcastResolved = () => { /* reset */ };
  },
};
