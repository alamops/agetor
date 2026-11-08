/**
 * The harness-stack failover engine (docs/architecture/harness-stacks.md,
 * plan T08).
 *
 * It owns the pure-ish decisions — the lap, which member to try next, when an
 * all-exhausted task should retry — plus the timers and persisted intent that
 * survive a core restart. It never spawns or settles a run itself: the
 * orchestrator registers two hooks (`onAutoRetry`, `onReconcileSwap`), which
 * is the only bridge and keeps this module import-cycle-free.
 */
import { MODEL_MIN_CLI_VERSION, type HarnessLimitSignal, type Task, type TaskHarnessState } from "../shared/types.ts";
import { pickNextMember, type NextMemberPlan } from "../shared/harness-stack.ts";
import { harnessQuotaLooksExhausted, harnessQuotaResetAt } from "../shared/harness-limits.ts";
import { getHarnessDiscoveredModels } from "./agent-discovery.ts";
import { peekCachedCliVersion } from "./agent-status.ts";
import { cliVersionSatisfies } from "../shared/cli-version.ts";
import { harnesses, harnessUsage, runs, tasks, type SessionIdColumn } from "./db.ts";
import { harnessStacks, loginEvidence, memberInstalled } from "./harness-stacks.ts";
import { findSessionIdForHarness, sessionTransferAdapter } from "./harness-session-transfer.ts";

export const HARNESS_STACK_RETRY_MAX = 3;
export const HARNESS_STACK_RETRY_BACKOFF_MS = 10 * 60_000;
export const HARNESS_STACK_RETRY_MIN_MS = 10_000;
export const HARNESS_STACK_RETRY_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const HARNESS_QUOTA_STALE_MS = 20 * 60_000;
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
}

let hooks: FailoverHooks | null = null;
export function setHarnessFailoverHooks(next: FailoverHooks | null): FailoverHooks | null {
  const prev = hooks;
  hooks = next;
  return prev;
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function updateTaskState(taskId: string, mutate: (state: TaskHarnessState | null, task: Task) => TaskHarnessState | null): TaskHarnessState | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const next = mutate(task.harnessState ?? null, task);
  tasks.setHarnessState(taskId, next);
  return next;
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

/** Record the account-global cooldown for a limit signal. */
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
  updateTaskState(taskId, (state) => (state ? { ...state, tried: [], allExhausted: null } : state));
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
  if (loginEvidence(harness) === false) return "not logged in";
  const catalog = getHarnessDiscoveredModels(harness.id);
  if (catalog.length > 0 && task.model && !catalog.some((m) => m.id === task.model)) {
    return `model ${task.model} is not offered`;
  }
  const floor = MODEL_MIN_CLI_VERSION[harness.kind]?.[task.model ?? ""];
  if (floor) {
    const version = peekCachedCliVersion(harness);
    if (version !== null && cliVersionSatisfies(version, floor) === false) {
      return `CLI is older than ${floor}`;
    }
  }
  return null;
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
    cooling: (id) => (opts.force ? null : harnessStacks.isCooling(id, now)),
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
      && harnessStacks.isCooling(current, now) === null
      && !harnessQuotaLooksExhausted(harnessUsage.get(current), now, HARNESS_QUOTA_STALE_MS)
    : false;
  if (currentUsable) return { kind: "next", member: currentMember!, skipped: [] };
  // A retry starts a fresh lap: accounts tried in the previous lap are
  // eligible again once their reset has expired.
  const retryTask = { ...task, harnessState: task.harnessState ? { ...task.harnessState, tried: [] } : null };
  return planNextMember(retryTask, { now, currentId: current });
}

function clampWait(ms: number): number {
  return Math.max(HARNESS_STACK_RETRY_MIN_MS, Math.min(HARNESS_STACK_RETRY_MAX_WAIT_MS, ms));
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
function deferAutoRetry(taskId: string, firedAt: number): void {
  const task = tasks.get(taskId);
  const persisted = task?.harnessState?.allExhausted;
  if (!task?.harnessState || !persisted) return;
  if (persisted.nextAttemptAt !== firedAt || persisted.inFlight) return;
  if (persisted.attempts >= HARNESS_STACK_RETRY_MAX) return;
  const at = Date.now() + HARNESS_STACK_RETRY_MIN_MS;
  tasks.setHarnessState(taskId, {
    ...task.harnessState,
    allExhausted: { ...persisted, nextAttemptAt: at },
  });
  armAutoRetry(taskId, at);
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
 *  recover one that was spawning when the core stopped. */
export function rearmAutoRetries(now = Date.now()): number {
  let armed = 0;
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
        tasks.setHarnessState(task.id, { ...state, allExhausted: null });
        continue;
      }
      if (attempts >= HARNESS_STACK_RETRY_MAX) {
        tasks.setHarnessState(task.id, {
          ...state,
          allExhausted: { ...exhausted, inFlight: false, nextAttemptAt: 0 },
        });
        continue;
      }
      const at = now + HARNESS_STACK_RETRY_BACKOFF_MS;
      tasks.setHarnessState(task.id, {
        ...state,
        allExhausted: { ...exhausted, inFlight: false, nextAttemptAt: at },
      });
      armAutoRetry(task.id, at);
      armed++;
      continue;
    }
    if (exhausted.attempts >= HARNESS_STACK_RETRY_MAX) continue;
    if (exhausted.nextAttemptAt <= 0) continue;
    // Clamp a missed timer to "now" AND persist the clamped instant, so the
    // armed timer's identity check matches the state it reads on fire.
    const at = Math.max(now, exhausted.nextAttemptAt);
    if (at !== exhausted.nextAttemptAt) {
      tasks.setHarnessState(task.id, {
        ...state,
        allExhausted: { ...exhausted, nextAttemptAt: at },
      });
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

/**
 * Prepare a task before a user-initiated Run/message. A no-op unless the task
 * is in a stack and its current account cannot serve the turn; then it moves
 * to the next usable member, transferring the conversation. A live run is left
 * alone (the message queues behind it). `manual: true` forces a cooling
 * account, and resets the lap.
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
  if (runs.hasRunning(taskId)) return { ok: true };
  const { stack, current } = resolved;
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

  const sessionId = latestSessionForAccount(task, fromHarness.kind, current);
  if (sessionId) {
    const adapter = sessionTransferAdapter(fromHarness.kind);
    if (!adapter) return { ok: false, error: "this harness kind cannot transfer a conversation" };
    const result = await adapter.transfer({
      taskId,
      fromHarness,
      toHarness,
      sessionId,
      cwd: task.worktreePath ?? task.workdir,
    });
    if (!result.ok) {
      // A conversation is recorded for this account, so a missing/unreadable
      // transcript is not "nothing to lose": refuse the move instead of
      // silently starting a fresh session on the backup. The automatic swap
      // blocks on the same condition.
      return { ok: false, error: `could not move the conversation to ${toHarness.label}: ${result.message}` };
    }
    for (const warning of result.warnings ?? []) {
      console.warn(`[agetor] harness session transfer warning for task ${taskId}:`, warning);
    }
  }

  tasks.update(taskId, { agent: to });
  updateTaskState(taskId, () => ({
    stackId: stack.id,
    position: plan.member.position,
    count: stack.members.length,
    tried: [],
    pendingSwap: null,
    allExhausted: null,
    lastMove: {
      from: current,
      to,
      at: Date.now(),
      reason: unusable.includes("disabled") ? "member-disabled" : member ? "member-unavailable" : "member-removed",
    },
  }));
  // A manual move supersedes any armed all-exhausted retry. The timer callback
  // would no-op on the cleared state, but leaving the handle in the map keeps
  // a dangling timer for up to 24 h; cancel it like the no-move branch does.
  cancelAutoRetry(taskId);
  return { ok: true, moved: { from: current, to } };
}

