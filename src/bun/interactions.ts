import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  derivePermissionEntry,
  matchesPermissionEntry,
  type ApprovalRememberScope,
} from "../shared/claude-permissions.ts";
import { tasks } from "./db.ts";

/**
 * In-process registry for user interactions claude needs to drive through
 * agetor's UI: tool-call approvals (PreToolUse hook) and clarifying questions
 * (ask_user MCP tool). Both follow the same shape — a localhost POST from a
 * subprocess that we hold open via a Promise until the user clicks Send.
 *
 * Everything here is in-memory. Pending interactions don't survive an agetor
 * restart, by design: on boot we kill all `agetor-*` tmux sessions, which
 * tears down the curl / MCP children waiting on these promises. Allow-rules
 * (the "Allow always for this task" persistent decisions) live as native
 * claude permission strings in the task cwd's `.claude/settings.local.json`
 * — see `saveAllowRule` / `lookupAllowRule` below.
 */

export type InteractionKind =
  | "approval"
  | "question"
  | "ask_questions"   // claude built-in AskUserQuestion intercepted via PreToolUse hook
  | "plan_approval";  // claude built-in ExitPlanMode intercepted via PreToolUse hook

export interface ApprovalRequest {
  kind: "approval";
  id: string;
  taskId: string;
  runId: string;
  toolName: string;
  /** Verbatim tool_input from the PreToolUse hook payload. */
  toolInput: unknown;
  createdAt: number;
}

export interface ApprovalAnswer {
  /** allow / deny are the user-driven outcomes. `ask` is reserved for the
   *  server's fail-open path — when we couldn't make a decision, fall
   *  through to claude's TUI behaviour. */
  decision: "allow" | "deny" | "ask";
  /** Surfaced to claude as `permissionDecisionReason`. */
  reason?: string;
  /** When true and decision=allow, save a permission rule to the task's
   *  `.claude/settings.local.json` so future matching tool calls auto-allow. */
  remember?: boolean;
  /** Optional permission entry string (claude syntax — see claude-permissions.ts)
   *  that the UI's granularity chooser already resolved to. When absent and
   *  `remember=true`, the server falls back to the most-specific scope for
   *  the tool. */
  entry?: string;
}

export interface QuestionRequest {
  kind: "question";
  id: string;
  taskId: string;
  runId: string;
  question: string;
  /** Preset options. When present + multi=false the UI renders radios; when
   *  multi=true, checkboxes. Always paired with a free-text custom answer. */
  choices?: string[];
  multi?: boolean;
  createdAt: number;
}

export interface QuestionAnswer {
  /** Selected choice strings. Empty when the user only typed a custom answer. */
  selected: string[];
  /** Optional free-text addition. May be the only field set if the user
   *  declined the presets. */
  custom?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Claude built-in interactive tools (intercepted via PreToolUse hook).
 *
 * Claude code has two tools whose tool *body* is "block until the human
 * answers in the TUI": AskUserQuestion (clarifying multiple-choice) and
 * ExitPlanMode (plan approval). Since agetor drives claude detached in
 * tmux, that TUI modal is invisible to the user. We intercept these tools
 * via the PreToolUse hook and route them through the UI as structured
 * interactions, then return the user's answer to claude as the hook's
 * `permissionDecisionReason` (deny). Claude reads the reason as if it
 * were the modal's output and proceeds.
 * ────────────────────────────────────────────────────────────────────────── */

/** One question inside an AskUserQuestion tool call (claude code shape). */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface AskQuestionsRequest {
  kind: "ask_questions";
  id: string;
  taskId: string;
  runId: string;
  questions: AskQuestion[];
  createdAt: number;
}

export interface AskQuestionsAnswer {
  /** One entry per question in `AskQuestionsRequest.questions`, same order.
   *  Each may contain selected option labels and/or a free-text custom
   *  answer. At least one of `selected` / `custom` must be non-empty per
   *  question. */
  answers: Array<{ selected: string[]; custom?: string }>;
}

export interface PlanApprovalRequest {
  kind: "plan_approval";
  id: string;
  taskId: string;
  runId: string;
  /** The markdown plan claude generated. */
  plan: string;
  createdAt: number;
}

export interface PlanApprovalAnswer {
  /** approve_implement → auto-accept edits and proceed
   *  approve_ask       → proceed but ask before each edit
   *  reject            → don't proceed; let claude revise (`revision` carries
   *                      the user's free-text feedback) */
  choice: "approve_implement" | "approve_ask" | "reject";
  revision?: string;
}

export type AnyRequest =
  | ApprovalRequest
  | QuestionRequest
  | AskQuestionsRequest
  | PlanApprovalRequest;

/**
 * Tools we never bother the user about. Same list lives in the hook script
 * for the fast path; this set is the source of truth and lets the server
 * short-circuit on the slow path too (e.g., if a future tool somehow slips
 * past the script check).
 */
export const SAFE_TOOLS = new Set<string>([
  "Read", "LS", "Glob", "Grep", "NotebookRead",
]);

interface ApprovalEntry {
  req: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
}
interface QuestionEntry {
  req: QuestionRequest;
  resolve: (answer: QuestionAnswer) => void;
}
interface AskQuestionsEntry {
  req: AskQuestionsRequest;
  resolve: (answer: AskQuestionsAnswer) => void;
}
interface PlanApprovalEntry {
  req: PlanApprovalRequest;
  resolve: (answer: PlanApprovalAnswer) => void;
}

const approvals = new Map<string, ApprovalEntry>();
const questions = new Map<string, QuestionEntry>();
const askQuestions = new Map<string, AskQuestionsEntry>();
const planApprovals = new Map<string, PlanApprovalEntry>();

type BroadcastFn = (req: AnyRequest) => void;
let broadcast: BroadcastFn = () => { /* installed by the orchestrator */ };

/**
 * The orchestrator hands us its event emitter so we can fan out new
 * interactions on the same SSE stream the UI is already subscribed to.
 * Kept as a setter (rather than a constructor dep) because this module is
 * imported by the server before the orchestrator's listener is registered.
 */
export function setBroadcaster(fn: BroadcastFn): void {
  broadcast = fn;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Approvals
 * ────────────────────────────────────────────────────────────────────────── */

export interface RegisterApprovalArgs {
  taskId: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
}

export function registerApproval(args: RegisterApprovalArgs): {
  id: string;
  answer: Promise<ApprovalAnswer>;
} {
  const id = randomUUID();
  const req: ApprovalRequest = {
    kind: "approval",
    id,
    taskId: args.taskId,
    runId: args.runId,
    toolName: args.toolName,
    toolInput: args.toolInput,
    createdAt: Date.now(),
  };
  const answer = new Promise<ApprovalAnswer>((resolve) => {
    approvals.set(id, { req, resolve });
  });
  broadcast(req);
  return { id, answer };
}

export function answerApproval(id: string, answer: ApprovalAnswer): boolean {
  const pending = approvals.get(id);
  if (!pending) return false;
  approvals.delete(id);
  if (answer.decision === "allow" && answer.remember) {
    saveAllowRule({
      taskId: pending.req.taskId,
      toolName: pending.req.toolName,
      toolInput: pending.req.toolInput,
      entry: answer.entry,
    });
  }
  pending.resolve(answer);
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Questions
 * ────────────────────────────────────────────────────────────────────────── */

export interface RegisterQuestionArgs {
  taskId: string;
  runId: string;
  question: string;
  choices?: string[];
  multi?: boolean;
}

export function registerQuestion(args: RegisterQuestionArgs): {
  id: string;
  answer: Promise<QuestionAnswer>;
} {
  const id = randomUUID();
  const req: QuestionRequest = {
    kind: "question",
    id,
    taskId: args.taskId,
    runId: args.runId,
    question: args.question,
    choices: args.choices,
    multi: args.multi,
    createdAt: Date.now(),
  };
  const answer = new Promise<QuestionAnswer>((resolve) => {
    questions.set(id, { req, resolve });
  });
  broadcast(req);
  return { id, answer };
}

export function answerQuestion(id: string, answer: QuestionAnswer): boolean {
  const entry = questions.get(id);
  if (!entry) return false;
  questions.delete(id);
  entry.resolve(answer);
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * AskUserQuestion (claude built-in tool)
 * ────────────────────────────────────────────────────────────────────────── */

export function registerAskQuestions(args: {
  taskId: string;
  runId: string;
  questions: AskQuestion[];
}): { id: string; req: AskQuestionsRequest; answer: Promise<AskQuestionsAnswer> } {
  const id = randomUUID();
  const req: AskQuestionsRequest = {
    kind: "ask_questions",
    id,
    taskId: args.taskId,
    runId: args.runId,
    questions: args.questions,
    createdAt: Date.now(),
  };
  const answer = new Promise<AskQuestionsAnswer>((resolve) => {
    askQuestions.set(id, { req, resolve });
  });
  broadcast(req);
  return { id, req, answer };
}

export function answerAskQuestions(id: string, answer: AskQuestionsAnswer): boolean {
  const entry = askQuestions.get(id);
  if (!entry) return false;
  askQuestions.delete(id);
  entry.resolve(answer);
  return true;
}

/**
 * Sentinel prefixes for the natural-language strings agetor sends back to
 * claude as `permissionDecisionReason` when intercepting AskUserQuestion /
 * ExitPlanMode. Exported because the JSONL tailer in `claude-tmux.ts` matches
 * on these prefixes to distinguish "user answered (success)" from "tool call
 * denied (real error)" — both arrive with `is_error: true` since the hook
 * reply is `decision: "deny"`. Keep formatter output and prefix in lockstep;
 * changing one without the other silently breaks the override.
 */
export const ASK_QUESTIONS_REPLY_PREFIX = "User has answered your questions:";
export const PLAN_APPROVED_REPLY_PREFIX = "User approved the plan";
export const PLAN_REJECTED_REPLY_PREFIX = "User rejected the plan";

/**
 * Build claude's canonical "User has answered your questions" string from
 * the user's picks. Claude generates this format internally when its TUI
 * modal closes; we mimic it so claude reads our deny reason as if it were
 * its own tool-result text and continues without confusion.
 */
export function formatAskQuestionsReason(
  req: AskQuestionsRequest,
  ans: AskQuestionsAnswer,
): string {
  // Mirror claude's own JSONL escaping for embedded quotes so a question
  // like `What about "X"?` doesn't produce ambiguous `"What about "X"?"`
  // syntax claude could mis-parse when it reads back the deny reason.
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const parts: string[] = [];
  req.questions.forEach((q, i) => {
    const a = ans.answers[i] ?? { selected: [] as string[] };
    const pieces: string[] = [...a.selected];
    if (a.custom && a.custom.trim()) pieces.push(a.custom.trim());
    const value = pieces.length === 0 ? "(no answer)" : pieces.join(", ");
    parts.push(`"${escape(q.question)}"="${escape(value)}"`);
  });
  return `${ASK_QUESTIONS_REPLY_PREFIX} ${parts.join(", ")}. You can now continue with the user's answers in mind.`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * ExitPlanMode (claude built-in tool)
 * ────────────────────────────────────────────────────────────────────────── */

export function registerPlanApproval(args: {
  taskId: string;
  runId: string;
  plan: string;
}): { id: string; answer: Promise<PlanApprovalAnswer> } {
  const id = randomUUID();
  const req: PlanApprovalRequest = {
    kind: "plan_approval",
    id,
    taskId: args.taskId,
    runId: args.runId,
    plan: args.plan,
    createdAt: Date.now(),
  };
  const answer = new Promise<PlanApprovalAnswer>((resolve) => {
    planApprovals.set(id, { req, resolve });
  });
  broadcast(req);
  return { id, answer };
}

export function answerPlanApproval(id: string, answer: PlanApprovalAnswer): boolean {
  const entry = planApprovals.get(id);
  if (!entry) return false;
  planApprovals.delete(id);
  entry.resolve(answer);
  return true;
}

/** Map a plan-approval choice into the natural-language string claude reads
 *  as the deny reason. Phrased as the user's response so claude can adapt
 *  its next turn without further prompting. */
export function formatPlanApprovalReason(ans: PlanApprovalAnswer): string {
  switch (ans.choice) {
    case "approve_implement":
      return `${PLAN_APPROVED_REPLY_PREFIX} and wants you to implement it now. Proceed with the edits — auto-accept changes (do not pause for per-edit approvals).`;
    case "approve_ask":
      return `${PLAN_APPROVED_REPLY_PREFIX} but wants you to confirm before each edit. Proceed with the implementation, asking for confirmation on each file change.`;
    case "reject": {
      const tail = ans.revision && ans.revision.trim()
        ? ` User feedback: ${ans.revision.trim()}`
        : " Revise the plan based on the feedback you receive in the next turn.";
      return `${PLAN_REJECTED_REPLY_PREFIX} and wants you to revise it.${tail}`;
    }
  }
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
  for (const [id, entry] of approvals) {
    if (entry.req.taskId !== taskId) continue;
    approvals.delete(id);
    entry.resolve({ decision: "deny", reason });
  }
  for (const [id, entry] of questions) {
    if (entry.req.taskId !== taskId) continue;
    questions.delete(id);
    entry.resolve({ selected: [], custom: reason });
  }
  for (const [id, entry] of askQuestions) {
    if (entry.req.taskId !== taskId) continue;
    askQuestions.delete(id);
    entry.resolve({
      answers: entry.req.questions.map(() => ({ selected: [], custom: reason })),
    });
  }
  for (const [id, entry] of planApprovals) {
    if (entry.req.taskId !== taskId) continue;
    planApprovals.delete(id);
    entry.resolve({ choice: "reject", revision: reason });
  }
}

export function listPendingForTask(taskId: string): AnyRequest[] {
  const out: AnyRequest[] = [];
  for (const e of approvals.values()) if (e.req.taskId === taskId) out.push(e.req);
  for (const e of questions.values()) if (e.req.taskId === taskId) out.push(e.req);
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) out.push(e.req);
  for (const e of planApprovals.values()) if (e.req.taskId === taskId) out.push(e.req);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Cheap counter used by `tasks.list()` / `tasks.get()` to surface the
 *  pending-interaction badge on each kanban card without serializing the
 *  full payloads. Linear scan over the four small in-memory Maps. */
export function countPendingForTask(taskId: string): number {
  let n = 0;
  for (const e of approvals.values()) if (e.req.taskId === taskId) n++;
  for (const e of questions.values()) if (e.req.taskId === taskId) n++;
  for (const e of askQuestions.values()) if (e.req.taskId === taskId) n++;
  for (const e of planApprovals.values()) if (e.req.taskId === taskId) n++;
  return n;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Allow-rules (persistent, stored as native claude permission entries in the
 * task cwd's `.claude/settings.local.json`)
 *
 * Why this storage shape rather than our own DB table:
 *   1. Human-readable — `cat .claude/settings.local.json` shows everything.
 *   2. Version-controllable — settings.local.json travels with the repo.
 *   3. Mirrors claude's conventions — no parallel system to learn.
 *
 * Note: claude itself never consults these entries in our setup — our
 * PreToolUse hook always returns a terminal decision before claude's
 * permission engine runs. We use claude's format purely as our storage.
 * ────────────────────────────────────────────────────────────────────────── */

export interface AllowRuleArgs {
  taskId: string;
  toolName: string;
  /** Verbatim tool_input from the PreToolUse payload. Needed for matching
   *  (does the saved pattern apply to this call?) and for default-derive
   *  on save (most-specific scope for the tool). */
  toolInput: unknown;
}

/** Look up whether the task has a saved allow-rule that matches this tool
 *  call. Walks `permissions.allow` in the task's effective settings file.
 *  Returns "allow" on first match, null otherwise. */
export function lookupAllowRule(args: AllowRuleArgs): "allow" | null {
  const cwd = resolveTaskCwd(args.taskId);
  if (!cwd) return null;
  for (const entry of readPermissionsAllow(cwd)) {
    if (matchesPermissionEntry(entry, args.toolName, args.toolInput)) return "allow";
  }
  return null;
}

/** Save an allow-rule for the task. If `entry` is supplied, it's stored
 *  verbatim. Otherwise the most-specific scope for the tool is derived from
 *  `toolInput`. Falls back to the bare tool name if no scope can be
 *  derived (always works). */
export function saveAllowRule(args: AllowRuleArgs & { entry?: string }): void {
  const cwd = resolveTaskCwd(args.taskId);
  if (!cwd) return;
  const entry = (args.entry && args.entry.trim()) || pickDefaultEntry(args.toolName, args.toolInput);
  if (!entry) return;
  appendPermissionEntry(cwd, entry);
}

/** Tool names whose `toolInput.file_path` is the canonical scoping key.
 *  Match the FILE_TOOLS set in claude-permissions.ts. Kept local so
 *  `pickDefaultEntry` can decide scope candidates without importing an
 *  internal symbol. */
const FILE_TOOLS_FOR_DEFAULT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Server-side default-derive: pick the most-specific scope for a tool
 *  when the UI didn't include an explicit `entry`. Always returns a
 *  non-null string — falls back to the bare tool name if scope-specific
 *  derive shapes are unavailable (e.g. malformed toolInput). Exported for
 *  tests. */
export function pickDefaultEntry(toolName: string, toolInput: unknown): string {
  const candidates: ApprovalRememberScope[] =
    toolName === "Bash" ? ["bash_exact", "tool"]
    : toolName === "WebFetch" ? ["host_exact", "tool"]
    : FILE_TOOLS_FOR_DEFAULT.has(toolName) ? ["path_exact", "tool"]
    : ["tool"];
  for (const scope of candidates) {
    const e = derivePermissionEntry(toolName, toolInput, scope);
    if (e) return e;
  }
  return toolName;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Settings file I/O
 * ────────────────────────────────────────────────────────────────────────── */

/** Effective cwd for a task: the worktree path if isolation produced one,
 *  otherwise the user's workdir. Returns null when the task no longer
 *  exists (e.g. cleanup races during shutdown). */
function resolveTaskCwd(taskId: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  return task.worktreePath ?? task.workdir ?? null;
}

/** Read the `permissions.allow` array from `<cwd>/.claude/settings.local.json`.
 *  Returns an empty array on missing file, parse errors, or unexpected shape
 *  — failing closed (the user just sees more cards, not fewer) is the right
 *  failure mode here. */
function readPermissionsAllow(cwd: string): string[] {
  const file = path.join(cwd, ".claude", "settings.local.json");
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const permissions = (parsed as Record<string, unknown>).permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return [];
  const allow = (permissions as Record<string, unknown>).allow;
  if (!Array.isArray(allow)) return [];
  return allow.filter((e): e is string => typeof e === "string");
}

/** Append a single `permissions.allow` entry to the task's settings file.
 *  Merge-safe: preserves all other keys, dedupes against existing entries.
 *  Creates the file if missing. Logs and skips on malformed pre-existing
 *  JSON rather than overwriting the user's edits. */
function appendPermissionEntry(cwd: string, entry: string): void {
  const dir = path.join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.local.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      console.error(
        `[agetor:interactions] cannot read ${file}: ${(e as Error).message}. ` +
        `Skipping allow-rule save.`,
      );
      return;
    }
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        } else {
          console.error(
            `[agetor:interactions] ${file} is not a JSON object (got ` +
            `${Array.isArray(parsed) ? "array" : typeof parsed}). Skipping allow-rule save.`,
          );
          return;
        }
      } catch (e) {
        console.error(
          `[agetor:interactions] refusing to merge: ${file} is not valid JSON. ` +
          `Fix or delete the file to re-enable allow-rule saves. (${(e as Error).message})`,
        );
        return;
      }
    }
  }

  const permissions = (settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions))
    ? settings.permissions as Record<string, unknown>
    : {};
  const allowRaw = Array.isArray(permissions.allow) ? permissions.allow as unknown[] : [];
  const existing = allowRaw.filter((e): e is string => typeof e === "string");
  if (!existing.includes(entry)) existing.push(entry);
  permissions.allow = existing;
  settings.permissions = permissions;

  // Atomic write: write to a sibling tempfile, rename onto the target.
  // rename is atomic on POSIX, so an unexpected process death mid-write
  // can never leave settings.local.json corrupted (would orphan the temp
  // file, harmless). Same protection ensureInstalled/Merged uses.
  //
  // Note on concurrency: agetor is single-process and saveAllowRule is
  // sync, so two saves can't actually interleave their read-modify-write —
  // the Bun event loop serialises sync work, and the only `await` in
  // server.ts/answerApproval happens before/after this function. If we
  // ever go multi-process or async, add a per-cwd mutex.
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Hook response shaping
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Shape the JSON the hook script needs to print on stdout so claude
 * understands our decision. Documented at
 * https://code.claude.com/docs/en/hooks-guide
 */
export function makeHookResponse(answer: ApprovalAnswer): unknown {
  const out: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: answer.decision,
    },
  };
  if (answer.reason) {
    (out.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason = answer.reason;
  }
  return out;
}

/** Test-only handle for asserting the registry state. */
export const __testing = {
  approvalsSize: () => approvals.size,
  questionsSize: () => questions.size,
  askQuestionsSize: () => askQuestions.size,
  planApprovalsSize: () => planApprovals.size,
  reset() {
    approvals.clear();
    questions.clear();
    askQuestions.clear();
    planApprovals.clear();
    broadcast = () => { /* reset */ };
  },
};
