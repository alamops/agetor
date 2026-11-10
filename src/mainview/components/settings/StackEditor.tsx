import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, StackChangedApiError, type HarnessStackResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { MirrorPreviewDialog } from "@/components/settings/MirrorPreviewDialog";
import { STACK_KIND_LABEL } from "@/components/settings/HarnessStackCard";
import type {
  Harness,
  HarnessLimitState,
  HarnessStack,
  HarnessStackKind,
  MirrorPreview,
} from "../../../shared/types.ts";
import {
  addMember,
  cooldownChips,
  draftBlockers,
  draftFromStack,
  draftWarnings,
  emptyDraft,
  guardedPatch,
  isMirrorRelevant,
  memberPickerOptions,
  MIRROR_MODE_COPY,
  moveMember,
  previewBody,
  removeMember,
  stackSaveFailure,
  virtualWindow,
  type StackDraft,
} from "@/lib/stack-editor";

interface Props {
  /** The stack to edit; null creates a new one. */
  stackId: string | null;
  stacks: HarnessStack[];
  limitStates: HarnessLimitState[];
  harnesses: Harness[];
  /** Ask the dialog to reload `/harnesses` after a save/delete. */
  onChange?: () => void;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The create/edit stack subpage (reached from a stack card's Edit or the
 * Harnesses toolbar's New stack). Stack cards, cooldowns and Restore live on
 * the Harnesses page; this file owns one draft at a time.
 */
export function StackEditor({ stackId, stacks, limitStates, harnesses, onChange, onSaved, onDirtyChange }: Props) {
  const confirm = useConfirm();
  const existing = stackId ? stacks.find((s) => s.id === stackId) ?? null : null;
  // The stack the draft is based on: its `updatedAt` rides every edit as
  // `expectedUpdatedAt`, and a 409 replaces it with the stored copy.
  const [base, setBase] = useState<HarnessStack | null>(existing);
  const [draft, setDraft] = useState<StackDraft>(() => (existing ? draftFromStack(existing) : emptyDraft()));
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<MirrorPreview | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The draft the open preview was computed for; Confirm writes exactly this.
  const previewedDraft = useRef<StackDraft | null>(null);
  const rerunSave = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  // A save can settle after the user has left this editor for another form;
  // its dirty report must not overwrite that form's. Report only while
  // mounted, and say "clean" once on unmount (the parent's discard prompt has
  // already run by then), as the other settings forms do.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const mountedRef = useRef(true);
  const reportDirty = (value: boolean) => {
    if (mountedRef.current) onDirtyChangeRef.current?.(value);
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onDirtyChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    const next = existing ? draftFromStack(existing) : emptyDraft();
    setBase(existing);
    setDraft(next);
    setPreview(null);
    dirty.current = false;
    reportDirty(false);
  }, [stackId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A refresh landed (or the stack list loaded after the editor opened) and
  // the user has typed nothing: follow it. A dirty draft keeps its base, so
  // saving it meets the 409 instead of silently overwriting the newer copy.
  useEffect(() => {
    if (dirty.current || !existing) return;
    if (base && base.updatedAt >= existing.updatedAt) return;
    setBase(existing);
    setDraft(draftFromStack(existing));
  }, [existing, base]);

  const markDirty = (next: StackDraft) => {
    setDraft(next);
    if (!dirty.current) {
      dirty.current = true;
      reportDirty(true);
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
  // made the picker look like the account did not exist: it is listed, not
  // selectable, with the reason. A disabled account IS selectable, with the
  // `member-disabled` warning below (`memberPickerOptions`).
  const available = memberPickerOptions(draft, { harnesses, stacks, membership });
  const now = Date.now();
  const coolingByHarness = new Map<string, string>();
  for (const h of sameKind) {
    const chips = cooldownChips(limitStates, h.id, now);
    if (chips.length > 0) coolingByHarness.set(h.id, chips.map((c) => c.text).join("; "));
  }

  const window = virtualWindow({
    rowCount: draft.members.length,
    scrollTop,
    rowHeight: 44,
    viewportHeight: 352,
  });
  const visible = draft.members.slice(window.start, window.end);

  /** Write the draft (after any preview confirmation). */
  const commit = async (toSave: StackDraft = draft) => {
    setSaving(true);
    setError(null);
    try {
      let result: HarnessStackResult;
      if (stackId) {
        if (!base) return;
        const patch = guardedPatch(base, toSave);
        if (Object.keys(patch).length === 0) {
          finishWithoutChanges();
          return;
        }
        result = await api.patchHarnessStack(stackId, patch);
      } else {
        result = await api.createHarnessStack({
          label: toSave.label,
          kind: toSave.kind,
          members: toSave.members,
          mirrorMode: toSave.mirrorMode,
        });
      }
      setPreview(null);
      dirty.current = false;
      reportDirty(false);
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
      setPreview(null);
      if (e instanceof StackChangedApiError) {
        // Edited elsewhere (D16): drop the draft and show the stored copy.
        toast.warning("This stack changed elsewhere — reloaded");
        setBase(e.current);
        setDraft(draftFromStack(e.current));
        dirty.current = false;
        reportDirty(false);
        setError(null);
        onChange?.();
        return;
      }
      // A dropped connection after the request left may still have saved the
      // stack (it mirrors inline and is never re-sent): say so and reload
      // rather than invite a second save into "already in another stack".
      const failure = stackSaveFailure(e);
      setError(failure.message);
      if (failure.reload) {
        toast.warning("The stack may have been saved", { description: failure.message, duration: Infinity });
        onChange?.();
      } else {
        toast.error("Couldn't save the stack", { description: failure.message, duration: Infinity });
      }
    } finally {
      setSaving(false);
    }
  };

  const finishWithoutChanges = () => {
    dirty.current = false;
    reportDirty(false);
    toast.info("No changes to save");
    onSaved?.();
  };

  const save = async () => {
    if (blockers.length > 0 || saving || previewing) return;
    if (stackId && !base) return;
    // Everything below acts on this snapshot: the preview, and the write that
    // follows it, must describe the same draft.
    const snapshot = draft;
    if (base && Object.keys(guardedPatch(base, snapshot)).length === 0) {
      finishWithoutChanges();
      return;
    }
    if (isMirrorRelevant(base, snapshot)) {
      // The dry run walks the plugin trees, so it can take a while: the Save
      // button shows a pending state meanwhile.
      setPreviewing(true);
      setError(null);
      try {
        const result = await api.previewHarnessMirror(previewBody(snapshot, stackId));
        // Edited while the dry run was in flight: the result describes an
        // older draft, so check the current one instead.
        if (draftRef.current !== snapshot) {
          rerunSave.current = true;
          return;
        }
        if (result.overwrites) {
          previewedDraft.current = snapshot;
          setPreview(result);
          return;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        toast.error("Couldn't preview the mirror", { description: message, duration: Infinity });
        return;
      } finally {
        setPreviewing(false);
      }
    }
    await commit(snapshot);
  };

  // A draft edited while the preview was pending re-runs the whole save once
  // the pending state has cleared (the guard above refuses while it is set).
  useEffect(() => {
    if (!previewing && rerunSave.current) {
      rerunSave.current = false;
      void save();
    }
  });

  const confirmPreview = () => {
    const previewed = previewedDraft.current;
    if (!previewed) return;
    if (draftRef.current !== previewed) {
      // The draft changed since it was previewed: check it again.
      setPreview(null);
      void save();
      return;
    }
    void commit(previewed);
  };

  const switchKind = async (kind: HarnessStackKind) => {
    if (kind === draft.kind) return;
    if (draft.members.length > 0) {
      const ok = await confirm({
        title: "Switch harness kind?",
        description: "Switching kind removes the selected accounts.",
        confirmLabel: "Switch",
        variant: "destructive",
      });
      if (!ok) return;
    }
    markDirty({ ...draft, kind, members: [] });
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
            {(Object.keys(STACK_KIND_LABEL) as HarnessStackKind[]).map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant={draft.kind === kind ? "secondary" : "outline"}
                onClick={() => void switchKind(kind)}
              >
                {STACK_KIND_LABEL[kind]}
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
                    {cooling ? <span className="text-xs text-warning"> ({cooling})</span> : null}
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
              {available.map(({ harness: h, note, selectable }) => (
                <option key={h.id} value={h.id} disabled={!selectable}>
                  {h.label}{note ? ` — ${note}` : ""}
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
            No {STACK_KIND_LABEL[draft.kind]} accounts yet — add one under Harnesses first.
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
          {MIRROR_MODE_COPY[draft.mirrorMode]}
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
        <Button
          size="sm"
          disabled={saving || previewing || blockers.length > 0 || (stackId !== null && !base)}
          onClick={() => void save()}
        >
          {previewing ? "Checking mirror…" : saving ? "Saving…" : stackId ? "Save stack" : "Create stack"}
        </Button>
      </div>

      <MirrorPreviewDialog
        preview={preview}
        saving={saving}
        onCancel={() => setPreview(null)}
        onConfirm={confirmPreview}
      />
    </div>
  );
}
