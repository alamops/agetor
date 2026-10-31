import { randomUUID } from "node:crypto";
// Lazy cycle: db.ts imports `countPendingForTask`/`pendingCountsByTask` from
// this module, and this module reads `tasks` back — safe ONLY because both
// sides touch the other's exports from function bodies (never at module
// scope). See the matching note at the top of db.ts before adding any
// top-level use of `tasks` here.
import { insertCursorAsk, resolveCursorAsk, runs, tasks } from "./db.ts";
import { questionText } from "../shared/cursor-ask.ts";
import type { RunEvent } from "../shared/types.ts";

/**
 * In-process registry for user interactions an agent needs to drive through
 * agetor's UI: scraper-sourced AskUserQuestion / ExitPlanMode modals,
 * unstructured tmux-pane prompts, and fx's ACP `session/request_permission`
 * calls. Each follows the same shape — a localhost POST, a scraper-driven
 * send-keys sequence, or a driver awaiting an RPC reply — held open via a
 * Promise (or a no-op resolve, for the scraper-sourced kinds) until the user
 * answers.
 *
 * Everything here is in-memory. Pending interactions don't survive an agetor
 * restart, by design: on boot we reattach or orphan `agetor-*` tmux sessions
 * (we never blind-kill), so the children waiting on these promises are
 * re-derived from the live pane rather than persisted. fx has no reattach
 * path at all (`fx-acp.ts` is a plain piped-stdio child, not tmux-hosted) —
 * a restart simply kills the driver and its pending card dies with it, same
 * in-memory-only discipline, just with no live process left to re-derive
 * anything from.
 *
 * Settlement single-source-of-truth: for the two kinds with a real awaiter
 * (`tmux_prompt`, `fx_permission`), exactly one of three paths resolves any
 * given entry — the user's answer via its HTTP route, `cancelPendingForTask`
 * (Stop / delete), or (for fx) the driver's own cancel/teardown calling
 * `answerFxPermission` directly instead of ever replying to the RPC itself.
 * Whichever gets there first deletes the map entry, so the other two become
 * no-ops (`answer*` returns `false` / the id is already gone) — no request
 * is ever answered twice.
 */

export type InteractionKind =
  | "ask_questions"   // claude built-in AskUserQuestion (scraper-sourced)
  | "tmux_prompt"     // unstructured in-REPL prompt detected by scraping the tmux pane
  | "fx_permission";  // fx ACP session/request_permission (real in-process awaiter)

/* ────────────────────────────────────────────────────────────────────────── *
 * Claude built-in AskUserQuestion (scraper-sourced).
 *
 * AskUserQuestion's tool body is "block until the human answers in the TUI".
 * Since agetor drives claude detached in tmux, that native Ink modal is
 * invisible to the user. The scraper in `claude-tmux.ts` detects it on the
 * pane and parses the structured `questions` out of it (claude does not write
 * the tool_use to the JSONL while the modal is open, so the pane is the only
 * live source), then surfaces it as a structured card. The answer is driven
 * back as keystrokes (`planAskAnswers` + `driveAskAnswers`) — a typed custom
 * answer goes into the modal's native `Type something` row via `send-keys -l`.
 * Only what can't be driven takes the message-mode fallback: custom text that
 * is multiline, over-long or carries control characters (`unsafe-custom`),
 * custom text for a question with no `Type something` row (`no-type-row`), an
 * empty answer, an unknown option or an arity mismatch (all decided by
 * `planAskAnswers`), and a drive whose typed step could not be delivered or
 * verified (`driveAskAnswers` returning `"typed-abort"`). That fallback
 * dismisses the modal (`dismissAskModalForMessage`: Escape, verify it left the
 * pane, clear a leftover composer draft) and sends a follow-up turn. There is
 * no blocking hook curl.
 * ────────────────────────────────────────────────────────────────────────── */

/** One question inside an AskUserQuestion tool call (claude code shape). */
export interface AskQuestion {
  /** Cursor `questions[].id`. Absent on scraper cards. */
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** `preview` is the multi-line code/text block claude attaches to an option
   *  (rendered as a side box in the TUI). Two sources can populate it: the JSONL
   *  tool_use (available only after the modal is answered, so in practice not
   *  while the card is live), and the live pane scrape, which grows the pane and walks each option to read its panel
   *  (see `collectAskQuestionsFromPane`). */
  options: Array<{ id?: string; label: string; description?: string; preview?: string }>;
  /** Live-pane scrapes only: whether the modal has an inline "Type something"
   *  row for a typed custom answer. `false` for the preview layout (bare
   *  `Chat about this`), where typed characters would act as hotkeys; absent
   *  means unknown / the normal layout. */
  hasTypeRow?: boolean;
}

export interface AskQuestionsRequest {
  kind: "ask_questions";
  id: string;
  taskId: string;
  runId: string;
  /** Set when `taskId` is a hidden pipeline STEP task — that step's parent
   *  (board card) id, resolved once at registration. Rides the per-task
   *  `interaction` SSE payload and the app-level `interaction` GlobalEvent
   *  so parent-scoped consumers (toasts, TUI rows, the parent's own pending
   *  list) don't have to resolve the step row themselves. Absent for an
   *  ordinary task. */
  pipelineParentId?: string;
  questions: AskQuestion[];
  createdAt: number;
  /**
   * How the answer is delivered. `"scraper"` is Claude's pane modal
   * (keystrokes via `planAskAnswers` + `driveAskAnswers`). `"cursor"` is an
   * ACP `cursor/ask_question` awaiter: the answer route resolves the promise
   * instead of sending keys.
   */
  source?: "scraper" | "cursor";
  /** Cursor tool title (`args.title`). Omitted when the call set none. */
  title?: string;
  /** Raw Cursor tool-call id. Stored for the row key; never a URL segment. */
  toolCallId?: string;
  /**
   * `"live"` while a child is blocked on the RPC. `"restart-followup"` when
   * that RPC is gone: Submit and Skip send the next user message.
   * `followupCause` says why. `"restart"` is a boot rebuild. `"child-exit"`
   * is the cursor-agent process leaving while Agetor stayed up. Absent on a
   * follow-up means restart.
   */
  delivery?: "live" | "restart-followup";
  followupCause?: "restart" | "child-exit";
  /** Pane fingerprint — used by the scraper for two-tick stability, dup
   *  suppression, and auto-cancel when the modal leaves the pane. */
  fingerprint?: string;
}

/** What a Cursor ask promise resolves to. The driver turns this into the
 *  nested ACP result. Labels have already been mapped to option ids. */
export type CursorAskAnswer =
  | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[]; freeformText?: string }> }
  | { outcome: "skipped" }
  | { outcome: "cancelled" };

export interface CursorAskQuestionInput {
  id: string;
  prompt?: string | null;
  promptMarkdown?: string | null;
  allowMultiple?: boolean;
  options: Array<{ id: string; label: string }>;
}

export interface AskQuestionsAnswer {
  /** One entry per question in `AskQuestionsRequest.questions`, same order.
   *  `selected` is option labels. `selectedOptionIds`, when set, picks those
   *  ids instead, which is what distinguishes two options that share a label.
   *  At least one of `selected` / `selectedOptionIds` / `custom` must be
   *  non-empty per question. */
  answers: Array<{ selected: string[]; selectedOptionIds?: string[]; custom?: string }>;
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
  /** Set when `taskId` is a hidden pipeline STEP task — that step's parent
   *  (board card) id, resolved once at registration. Rides the per-task
   *  `interaction` SSE payload and the app-level `interaction` GlobalEvent
   *  so parent-scoped consumers (toasts, TUI rows, the parent's own pending
   *  list) don't have to resolve the step row themselves. Absent for an
   *  ordinary task. */
  pipelineParentId?: string;
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
  /** Which arrow-key pair the dismissal path presses to walk the cursor
   *  from `cursorIndex` to the chosen index. `undefined`/`"vertical"` ⇒
   *  `Down`/`Up` (Ink select-input: permission modals, numbered pickers).
   *  `"horizontal"` ⇒ `Right`/`Left` (claude 2.1.245's `/effort` slider,
   *  which reads "←/→ to adjust · Enter to confirm"). */
  nav?: "vertical" | "horizontal";
  /** Key that confirms the highlighted choice on the arrow-nav path in
   *  place of Enter — `undefined` for every modal but claude 2.1.245's bare
   *  `/model` picker, whose footer offers `s to use this session only`
   *  alongside the default `Enter to set as default`. A card click through
   *  agetor must not mutate the user's *global* claude default the way a
   *  plain Enter there would; `task.model` still syncs from claude's own
   *  `<local-command-stdout>` regardless of which key confirmed the picker
   *  (docs/plans/model-effort-local-command-turns.md §2, §8 Q6). Set by
   *  `matchNumberedModal` (claude-tmux.ts) whenever the footer text is
   *  present — evidence-gated, not a `/model`-specific special case — and
   *  consumed by `dismissTmuxPrompt`'s `ctx.confirmKey`. Deliberately not
   *  mirrored into the webview (`src/mainview/lib/api.ts`): the UI never
   *  reads it, same as `nav`. */
  confirmKey?: string;
  /** Stable hash of the matched block — used to debounce duplicate
   *  registrations across consecutive scrapes and to detect external
   *  dismissal (the prompt disappeared from the pane). */
  fingerprint: string;
  createdAt: number;
  /** True when this card is the fallback for a prompt no real matcher
   *  parsed — `choices` is empty and there's no keystroke path back into
   *  the pane. The UI renders a distinct "answer it in the terminal" card
   *  instead of choice buttons; the answer route still accepts only
   *  `__external__` / `__cancelled__` since there are no real choices to
   *  validate against. */
  unparsable?: boolean;
}

export interface TmuxPromptAnswer {
  /** Must equal one of the keys advertised on the request. The route
   *  validates this before sending keystrokes to tmux. The sentinel
   *  `"__external__"` is reserved for the scraper's auto-cancel path
   *  (the prompt vanished from the pane on its own — e.g. user
   *  attached to tmux and answered directly). */
  key: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * fx ACP `session/request_permission` (real in-process awaiter).
 *
 * Unlike the scraper-sourced kinds above, fx is a plain `Bun.spawn` child
 * speaking JSON-RPC over piped stdio (`fx-acp.ts`) — there is no tmux pane to
 * scrape and no keystroke path back in. `session/request_permission` blocks
 * fx's turn until agetor answers the RPC call, so this kind follows the
 * `tmux_prompt` structural pattern exactly: `registerFxPermission` hands the
 * driver a real Promise it awaits directly, and `answerFxPermission` resolves
 * it from whichever settlement path gets there first. See the "Settlement
 * invariant" section of `src/bun/fx-acp.ts`'s header for the single
 * authoritative statement of which path is allowed to win.
 * ────────────────────────────────────────────────────────────────────────── */

/** The ACP tool call a permission request is asking about. Mirrors
 *  ACP's `ToolCallUpdate` shape, trimmed to what the card needs to render —
 *  only `toolCallId` is guaranteed present on the wire; `title`/`kind`/
 *  `rawInput` are optional per schema and rendered generically when absent. */
export interface FxPermissionToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
}

/** One selectable option fx offered for a permission request. `kind` is a
 *  hint from ACP's `PermissionOptionKind` (`allow_once` | `allow_always` |
 *  `reject_once` | `reject_always`) but kept as a plain optional string —
 *  fx additionally documents session-scoped approvals ("Allow for this
 *  session") beyond the four canonical kinds, so the card renders fx's own
 *  option `name`s verbatim rather than hardcoding a fixed set. */
export interface FxPermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface FxPermissionRequest {
  kind: "fx_permission";
  id: string;
  taskId: string;
  runId: string;
  /** Set when `taskId` is a hidden pipeline STEP task — that step's parent
   *  (board card) id, resolved once at registration. Rides the per-task
   *  `interaction` SSE payload and the app-level `interaction` GlobalEvent
   *  so parent-scoped consumers (toasts, TUI rows, the parent's own pending
   *  list) don't have to resolve the step row themselves. Absent for an
   *  ordinary task. */
  pipelineParentId?: string;
  createdAt: number;
  toolCall: FxPermissionToolCall;
  options: FxPermissionOption[];
  /** The agetor mode that caused this request to surface as a card in the
   *  first place — `yolo` auto-allows and never reaches this registry.
   *  Carried through so the UI can tailor copy without having to re-derive
   *  it from the task row. */
  mode: "auto" | "ask";
}

/** `{ optionId }` echoes the user's pick straight back to fx's
 *  `outcome: { outcome: "selected", optionId }`. `{ cancelled: true }` is the
 *  Stop/delete/driver-teardown path — mirrors `TmuxPromptAnswer`'s
 *  `"__cancelled__"` sentinel idiom, but as a real discriminant since fx's
 *  RPC reply is itself a `{outcome: "cancelled"}` shape rather than a bare
 *  key string. */
export type FxPermissionAnswer =
  | { optionId: string }
  | { cancelled: true };

export type AnyRequest =
  | AskQuestionsRequest
  | TmuxPromptRequest
  | FxPermissionRequest;

interface AskQuestionsEntry {
  req: AskQuestionsRequest;
  /** Scraper cards: no-op. Cursor cards also set `resolveCursor`. */
  resolve: (answer: AskQuestionsAnswer) => void;
  resolveCursor?: (answer: CursorAskAnswer) => void;
  cursorAnswer?: Promise<CursorAskAnswer>;
}
interface TmuxPromptEntry {
  req: TmuxPromptRequest;
  resolve: (answer: TmuxPromptAnswer) => void;
}
interface FxPermissionEntry {
  req: FxPermissionRequest;
  resolve: (answer: FxPermissionAnswer) => void;
}

const askQuestions = new Map<string, AskQuestionsEntry>();
/** `taskId + toolCallId` → interaction id. A second register returns the card already here. */
const cursorAskByTool = new Map<string, string>();

function cursorAskKey(taskId: string, toolCallId: string): string {
  return `${taskId}\0${toolCallId}`;
}
const tmuxPrompts = new Map<string, TmuxPromptEntry>();
const fxPermissions = new Map<string, FxPermissionEntry>();

/**
 * `"register"` is a new card (also raises the app-level pending alert).
 * `"update"` republishes a card the panel already has — a delivery change
 * after the child exits. It must not count as a second pending prompt.
 */
export type InteractionBroadcastReason = "register" | "update";

type BroadcastFn = (req: AnyRequest, reason?: InteractionBroadcastReason) => void;
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
  /** Mirrors the request's `pipelineParentId` — see `AskQuestionsRequest`. */
  pipelineParentId?: string;
}

type ResolveBroadcastFn = (res: InteractionResolved) => void;
let broadcastResolved: ResolveBroadcastFn = () => { /* installed by the orchestrator */ };

type RunEventEmitter = (event: RunEvent) => void;
let emitRunEvent: RunEventEmitter = () => { /* installed by the orchestrator */ };

/**
 * Persist the `tool_result` that closes an `askQuestionToolCall` block.
 * The live child usually sends this as `tool_call_update` `completed`.
 * Cancel (Stop, archive, delete) and a fake answer have no such update,
 * so the block would stay forced open. A second write for the same tool
 * id is a no-op (`INSERT OR IGNORE` on `tool_call:<id>:completed`). A
 * missing run row is ignored: the card still resolves.
 */
export function recordCursorAskToolResult(args: {
  taskId: string;
  runId: string;
  toolCallId: string;
  content: unknown;
}): void {
  if (!args.toolCallId) return;
  const data = JSON.stringify({
    toolUseId: args.toolCallId,
    content: args.content,
    isError: false,
  });
  const lineUuid = `tool_call:${args.toolCallId}:completed`;
  let inserted: ReturnType<typeof runs.appendEvent>;
  try {
    inserted = runs.appendEvent(args.runId, "tool_result", data, lineUuid);
  } catch {
    return;
  }
  if (inserted == null) return;
  try {
    emitRunEvent({
      runId: args.runId,
      taskId: args.taskId,
      stream: "tool_result",
      data,
      ts: inserted.ts,
      id: inserted.id,
    });
  } catch {
    /* the row is already the record */
  }
}

/** The orchestrator installs its SSE fan-out. Returns the previous fn. */
export function setRunEventEmitter(fn: RunEventEmitter): RunEventEmitter {
  const prev = emitRunEvent;
  emitRunEvent = fn;
  return prev;
}

/**
 * The orchestrator hands us its event emitter so we can fan out new
 * interactions on the same SSE stream the UI is already subscribed to.
 * Kept as a setter (rather than a constructor dep) because this module is
 * imported by the server before the orchestrator's listener is registered.
 * Returns the previously installed fn so a test overriding it can restore it.
 */
export function setBroadcaster(fn: BroadcastFn): BroadcastFn {
  const prev = broadcast;
  broadcast = fn;
  return prev;
}

/**
 * Companion to `setBroadcaster` for the *removal* side: every `answer*`
 * call and `cancelPendingForTask` path emits one of these so the UI can
 * drop the resolved card without waiting for a polling refresh. Without
 * this, scraper auto-cancel and run-cancellation leave stale cards in
 * the run panel until the user closes and reopens it. Returns the
 * previously installed fn, like `setBroadcaster`.
 */
export function setResolvedBroadcaster(fn: ResolveBroadcastFn): ResolveBroadcastFn {
  const prev = broadcastResolved;
  broadcastResolved = fn;
  return prev;
}

/** Internal helper — every answer* / cancel* path that deletes from one
 *  of the maps should call this with the request it removed so the UI
 *  hears about it. */
function fanoutResolved(req: AnyRequest): void {
  broadcastResolved({
    id: req.id,
    taskId: req.taskId,
    runId: req.runId,
    kind: req.kind,
    ...(req.pipelineParentId !== undefined ? { pipelineParentId: req.pipelineParentId } : {}),
  });
}

/** `tasks.get(taskId)?.pipelineParentId`, as the optional-field spread every
 *  `register*` below stamps onto its request — `undefined` (key omitted, so
 *  existing JSON shapes stay byte-identical) for an ordinary task, an
 *  unknown task id, or when the db can't answer (never throws: a
 *  registration must not fail because of a parent lookup). */
function pipelineParentFor(taskId: string): { pipelineParentId?: string } {
  try {
    const parentId = tasks.get(taskId)?.pipelineParentId;
    return typeof parentId === "string" && parentId.length > 0 ? { pipelineParentId: parentId } : {};
  } catch {
    return {};
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * AskUserQuestion — scraper-sourced.
 *
 * Claude renders its native Ink modal in the tmux pane. The scraper detects
 * it, parses the structured `questions` from the pane (the JSONL tool_use only
 * lands once the modal is answered, so it is never available while the card is
 * live), and registers it here. There is no blocking curl to resolve — the
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
    ...pipelineParentFor(args.taskId),
    questions: args.questions,
    createdAt: Date.now(),
    source: "scraper",
    fingerprint: args.fingerprint,
  };
  // No awaiter — the answer is driven via send-keys, not a promise resolve.
  askQuestions.set(id, { req, resolve: () => { /* scraper-sourced: no hook promise */ } });
  // The orchestrator's `emit` fan-out has no per-listener try/catch, so a
  // throwing listener must not strand this entry as a phantom pending card.
  try {
    broadcast(req);
  } catch (err) {
    askQuestions.delete(id);
    // Tell the UI the card is gone too — without this, a listener that
    // throws after an earlier listener already pushed the card over SSE
    // leaves a zombie card the user can never dismiss. A throw from the
    // resolved-broadcast itself must not mask the original error.
    try {
      fanoutResolved(req);
    } catch {
      /* swallow — the original broadcast error below is authoritative */
    }
    throw err;
  }
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

export interface RegisterCursorAskArgs {
  taskId: string;
  runId: string;
  toolCallId: string;
  title?: string;
  questions: CursorAskQuestionInput[];
  delivery: "live" | "restart-followup";
  /** Set with `"restart-followup"`. Omitted on a live card. */
  followupCause?: "restart" | "child-exit";
  /** When false, the row already exists (boot rebuild). Default true. */
  persist?: boolean;
}

/**
 * Register a Cursor `cursor/ask_question` card and return the promise the
 * driver awaits. A second call for the same task and tool-call id returns
 * the card already registered, including its original promise.
 */
export function registerCursorAskQuestions(args: RegisterCursorAskArgs): {
  id: string;
  req: AskQuestionsRequest;
  answer: Promise<CursorAskAnswer>;
} {
  const key = cursorAskKey(args.taskId, args.toolCallId);
  const existingId = cursorAskByTool.get(key);
  if (existingId) {
    const existing = askQuestions.get(existingId);
    if (existing?.cursorAnswer && existing.resolveCursor) {
      return { id: existingId, req: existing.req, answer: existing.cursorAnswer };
    }
  }

  const questions: AskQuestion[] = args.questions.map((q) => ({
    id: q.id,
    question: questionText(q.prompt, q.promptMarkdown),
    multiSelect: q.allowMultiple === true,
    options: q.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  const title = typeof args.title === "string" && args.title.length > 0 ? args.title : undefined;
  const id = randomUUID();
  const req: AskQuestionsRequest = {
    kind: "ask_questions",
    id,
    taskId: args.taskId,
    runId: args.runId,
    ...pipelineParentFor(args.taskId),
    questions,
    createdAt: Date.now(),
    source: "cursor",
    toolCallId: args.toolCallId,
    delivery: args.delivery,
    ...(args.delivery === "restart-followup" && args.followupCause ? { followupCause: args.followupCause } : {}),
    ...(title !== undefined ? { title } : {}),
  };
  if (args.persist !== false) {
    insertCursorAsk({
      taskId: args.taskId,
      toolCallId: args.toolCallId,
      runId: args.runId,
      payload: {
        ...(title !== undefined ? { title } : {}),
        questions: args.questions.map((q) => ({
          id: q.id,
          prompt: questionText(q.prompt, q.promptMarkdown),
          allowMultiple: q.allowMultiple === true,
          options: q.options.map((o) => ({ id: o.id, label: o.label })),
        })),
      },
    });
  }
  let resolveCursor!: (answer: CursorAskAnswer) => void;
  const cursorAnswer = new Promise<CursorAskAnswer>((resolve) => {
    resolveCursor = resolve;
  });
  askQuestions.set(id, { req, resolve: () => { /* cursor: the awaiter is resolveCursor */ }, resolveCursor, cursorAnswer });
  cursorAskByTool.set(key, id);
  try {
    broadcast(req);
  } catch (err) {
    askQuestions.delete(id);
    cursorAskByTool.delete(key);
    try {
      fanoutResolved(req);
    } catch {
      /* the original broadcast error is authoritative */
    }
    throw err;
  }
  return { id, req, answer: cursorAnswer };
}

/** Write the outcome, then resolve the Cursor awaiter. Returns false when
 *  the id is unknown or is not a Cursor card. */
export function answerCursorAsk(id: string, answer: CursorAskAnswer): boolean {
  const entry = askQuestions.get(id);
  if (!entry?.resolveCursor) return false;
  const toolCallId = entry.req.toolCallId;
  if (toolCallId) resolveCursorAsk(entry.req.taskId, toolCallId, answer.outcome);
  askQuestions.delete(id);
  cursorAskByTool.delete(cursorAskKey(entry.req.taskId, toolCallId ?? ""));
  entry.resolveCursor(answer);
  fanoutResolved(entry.req);
  return true;
}

/**
 * The child blocked on these RPCs has exited. Keep each still-open live
 * card for this run, switch it to the restart follow-up, and release the
 * driver's awaiter with `cancelled` without writing an outcome. A later
 * submit then sends the next user message. The row stays unanswered, so a
 * restart can rebuild it. The same card id is republished so an open panel
 * replaces "Cursor is waiting" with the child-exit copy, not the boot
 * restart sentence. Other runs, follow-ups already retargeted, and scraper
 * cards are left alone.
 */
export function retargetLiveCursorAsksForRun(runId: string): void {
  for (const entry of askQuestions.values()) {
    if (entry.req.runId !== runId) continue;
    if (entry.req.source !== "cursor" || entry.req.delivery !== "live") continue;
    if (!entry.resolveCursor) continue;
    const releaseDriver = entry.resolveCursor;
    let resolveCursor!: (answer: CursorAskAnswer) => void;
    const cursorAnswer = new Promise<CursorAskAnswer>((resolve) => {
      resolveCursor = resolve;
    });
    entry.resolveCursor = resolveCursor;
    entry.cursorAnswer = cursorAnswer;
    entry.req.delivery = "restart-followup";
    entry.req.followupCause = "child-exit";
    // Release the dead child's awaiter before publishing. A throwing
    // listener must not leave this card, or the next one, blocked on a
    // process that has already exited.
    releaseDriver({ outcome: "cancelled" });
    try {
      broadcast(entry.req, "update");
    } catch {
      /* the in-memory card is already the follow-up */
    }
  }
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
  nav?: "vertical" | "horizontal";
  fingerprint: string;
  unparsable?: boolean;
  confirmKey?: string;
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
  // Defensive, not load-bearing today: `matchNumberedModal` is the only
  // producer of `confirmKey` and only ever sets `"s"`. But this is the seam
  // a future matcher goes through too, and `dismissTmuxPrompt` sends
  // whatever arrives here straight to `tmux send-keys` — reject anything
  // that isn't a single printable ASCII letter so a bug (or a hostile
  // producer) can never smuggle a key *name* like `"Enter"` or `"C-c"`
  // through this field.
  if (args.confirmKey !== undefined && !/^[A-Za-z]$/.test(args.confirmKey)) {
    throw new Error(
      `registerTmuxPrompt: confirmKey '${args.confirmKey}' must be a single printable ASCII letter`,
    );
  }
  const id = randomUUID();
  const req: TmuxPromptRequest = {
    kind: "tmux_prompt",
    id,
    taskId: args.taskId,
    runId: args.runId,
    ...pipelineParentFor(args.taskId),
    paneText: args.paneText,
    choices: args.choices,
    cursorIndex: args.cursorIndex,
    nav: args.nav,
    fingerprint: args.fingerprint,
    createdAt: Date.now(),
    unparsable: args.unparsable,
    confirmKey: args.confirmKey,
  };
  const answer = new Promise<TmuxPromptAnswer>((resolve) => {
    tmuxPrompts.set(id, { req, resolve });
  });
  // The orchestrator's `emit` fan-out has no per-listener try/catch, so a
  // throwing listener must not strand this entry as a phantom pending card.
  try {
    broadcast(req);
  } catch (err) {
    tmuxPrompts.delete(id);
    // Tell the UI the card is gone too — without this, a listener that
    // throws after an earlier listener already pushed the card over SSE
    // leaves a zombie card the user can never dismiss. A throw from the
    // resolved-broadcast itself must not mask the original error.
    try {
      fanoutResolved(req);
    } catch {
      /* swallow — the original broadcast error below is authoritative */
    }
    throw err;
  }
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
 * fx ACP permission requests
 * ────────────────────────────────────────────────────────────────────────── */

export function registerFxPermission(args: {
  taskId: string;
  runId: string;
  toolCall: FxPermissionToolCall;
  options: FxPermissionOption[];
  mode: "auto" | "ask";
}): { id: string; req: FxPermissionRequest; answer: Promise<FxPermissionAnswer> } {
  const id = randomUUID();
  const req: FxPermissionRequest = {
    kind: "fx_permission",
    id,
    taskId: args.taskId,
    runId: args.runId,
    ...pipelineParentFor(args.taskId),
    createdAt: Date.now(),
    toolCall: args.toolCall,
    options: args.options,
    mode: args.mode,
  };
  const answer = new Promise<FxPermissionAnswer>((resolve) => {
    fxPermissions.set(id, { req, resolve });
  });
  // The orchestrator's `emit` fan-out has no per-listener try/catch, so a
  // throwing listener must not strand this entry as a phantom pending card.
  try {
    broadcast(req);
  } catch (err) {
    fxPermissions.delete(id);
    // Tell the UI the card is gone too — without this, a listener that
    // throws after an earlier listener already pushed the card over SSE
    // leaves a zombie card the user can never dismiss. A throw from the
    // resolved-broadcast itself must not mask the original error.
    try {
      fanoutResolved(req);
    } catch {
      /* swallow — the original broadcast error below is authoritative */
    }
    throw err;
  }
  return { id, req, answer };
}

export function answerFxPermission(id: string, answer: FxPermissionAnswer): boolean {
  const entry = fxPermissions.get(id);
  if (!entry) return false;
  fxPermissions.delete(id);
  entry.resolve(answer);
  fanoutResolved(entry.req);
  return true;
}

/** Look up a pending fx_permission by id — used by the route handler to
 *  validate the chosen `optionId` against the recorded options before
 *  resolving the driver's awaiter. */
export function findFxPermissionById(id: string): FxPermissionRequest | null {
  return fxPermissions.get(id)?.req ?? null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Shared helpers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve every pending interaction for this task with a synthetic
 * "cancelled" answer so subprocess waiters unblock immediately. Called from
 * cancelRun (Stop button), deleteTask, and archiveTask — including an
 * archive that has no live run. A Cursor card writes `cancelled` on
 * `cursor_asks` (never `skipped`) and a `tool_result` for that tool call,
 * so the ask block can close. If we just kill the tmux session without
 * doing this first, the in-flight curl / MCP children would hang until
 * their HTTP timeout instead of returning cleanly.
 */
export function cancelPendingForTask(taskId: string, reason: string): void {
  for (const [id, entry] of askQuestions) {
    if (entry.req.taskId !== taskId) continue;
    askQuestions.delete(id);
    if (entry.resolveCursor) {
      const toolCallId = entry.req.toolCallId;
      if (toolCallId) {
        cursorAskByTool.delete(cursorAskKey(taskId, toolCallId));
        resolveCursorAsk(taskId, toolCallId, "cancelled");
        recordCursorAskToolResult({
          taskId,
          runId: entry.req.runId,
          toolCallId,
          content: "cancelled",
        });
      }
      entry.resolveCursor({ outcome: "cancelled" });
    } else {
      entry.resolve({
        answers: entry.req.questions.map(() => ({ selected: [], custom: reason })),
      });
    }
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
  for (const [id, entry] of fxPermissions) {
    if (entry.req.taskId !== taskId) continue;
    fxPermissions.delete(id);
    // Unblocks the fx-acp driver's awaiter — it answers fx's RPC with
    // `outcome: "cancelled"` instead of ever registering a resolved pick.
    entry.resolve({ cancelled: true });
    fanoutResolved(entry.req);
  }
}

export function listPendingForTask(taskId: string): AnyRequest[] {
  const out: AnyRequest[] = [];
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) out.push(e.req);
  for (const e of tmuxPrompts.values()) if (e.req.taskId === taskId) out.push(e.req);
  for (const e of fxPermissions.values()) if (e.req.taskId === taskId) out.push(e.req);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Cheap counter used by `tasks.list()` / `tasks.get()` to surface the
 *  pending-interaction badge on each kanban card without serializing the
 *  full payloads. Linear scan over the small in-memory Maps. */
export function countPendingForTask(taskId: string): number {
  let n = 0;
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) n++;
  for (const e of tmuxPrompts.values()) if (e.req.taskId === taskId) n++;
  for (const e of fxPermissions.values()) if (e.req.taskId === taskId) n++;
  return n;
}

/** Grouped counts of pending interactions across every task in one pass over
 *  both in-memory maps — used by `tasks.list()` so the 2s `/tasks` poll does
 *  a single scan instead of calling `countPendingForTask` per task row. */
export function pendingCountsByTask(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of askQuestions.values()) {
    counts.set(e.req.taskId, (counts.get(e.req.taskId) ?? 0) + 1);
  }
  for (const e of tmuxPrompts.values()) {
    counts.set(e.req.taskId, (counts.get(e.req.taskId) ?? 0) + 1);
  }
  for (const e of fxPermissions.values()) {
    counts.set(e.req.taskId, (counts.get(e.req.taskId) ?? 0) + 1);
  }
  return counts;
}

/** Test-only handle for asserting the registry state. */
export const __testing = {
  askQuestionsSize: () => askQuestions.size,
  tmuxPromptsSize: () => tmuxPrompts.size,
  fxPermissionsSize: () => fxPermissions.size,
  /** Clears the registry. The broadcasters stay as installed: they are the
   *  process-wide bridges orchestrator.ts installs once at load, and resetting
   *  them here silently detached the global `interaction` events for every
   *  later test file in the same `bun test` process. A test that overrides a
   *  broadcaster restores it through the setter's returned previous fn. */
  reset() {
    askQuestions.clear();
    cursorAskByTool.clear();
    tmuxPrompts.clear();
    fxPermissions.clear();
  },
};
