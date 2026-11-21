/**
 * The harness-stack failover engine (docs/architecture/harness-stacks.md,
 * plan T08).
 *
 * It owns the pure-ish decisions — the lap, which member to try next, when an
 * all-exhausted task should retry — the timers and persisted intent that
 * survive a core restart, the single `harness_state` write path
 * (`updateTaskState`/`patchTaskState`) and the single account move
 * (`moveTaskToMember`: mirror, transcript transfer, commit). It never spawns
 * or settles a run itself: the orchestrator registers its hooks
 * (`onAutoRetry`, `onReconcileSwap`, `canAutoRetry`, `isTaskHeld`), which are
 * the only bridge and keep this module import-cycle-free.
 */
import {
  DEFAULT_MODEL,
  MODEL_MIN_CLI_VERSION,
  type Harness,
  type HarnessLimitSignal,
  type HarnessLimitState,
  type HarnessMemberReason,
  type HarnessStack,
  type HarnessStackMember,
  type HarnessSwapEvent,
  type HarnessSwapTrigger,
  type Task,
  type TaskHarnessState,
} from "../shared/types.ts";
import { pickNextMember, type NextMemberPlan } from "../shared/harness-stack.ts";
import { HARNESS_QUOTA_STALE_MS, harnessQuotaLooksExhausted, harnessQuotaResetAt } from "../shared/harness-limits.ts";
import { getHarnessDiscoveredModels } from "./agent-discovery.ts";
import { preflightCatalogFor } from "./model-discovery.ts";
import { CLI_AUTHORITATIVE_CATALOG_KINDS, modelCatalogVerdict } from "../shared/model-catalog.ts";
import { CLAUDE_LOGIN_HINT, peekCachedCliVersion, peekClaudeLoggedIn, refreshClaudeAuth } from "./agent-status.ts";
import { cliVersionSatisfies } from "../shared/cli-version.ts";
import { harnesses, harnessUsage, op, runs, tasks, type SessionIdColumn } from "./db-async.ts";
import { harnessStacks, loginEvidence, memberInstalled } from "./harness-stacks.ts";
import { findSessionIdForHarness, sessionTransferAdapter } from "./harness-session-transfer.ts";
import { mirrorForSwap } from "./harness-mirror.ts";
import { harnessSwapEvents } from "./harness-swap-history.ts";

export const HARNESS_STACK_RETRY_MAX = 3;
export const HARNESS_STACK_RETRY_BACKOFF_MS = 10 * 60_000;
/** Production floor for any retry wait. Tests/e2e can lower it through
 *  `AGETOR_HARNESS_RETRY_MIN_MS` (see {@link retryMinMs}). */
export const HARNESS_STACK_RETRY_MIN_MS = 10_000;
export const HARNESS_STACK_RETRY_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** Boot stagger for overdue retries (same shape as `rearmFxAutoResumes`):
 *  `now + BASE + i * STEP`, so N tasks never mirror into one backup at once. */
export const HARNESS_STACK_REARM_OVERDUE_BASE_MS = 5_000;
export const HARNESS_STACK_REARM_OVERDUE_STEP_MS = 2_000;
export interface FailoverHooks {
  /** Re-read the task and start a retry run (all-exhausted timer fired). */
  onAutoRetry(taskId: string): Promise<void>;
  /** Complete or visibly block a swap persisted before a crash. */
  onReconcileSwap(taskId: string): Promise<void>;
  /** False while another start/swap holds the task's start claim. The timer
   *  must not be consumed in that case: it re-arms a short backoff instead, so
   *  a start whose prepare then fails cannot leave a persisted countdown with
   *  no timer (R17-S3). Omitted ⇒ the timer always fires. */
  canAutoRetry?(taskId: string): boolean;
  /** True while the task is held by running background agents (its terminal
   *  run succeeded, so there is no `running` run row, but its REPL is still
   *  live). A manual prepare must leave such a task alone exactly like a live
   *  run (review Q6). Omitted ⇒ never held. */
  isTaskHeld?(taskId: string): boolean | Promise<boolean>;
  /** A requested "switch to next account" was dropped by the engine (the
   *  stack was cut to a single account); the orchestrator says why on the
   *  task's latest run. Omitted ⇒ no status line. */
  onScheduledSwitchDropped?(taskId: string, line: string): void | Promise<void>;
}

let hooks: FailoverHooks | null = null;
export function setHarnessFailoverHooks(next: FailoverHooks | null): FailoverHooks | null {
  const prev = hooks;
  hooks = next;
  return prev;
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Per-task epoch, bumped by every arm and cancel of that task's retry timer.
 *  A fired timer reads the persisted schedule across a database hop; if the
 *  epoch moved meanwhile, a newer arm or a cancel owns the retry and the stale
 *  fire stands down. One small number per task that ever armed a retry. */
const retryEpochs = new Map<string, number>();
const bumpRetryEpoch = (taskId: string): void => {
  retryEpochs.set(taskId, (retryEpochs.get(taskId) ?? 0) + 1);
};

// ---------------------------------------------------------------------------
// The `harness_state` read-modify-write
// ---------------------------------------------------------------------------
//
// Every write of a task's failover state is "read the task, decide the next
// state from it, write it". With the database on another thread the read and
// the write are separate hops, so two flows on one task (a settle and a timer,
// a retry and a manual Run, a switch and a stack edit) could both read the same
// state and the second write would drop the first one's change. Two layers keep
// each such step atomic:
//
//  1. a per-task async mutex (`withTaskLock`) around the whole
//     read-decide-write, so every flow of THIS process runs one after another;
//  2. a compare-and-set at the write (`harnessState.cas`, one transaction in
//     the worker): the write lands only while the stored state is still the one
//     the decision was made from, so a writer outside the mutex (a stack delete
//     clearing the state in its own transaction) is never overwritten with a
//     stale result; the step then re-reads and decides again.
//
// There is no single op for the decision because it needs main-thread-only
// state: the retry timers and swap bookkeeping armed from inside the mutation,
// the cached CLI version, the discovered model catalog and the live hooks.
// A mutation callback must not call a locked function of this module
// (`updateTaskState`, `patchTaskState`, `clearFailoverState`): the lock is not
// re-entrant and that would wait on itself.

const taskLocks = new Map<string, Promise<void>>();

function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve();
  const result = prev.then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  taskLocks.set(taskId, tail);
  void tail.then(() => {
    // Only the latest holder clears the entry, so the map is empty when idle.
    if (taskLocks.get(taskId) === tail) taskLocks.delete(taskId);
  });
  return result;
}

/** Return this from a mutation to leave the stored state as it is (no write). */
export const KEEP_TASK_STATE = Symbol("keep-task-state");
type StateMutation = TaskHarnessState | null | typeof KEEP_TASK_STATE;

/** How many times a write that lost the compare-and-set re-reads and decides
 *  again before giving up. Inside the mutex only an outside writer can cause a
 *  retry, so more than one is already rare. */
const STATE_WRITE_ATTEMPTS = 5;

async function applyStateUpdate(
  taskId: string,
  mutate: (state: TaskHarnessState | null, task: Task) => StateMutation | Promise<StateMutation>,
  opts: { requireState?: boolean } = {},
): Promise<TaskHarnessState | null> {
  for (let attempt = 0; attempt < STATE_WRITE_ATTEMPTS; attempt++) {
    const task = await tasks.get(taskId);
    if (!task) return null;
    if (opts.requireState && !task.harnessState) return null;
    const expected = JSON.stringify(task.harnessState ?? null);
    const next = await mutate(task.harnessState ?? null, task);
    if (next === KEEP_TASK_STATE) return task.harnessState ?? null;
    const written = next === null
      ? null
      : stateBase(next, await harnessStacks.resolveForTask({ ...task, harnessState: next }));
    if (await op("harnessState.cas", [taskId, expected, written])) return written;
  }
  throw new Error(`harness state of task ${taskId} kept changing; gave up after ${STATE_WRITE_ATTEMPTS} attempts`);
}

/**
 * The one write path for `tasks.harness_state` (review S10). `mutate` gets the
 * persisted state (or null) and returns the next one (or
 * {@link KEEP_TASK_STATE}); a non-null result is re-pointed at the stack the
 * task's CURRENT account belongs to (see {@link stateBase}), so no caller can
 * write back a `stackId`/position the account already left — the
 * orchestrator's settle/retry/swap writes used to spread the stale value back
 * in and stack delete then missed the task. The read, `mutate` and the write
 * are one atomic step per task (see the section comment above); `mutate` may
 * be async and may run more than once, so side effects in it must be idempotent.
 */
export function updateTaskState(
  taskId: string,
  mutate: (state: TaskHarnessState | null, task: Task) => StateMutation | Promise<StateMutation>,
): Promise<TaskHarnessState | null> {
  return withTaskLock(taskId, () => applyStateUpdate(taskId, mutate));
}

/**
 * Merge `patch` into the persisted state (re-pointed like
 * {@link updateTaskState}). A no-op returning null when the task has no state:
 * every caller patches a field of an existing failover state, and creating one
 * from nothing would turn a lone account into a "stacked" task. A function
 * patch receives the state read inside the atomic step, so it never works from
 * a stale copy.
 */
export function patchTaskState(
  taskId: string,
  patch: Partial<TaskHarnessState> | ((state: TaskHarnessState) => Partial<TaskHarnessState>),
): Promise<TaskHarnessState | null> {
  return withTaskLock(taskId, () =>
    applyStateUpdate(
      taskId,
      (state) => (state ? { ...state, ...(typeof patch === "function" ? patch(state) : patch) } : null),
      { requireState: true },
    ));
}

/**
 * The ids of every task whose failover state belongs to `stackId`: the stack
 * the task resolves to right now — its account's current stack, or, for an
 * account that left every stack, the recorded one. A stack delete must clear
 * those — an account edited into this stack after the task's last write still
 * names the old train (review S10) — and nothing else: a task whose account
 * has since moved into ANOTHER stack still names this one until its next
 * write, but its retry and scheduled switch belong to the stack it is in now.
 * Call BEFORE the stack row is deleted (the resolution needs the membership),
 * together with {@link repointTaskStatesAwayFromStack}.
 */
export async function failoverTaskIdsForStack(stackId: string): Promise<string[]> {
  const ids: string[] = [];
  // Only tasks that carry a state (or an armed timer) can belong to a stack,
  // so the per-task resolution runs for those few, not for every task.
  for (const task of await tasks.list()) {
    if (!task.harnessState && !retryTimers.has(task.id)) continue;
    if ((await harnessStacks.resolveForTask(task))?.stack.id === stackId) ids.push(task.id);
  }
  return ids;
}

/**
 * Re-point the state of every task that still records `stackId` but whose
 * account now belongs to another stack, so the stack delete (which clears
 * every state recording the deleted id) leaves it alone. Call BEFORE the
 * delete. Returns the re-pointed ids.
 */
export async function repointTaskStatesAwayFromStack(stackId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const task of await tasks.list()) {
    if (task.harnessState?.stackId !== stackId) continue;
    const resolved = await harnessStacks.resolveForTask(task);
    if (!resolved || resolved.stack.id === stackId) continue;
    // An identity mutation: `updateTaskState` re-points the base at the
    // stack the task resolves to now.
    await updateTaskState(task.id, (state) => state);
    ids.push(task.id);
  }
  return ids;
}

/**
 * The persisted base a mutation starts from, re-pointed at the stack the
 * task's CURRENT account belongs to. `resolveForTask` already plans inside
 * that stack; writing the old `stackId`/position back would leave a task moved
 * between stacks labelled with the train it left (and `clearTaskStateForStack`
 * naming the wrong one). A task whose account left every stack keeps the
 * recorded base until its next real move.
 */
function stateBase(
  state: TaskHarnessState | null,
  resolved: Awaited<ReturnType<typeof harnessStacks.resolveForTask>>,
): TaskHarnessState {
  const base: TaskHarnessState = state ?? {
    stackId: resolved?.stack.id ?? "",
    position: resolved?.position ?? 0,
    count: resolved?.stack.members.length,
    tried: [],
    pendingSwap: null,
    allExhausted: null,
    lastMove: null,
  };
  if (!resolved) return base;
  const stackId = resolved.stack.id;
  const position = resolved.position;
  const count = resolved.stack.members.length;
  if (base.stackId === stackId && base.position === position && base.count === count) return base;
  return { ...base, stackId, position, count };
}

/**
 * The retry-wait floor. `AGETOR_HARNESS_RETRY_MIN_MS` (a positive integer in
 * ms, at least 50) lowers it so a test or e2e run need not wait 10 s, but it
 * is honored ONLY when `NODE_ENV === "test"` or `AGETOR_E2E_HARNESS_SEAMS ===
 * "1"`; anywhere else it is ignored. Read at call time so a test can set and
 * restore it.
 */
export function retryMinMs(): number {
  const seamOn = process.env.NODE_ENV === "test" || process.env.AGETOR_E2E_HARNESS_SEAMS === "1";
  if (!seamOn) return HARNESS_STACK_RETRY_MIN_MS;
  const raw = process.env.AGETOR_HARNESS_RETRY_MIN_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return HARNESS_STACK_RETRY_MIN_MS;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 50 ? n : HARNESS_STACK_RETRY_MIN_MS;
}

/** Record the cooldown for a limit signal: account-wide, or one model's row
 *  when `signal.model` is set (the store keys the row on it). */
export function recordLimitSignal(harnessId: string, signal: HarnessLimitSignal): Promise<HarnessLimitState> {
  return harnessStacks.setLimitState(harnessId, signal);
}

/** Mark an account as tried in the current lap. */
export async function recordTried(taskId: string, harnessId: string): Promise<void> {
  await updateTaskState(taskId, async (state, task) => {
    const resolved = await harnessStacks.resolveForTask(task);
    const base = stateBase(state, resolved);
    const tried = base.tried.includes(harnessId) ? base.tried : [...base.tried, harnessId];
    return { ...base, tried };
  });
}

/** A successful (or cancelled) terminal turn ends the lap. */
export async function resetLap(taskId: string): Promise<void> {
  await patchTaskState(taskId, { tried: [], allExhausted: null });
}

/** Clear all failover state (a non-stack switch, archive, or stack delete). */
export async function clearFailoverState(taskId: string): Promise<void> {
  // Cancel first so a timer cannot fire into the window, and again after the
  // clear in case a mutation queued ahead of it armed one.
  cancelAutoRetry(taskId);
  await withTaskLock(taskId, async () => {
    await tasks.setHarnessState(taskId, null);
  });
  cancelAutoRetry(taskId);
}

export type { NextMemberPlan };

/** The reason a logged-out account is skipped with (also the status line's). */
export const NOT_LOGGED_IN_REASON = "not logged in";

/**
 * Warm the Claude login cache for every account in the task's stack so the
 * planners below (`planNextMember`, `planRetryMember`,
 * `planManualSwitchTarget`, `memberUnusableReason`) can skip a logged-out
 * account from the cache alone: the probes run in parallel, capped at 5 s in
 * all, and fail open. A task outside a stack is a no-op. Call it before planning.
 */
export async function warmStackLogins(
  task: Pick<Task, "id" | "agent" | "harnessState">,
  opts?: { fresh?: boolean },
): Promise<void> {
  const resolved = await harnessStacks.resolveForTask(task);
  if (!resolved) return;
  const members = (await Promise.all(resolved.stack.members.map((m) => harnesses.getByIdOrKind(m.harnessId))))
    .filter((h): h is NonNullable<typeof h> => h != null);
  await refreshClaudeAuth(members, undefined, opts);
}

/** The "skipped <account>: not logged in" status lines for a plan's skipped
 *  members (a stack's logged-out account is skipped like an exhausted one). */
export async function loggedOutSkipLines(skipped: ReadonlyArray<{ harnessId: string; reason: string }>): Promise<string[]> {
  const lines: string[] = [];
  for (const s of skipped) {
    if (s.reason !== NOT_LOGGED_IN_REASON) continue;
    const label = (await harnesses.getByIdOrKind(s.harnessId))?.label ?? s.harnessId;
    lines.push(`skipped ${label}: ${NOT_LOGGED_IN_REASON}`);
  }
  return lines;
}

/**
 * Why a member cannot run this task's turn right now, or null when it can.
 * Deliberately cheap: no fresh CLI probe on the hot path — the cached version
 * from the last /harnesses poll is enough, and an unknown version fails open.
 */
export async function memberUnusableReason(member: { harnessId: string; enabled: boolean; label: string }, task: Pick<Task, "model">): Promise<string | null> {
  if (!member.enabled) return "disabled";
  const harness = await harnesses.getByIdOrKind(member.harnessId);
  if (!harness) return "account no longer exists";
  if (!memberInstalled(harness)) return "CLI not installed";
  // `loginEvidence` is the file/keychain check; `peekClaudeLoggedIn` is the
  // cached `claude auth status` answer (warmed by `warmStackLogins` before
  // every planner). Both fail open: `null` means "cannot tell", never "out".
  if (loginEvidence(harness) === false || peekClaudeLoggedIn(harness) === false) return NOT_LOGGED_IN_REASON;
  // The model the turn would really run: a default-model task (null) resolves
  // exactly like `startTask` does, so a backup that cannot serve the default
  // model is skipped too.
  const model = task.model ?? DEFAULT_MODEL[harness.kind] ?? null;
  // The raw per-harness list judges only the kinds without a CLI-authoritative
  // catalog (fx, opencode, …); codex and copilot go through the version-guarded
  // verdict below, so a list stored before a CLI upgrade never refuses a model
  // the upgraded CLI (and the member's own pre-flight) accepts.
  if (!CLI_AUTHORITATIVE_CATALOG_KINDS.has(harness.kind)) {
    const catalog = getHarnessDiscoveredModels(harness.id);
    if (catalog.length > 0 && model && !catalog.some((m) => m.id === model)) {
      return `model ${model} not offered`;
    }
  }
  // Discovery first for the kinds whose CLI catalog is authoritative (codex,
  // copilot): a model the CLI lists is usable whatever the frozen version
  // table says; one a non-empty trusted catalog lacks is not. Only `unknown`
  // (nothing to judge by) falls through to the table below.
  let verdict: "offered" | "missing" | "unknown" = "unknown";
  if (model) {
    // Judged by the same catalog and the same version guard the member's own
    // pre-flight uses (`preflightCatalogFor`), so a backup is never skipped for
    // a model its own launch would accept (a codex account judged by another
    // account's list, or by a list from before a CLI upgrade).
    verdict = modelCatalogVerdict(
      harness.kind,
      model,
      preflightCatalogFor(harness, peekCachedCliVersion(harness)),
      loginEvidence(harness),
    );
    if (verdict === "missing") return `model ${model} not offered`;
  }
  const floor = verdict === "unknown" ? MODEL_MIN_CLI_VERSION[harness.kind]?.[model ?? ""] : undefined;
  if (floor) {
    const version = peekCachedCliVersion(harness);
    if (version !== null && cliVersionSatisfies(version, floor) === false) {
      return `CLI older than ${floor}`;
    }
  }
  return null;
}

/** The lower-cased model a task's turn would run on `harnessId`, which keys
 *  per-model cooldown rows (`parseLimitedModel` also yields lower-case). */
export async function cooldownModelFor(task: Pick<Task, "model">, harnessId: string): Promise<string | null> {
  const harness = await harnesses.getByIdOrKind(harnessId);
  const model = task.model ?? (harness ? DEFAULT_MODEL[harness.kind] : null) ?? null;
  return model ? model.toLowerCase() : null;
}

/** What the synchronous {@link pickNextMember} walk asks about each member,
 *  read ahead (the reads are database hops, the walk is pure). */
interface MemberFacts {
  cooling: Map<string, HarnessLimitState | null>;
  exhausted: Map<string, boolean>;
  resetAt: Map<string, number | null>;
  unusable: Map<string, string | null>;
}

async function loadMemberFacts(
  members: readonly HarnessStackMember[],
  task: Pick<Task, "model">,
  now: number,
  opts: { ignoreLimits?: boolean } = {},
): Promise<MemberFacts> {
  const facts: MemberFacts = { cooling: new Map(), exhausted: new Map(), resetAt: new Map(), unusable: new Map() };
  await Promise.all(members.map(async (member) => {
    const id = member.harnessId;
    if (opts.ignoreLimits) {
      facts.cooling.set(id, null);
      facts.exhausted.set(id, false);
      facts.resetAt.set(id, null);
    } else {
      const [cool, usage] = await Promise.all([
        cooldownModelFor(task, id).then((model) => harnessStacks.isCooling(id, now, model)),
        harnessUsage.get(id),
      ]);
      facts.cooling.set(id, cool);
      facts.exhausted.set(id, harnessQuotaLooksExhausted(usage, now, HARNESS_QUOTA_STALE_MS));
      facts.resetAt.set(id, harnessQuotaResetAt(usage, now, HARNESS_QUOTA_STALE_MS));
    }
    facts.unusable.set(id, await memberUnusableReason(member, task));
  }));
  return facts;
}

/**
 * Walk forward from the current account and pick the next usable one. Skips
 * tried, disabled, cooling, quota-exhausted and unusable members. `cooling`
 * is ignored when `force` is set (a manual Run).
 */
export async function planNextMember(
  task: Pick<Task, "id" | "agent" | "model" | "harnessState">,
  opts: { now?: number; force?: boolean; currentId?: string } = {},
): Promise<NextMemberPlan> {
  const now = opts.now ?? Date.now();
  const resolved = await harnessStacks.resolveForTask(task);
  if (!resolved) {
    return { kind: "none-usable", reasons: [{ harnessId: task.agent, reason: "not in a stack" }], earliestResetAtMs: null, skipped: [] };
  }
  const { stack } = resolved;
  // A settle must walk from the account that actually ran the limited turn,
  // not from whatever `tasks.agent` says now: a run can settle after a
  // manual/manual-failover move changed the task's account.
  const current = opts.currentId ?? resolved.current;
  const state = task.harnessState;
  const facts = await loadMemberFacts(stack.members, task, now, { ignoreLimits: opts.force });
  return pickNextMember({
    members: stack.members,
    currentId: current,
    tried: state?.tried ?? [],
    now,
    cooling: (id) => facts.cooling.get(id) ?? null,
    exhaustedByQuota: (id) => facts.exhausted.get(id) ?? false,
    quotaResetAt: (id) => facts.resetAt.get(id) ?? null,
    usable: (member) => facts.unusable.get(member.harnessId) ?? null,
  });
}

/**
 * Pick the member an all-exhausted retry should start on. The current
 * account is eligible only when it is genuinely usable *now* — installed,
 * logged in, the task's model offered, AND no longer cooling / quota-blocked.
 * "Installed and logged in" is not enough: the timer can fire a moment early,
 * or another task can record a fresh limit on the same account while this one
 * waits, and retrying there would fail immediately and throw away the
 * conversation.
 */
export async function planRetryMember(
  task: Pick<Task, "id" | "agent" | "model" | "harnessState">,
  opts: { now?: number } = {},
): Promise<NextMemberPlan> {
  const now = opts.now ?? Date.now();
  const resolved = await harnessStacks.resolveForTask(task);
  if (!resolved) {
    return { kind: "none-usable", reasons: [{ harnessId: task.agent, reason: "not in a stack" }], earliestResetAtMs: null, skipped: [] };
  }
  const { stack, current } = resolved;
  const currentMember = stack.members.find((m) => m.harnessId === current);
  let currentUsable = false;
  if (currentMember && (await memberUnusableReason(currentMember, task)) === null) {
    const [cool, usage] = await Promise.all([
      cooldownModelFor(task, current).then((model) => harnessStacks.isCooling(current, now, model)),
      harnessUsage.get(current),
    ]);
    currentUsable = cool === null && !harnessQuotaLooksExhausted(usage, now, HARNESS_QUOTA_STALE_MS);
  }
  if (currentUsable) return { kind: "next", member: currentMember!, skipped: [] };
  // A retry starts a fresh lap: accounts tried in the previous lap are
  // eligible again once their reset has expired.
  const retryTask = { ...task, harnessState: task.harnessState ? { ...task.harnessState, tried: [] } : null };
  return planNextMember(retryTask, { now, currentId: current });
}

function clampWait(ms: number): number {
  return Math.max(retryMinMs(), Math.min(HARNESS_STACK_RETRY_MAX_WAIT_MS, ms));
}

/**
 * Persist the all-exhausted/unusable state and arm the retry timer. Returns
 * the persisted state. `startedThisAttempt: false` is for the two paths where
 * no retry run actually started (the initial limit settlement and a timer
 * re-arm that found nothing usable): they must not spend the three-attempt
 * cap. A retry run that started and later returned to exhausted increments on
 * its failure, which is the default.
 */
export function planExhausted(
  taskId: string,
  plan: Extract<NextMemberPlan, { kind: "all-exhausted" | "none-usable" }>,
  now = Date.now(),
  opts: {
    startedThisAttempt?: boolean;
    /** The limited run a CLEAN retry would replay (first turn, no tool call).
     *  Persisted as `allExhausted.cleanRetryOf` only when a retry timer is
     *  armed, so every path that ends the retry unrun can stash that run's
     *  unread follow-ups. `undefined` carries the existing marker, `null`
     *  clears it. */
    cleanRetryOf?: string | null;
  } = {},
): Promise<TaskHarnessState | null> {
  return updateTaskState(taskId, async (state, task) => {
    const resolved = await harnessStacks.resolveForTask(task);
    const base = stateBase(state, resolved);
    // Why each member could not take the task (banners, `agetor show`),
    // including the account that was running it.
    const memberReasons = resolved ? await memberReasonsFor(resolved.stack, task, now, { includeCurrent: true }) : [];
    const reasonsField = memberReasons.length > 0 ? { memberReasons } : {};
    const cleanRetryOf = opts.cleanRetryOf === undefined ? base.allExhausted?.cleanRetryOf : opts.cleanRetryOf ?? undefined;
    const priorAttempts = base.allExhausted?.attempts ?? 0;
    const attempts = opts.startedThisAttempt === false ? priorAttempts : priorAttempts + 1;
    const capReached = attempts >= HARNESS_STACK_RETRY_MAX;
    const earliest = plan.earliestResetAtMs;
    // A `none-usable` with only disabled/logged-out/model reasons has no reset
    // to wait for — no timer, block until the user fixes it.
    if (plan.kind === "none-usable" && earliest === null) {
      cancelAutoRetry(taskId);
      return {
        ...base,
        allExhausted: {
          at: now,
          attempts: capReached ? HARNESS_STACK_RETRY_MAX : attempts,
          max: HARNESS_STACK_RETRY_MAX,
          nextAttemptAt: 0,
          earliestResetAtMs: null,
          reason: "no-usable-member",
          ...reasonsField,
        },
      };
    }
    if (capReached) {
      cancelAutoRetry(taskId);
      return {
        ...base,
        allExhausted: {
          at: base.allExhausted?.at ?? now,
          attempts: HARNESS_STACK_RETRY_MAX,
          max: HARNESS_STACK_RETRY_MAX,
          nextAttemptAt: 0,
          earliestResetAtMs: earliest,
          reason: plan.kind === "none-usable" ? "no-usable-member" : "quota",
          ...reasonsField,
        },
      };
    }
    const target = earliest ?? now + HARNESS_STACK_RETRY_BACKOFF_MS;
    const nextAttemptAt = clampWait(target - now) + now;
    armAutoRetry(taskId, nextAttemptAt);
    return {
      ...base,
      allExhausted: {
        at: base.allExhausted?.at ?? now,
        attempts,
        max: HARNESS_STACK_RETRY_MAX,
        nextAttemptAt,
        earliestResetAtMs: earliest,
        reason: plan.kind === "none-usable" ? "no-usable-member" : "quota",
        ...(cleanRetryOf ? { cleanRetryOf } : {}),
        ...reasonsField,
      },
    };
  });
}

/**
 * Push a fired-but-not-consumed retry a short backoff into the future and
 * re-arm it. The timer callback has already dropped its handle, so without
 * this the persisted `nextAttemptAt` would name a past instant that nothing
 * ever wakes (R17-S3). Guards against a concurrent re-arm/clear: only the
 * exact schedule that fired is moved.
 */
async function deferAutoRetry(taskId: string, firedAt: number): Promise<boolean> {
  let at = 0;
  // The guard and the write are one atomic step: the persisted schedule is
  // checked against `firedAt` in the same read the new instant is written from.
  await updateTaskState(taskId, (state) => {
    const persisted = state?.allExhausted;
    if (!state || !persisted) return KEEP_TASK_STATE;
    if (persisted.nextAttemptAt !== firedAt || persisted.inFlight) return KEEP_TASK_STATE;
    if (persisted.attempts >= HARNESS_STACK_RETRY_MAX) return KEEP_TASK_STATE;
    at = Date.now() + retryMinMs();
    return { ...state, allExhausted: { ...persisted, nextAttemptAt: at } };
  });
  if (at === 0) return false;
  armAutoRetry(taskId, at);
  return true;
}

/**
 * A retry whose handler found the task busy (a run is live, so this turn must
 * not mint a second one): push the persisted schedule a short backoff out and
 * re-arm it, instead of consuming the timer and leaving a countdown nothing
 * wakes (review Q7). The live run's own settle then decides: success/cancel
 * clears the exhausted state (and this timer), a limit re-plans it. Returns
 * whether a timer was re-armed.
 */
export async function deferAutoRetryNow(taskId: string): Promise<boolean> {
  const persisted = (await tasks.get(taskId))?.harnessState?.allExhausted;
  if (!persisted || persisted.inFlight || persisted.nextAttemptAt <= 0) return false;
  // `deferAutoRetry` re-checks `nextAttemptAt` inside its atomic step, so a
  // schedule that moved since this read is left alone.
  return deferAutoRetry(taskId, persisted.nextAttemptAt);
}

/** Stop every armed retry timer in this process (a launch freeze before a
 *  handoff/quit, and test cleanup). The persisted schedules are untouched:
 *  the next owner's boot re-arms them from the DB. Returns how many stopped. */
export function stopAllAutoRetryTimers(): number {
  let stopped = 0;
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
    stopped++;
  }
  retryTimers.clear();
  // A timer already firing (past its handle) stands down too.
  for (const taskId of retryEpochs.keys()) bumpRetryEpoch(taskId);
  return stopped;
}

/** Whether a retry timer is armed in this process for `taskId`. */
export function hasArmedAutoRetry(taskId: string): boolean {
  return retryTimers.has(taskId);
}

/** Arm (or re-arm) the all-exhausted retry timer. Re-arming replaces the old one. */
export function armAutoRetry(taskId: string, at: number): void {
  cancelAutoRetry(taskId);
  bumpRetryEpoch(taskId);
  const delay = Math.max(0, at - Date.now());
  const timer = setTimeout(() => {
    void fireAutoRetry(taskId, at).catch((err) => {
      console.warn(`[agetor] harness auto-retry failed for task ${taskId}:`, err);
    });
  }, Math.min(delay, 2_147_483_647));
  // Don't keep the process alive just for a retry timer; the boot re-arm
  // reads the persisted intent.
  timer.unref?.();
  retryTimers.set(taskId, timer);
}

async function fireAutoRetry(taskId: string, at: number): Promise<void> {
  retryTimers.delete(taskId);
  if (!hooks) return;
  const epoch = retryEpochs.get(taskId) ?? 0;
  // Identity check: a timer whose callback was already queued when the
  // schedule was re-armed (or cleared by a manual run) must not start a
  // turn against the newer state. The read is a database hop, so an arm or a
  // cancel that landed during it (the epoch moved) also stands this fire down.
  const persisted = (await tasks.get(taskId))?.harnessState?.allExhausted;
  if (!persisted || persisted.nextAttemptAt !== at) return;
  if ((retryEpochs.get(taskId) ?? 0) !== epoch || !hooks) return;
  // Another start/swap owns the task right now. Consuming the timer here
  // would strand the persisted countdown if that start's prepare fails;
  // re-arm a short backoff and let the claim holder's own settle decide.
  if (hooks.canAutoRetry && !hooks.canAutoRetry(taskId)) {
    await deferAutoRetry(taskId, at);
    return;
  }
  await hooks.onAutoRetry(taskId);
}

export function cancelAutoRetry(taskId: string): void {
  const timer = retryTimers.get(taskId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(taskId);
  // Only a task that ever armed a retry has an epoch to move (and one whose
  // fire may be in flight past its handle).
  if (timer || retryEpochs.has(taskId)) bumpRetryEpoch(taskId);
}

/** Boot: re-arm every persisted all-exhausted retry still in the future, and
 *  recover one that was spawning when the core stopped. An overdue schedule
 *  (the core was down through it) is staggered like `rearmFxAutoResumes`'s —
 *  `now + 5 s + i × 2 s` per overdue entry, persisted so the armed timer's
 *  identity check matches — instead of every overdue task firing in the same
 *  tick and mirroring into one backup concurrently (review S9). */
export async function rearmAutoRetries(now = Date.now()): Promise<number> {
  let armed = 0;
  let overdue = 0;
  for (const listed of await tasks.list()) {
    // The listing only picks the few tasks with a countdown; every decision is
    // made from the state read again inside the atomic step below.
    if (!listed.harnessState?.allExhausted) continue;
    const out: { arm: number | null; staggered: boolean } = { arm: null, staggered: false };
    await updateTaskState(listed.id, async (state, task) => {
      out.arm = null;
      out.staggered = false;
      const exhausted = state?.allExhausted;
      if (!state || !exhausted) return KEEP_TASK_STATE;
      if (exhausted.inFlight) {
        // The retry's run row is minted before its spawn, so a live row means
        // the successor really started: let its own settle own the outcome.
        // Anything else (crash mid-spawn, a non-limit failure before the
        // settle hook ran) would otherwise keep `nextAttemptAt: 0` and never
        // retry again. Re-arm without spending an attempt: a crash is not a
        // started retry, and the spawn-failure path still spends one so a
        // permanently broken destination reaches the visible cap.
        const attemptRunId = exhausted.attemptRunId;
        const live = attemptRunId
          ? await runs.get(attemptRunId)
          : task.runId
            ? await runs.get(task.runId)
            : null;
        const attempts = exhausted.attempts;
        if (live && live.status === "running") {
          // The retry run is still live (re-attached, or the core is answering
          // again after a handoff): keep `inFlight` so its own settle stays
          // armed to end the loop on a non-limit failure. Clearing it here set
          // `nextAttemptAt: 0` with no timer, which the UI reads as
          // "Retrying…" forever.
          return KEEP_TASK_STATE;
        }
        if (attemptRunId && live && live.status !== "orphaned") {
          // The retry run genuinely settled (succeeded/failed/cancelled) but the
          // in-flight marker survived: the crash landed between the terminal run
          // write and this bookkeeping. A non-limit failure must never be
          // re-armed — that would loop on the same error — and a succeeded run
          // already proved the account works. Drop the exhausted state and let
          // the run's own visible outcome stand.
          return { ...state, allExhausted: null };
        }
        if (attempts >= HARNESS_STACK_RETRY_MAX) {
          return { ...state, allExhausted: { ...exhausted, inFlight: false, nextAttemptAt: 0 } };
        }
        const at = now + HARNESS_STACK_RETRY_BACKOFF_MS;
        out.arm = at;
        return { ...state, allExhausted: { ...exhausted, inFlight: false, nextAttemptAt: at } };
      }
      if (exhausted.attempts >= HARNESS_STACK_RETRY_MAX) return KEEP_TASK_STATE;
      if (exhausted.nextAttemptAt <= 0) return KEEP_TASK_STATE;
      // A missed timer is staggered (see the doc above) AND the new instant is
      // persisted, so the armed timer's identity check matches the state it
      // reads on fire.
      out.staggered = exhausted.nextAttemptAt <= now;
      const at = out.staggered
        ? now + HARNESS_STACK_REARM_OVERDUE_BASE_MS + overdue * HARNESS_STACK_REARM_OVERDUE_STEP_MS
        : exhausted.nextAttemptAt;
      out.arm = at;
      if (at !== exhausted.nextAttemptAt) {
        return { ...state, allExhausted: { ...exhausted, nextAttemptAt: at } };
      }
      return KEEP_TASK_STATE;
    });
    if (out.arm !== null) {
      armAutoRetry(listed.id, out.arm);
      armed++;
      // Counted once the write landed (the step above may run more than once).
      if (out.staggered) overdue++;
    }
  }
  return armed;
}

/** Boot: complete or visibly block swaps persisted before a crash/handoff. */
export async function reconcilePendingSwaps(): Promise<number> {
  let reconciled = 0;
  for (const task of await tasks.list()) {
    if (!task.harnessState?.pendingSwap) continue;
    reconciled++;
    if (hooks) {
      try {
        await hooks.onReconcileSwap(task.id);
      } catch (err) {
        console.warn(`[agetor] harness swap reconcile failed for task ${task.id}:`, err);
      }
    }
  }
  return reconciled;
}


export interface PrepareResult {
  ok: boolean;
  moved?: { from: string; to: string };
  error?: string;
  /** Non-fatal mirror/transfer warnings of a move, already prefixed
   *  (`config mirror: …`, `session transfer: …`). The caller writes them as
   *  status lines so a partially mirrored backup is visible (review S11). */
  warnings?: string[];
}

/**
 * The newest provider session `harnessId` genuinely owns for this task — the
 * shared rule lives in `harness-session-transfer.ts` so the swap settlement
 * and this manual move cannot disagree. See `findSessionIdForHarness`.
 */
function latestSessionForAccount(
  task: Task,
  kind: string,
  harnessId: string,
): Promise<string | null> {
  const column: SessionIdColumn = kind === "codex" ? "codex_session_id" : "claude_session_id";
  return findSessionIdForHarness(task.id, column, harnessId);
}

/** What {@link moveTaskToMember} did. */
export type MoveTaskToMemberResult =
  /** Mirrored/transferred and committed (agent + state written). */
  | { kind: "moved"; transferredSessionId: string | null; warnings: string[] }
  /** `beforeCommit` declined after the mirror/transfer: nothing committed. */
  | { kind: "aborted"; transferredSessionId: string | null; warnings: string[] }
  /** A recorded conversation could not be moved: nothing committed. The
   *  caller's failure policy decides (block, refuse, or start fresh). */
  | { kind: "transfer-failed"; message: string; warnings: string[] };

export interface MoveTaskToMemberArgs {
  taskId: string;
  /** The stack both accounts belong to (the mirror's source is its primary). */
  stack: HarnessStack;
  /** The account the conversation lives on (the run's own account). */
  from: string;
  /** The destination account. Equal to `from` for a same-account retry:
   *  no mirror and no copy, the existing session is resumed in place. */
  to: string;
  /** The provider session on `from` to carry, or null when there is nothing
   *  worth moving (a clean first turn). */
  sessionId: string | null;
  /** The task's cwd (the transcript's project key). */
  cwd: string;
  /** Refresh `to`'s config from the primary first (contract C4). Default
   *  true; never for a same-account retry. */
  mirror?: boolean;
  /** Re-check after the mirror/transfer awaits and before the commit. Return
   *  false when the move is no longer wanted (a Stop, an archive, a freeze):
   *  the result is `aborted` and nothing is written. */
  beforeCommit?: () => boolean | Promise<boolean>;
  /** Write `tasks.agent = to` on commit (default true; skipped when the row
   *  already names `to`, e.g. a PATCH that switched it). */
  writeAgent?: boolean;
  /** The failover state written with the commit, through
   *  {@link updateTaskState} (re-pointed at the current stack). */
  state?: (current: TaskHarnessState | null, task: Task) => TaskHarnessState | null | Promise<TaskHarnessState | null>;
  /** When set AND the move commits (`moved`), exactly one swap-history row is
   *  recorded with the real from/to. Omitted ⇒ nothing is recorded (the
   *  orchestrator records limit/retry/boot swaps itself, where both run ids
   *  are known). */
  history?: Omit<Parameters<typeof recordHarnessSwapEvent>[0], "task" | "stackId" | "fromHarnessId" | "toHarnessId">;
}

/** How many mirror warnings a status line carries (the rest are logged). */
const MIRROR_WARNINGS_SHOWN = 3;

/**
 * Move a task's conversation from one stack member to another — the single
 * implementation every account move uses (review S11): the automatic swap, the
 * all-exhausted retry, the manual prepare move, the same-stack PATCH switch and
 * the boot completion of an interrupted manual switch. It owns, in order:
 *
 *  1. the config mirror onto `to` (contract C4; a failure is a warning);
 *  2. the provider-session transfer (Claude transcript + sidecars, or the
 *     Codex rollout) when `sessionId` is set;
 *  3. the caller's `beforeCommit` re-check;
 *  4. the commit: `tasks.agent = to` and the failover state.
 *
 * Warnings come back prefixed for status lines. The failure policy stays with
 * the caller: a transfer failure commits nothing, and NEVER touches the source
 * account's files — the transfer only reads them.
 */
export async function moveTaskToMember(args: MoveTaskToMemberArgs): Promise<MoveTaskToMemberResult> {
  const { taskId, stack, from, to, sessionId, cwd } = args;
  const warnings: string[] = [];
  const sameAccount = from === to;
  if (!sameAccount && args.mirror !== false) {
    try {
      const mirror = await mirrorForSwap(stack, to);
      if (mirror.warnings.length > 0) {
        warnings.push(`config mirror: ${mirror.warnings.slice(0, MIRROR_WARNINGS_SHOWN).join("; ")}`);
        if (mirror.warnings.length > MIRROR_WARNINGS_SHOWN) {
          console.warn(`[agetor] harness mirror warnings for task ${taskId}:`, mirror.warnings);
        }
      }
    } catch (err) {
      warnings.push(`config mirror skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let transferredSessionId: string | null = null;
  if (sessionId) {
    if (sameAccount) {
      // The transcript never moved: resume the existing provider session.
      transferredSessionId = sessionId;
    } else {
      const fromHarness = await harnesses.getByIdOrKind(from);
      const toHarness = await harnesses.getByIdOrKind(to);
      if (!fromHarness || !toHarness) {
        return { kind: "transfer-failed", message: "the account no longer exists", warnings };
      }
      const adapter = sessionTransferAdapter(fromHarness.kind);
      if (!adapter) {
        return { kind: "transfer-failed", message: "this harness kind cannot transfer a conversation", warnings };
      }
      const result = await adapter.transfer({ taskId, fromHarness, toHarness, sessionId, cwd });
      if (!result.ok) return { kind: "transfer-failed", message: result.message, warnings };
      transferredSessionId = result.sessionId;
      for (const warning of result.warnings ?? []) warnings.push(`session transfer: ${warning}`);
    }
  }

  if (args.beforeCommit && !(await args.beforeCommit())) {
    return { kind: "aborted", transferredSessionId, warnings };
  }
  if (args.writeAgent !== false && (await tasks.get(taskId))?.agent !== to) await tasks.update(taskId, { agent: to });
  if (args.state) await updateTaskState(taskId, args.state);
  if (args.history) {
    const row = await tasks.get(taskId);
    if (row) {
      await recordHarnessSwapEvent({
        ...args.history,
        task: row,
        stackId: stack.id,
        fromHarnessId: from,
        toHarnessId: to,
      });
    }
  }
  return { kind: "moved", transferredSessionId, warnings };
}

/**
 * Prepare a task before a user-initiated Run/message. A no-op unless the task
 * is in a stack and its current account cannot serve the turn; then it moves
 * to the next usable member, mirroring its config and transferring the
 * conversation ({@link moveTaskToMember}). A live run — or a task held by
 * running background agents, whose REPL is still live — is left alone (the
 * message queues behind it). `manual: true` forces a cooling account, and
 * resets the lap.
 *
 * The caller holds the task's start claim for the whole call (the move awaits
 * a mirror and a transcript copy; an all-exhausted retry timer firing in that
 * window must not mint a successor the move then overwrites — review S8).
 *
 * `forceOffCurrent` is for a start pre-flight that failed on the current
 * account even though the cached member snapshot looked usable (a fresh-auth
 * probe or the per-model CLI floor is newer than the 60 s status cache). It
 * treats the current account as unusable for this turn and moves to a backup
 * exactly like a disabled/logged-out member would.
 */
export async function prepareTaskHarness(
  taskId: string,
  opts: { manual: boolean; forceOffCurrent?: boolean; forceReason?: string } = { manual: true },
): Promise<PrepareResult> {
  return prepareTaskHarnessPass(taskId, opts, false);
}

/** One pass of {@link prepareTaskHarness}. `freshAuth` re-probes every
 *  account's login instead of reading the 60 s cache: a manual start that the
 *  cache says is logged out everywhere gets one fresh pass before it is
 *  refused, so logging in and pressing Start again works at once. */
async function prepareTaskHarnessPass(
  taskId: string,
  opts: { manual: boolean; forceOffCurrent?: boolean; forceReason?: string },
  freshAuth: boolean,
): Promise<PrepareResult> {
  const before = await tasks.get(taskId);
  if (!before) return { ok: false, error: "task not found" };
  if (!(await harnessStacks.resolveForTask(before))) return { ok: true };
  if ((await runs.hasRunning(taskId)) || (await hooks?.isTaskHeld?.(taskId))) return { ok: true };
  await warmStackLogins(before, { fresh: freshAuth });
  // The probe awaited: plan from the task and stack as they are NOW (an
  // account switch, a stack edit or a member change may have landed meanwhile).
  const task = await tasks.get(taskId);
  if (!task) return { ok: false, error: "task not found" };
  const resolved = await harnessStacks.resolveForTask(task);
  if (!resolved) return { ok: true };
  // A turn may have started, or background agents taken hold, while the probe ran.
  const busy = async (): Promise<boolean> =>
    (await runs.hasRunning(taskId)) || Boolean(await hooks?.isTaskHeld?.(taskId));
  if (await busy()) return { ok: true };
  const { stack, current } = resolved;
  // A stack of fewer than two accounts behaves exactly like a lone account:
  // no failover state, and the normal pre-flight error (with its login help)
  // is what the user sees.
  if (stack.members.length < 2) {
    // A stack cut down to one account may still carry a stale exhausted
    // countdown and armed timer from when it had two: drop both.
    const hadScheduledSwitch = Boolean(task.harnessState?.scheduledSwitch);
    if (task.harnessState) await clearFailoverState(taskId);
    if (hadScheduledSwitch) {
      await hooks?.onScheduledSwitchDropped?.(taskId, "scheduled account switch dropped — the stack has fewer than two accounts");
    }
    return { ok: true };
  }
  const member = stack.members.find((m) => m.harnessId === current);
  const unusable = opts.forceOffCurrent
    ? (opts.forceReason ?? "unavailable")
    : member
      ? await memberUnusableReason(member, task)
      : "account left the stack";
  // The cache (60 s) may predate a login the user just did on THIS account:
  // never move a manual start off it on a cached "logged out".
  if (opts.manual && !freshAuth && unusable === NOT_LOGGED_IN_REASON) {
    return prepareTaskHarnessPass(taskId, opts, true);
  }
  if (!unusable) {
    if (opts.manual) {
      // A manual turn is a fresh lap and clears the exhausted countdown. It
      // deliberately does NOT clear the account-global cooldown: forcing one
      // task through a still-limited account must not make every other task
      // retry there. The cooldown ends on a successful turn or its reset.
      await updateTaskState(taskId, (state) => ({
        stackId: stack.id,
        position: resolved.position,
        count: stack.members.length,
        tried: [],
        pendingSwap: null,
        allExhausted: null,
        lastMove: state?.lastMove ?? null,
        // A requested "switch to next account" is not part of the lap.
        ...(state?.scheduledSwitch ? { scheduledSwitch: state.scheduledSwitch } : {}),
      }));
      cancelAutoRetry(taskId);
    }
    return { ok: true };
  }

  const now = Date.now();
  const facts = await loadMemberFacts(stack.members, task, now, { ignoreLimits: true });
  const plan = pickNextMember({
    members: stack.members,
    currentId: current,
    // A forced move must never pick the account that just failed pre-flight.
    tried: opts.forceOffCurrent ? [current] : [],
    now,
    // A manual start may force a member whose cooldown is still running —
    // the user explicitly asked to run now.
    cooling: () => null,
    exhaustedByQuota: () => false,
    usable: (m) => facts.unusable.get(m.harnessId) ?? null,
  });
  if (plan.kind !== "next") {
    // Every account refused for the same reason: the login. Say how to fix it.
    if (plan.kind === "none-usable" && plan.reasons.length > 0 && plan.reasons.every((r) => r.reason === NOT_LOGGED_IN_REASON)) {
      // The cache may predate a login the user just did: ask again before refusing.
      if (opts.manual && !freshAuth) return prepareTaskHarnessPass(taskId, opts, true);
      return { ok: false, error: `every account in this stack is ${NOT_LOGGED_IN_REASON} — ${CLAUDE_LOGIN_HINT}` };
    }
    return { ok: false, error: "no usable account in this stack — enable, install or log in to one" };
  }
  const to = plan.member.harnessId;
  const fromHarness = await harnesses.getByIdOrKind(current);
  const toHarness = await harnesses.getByIdOrKind(to);
  if (!fromHarness || !toHarness) return { ok: false, error: "account no longer exists" };

  const reason: NonNullable<TaskHarnessState["lastMove"]>["reason"] = unusable.includes("disabled")
    ? "member-disabled"
    : member ? "member-unavailable" : "member-removed";
  const moved = await moveTaskToMember({
    taskId,
    stack,
    from: current,
    to,
    sessionId: await latestSessionForAccount(task, fromHarness.kind, current),
    cwd: task.worktreePath ?? task.workdir,
    history: { trigger: "unavailable", reason },
    // Re-checked after the mirror and transfer awaits: a task that went live
    // or got held meanwhile keeps its account (the message queues behind it).
    beforeCommit: async () => !(await busy()),
    state: () => ({
      stackId: stack.id,
      position: plan.member.position,
      count: stack.members.length,
      tried: [],
      pendingSwap: null,
      allExhausted: null,
      lastMove: { from: current, to, at: Date.now(), reason },
    }),
  });
  if (moved.kind === "transfer-failed") {
    // A conversation is recorded for this account, so a missing/unreadable
    // transcript is not "nothing to lose": refuse the move instead of
    // silently starting a fresh session on the backup. The automatic swap
    // blocks on the same condition.
    return { ok: false, error: `could not move the conversation to ${toHarness.label}: ${moved.message}` };
  }
  // Declined by `beforeCommit`: nothing was written, so report no move (the
  // caller must not drop the session of an account the task never left).
  if (moved.kind === "aborted") return { ok: true };
  // A manual move supersedes any armed all-exhausted retry. The timer callback
  // would no-op on the cleared state, but leaving the handle in the map keeps
  // a dangling timer for up to 24 h; cancel it like the no-move branch does.
  cancelAutoRetry(taskId);
  // The walk starts AFTER the current account, so `plan.skipped` never lists
  // it: a logged-out current account is named here, ahead of the others.
  const skipLines = await loggedOutSkipLines([
    ...(unusable === NOT_LOGGED_IN_REASON ? [{ harnessId: current, reason: unusable }] : []),
    ...plan.skipped,
  ]);
  return {
    ok: true,
    moved: { from: current, to },
    ...(moved.warnings.length > 0 || skipLines.length > 0
      ? { warnings: [...skipLines, ...moved.warnings] }
      : {}),
  };
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Why each member other than the task's current account cannot take the task
 * right now, one entry per member ("available" when it can). Same rules and
 * order as {@link pickNextMember}: disabled, cooling (model-aware), quota
 * exhausted, then {@link memberUnusableReason}. Reads only; writes nothing.
 */
export async function memberReasonsFor(
  stack: HarnessStack,
  task: Task,
  now = Date.now(),
  opts: { includeCurrent?: boolean } = {},
): Promise<HarnessMemberReason[]> {
  const current = (await harnessStacks.resolveForTask(task))?.current ?? task.agent;
  const tried = task.harnessState?.tried ?? [];
  const members = stack.members.filter((m) => opts.includeCurrent || m.harnessId !== current);
  // One read per member, all in flight together; the order of `members` stays.
  const texts = await Promise.all(
    members.map((member) => memberReasonFor(member, task, now, tried.includes(member.harnessId))),
  );
  return members.map((member, i) => ({
    harnessId: member.harnessId,
    label: member.label,
    reason: member.harnessId === current ? `current — ${texts[i]}` : texts[i]!,
  }));
}

async function memberReasonFor(member: HarnessStackMember, task: Task, now: number, tried: boolean): Promise<string> {
  if (!member.enabled) return (await memberUnusableReason(member, task)) ?? "disabled";
  const cool = await harnessStacks.isCooling(member.harnessId, now, await cooldownModelFor(task, member.harnessId));
  if (cool && cool.exhaustedUntilMs > now) {
    return `cooling until ${formatClock(cool.exhaustedUntilMs)}${cool.model ? ` for ${cool.model}` : ""}`;
  }
  const usage = await harnessUsage.get(member.harnessId);
  if (harnessQuotaLooksExhausted(usage, now, HARNESS_QUOTA_STALE_MS)) {
    const reset = harnessQuotaResetAt(usage, now, HARNESS_QUOTA_STALE_MS);
    return reset !== null && reset > now ? `quota exhausted until ${formatClock(reset)}` : "quota exhausted";
  }
  const unusable = await memberUnusableReason(member, task);
  if (unusable) return unusable;
  return tried ? "tried this lap" : "available";
}

/**
 * The target of a manual "Switch to next account": the next member after the
 * task's current account (wrapping) that an automatic swap would also accept.
 * A PURE planner: it ignores `tried` and never writes a cooldown, `tried` or
 * any other state (invariant: a manual move never cools or marks tried).
 */
export async function planManualSwitchTarget(
  task: Task,
  now = Date.now(),
): Promise<
  | { kind: "next"; stack: HarnessStack; member: HarnessStackMember }
  | { kind: "refused"; code: "not-in-stack" | "no-usable-member"; reasons: HarnessMemberReason[] }
> {
  const resolved = await harnessStacks.resolveForTask(task);
  // An account that left every stack still resolves to the stack it was in
  // (`orphaned`), but it is not a member any more: a move from it is not a
  // same-stack switch, so it would take the outside-stack reset path (no
  // transfer, follow-ups dropped, no history row) while reporting success.
  if (!resolved || resolved.orphaned || resolved.stack.members.length < 2) {
    return { kind: "refused", code: "not-in-stack", reasons: [] };
  }
  const { stack, current } = resolved;
  const facts = await loadMemberFacts(stack.members, task, now);
  const plan = pickNextMember({
    members: stack.members,
    currentId: current,
    // The wrap visits the current account last; counting it as tried keeps a
    // switch from "landing" on the account the task is already on.
    tried: [current],
    now,
    cooling: (id) => facts.cooling.get(id) ?? null,
    exhaustedByQuota: (id) => facts.exhausted.get(id) ?? false,
    quotaResetAt: (id) => facts.resetAt.get(id) ?? null,
    usable: (m) => facts.unusable.get(m.harnessId) ?? null,
  });
  if (plan.kind === "next" && plan.member.harnessId !== current) {
    return { kind: "next", stack, member: plan.member };
  }
  return { kind: "refused", code: "no-usable-member", reasons: await memberReasonsFor(stack, task, now) };
}

/**
 * Append one row to the per-stack swap history. Labels fall back to the id,
 * the task title is denormalized, and source/message/model/resetsAtMs come
 * from `signal`. NEVER throws: a history write must not break a swap, so a
 * failure is logged and null returned.
 */
export async function recordHarnessSwapEvent(args: {
  task: Task;
  stackId: string;
  trigger: HarnessSwapTrigger;
  fromHarnessId: string | null;
  toHarnessId: string | null;
  reason?: HarnessSwapEvent["reason"];
  signal?: HarnessLimitSignal | null;
  fromRunId?: string | null;
  toRunId?: string | null;
  continuation?: HarnessSwapEvent["continuation"];
}): Promise<HarnessSwapEvent | null> {
  try {
    const label = async (id: string | null) => (id === null ? null : (await harnesses.getByIdOrKind(id))?.label ?? id);
    const signal = args.signal ?? null;
    return await harnessSwapEvents.insert({
      stackId: args.stackId,
      taskId: args.task.id,
      taskTitle: args.task.title ?? null,
      fromHarnessId: args.fromHarnessId,
      fromLabel: await label(args.fromHarnessId),
      toHarnessId: args.toHarnessId,
      toLabel: await label(args.toHarnessId),
      trigger: args.trigger,
      reason: args.reason ?? signal?.reason ?? null,
      source: signal?.source ?? null,
      message: signal?.message ?? null,
      model: signal?.model ?? null,
      resetsAtMs: signal?.resetAtMs ?? null,
      fromRunId: args.fromRunId ?? null,
      toRunId: args.toRunId ?? null,
      continuation: args.continuation ?? null,
    });
  } catch (err) {
    console.warn(`[agetor] harness swap history write failed for task ${args.task.id}:`, err);
    return null;
  }
}
