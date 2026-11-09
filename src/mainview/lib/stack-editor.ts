/**
 * Pure harness-stack editor mechanics (Settings → Stacks). Kept out of the
 * React component so add/remove/reorder, blocker/warning classification and
 * the >20-row virtual window can be unit-tested without a DOM.
 * Model and rules: docs/architecture/harness-stacks.md.
 */
import type { Harness, HarnessMirrorMode, HarnessStack, HarnessStackKind } from "../../shared/types.ts";
import { ApiTransitError } from "./net-retry.ts";

/**
 * What each mirror mode copies, in the exact words the docs and CLI use
 * (review S6). Safe mode skips the executable/permission-bearing settings;
 * plugins and MCP servers are the tools the feature promises, so both modes
 * mirror them.
 */
export const MIRROR_MODE_COPY: Record<HarnessMirrorMode, string> = {
  full: "Full also mirrors settings hooks, permissions, status line and helper commands (Codex: notify), plus plugins and MCP servers.",
  safe: "Safe skips settings hooks, permissions, status line and helper commands (Codex: notify); plugins and MCP servers are still mirrored.",
};

export interface StackDraft {
  label: string;
  kind: HarnessStackKind;
  members: string[];
  mirrorMode: HarnessMirrorMode;
}

export interface DraftProblem {
  code: string;
  message: string;
  harnessId?: string;
}

export function emptyDraft(kind: HarnessStackKind = "claude-code"): StackDraft {
  return { label: "", kind, members: [], mirrorMode: "full" };
}

export function draftFromStack(stack: HarnessStack): StackDraft {
  return {
    label: stack.label,
    kind: stack.kind,
    members: stack.members.map((m) => m.harnessId),
    mirrorMode: stack.mirrorMode,
  };
}

export function addMember(draft: StackDraft, harnessId: string): StackDraft {
  if (draft.members.includes(harnessId)) return draft;
  return { ...draft, members: [...draft.members, harnessId] };
}

export function removeMember(draft: StackDraft, harnessId: string): StackDraft {
  return { ...draft, members: draft.members.filter((id) => id !== harnessId) };
}

/** Move a member to a new index (clamped). Position 0 is the primary. */
export function moveMember(draft: StackDraft, from: number, to: number): StackDraft {
  if (from < 0 || from >= draft.members.length) return draft;
  const target = Math.max(0, Math.min(draft.members.length - 1, to));
  if (target === from) return draft;
  const members = [...draft.members];
  const [item] = members.splice(from, 1);
  if (item === undefined) return draft;
  members.splice(target, 0, item);
  return { ...draft, members };
}

/** The PATCH body for an edit: only fields that actually changed. A rename
 *  must not resend `members` — the server treats a members field as
 *  mirror-relevant and re-copies the full config for nothing. */
export function draftPatch(
  original: HarnessStack,
  draft: StackDraft,
): Partial<Pick<StackDraft, "label" | "members" | "mirrorMode">> {
  const patch: Partial<Pick<StackDraft, "label" | "members" | "mirrorMode">> = {};
  if (draft.label !== original.label) patch.label = draft.label;
  const originalMembers = original.members.map((m) => m.harnessId);
  if (
    draft.members.length !== originalMembers.length
    || draft.members.some((id, i) => id !== originalMembers[i])
  ) {
    patch.members = draft.members;
  }
  if (draft.mirrorMode !== original.mirrorMode) patch.mirrorMode = draft.mirrorMode;
  return patch;
}

/** Blockers that prevent saving; mirrors the server's `validateInput`. */
export function draftBlockers(
  draft: StackDraft,
  ctx: {
    harnesses: readonly Harness[];
    stackId: string | null;
    /** account → the stack that already owns it (when not this one). */
    membership: ReadonlyMap<string, string>;
  },
): DraftProblem[] {
  const blockers: DraftProblem[] = [];
  if (draft.label.trim() === "") blockers.push({ code: "no-label", message: "Give the stack a name." });
  if (draft.members.length === 0) blockers.push({ code: "no-members", message: "Add at least one account." });
  if (new Set(draft.members).size !== draft.members.length) {
    blockers.push({ code: "duplicate-member", message: "An account can appear only once." });
  }
  // Mirror the server's same-home blocker (review nit): two members that read
  // and write one config root would share a login and a session store, so a
  // failover between them is meaningless and the mirror writes over itself.
  // The comparison is string-based here (the webview cannot realpath); the
  // server remains authoritative.
  const roots = new Map<string, string>();
  for (const id of draft.members) {
    const harness = ctx.harnesses.find((h) => h.id === id);
    if (!harness) {
      blockers.push({ code: "unknown-harness", harnessId: id, message: `Unknown account ${id}.` });
      continue;
    }
    if (harness.kind !== draft.kind) {
      blockers.push({ code: "mixed-kinds", harnessId: id, message: `${harness.label} is a ${harness.kind} account.` });
    }
    const root = configRootKey(harness);
    const clash = roots.get(root);
    if (clash) {
      blockers.push({
        code: "same-home",
        harnessId: id,
        message: `${harness.label} and ${clash} share the same config directory.`,
      });
    } else {
      roots.set(root, harness.label);
    }
    const owner = ctx.membership.get(id);
    if (owner && owner !== ctx.stackId) {
      blockers.push({ code: "already-in-stack", harnessId: id, message: `${harness.label} is already in another stack.` });
    }
  }
  return blockers;
}

/**
 * The config root a draft member would use, without touching the filesystem.
 * Mirrors the server's `effectiveHome`: an env override wins, then the
 * harness home (`<home>/.codex` for codex), then the process default. A
 * home-less built-in therefore collapses to one per-kind sentinel — the same
 * way every home-less built-in inherits the same `~/.claude` / `~/.codex`,
 * so adding two of them still trips the blocker.
 */
function configRootKey(harness: Harness): string {
  const env = harness.env ?? {};
  if (harness.kind === "claude-code") {
    return env.CLAUDE_CONFIG_DIR?.trim() || harness.home || "__default-claude__";
  }
  if (harness.kind === "codex") {
    return env.CODEX_HOME?.trim() || (harness.home ? `${harness.home.replace(/\/+$/, "")}/.codex` : "__default-codex__");
  }
  return harness.home || `__default-${harness.kind}__`;
}

/** Non-blocking warnings shown next to a saveable draft. */
export function draftWarnings(draft: StackDraft, ctx: { harnesses: readonly Harness[] }): DraftProblem[] {
  const warnings: DraftProblem[] = [];
  if (draft.members.length < 2) {
    warnings.push({ code: "too-few-members", message: "A stack needs at least two accounts to fail over." });
  }
  if (draft.members.length > 10) {
    warnings.push({ code: "too-many-members", message: "More than 10 accounts makes the train hard to reason about." });
  }
  if (draft.mirrorMode === "full") {
    warnings.push({
      code: "full-mirror-hooks",
      message: "Full mirror copies settings hooks, permissions, status line and helper commands (Codex: notify) onto every backup.",
    });
  }
  for (const id of draft.members) {
    const harness = ctx.harnesses.find((h) => h.id === id);
    if (harness && !harness.enabled) {
      warnings.push({ code: "member-disabled", harnessId: id, message: `${harness.label} is disabled.` });
    }
  }
  return warnings;
}

export interface MemberPickerOption {
  harness: Harness;
  /** Shown after the label (`— disabled`, `— in stack "X"`), or null. */
  note: string | null;
  /** False only when the account cannot join this stack at all. */
  selectable: boolean;
}

/**
 * The "Add account" picker rows: every same-kind account not already in the
 * draft. An account in ANOTHER stack is listed but not selectable (the
 * server refuses it). A DISABLED account is selectable — the server and CLI
 * accept it with a `member-disabled` warning, which the editor shows too
 * (`draftWarnings`); the failover walk skips it until it is enabled (review
 * N5).
 */
export function memberPickerOptions(
  draft: StackDraft,
  ctx: {
    harnesses: readonly Harness[];
    stacks: readonly HarnessStack[];
    /** account → the stack that already owns it (when not this one). */
    membership: ReadonlyMap<string, string>;
  },
): MemberPickerOption[] {
  return ctx.harnesses
    .filter((h) => h.kind === draft.kind && !draft.members.includes(h.id))
    .map((harness) => {
      const otherStackId = ctx.membership.get(harness.id);
      if (otherStackId) {
        const otherLabel = ctx.stacks.find((s) => s.id === otherStackId)?.label ?? otherStackId;
        return { harness, note: `in stack "${otherLabel}"`, selectable: false };
      }
      return { harness, note: harness.enabled ? null : "disabled", selectable: true };
    });
}

/**
 * How a failed save reads. Stack create/edit mirrors the primary's config
 * inline, which can outlast the connection; the requests are sent with
 * `retry: false` (a replay would hit "already in another stack"), so a
 * transit failure means the save MAY have landed. The editor then says so
 * and reloads the stacks instead of claiming it failed (review S21).
 */
export function stackSaveFailure(error: unknown): { message: string; reload: boolean } {
  if (error instanceof ApiTransitError) {
    return {
      message: "The connection dropped before agetor answered — the stack may have been saved — reloading.",
      reload: true,
    };
  }
  return { message: error instanceof Error ? error.message : String(error), reload: false };
}

export interface VirtualWindow {
  start: number;
  end: number;
  /** Top padding in rows. */
  leading: number;
  /** Bottom padding in rows, so the scrollbar reflects the full list. */
  trailing: number;
  /** Rendered row count. */
  count: number;
}

/**
 * A small fixed-row window for a long member list. Above `threshold` rows the
 * list renders only the visible slice plus `overscan` rows on each side; the
 * leading spacer keeps the scrollbar honest. Below the threshold everything
 * renders (the common case).
 */
export function virtualWindow(args: {
  rowCount: number;
  scrollTop: number;
  rowHeight: number;
  viewportHeight: number;
  overscan?: number;
  threshold?: number;
}): VirtualWindow {
  const { rowCount, scrollTop, rowHeight, viewportHeight } = args;
  const overscan = args.overscan ?? 3;
  const threshold = args.threshold ?? 20;
  const safeRow = Math.max(1, rowHeight);
  const visible = Math.max(1, Math.ceil(viewportHeight / safeRow));
  if (rowCount <= threshold) return { start: 0, end: rowCount, leading: 0, trailing: 0, count: rowCount };
  const first = Math.max(0, Math.floor(scrollTop / safeRow) - overscan);
  const end = Math.min(rowCount, first + visible + overscan * 2);
  return { start: first, end, leading: first, trailing: rowCount - end, count: end - first };
}
