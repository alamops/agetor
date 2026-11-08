import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type HarnessStackResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import type { Harness, HarnessLimitState, HarnessStack, HarnessStackKind } from "../../../shared/types.ts";
import {
  addMember,
  draftBlockers,
  draftFromStack,
  draftPatch,
  draftWarnings,
  emptyDraft,
  moveMember,
  removeMember,
  virtualWindow,
  type StackDraft,
} from "@/lib/stack-editor";

interface Props {
  /** `list` is the Settings section; `editor` is the create/edit subpage. */
  mode?: "list" | "editor";
  /** The stack to edit; null creates a new one. */
  stackId?: string | null;
  stacks: HarnessStack[];
  limitStates: HarnessLimitState[];
  harnesses: Harness[];
  onEdit?: (id: string) => void;
  onNew?: () => void;
  /** Ask the dialog to reload `/harnesses` after a save/delete. */
  onChange?: () => void;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

const KIND_LABEL: Record<HarnessStackKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function coolingLabel(state: HarnessLimitState | undefined): string | null {
  if (!state) return null;
  return `cooling until ${new Date(state.exhaustedUntilMs).toLocaleString()}`;
}

/**
 * Settings → Stacks. The list shows every stack with its primary/backup
 * order and any cooling account; the editor builds one draft at a time.
 * Both modes live in one component because the dialog keeps either mounted
 * (the same file owns the create and edit flows).
 */
export function HarnessStacksSection(props: Props) {
  const mode = props.mode ?? "list";
  return mode === "editor"
    ? <StackEditor {...props} />
    : <StackList {...props} />;
}

function StackList({ stacks, limitStates, harnesses, onEdit, onNew, onChange }: Props) {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState<string | null>(null);
  const coolingByHarness = useMemo(
    () => new Map(limitStates.map((s) => [s.harnessId, s] as const)),
    [limitStates],
  );
  const labelOf = (id: string) => harnesses.find((h) => h.id === id)?.label ?? id;

  const remove = async (stack: HarnessStack) => {
    const ok = await confirm({
      title: `Delete stack "${stack.label}"?`,
      description:
        "Tasks keep their current account; automatic failover stops immediately. Copied session files stay with their accounts until retention removes them.",
    });
    if (!ok) return;
    setDeleting(stack.id);
    try {
      await api.deleteHarnessStack(stack.id);
      toast.success("Stack deleted");
      onChange?.();
    } catch (e) {
      toast.error("Couldn't delete the stack", {
        description: e instanceof Error ? e.message : String(e),
        duration: Infinity,
      });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-4 pt-3 text-sm" data-testid="harness-stacks-section">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">Account stacks</p>
          <p className="text-xs text-muted-foreground">
            Stack two or more accounts of the same harness. At its limit, a task continues on the
            next account with the same conversation, tools and settings. Stacks are machine-local.
          </p>
        </div>
        <Button size="sm" onClick={onNew}>
          <Plus className="size-4" /> New stack
        </Button>
      </div>

      {stacks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No stacks yet.</p>
      ) : (
        <ul className="space-y-2">
          {stacks.map((stack) => (
            <li
              key={stack.id}
              data-testid="harness-stack-row"
              className="rounded-md border border-border/60 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {stack.label} <span className="text-xs text-muted-foreground">({KIND_LABEL[stack.kind]})</span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {stack.members.map((m, i) => {
                      const cooling = coolingLabel(coolingByHarness.get(m.harnessId));
                      return (
                        <span
                          key={m.harnessId}
                          className={cn(
                            "rounded border border-border/60 px-1.5 py-0.5",
                            i === 0 && "border-info/40 text-info",
                          )}
                          title={i === 0 ? "Primary — mirrored onto every backup" : "Backup"}
                        >
                          {i === 0 ? "Primary · " : `${i + 1} · `}
                          {labelOf(m.harnessId)}
                          {cooling ? ` (${cooling})` : ""}
                        </span>
                      );
                    })}
                  </p>
                  {stack.warnings.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-warning">
                      {stack.warnings.map((w, i) => (
                        <li key={`${w.code}:${w.harnessId ?? i}`}>{w.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onEdit?.(stack.id)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={deleting === stack.id}
                    onClick={() => void remove(stack)}
                    aria-label={`Delete stack ${stack.label}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StackEditor({ stackId, stacks, limitStates, harnesses, onChange, onSaved, onDirtyChange }: Props) {
  const existing = stackId ? stacks.find((s) => s.id === stackId) : null;
  const [draft, setDraft] = useState<StackDraft>(() => (existing ? draftFromStack(existing) : emptyDraft()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);

  useEffect(() => {
    const next = existing ? draftFromStack(existing) : emptyDraft();
    setDraft(next);
    dirty.current = false;
    onDirtyChange?.(false);
  }, [stackId]); // eslint-disable-line react-hooks/exhaustive-deps

  const markDirty = (next: StackDraft) => {
    setDraft(next);
    if (!dirty.current) {
      dirty.current = true;
      onDirtyChange?.(true);
    }
  };

  const membership = useMemo(() => {
    const map = new Map<string, string>();
    for (const stack of stacks) {
      if (stack.id === stackId) continue;
      for (const m of stack.members) map.set(m.harnessId, stack.id);
    }
    return map;
  }, [stacks, stackId]);

  const blockers = draftBlockers(draft, { harnesses, stackId: stackId ?? null, membership });
  const warnings = draftWarnings(draft, { harnesses });
  const sameKind = harnesses.filter((h) => h.kind === draft.kind);
  // An account already in another stack cannot join this one, but hiding it
  // made the picker look like the account did not exist. List it disabled with
  // the reason instead (review nit).
  const available = sameKind
    .filter((h) => !draft.members.includes(h.id))
    .map((h) => {
      const otherStackId = membership.get(h.id);
      const otherStack = otherStackId ? stacks.find((s) => s.id === otherStackId) : null;
      const reason = otherStack
        ? `in stack "${otherStack.label}"`
        : h.enabled
          ? null
          : "disabled";
      return { harness: h, reason };
    });
  const coolingByHarness = useMemo(
    () => new Map(limitStates.map((s) => [s.harnessId, s] as const)),
    [limitStates],
  );

  const window = virtualWindow({
    rowCount: draft.members.length,
    scrollTop,
    rowHeight: 44,
    viewportHeight: 352,
  });
  const visible = draft.members.slice(window.start, window.end);

  const save = async () => {
    if (blockers.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      let result: HarnessStackResult;
      if (stackId) {
        const patch = existing ? draftPatch(existing, draft) : {
          label: draft.label,
          members: draft.members,
          mirrorMode: draft.mirrorMode,
        };
        if (Object.keys(patch).length === 0) {
          dirty.current = false;
          onDirtyChange?.(false);
          return;
        }
        result = await api.patchHarnessStack(stackId, patch);
      } else {
        result = await api.createHarnessStack({
          label: draft.label,
          kind: draft.kind,
          members: draft.members,
          mirrorMode: draft.mirrorMode,
        });
      }
      dirty.current = false;
      onDirtyChange?.(false);
      // The config copy is best-effort per file: a partially mirrored stack is
      // a success with warnings, not a silent one. The CLI and the swap status
      // line surface these; the primary UI must too (review R13-M2).
      const mirrorWarnings = result.mirror?.warnings ?? [];
      if (mirrorWarnings.length > 0) {
        const shown = mirrorWarnings.slice(0, 3);
        toast.warning(stackId ? "Stack updated — config mirror incomplete" : "Stack created — config mirror incomplete", {
          description: [
            ...shown,
            ...(mirrorWarnings.length > shown.length ? [`…and ${mirrorWarnings.length - shown.length} more`] : []),
          ].join("; "),
          duration: Infinity,
        });
      } else {
        toast.success(stackId ? "Stack updated" : "Stack created");
      }
      onChange?.();
      onSaved?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error("Couldn't save the stack", { description: message, duration: Infinity });
    } finally {
      setSaving(false);
    }
  };

  const dragFrom = useRef<number | null>(null);

  return (
    <div className="space-y-4 pt-3 text-sm" data-testid="harness-stack-editor">
      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="stack-label">Name</label>
        <Input
          id="stack-label"
          value={draft.label}
          maxLength={80}
          placeholder="Claude train"
          onChange={(e) => markDirty({ ...draft, label: e.target.value })}
        />
      </div>

      {!stackId && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Harness</p>
          <div className="flex gap-2">
            {(Object.keys(KIND_LABEL) as HarnessStackKind[]).map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant={draft.kind === kind ? "secondary" : "outline"}
                onClick={() => markDirty({ ...draft, kind, members: [] })}
              >
                {KIND_LABEL[kind]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Both accounts must be the same harness kind.</p>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs font-medium">Accounts in order</p>
        <p className="text-xs text-muted-foreground">
          First is the primary; its settings, MCP servers, skills and commands are mirrored onto the backups.
        </p>
        <div
          ref={listRef}
          className="max-h-[352px] overflow-y-auto rounded-md border border-border/60"
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          data-testid="stack-member-list"
        >
          {draft.members.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">No accounts yet.</p>
          )}
          {window.leading > 0 && <div style={{ height: window.leading * 44 }} aria-hidden />}
          <ul>
            {visible.map((id, offset) => {
              const index = window.start + offset;
              const harness = harnesses.find((h) => h.id === id);
              const cooling = coolingByHarness.get(id);
              return (
                <li
                  key={id}
                  draggable
                  onDragStart={() => { dragFrom.current = index; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragFrom.current !== null) markDirty(moveMember(draft, dragFrom.current, index));
                    dragFrom.current = null;
                  }}
                  className="flex items-center gap-2 border-b border-border/40 px-2 py-2 last:border-0"
                  style={{ minHeight: 44 }}
                >
                  <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      index === 0 && "font-medium text-info",
                    )}
                  >
                    {index === 0 ? "Primary · " : `${index + 1} · `}
                    {harness?.label ?? id}
                    {cooling ? <span className="text-xs text-warning"> ({coolingLabel(cooling)})</span> : null}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={`Move ${harness?.label ?? id} up`}
                    onClick={() => markDirty(moveMember(draft, index, index - 1))}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === draft.members.length - 1}
                    aria-label={`Move ${harness?.label ?? id} down`}
                    onClick={() => markDirty(moveMember(draft, index, index + 1))}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${harness?.label ?? id}`}
                    onClick={() => markDirty(removeMember(draft, id))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
          {window.trailing > 0 && <div style={{ height: window.trailing * 44 }} aria-hidden />}
        </div>

        <div className="flex items-end gap-2 pt-1">
          <div className="min-w-0 flex-1 space-y-1">
            <label className="text-xs font-medium" htmlFor="stack-add-member">Add account</label>
            <select
              id="stack-add-member"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={picker}
              onChange={(e) => setPicker(e.target.value)}
            >
              <option value="">Choose an account…</option>
              {available.map(({ harness: h, reason }) => (
                <option key={h.id} value={h.id} disabled={reason !== null}>
                  {h.label}{reason ? ` — ${reason}` : ""}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            disabled={!picker}
            onClick={() => {
              if (!picker) return;
              markDirty(addMember(draft, picker));
              setPicker("");
            }}
          >
            Add
          </Button>
        </div>
        {sameKind.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No {KIND_LABEL[draft.kind]} accounts yet — add one under Harnesses first.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">Mirror mode</p>
        <div className="flex gap-2">
          {(["full", "safe"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={draft.mirrorMode === mode ? "secondary" : "outline"}
              onClick={() => markDirty({ ...draft, mirrorMode: mode })}
            >
              {mode === "full" ? "Full" : "Safe subset"}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {draft.mirrorMode === "full"
            ? "Copies user-level hooks and permissions too."
            : "Skips hooks and permissions; everything else still mirrors."}
        </p>
      </div>

      {blockers.length > 0 && (
        <ul className="space-y-1 rounded-md border border-destructive/40 p-2 text-xs text-destructive" data-testid="stack-blockers">
          {blockers.map((b) => <li key={`${b.code}:${b.harnessId ?? ""}`}>{b.message}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-warning/40 p-2 text-xs text-warning" data-testid="stack-warnings">
          {warnings.map((w) => <li key={`${w.code}:${w.harnessId ?? ""}`}>{w.message}</li>)}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || blockers.length > 0} onClick={() => void save()}>
          {saving ? "Saving…" : stackId ? "Save stack" : "Create stack"}
        </Button>
      </div>
    </div>
  );
}
