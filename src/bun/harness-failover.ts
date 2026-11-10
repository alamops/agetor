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
import { peekCachedCliVersion } from "./agent-status.ts";
import { cliVersionSatisfies } from "../shared/cli-version.ts";
import { harnesses, harnessUsage, runs, tasks, type SessionIdColumn } from "./db.ts";
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
  isTaskHeld?(taskId: string): boolean;
}

let hooks: FailoverHooks | null = null;
export function setHarnessFailoverHooks(next: FailoverHooks | null): FailoverHooks | null {
  const prev = hooks;
  hooks = next;
  return prev;
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The one write path for `tasks.harness_state` (review S10). `mutate` gets the
 * persisted state (or null) and returns the next one; a non-null result is
 * re-pointed at the stack the task's CURRENT account belongs to (see
 * {@link stateBase}), so no caller can write back a `stackId`/position the
 * account already left — the orchestrator's settle/retry/swap writes used to
 * spread the stale value back in and stack delete then missed the task.
 */
export function updateTaskState(
  taskId: string,
  mutate: (state: TaskHarnessState | null, task: Task) => TaskHarnessState | null,
): TaskHarnessState | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const next = mutate(task.harnessState ?? null, task);
  if (next === null) {
    tasks.setHarnessState(taskId, null);
    return null;
  }
  const repointed = stateBase(next, harnessStacks.resolveForTask({ ...task, harnessState: next }));
  tasks.setHarnessState(taskId, repointed);
  return repointed;
}

/**
 * Merge `patch` into the persisted state (re-pointed like
 * {@link updateTaskState}). A no-op returning null when the task has no state:
 * every caller patches a field of an existing failover state, and creating one
 * from nothing would turn a lone account into a "stacked" task.
 */
export function patchTaskState(
  taskId: string,
  patch: Partial<TaskHarnessState> | ((state: TaskHarnessState) => Partial<TaskHarnessState>),
): TaskHarnessState | null {
  if (!tasks.get(taskId)?.harnessState) return null;
  return updateTaskState(taskId, (state) => {
    if (!state) return null;
    return { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  });
}

/**
 * The ids of every task whose failover state belongs to `stackId`: the
 * recorded `stackId` OR the stack the task's account resolves to right now.
 * A stack delete must clear both — an account edited into this stack after the
 * task's last write still names the old train (review S10). Call BEFORE the
 * stack row is deleted (the resolution needs the membership).
 */
export function failoverTaskIdsForStack(stackId: string): string[] {
  const ids: string[] = [];
  for (const task of tasks.list()) {
    if (task.harnessState?.stackId === stackId) {
      ids.push(task.id);
      continue;
    }
    if (!task.harnessState && !retryTimers.has(task.id)) continue;
    if (harnessStacks.resolveForTask(task)?.stack.id === stackId) ids.push(task.id);
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
  resolved: ReturnType<typeof harnessStacks.resolveForTask>,
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
export function recordLimitSignal(harnessId: string, signal: HarnessLimitSignal): void {
  harnessStacks.setLimitState(harnessId, signal);
}

/** Mark an account as tried in the current lap. */
export function recordTried(taskId: string, harnessId: string): void {
  updateTaskState(taskId, (state, task) => {
    const resolved = harnessStacks.resolveForTask(task);
    const base = stateBase(state, resolved);
    const tried = base.tried.includes(harnessId) ? base.tried : [...base.tried, harnessId];
    return { ...base, tried };
  });
}

/** A successful (or cancelled) terminal turn ends the lap. */
export function resetLap(taskId: string): void {
  patchTaskState(taskId, { tried: [], allExhausted: null });
}

/** Clear all failover state (a non-stack switch, archive, or stack delete). */
export function clearFailoverState(taskId: string): void {
  tasks.setHarnessState(taskId, null);
  cancelAutoRetry(taskId);
}

export type { NextMemberPlan };

/**
 * Why a member cannot run this task's turn right now, or null when it can.
 * Deliberately cheap: no fresh CLI probe on the hot path — the cached version
 * from the last /harnesses poll is enough, and an unknown version fails open.
 */
export function memberUnusableReason(member: { harnessId: string; enabled: boolean; label: string }, task: Pick<Task, "model">): string | null {
  if (!member.enabled) return "disabled";
  const harness = harnesses.getByIdOrKind(member.harnessId);
  if (!harness) return "account no longer exists";
  if (!memberInstalled(harness)) return "CLI not installed";
  if (loginEvidence(harness) === false) return "logged out";
  // The model the turn would really run: a default-model task (null) resolves
  // exactly like `startTask` does, so a backup that cannot serve the default
  // model is skipped too.
  const model = task.model ?? DEFAULT_MODEL[harness.kind] ?? null;
  const catalog = getHarnessDiscoveredModels(harness.id);
  if (catalog.length > 0 && model && !catalog.some((m) => m.id === model)) {
    return `model ${model} not offered`;
  }
  const floor = MODEL_MIN_CLI_VERSION[harness.kind]?.[model ?? ""];
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
function cooldownModelFor(task: Pick<Task, "model">, harnessId: string): string | null {
  const harness = harnesses.getByIdOrKind(harnessId);
  const model = task.model ?? (harness ? DEFAULT_MODEL[harness.kind] : null) ?? null;
  return model ? model.toLowerCase() : null;
}

/**
 * Walk forward from the current account and pick the next usable one. Skips
 * tried, disabled, cooling, quota-exhausted and unusable members. `cooling`
 * is ignored when `force` is set (a manual Run).
 */
export function planNextMember(
  task: Pick<Task, "id" | "agent" | "model" | "harnessState">,
  opts: { now?: number; force?: boolean; currentId?: string } = {},
): NextMemberPlan {
  const now = opts.now ?? Date.now();
  const resolved = harnessStacks.resolveForTask(task);
  if (!resolved) {
    return { kind: "none-usable", reasons: [{ harnessId: task.agent, reason: "not in a stack" }], earliestResetAtMs: null, skipped: [] };
  }
  const { stack } = resolved;
  // A settle must walk from the account that actually ran the limited turn,
  // not from whatever `tasks.agent` says now: a run can settle after a
  // manual/manual-failover move changed the task's account.
  const current = opts.currentId ?? resolved.current;
  const state = task.harnessState;
  return pickNextMember({
    members: stack.members,
    currentId: current,
    tried: state?.tried ?? [],
    now,
    cooling: (id) => (opts.force ? null : harnessStacks.isCooling(id, now, cooldownModelFor(task, id))),
    exhaustedByQuota: (id) => (opts.force ? false : harnessQuotaLooksExhausted(harnessUsage.get(id), now, HARNESS_QUOTA_STALE_MS)),
    quotaResetAt: (id) => (opts.force ? null : harnessQuotaResetAt(harnessUsage.get(id), now, HARNESS_QUOTA_STALE_MS)),
    usable: (member) => memberUnusableReason(member, task),
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
export function planRetryMember(
  task: Pick<Task, "id" | "agent" | "model" | "harnessState">,
  opts: { now?: number } = {},
): NextMemberPlan {
  const now = opts.now ?? Date.now();
  const resolved = harnessStacks.resolveForTask(task);
  if (!resolved) {
    return { kind: "none-usable", reasons: [{ harnessId: task.agent, reason: "not in a stack" }], earliestResetAtMs: null, skipped: [] };
  }
  const { stack, current } = resolved;
  const currentMember = stack.members.find((m) => m.harnessId === current);
  const currentUsable = currentMember
    ? memberUnusableReason(currentMember, task) === null
      && harnessStacks.isCooling(current, now, cooldownModelFor(task, current)) === null
      && !harnessQuotaLooksExhausted(harnessUsage.get(current), now, HARNESS_QUOTA_STALE_MS)
    : false;
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
  opts: { startedThisAttempt?: boolean } = {},
): TaskHarnessState | null {
  return updateTaskState(taskId, (state, task) => {
    const resolved = harnessStacks.resolveForTask(task);
    const base = stateBase(state, resolved);
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
function deferAutoRetry(taskId: string, firedAt: number): boolean {
  const persisted = tasks.get(taskId)?.harnessState?.allExhausted;
  if (!persisted) return false;
  if (persisted.nextAttemptAt !== firedAt || persisted.inFlight) return false;
  if (persisted.attempts >= HARNESS_STACK_RETRY_MAX) return false;
  const at = Date.now() + retryMinMs();
  patchTaskState(taskId, { allExhausted: { ...persisted, nextAttemptAt: at } });
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
export function deferAutoRetryNow(taskId: string): boolean {
  const persisted = tasks.get(taskId)?.harnessState?.allExhausted;
  if (!persisted || persisted.inFlight || persisted.nextAttemptAt <= 0) return false;
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
  return stopped;
}

/** Whether a retry timer is armed in this process for `taskId`. */
export function hasArmedAutoRetry(taskId: string): boolean {
  return retryTimers.has(taskId);
}

/** Arm (or re-arm) the all-exhausted retry timer. Re-arming replaces the old one. */
export function armAutoRetry(taskId: string, at: number): void {
  cancelAutoRetry(taskId);
  const delay = Math.max(0, at - Date.now());
  const timer = setTimeout(() => {
    retryTimers.delete(taskId);
    if (!hooks) return;
    // Identity check: a timer whose callback was already queued when the
    // schedule was re-armed (or cleared by a manual run) must not start a
    // turn against the newer state.
    const persisted = tasks.get(taskId)?.harnessState?.allExhausted;
    if (!persisted || persisted.nextAttemptAt !== at) return;
    // Another start/swap owns the task right now. Consuming the timer here
    // would strand the persisted countdown if that start's prepare fails;
    // re-arm a short backoff and let the claim holder's own settle decide.
    if (hooks.canAutoRetry && !hooks.canAutoRetry(taskId)) {
      deferAutoRetry(taskId, at);
      return;
    }
    void hooks.onAutoRetry(taskId).catch((err) => {
      console.warn(`[agetor] harness auto-retry failed for task ${taskId}:`, err);
    });
  }, Math.min(delay, 2_147_483_647));
  // Don't keep the process alive just for a retry timer; the boot re-arm
  // reads the persisted intent.
  timer.unref?.();
  retryTimers.set(taskId, timer);
}

export function cancelAutoRetry(taskId: string): void {
  const timer = retryTimers.get(taskId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(taskId);
}

/** Boot: re-arm every persisted all-exhausted retry still in the future, and
 *  recover one that was spawning when the core stopped. An overdue schedule
 *  (the core was down through it) is staggered like `rearmFxAutoResumes`'s —
 *  `now + 5 s + i × 2 s` per overdue entry, persisted so the armed timer's
 *  identity check matches — instead of every overdue task firing in the same
 *  tick and mirroring into one backup concurrently (review S9). */
export function rearmAutoRetries(now = Date.now()): number {
  let armed = 0;
  let overdue = 0;
  for (const task of tasks.list()) {
    const state = task.harnessState;
    const exhausted = state?.allExhausted;
    if (!state || !exhausted) continue;
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
        ? runs.get(attemptRunId)
        : task.runId
          ? runs.get(task.runId)
          : null;
      const attempts = exhausted.attempts;
      if (live && live.status === "running") {
        // The retry run is still live (re-attached, or the core is answering
        // again after a handoff): keep `inFlight` so its own settle stays
        // armed to end the loop on a non-limit failure. Clearing it here set
        // `nextAttemptAt: 0` with no timer, which the UI reads as
        // "Retrying…" forever.
        continue;
      }
      if (attemptRunId && live && live.status !== "orphaned") {
        // The retry run genuinely settled (succeeded/failed/cancelled) but the
        // in-flight marker survived: the crash landed between the terminal run
        // write and this bookkeeping. A non-limit failure must never be
        // re-armed — that would loop on the same error — and a succeeded run
        // already proved the account works. Drop the exhausted state and let
        // the run's own visible outcome stand.
        patchTaskState(task.id, { allExhausted: null });
        continue;
      }
      if (attempts >= HARNESS_STACK_RETRY_MAX) {
        patchTaskState(task.id, { allExhausted: { ...exhausted, inFlight: false, nextAttemptAt: 0 } });
        continue;
      }
      const at = now + HARNESS_STACK_RETRY_BACKOFF_MS;
      patchTaskState(task.id, { allExhausted: { ...exhausted, inFlight: false, nextAttemptAt: at } });
      armAutoRetry(task.id, at);
      armed++;
      continue;
    }
    if (exhausted.attempts >= HARNESS_STACK_RETRY_MAX) continue;
    if (exhausted.nextAttemptAt <= 0) continue;
    // A missed timer is staggered (see the doc above) AND the new instant is
    // persisted, so the armed timer's identity check matches the state it
    // reads on fire.
    const at = exhausted.nextAttemptAt > now
      ? exhausted.nextAttemptAt
      : now + HARNESS_STACK_REARM_OVERDUE_BASE_MS + overdue++ * HARNESS_STACK_REARM_OVERDUE_STEP_MS;
    if (at !== exhausted.nextAttemptAt) {
      patchTaskState(task.id, { allExhausted: { ...exhausted, nextAttemptAt: at } });
    }
    armAutoRetry(task.id, at);
    armed++;
  }
  return armed;
}

/** Boot: complete or visibly block swaps persisted before a crash/handoff. */
export async function reconcilePendingSwaps(): Promise<number> {
  let reconciled = 0;
  for (const task of tasks.list()) {
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
): string | null {
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
  state?: (current: TaskHarnessState | null, task: Task) => TaskHarnessState | null;
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
      const fromHarness = harnesses.getByIdOrKind(from);
      const toHarness = harnesses.getByIdOrKind(to);
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
  if (args.writeAgent !== false && tasks.get(taskId)?.agent !== to) tasks.update(taskId, { agent: to });
  if (args.state) updateTaskState(taskId, args.state);
  if (args.history) {
    const row = tasks.get(taskId);
    if (row) {
      recordHarnessSwapEvent({
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
 * probe or the per-model CLI floor is newer than the 15 s status cache). It
 * treats the current account as unusable for this turn and moves to a backup
 * exactly like a disabled/logged-out member would.
 */
export async function prepareTaskHarness(
  taskId: string,
  opts: { manual: boolean; forceOffCurrent?: boolean; forceReason?: string } = { manual: true },
): Promise<PrepareResult> {
  const task = tasks.get(taskId);
  if (!task) return { ok: false, error: "task not found" };
  const resolved = harnessStacks.resolveForTask(task);
  if (!resolved) return { ok: true };
  if (runs.hasRunning(taskId) || hooks?.isTaskHeld?.(taskId)) return { ok: true };
  const { stack, current } = resolved;
  // A stack of fewer than two accounts behaves exactly like a lone account:
  // no failover state, and the normal pre-flight error (with its login help)
  // is what the user sees.
  if (stack.members.length < 2) {
    // A stack cut down to one account may still carry a stale exhausted
    // countdown and armed timer from when it had two: drop both.
    if (task.harnessState) clearFailoverState(taskId);
    return { ok: true };
  }
  const member = stack.members.find((m) => m.harnessId === current);
  const unusable = opts.forceOffCurrent
    ? (opts.forceReason ?? "unavailable")
    : member
      ? memberUnusableReason(member, task)
      : "account left the stack";
  if (!unusable) {
    if (opts.manual) {
      // A manual turn is a fresh lap and clears the exhausted countdown. It
      // deliberately does NOT clear the account-global cooldown: forcing one
      // task through a still-limited account must not make every other task
      // retry there. The cooldown ends on a successful turn or its reset.
      updateTaskState(taskId, (state) => ({
        stackId: stack.id,
        position: resolved.position,
        count: stack.members.length,
        tried: [],
        pendingSwap: null,
        allExhausted: null,
        lastMove: state?.lastMove ?? null,
      }));
      cancelAutoRetry(taskId);
    }
    return { ok: true };
  }

  const plan = pickNextMember({
    members: stack.members,
    currentId: current,
    // A forced move must never pick the account that just failed pre-flight.
    tried: opts.forceOffCurrent ? [current] : [],
    now: Date.now(),
    // A manual start may force a member whose cooldown is still running —
    // the user explicitly asked to run now.
    cooling: () => null,
    exhaustedByQuota: () => false,
    usable: (m) => memberUnusableReason(m, task),
  });
  if (plan.kind !== "next") {
    return { ok: false, error: "no usable account in this stack — enable, install or log in to one" };
  }
  const to = plan.member.harnessId;
  const fromHarness = harnesses.getByIdOrKind(current);
  const toHarness = harnesses.getByIdOrKind(to);
  if (!fromHarness || !toHarness) return { ok: false, error: "account no longer exists" };

  const reason: NonNullable<TaskHarnessState["lastMove"]>["reason"] = unusable.includes("disabled")
    ? "member-disabled"
    : member ? "member-unavailable" : "member-removed";
  const moved = await moveTaskToMember({
    taskId,
    stack,
    from: current,
    to,
    sessionId: latestSessionForAccount(task, fromHarness.kind, current),
    cwd: task.worktreePath ?? task.workdir,
    history: { trigger: "unavailable", reason },
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
  // A manual move supersedes any armed all-exhausted retry. The timer callback
  // would no-op on the cleared state, but leaving the handle in the map keeps
  // a dangling timer for up to 24 h; cancel it like the no-move branch does.
  cancelAutoRetry(taskId);
  return {
    ok: true,
    moved: { from: current, to },
    ...(moved.warnings.length > 0 ? { warnings: moved.warnings } : {}),
  };
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Why each member other than the task's current account cannot take the task
 * right now, one entry per member ("available" when it can). Same rules and
 * order as {@link pickNextMember}: disabled, cooling (model-aware), quota
 * exhausted, then {@link memberUnusableReason}. Pure: reads only.
 */
export function memberReasonsFor(
  stack: HarnessStack,
  task: Task,
  now = Date.now(),
  opts: { includeCurrent?: boolean } = {},
): HarnessMemberReason[] {
  const current = harnessStacks.resolveForTask(task)?.current ?? task.agent;
  const tried = task.harnessState?.tried ?? [];
  const out: HarnessMemberReason[] = [];
  for (const member of stack.members) {
    const isCurrent = member.harnessId === current;
    if (isCurrent && !opts.includeCurrent) continue;
    const text = memberReasonFor(member, task, now, tried.includes(member.harnessId));
    out.push({ harnessId: member.harnessId, label: member.label, reason: isCurrent ? `current — ${text}` : text });
  }
  return out;
}

function memberReasonFor(member: HarnessStackMember, task: Task, now: number, tried: boolean): string {
  if (!member.enabled) return memberUnusableReason(member, task) ?? "disabled";
  const cool = harnessStacks.isCooling(member.harnessId, now, cooldownModelFor(task, member.harnessId));
  if (cool && cool.exhaustedUntilMs > now) {
    return `cooling until ${formatClock(cool.exhaustedUntilMs)}${cool.model ? ` for ${cool.model}` : ""}`;
  }
  if (harnessQuotaLooksExhausted(harnessUsage.get(member.harnessId), now, HARNESS_QUOTA_STALE_MS)) {
    const reset = harnessQuotaResetAt(harnessUsage.get(member.harnessId), now, HARNESS_QUOTA_STALE_MS);
    return reset !== null && reset > now ? `quota exhausted until ${formatClock(reset)}` : "quota exhausted";
  }
  const unusable = memberUnusableReason(member, task);
  if (unusable) return unusable;
  return tried ? "tried this lap" : "available";
}

/**
 * The target of a manual "Switch to next account": the next member after the
 * task's current account (wrapping) that an automatic swap would also accept.
 * A PURE planner: it ignores `tried` and never writes a cooldown, `tried` or
 * any other state (invariant: a manual move never cools or marks tried).
 */
export function planManualSwitchTarget(
  task: Task,
  now = Date.now(),
):
  | { kind: "next"; stack: HarnessStack; member: HarnessStackMember }
  | { kind: "refused"; code: "not-in-stack" | "no-usable-member"; reasons: HarnessMemberReason[] } {
  const resolved = harnessStacks.resolveForTask(task);
  if (!resolved || resolved.stack.members.length < 2) {
    return { kind: "refused", code: "not-in-stack", reasons: [] };
  }
  const { stack, current } = resolved;
  const plan = pickNextMember({
    members: stack.members,
    currentId: current,
    // The wrap visits the current account last; counting it as tried keeps a
    // switch from "landing" on the account the task is already on.
    tried: [current],
    now,
    cooling: (id) => harnessStacks.isCooling(id, now, cooldownModelFor(task, id)),
    exhaustedByQuota: (id) => harnessQuotaLooksExhausted(harnessUsage.get(id), now, HARNESS_QUOTA_STALE_MS),
    quotaResetAt: (id) => harnessQuotaResetAt(harnessUsage.get(id), now, HARNESS_QUOTA_STALE_MS),
    usable: (m) => memberUnusableReason(m, task),
  });
  if (plan.kind === "next" && plan.member.harnessId !== current) {
    return { kind: "next", stack, member: plan.member };
  }
  return { kind: "refused", code: "no-usable-member", reasons: memberReasonsFor(stack, task, now) };
}

/**
 * Append one row to the per-stack swap history. Labels fall back to the id,
 * the task title is denormalized, and source/message/model/resetsAtMs come
 * from `signal`. NEVER throws: a history write must not break a swap, so a
 * failure is logged and null returned.
 */
export function recordHarnessSwapEvent(args: {
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
}): HarnessSwapEvent | null {
  try {
    const label = (id: string | null) => (id === null ? null : harnesses.getByIdOrKind(id)?.label ?? id);
    const signal = args.signal ?? null;
    return harnessSwapEvents.insert({
      stackId: args.stackId,
      taskId: args.task.id,
      taskTitle: args.task.title ?? null,
      fromHarnessId: args.fromHarnessId,
      fromLabel: label(args.fromHarnessId),
      toHarnessId: args.toHarnessId,
      toLabel: label(args.toHarnessId),
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
