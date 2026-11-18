/**
 * Pure model behind the app bar's Harnesses button and panel
 * (`components/app-bar/`). No DOM, no React, no I/O: it takes the App's
 * harness state and returns what the bar renders, so every rule below has one
 * implementation and the components only draw.
 *
 * "Out of quota", "cooling" and "stale" are decided here and nowhere else
 * (`accountState`), by delegating to the failover's own predicates
 * (`harnessQuotaLooksExhausted`, `harnessQuotaResetAt`, `quotaSummary`,
 * `HARNESS_QUOTA_STALE_MS`) and to `cooldownChips`, so the bar can never
 * disagree with what the failover does. Contract:
 * docs/architecture/app-bar.md.
 */
import {
  HARNESS_QUOTA_STALE_MS,
  harnessQuotaLooksExhausted,
  harnessQuotaResetAt,
} from "../../shared/harness-limits.ts";
import { quotaSummary } from "../../shared/harness-stack.ts";
import {
  USAGE_CRIT_PERCENT,
  USAGE_SUPPORTED_KINDS,
  type AgentKind,
  type AgentStatus,
  type Harness,
  type HarnessLimitState,
  type HarnessQuota,
  type HarnessStack,
  type Task,
} from "../../shared/types.ts";
import { STACK_KIND_LABEL } from "../components/settings/HarnessStackCard.tsx";
import { cooldownChips, type CooldownChip } from "./stack-editor.ts";
import { formatResetClock } from "./stack-badge.ts";
import { visibleTopbarAgents } from "./usage.ts";

export type AccountTone = "danger" | "warning" | "success" | "muted";
export type AccountStateKind = "disabled" | "unavailable" | "logged-out" | "cooling" | "out-of-quota" | "ready";

export interface AccountState {
  harnessId: string;
  kind: AgentKind;
  label: string;
  state: AccountStateKind;
  tone: AccountTone;
  /** "Unavailable" | "Status unknown" | "Logged out" | "Cooling until 14:30" | "Out of quota until 14:30" | "Out of quota" | "Ready" | "Disabled" */
  statusText: string;
  /** CLI reason / authHelp / path. Third-party text: render as plain text only. */
  detail: string | null;
  quota: HarnessQuota | null;
  /** Worst blocking meter (`quotaSummary`); null when there is none or the snapshot isn't `ok`. */
  usedPercent: number | null;
  /** `quotaSummary(...).stale` for a present snapshot; false when `quota` is null. */
  stale: boolean;
  /** Account-wide cooldown end, else the quota snapshot's reset. */
  blockedUntil: number | null;
  cooldowns: CooldownChip[];
  /** Non-archived tasks in column "running" on this account. */
  runningTasks: number;
  usageSupported: boolean;
}

export interface StackMemberState extends AccountState {
  /** "Primary" | "Backup 1" | … */
  positionLabel: string;
}

export interface FailoverTask {
  taskId: string;
  title: string;
  parentId: string | null;
  stackId: string;
  kind: "switching" | "waiting";
  text: string;
}

export interface StackUnit {
  stack: HarnessStack;
  kindLabel: string;
  /** Stack order; disabled members are included (state "disabled"). */
  members: StackMemberState[];
  usableCount: number;
  /** Lowest worst-blocking % among the usable members; 100 when none is usable; null when no usable member reports one. */
  headroomPercent: number | null;
  headroomSource: string | null;
  stale: boolean;
  /** Earliest known reset among the blocked members; set only when `usableCount === 0`. */
  blockedUntil: number | null;
  failoverTasks: FailoverTask[];
}

export interface HarnessBarButton {
  dot: AccountTone | "none";
  enabledCount: number;
  meter: { usedPercent: number; stale: boolean; source: string } | null;
  badgeCount: number;
  allBlocked: boolean;
  until: number | null;
  /** Tooltip text and the button's `aria-describedby` target. */
  summaryText: string;
}

export interface HarnessBarModel {
  button: HarnessBarButton;
  stacks: StackUnit[];
  accounts: AccountState[];
  otherFailoverTasks: FailoverTask[];
  /** The next instant the model's answer can change on its own, or null. */
  nextChangeAt: number | null;
}

export interface HarnessBarInput {
  agents: readonly AgentStatus[];
  harnesses: readonly Harness[];
  stacks: readonly HarnessStack[];
  limitStates: readonly HarnessLimitState[];
  usage: Readonly<Record<string, HarnessQuota>>;
  tasks: readonly Task[];
}

const TONE_RANK: Record<AccountTone, number> = { muted: 0, success: 1, warning: 2, danger: 3 };

/** The state of one account, by D-P6 precedence: disabled > unavailable >
 *  logged-out > cooling (account-wide) > out-of-quota > ready. A per-model
 *  cooldown only adds a chip. */
export function accountState(
  harness: Harness,
  status: AgentStatus | undefined,
  limitStates: readonly HarnessLimitState[],
  quota: HarnessQuota | null | undefined,
  tasks: readonly Task[],
  now: number,
): AccountState {
  const q = quota ?? null;
  const summary = quotaSummary(q, now);
  const usedPercent =
    q && summary.status === "ok" && summary.meters.length > 0
      ? Math.max(...summary.meters.map((m) => m.usedPercent))
      : null;
  const cooldowns = cooldownChips(limitStates, harness.id, now);
  const accountWide = limitStates.filter(
    (s) => s.harnessId === harness.id && (s.model ?? null) === null && s.exhaustedUntilMs > now,
  );
  const cooldownEnd = accountWide.reduce<number | null>(
    (best, s) => (best === null || s.exhaustedUntilMs > best ? s.exhaustedUntilMs : best),
    null,
  );
  const quotaExhausted = harnessQuotaLooksExhausted(q, now, HARNESS_QUOTA_STALE_MS);
  const quotaReset = harnessQuotaResetAt(q, now, HARNESS_QUOTA_STALE_MS);
  const runningTasks = tasks.filter((t) => !t.archivedAt && t.column === "running" && t.agent === harness.id).length;

  let state: AccountStateKind;
  let tone: AccountTone;
  let statusText: string;
  let detail: string | null = null;
  let blockedUntil: number | null = null;
  if (!harness.enabled) {
    state = "disabled";
    tone = "muted";
    statusText = "Disabled";
  } else if (!status) {
    state = "unavailable";
    tone = "danger";
    statusText = "Status unknown";
  } else if (!status.available) {
    state = "unavailable";
    tone = "danger";
    statusText = "Unavailable";
    detail = status.reason ?? status.path ?? null;
  } else if (status.loggedIn === false) {
    state = "logged-out";
    tone = "warning";
    statusText = "Logged out";
    detail = status.authHelp ?? "Not logged in";
  } else if (cooldownEnd !== null) {
    state = "cooling";
    tone = "warning";
    blockedUntil = cooldownEnd;
    statusText = `Cooling until ${formatResetClock(cooldownEnd, now)}`;
  } else if (quotaExhausted) {
    state = "out-of-quota";
    tone = "warning";
    blockedUntil = quotaReset;
    statusText = quotaReset === null ? "Out of quota" : `Out of quota until ${formatResetClock(quotaReset, now)}`;
  } else {
    state = "ready";
    tone = "success";
    statusText = "Ready";
  }
  return {
    harnessId: harness.id,
    kind: harness.kind,
    label: harness.label,
    state,
    tone,
    statusText,
    detail,
    quota: q,
    usedPercent,
    stale: q ? summary.stale : false,
    blockedUntil,
    cooldowns,
    runningTasks,
    usageSupported: (USAGE_SUPPORTED_KINDS as readonly string[]).includes(harness.kind),
  };
}

function isBlocked(a: AccountState): boolean {
  return a.state === "cooling" || a.state === "out-of-quota";
}

/** An account that exists in principle: it is installed and logged in, even if it is cooling right now. */
function canRunInPrinciple(a: AccountState): boolean {
  return a.state === "ready" || isBlocked(a);
}

function earliest(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const v of values) if (v !== null && (best === null || v < best)) best = v;
  return best;
}

function buildFailoverTasks(
  tasks: readonly Task[],
  harnesses: readonly Harness[],
  now: number,
): FailoverTask[] {
  const labelOf = (id: string) => harnesses.find((h) => h.id === id)?.label ?? id;
  const out: FailoverTask[] = [];
  for (const t of tasks) {
    if (t.archivedAt) continue;
    const hs = t.harnessState;
    if (!hs || (!hs.pendingSwap && !hs.allExhausted)) continue;
    const parentId = t.pipelineParentId ?? null;
    if (hs.pendingSwap) {
      out.push({
        taskId: t.id,
        title: t.title,
        parentId,
        stackId: hs.stackId,
        kind: "switching",
        text: `switching to ${labelOf(hs.pendingSwap.to)}`,
      });
      continue;
    }
    const reset = hs.allExhausted?.earliestResetAtMs ?? null;
    out.push({
      taskId: t.id,
      title: t.title,
      parentId,
      stackId: hs.stackId,
      kind: "waiting",
      text:
        reset !== null && Number.isFinite(reset) && reset > now
          ? `waiting for quota until ${formatResetClock(reset, now)}`
          : "waiting for quota",
    });
  }
  return out;
}

function problemRank(a: AccountState): number {
  if (a.runningTasks > 0) return 0;
  if (a.tone === "danger" || a.tone === "warning" || (a.usedPercent !== null && a.usedPercent >= USAGE_CRIT_PERCENT)) {
    return 1;
  }
  return 2;
}

interface MeterUnit {
  usedPercent: number;
  stale: boolean;
  source: string;
}

/** Every instant at which the model can change without new data arriving. */
function nextChange(
  now: number,
  limitStates: readonly HarnessLimitState[],
  usage: Readonly<Record<string, HarnessQuota>>,
  enabledIds: ReadonlySet<string>,
  tasks: readonly Task[],
): number | null {
  const candidates: number[] = [];
  for (const s of limitStates) if (enabledIds.has(s.harnessId)) candidates.push(s.exhaustedUntilMs);
  for (const id of enabledIds) {
    const q = usage[id];
    if (!q) continue;
    candidates.push(q.fetchedAtMs + HARNESS_QUOTA_STALE_MS);
    for (const m of q.meters) if (m.resetsAtMs !== null) candidates.push(m.resetsAtMs);
  }
  for (const t of tasks) {
    const at = t.harnessState?.allExhausted?.earliestResetAtMs;
    if (at != null) candidates.push(at);
  }
  let best: number | null = null;
  for (const c of candidates) {
    if (Number.isFinite(c) && c > now && (best === null || c < best)) best = c;
  }
  return best;
}

export function buildHarnessBarModel(input: HarnessBarInput, now: number): HarnessBarModel {
  const { agents, harnesses, stacks, limitStates, usage, tasks } = input;
  const harnessById = new Map(harnesses.map((h) => [h.id, h] as const));
  const statusById = new Map(agents.map((a) => [a.harnessId, a] as const));
  const stateFor = (h: Harness) => accountState(h, statusById.get(h.id), limitStates, usage[h.id], tasks, now);

  // The enabled accounts, in the order the old bar used (agent order), plus
  // any enabled account whose status row hasn't arrived yet.
  const enabledIds: string[] = visibleTopbarAgents(agents, harnesses).map((a) => a.harnessId);
  for (const h of harnesses) if (h.enabled && !enabledIds.includes(h.id)) enabledIds.push(h.id);
  const enabledSet = new Set(enabledIds);

  // Live stacks: at least two ENABLED members (D-P7).
  const failover = buildFailoverTasks(tasks, harnesses, now);
  const stackedIds = new Set<string>();
  const stackUnits: StackUnit[] = [];
  for (const stack of stacks) {
    const memberHarnesses = stack.members
      .map((m) => harnessById.get(m.harnessId))
      .filter((h): h is Harness => h !== undefined);
    if (memberHarnesses.filter((h) => h.enabled).length < 2) continue;
    const members: StackMemberState[] = memberHarnesses.map((h, i) => ({
      ...stateFor(h),
      positionLabel: i === 0 ? "Primary" : `Backup ${i}`,
    }));
    for (const m of members) stackedIds.add(m.harnessId);
    const usable = members.filter((m) => m.state === "ready");
    let headroomPercent: number | null = null;
    let headroomSource: string | null = null;
    let stale = false;
    let blockedUntil: number | null = null;
    if (usable.length === 0) {
      headroomPercent = 100;
      blockedUntil = earliest(members.filter(isBlocked).map((m) => m.blockedUntil));
    } else {
      for (const m of usable) {
        if (m.usedPercent === null) continue;
        if (headroomPercent === null || m.usedPercent < headroomPercent) {
          headroomPercent = m.usedPercent;
          headroomSource = m.label;
          stale = m.stale;
        }
      }
    }
    stackUnits.push({
      stack,
      kindLabel: STACK_KIND_LABEL[stack.kind],
      members,
      usableCount: usable.length,
      headroomPercent,
      headroomSource,
      stale,
      blockedUntil,
      failoverTasks: failover.filter((f) => f.stackId === stack.id),
    });
  }
  const liveStackIds = new Set(stackUnits.map((u) => u.stack.id));
  const otherFailoverTasks = failover.filter((f) => !liveStackIds.has(f.stackId));

  // The remaining enabled accounts, ordered running → problem → DB order.
  const accounts = enabledIds
    .filter((id) => !stackedIds.has(id) && harnessById.has(id))
    .map((id, index) => ({ a: stateFor(harnessById.get(id) as Harness), index }))
    .sort((x, y) => problemRank(x.a) - problemRank(y.a) || x.index - y.index)
    .map((x) => x.a);

  // Dot: the worst tone over every enabled account (stack members included).
  const enabledStates: AccountState[] = [
    ...stackUnits.flatMap((u) => u.members.filter((m) => m.state !== "disabled")),
    ...accounts,
  ];
  let dot: AccountTone | "none" = "none";
  if (enabledStates.length > 0) {
    dot = enabledStates.reduce<AccountTone>((w, a) => (TONE_RANK[a.tone] > TONE_RANK[w] ? a.tone : w), "muted");
  }

  // Meter: the tightest unit that can still run (D-P4). Stacks come first, in
  // panel order, so ties go to the earlier one.
  const meterUnits: MeterUnit[] = [];
  for (const u of stackUnits) {
    const anyCapacity = u.usableCount > 0 || u.members.some(isBlocked);
    if (anyCapacity && u.headroomPercent !== null) {
      meterUnits.push({
        usedPercent: u.headroomPercent,
        stale: u.stale,
        source: `${u.stack.label} stack${u.headroomSource ? ` (${u.headroomSource})` : ""}`,
      });
    }
  }
  for (const a of accounts) {
    if (!canRunInPrinciple(a)) continue;
    const pct = isBlocked(a) ? 100 : a.usedPercent;
    if (pct !== null) meterUnits.push({ usedPercent: pct, stale: a.stale, source: a.label });
  }
  let meter: HarnessBarButton["meter"] = null;
  for (const u of meterUnits) if (meter === null || u.usedPercent > meter.usedPercent) meter = u;

  // allBlocked / until (D-P5).
  const runnableUnits: { blocked: boolean; until: number | null }[] = [
    ...stackUnits
      .filter((u) => u.members.some(canRunInPrinciple))
      .map((u) => ({ blocked: u.usableCount === 0, until: u.blockedUntil })),
    ...accounts.filter(canRunInPrinciple).map((a) => ({ blocked: isBlocked(a), until: a.blockedUntil })),
  ];
  const allBlocked = runnableUnits.length > 0 && runnableUnits.every((u) => u.blocked);
  const until = allBlocked ? earliest(runnableUnits.map((u) => u.until)) : null;

  const badgeCount = failover.length;
  const enabledCount = enabledIds.length;
  const summary: string[] = [
    enabledCount === 0 ? "No harnesses enabled" : `${enabledCount} harness${enabledCount === 1 ? "" : "es"} enabled`,
  ];
  if (meter) {
    summary.push(`Meter: ${Math.round(meter.usedPercent)}% used on ${meter.source}${meter.stale ? " (stale)" : ""}`);
  }
  if (allBlocked) {
    summary.push(
      until === null
        ? "Every account is out of quota"
        : `Every account is out of quota until ${formatResetClock(until, now)}`,
    );
  }
  if (badgeCount > 0) {
    summary.push(`${badgeCount} task${badgeCount === 1 ? "" : "s"} switching accounts or waiting for quota`);
  }

  return {
    button: { dot, enabledCount, meter, badgeCount, allBlocked, until, summaryText: summary.join(" · ") },
    stacks: stackUnits,
    accounts,
    otherFailoverTasks,
    nextChangeAt: nextChange(now, limitStates, usage, enabledSet, tasks),
  };
}
