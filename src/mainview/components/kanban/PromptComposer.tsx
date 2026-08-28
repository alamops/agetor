import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { api, type AvailableCommand, type AvailableExtension } from "@/lib/api";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SavedPrompt, TaskReference } from "../../../shared/types.ts";
import {
  ReferencesPicker,
  captureDroppedOrPastedItems,
  dropHintMessage,
  mergeRefs,
  type CapturedItem,
} from "./ReferencesPicker";
import { SlashAutocomplete } from "./SlashAutocomplete";
import { ExtensionPicker } from "./ExtensionPicker";
import { spliceAtSelection, readCaret, restoreCaret } from "@/lib/textarea-insert";

/**
 * Shared prompt-composer block: the label row + Extensions picker, the
 * prompt `<Textarea>` with its `/` autocomplete and drag/paste-to-attach
 * wiring, and the References picker beneath it.
 *
 * Lifted **verbatim** out of `NewTaskForm.tsx` (its capabilities effect,
 * saved-prompts loader, `applyCaptured`/`reportCapture`/`onPromptPaste`
 * capture handlers, and the prompt-block JSX) — this module is the single
 * source of truth for that behavior now, consumed by three call sites
 * (`NewTaskForm`, `CreateTaskFromIssueDialog`, `ResolveConflictsDialog`).
 * `NewTaskForm` itself is migrated onto this module in a later change; until
 * then, keep this file and `NewTaskForm`'s copy in lockstep rather than
 * letting them drift — the same discipline `TaskLaunchPickers.tsx` documents
 * for the harness/mode/model/effort picker it was lifted from.
 *
 * **The `capture` seam**: `usePromptCapture` needs a real, dispatch-shaped
 * (`Dispatch<SetStateAction<...>>`) prompt/references setter to safely
 * serialize two captures that land back-to-back across an async boundary
 * (see `applyCaptured` below) — a plain `value`/`onChange` prop pair can only
 * approximate that from the latest render's props. `NewTaskForm` owns a
 * full aside-wide drop zone (`onAsideDrop`) where concurrent drops are a real
 * scenario, so it builds its own `usePromptCapture` from its actual
 * `useState` dispatchers and passes the result in via the `capture` prop,
 * sharing the exact same drop-hint/caret path the textarea's own paste
 * handler uses. A dialog with no outer drop zone has no such race in
 * practice and can just let the composer own its own internal instance.
 *
 * **The caret-before-focus rule**: any future code that inserts text into
 * the prompt textarea programmatically must call `setSelectionRange` (or
 * otherwise position the caret) *before* calling `.focus()`, never after —
 * `SlashAutocomplete` syncs its tracked caret off the native `focus` event,
 * so focusing first makes it read the stale pre-insert offset, which can
 * land inside a `/token`, pop the slash menu, and swallow the next Enter via
 * `preventDefault`. See `ExtensionPicker.tsx`'s `insertText` for the
 * canonical example of getting this right.
 */

/**
 * Fetches the `/` autocomplete commands and Extensions-picker entries
 * reachable for a given agent + workdir (+ optional branch) — lifted from
 * `NewTaskForm`'s identical effect verbatim. Empty/whitespace `workdir`
 * short-circuits to empty lists without a fetch; a failed fetch also
 * resolves to empty lists (no autocomplete is no worse than none).
 */
export function useAgentCapabilities(
  agent: string,
  workdir: string,
  branch?: string,
): { commands: AvailableCommand[]; extensions: AvailableExtension[] } {
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [extensions, setExtensions] = useState<AvailableExtension[]>([]);

  useEffect(() => {
    if (!workdir.trim()) { setCommands([]); setExtensions([]); return; }
    let cancelled = false;
    // Pass the harness id (not just the kind) so aliased multi-account
    // harnesses read their own per-harness commands/skills — the server
    // resolves it via getByIdOrKind, so a built-in's id-equals-kind is still
    // honored unchanged.
    api
      .listAgentCapabilities({ agent, workdir: workdir.trim(), branch: branch?.trim() || undefined })
      .then(({ commands, extensions }) => {
        if (cancelled) return;
        setCommands(commands);
        setExtensions(extensions);
      })
      .catch(() => { if (!cancelled) { setCommands([]); setExtensions([]); } });
    return () => { cancelled = true; };
  }, [agent, workdir, branch]);

  return { commands, extensions };
}

/**
 * User-global saved prompts — not keyed on agent/workdir, unlike
 * `useAgentCapabilities`'s lists. Loaded once on mount; `reload` is what the
 * Extensions picker's `onPromptsOpen` and the textarea's `onFocus` call, so
 * an edit made in Settings mid-session shows up without a remount. Lifted
 * from `NewTaskForm`'s `savedPrompts`/`loadSavedPrompts` verbatim.
 */
export function useSavedPrompts(): { savedPrompts: SavedPrompt[]; reload: () => void } {
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const reload = () => {
    void api.listSavedPrompts().then(setSavedPrompts).catch(() => setSavedPrompts([]));
  };
  useEffect(() => { reload(); }, []);
  return { savedPrompts, reload };
}

/**
 * `Awaited<ReturnType<typeof captureDroppedOrPastedItems>>` — the shape a
 * drop/paste capture resolves to. Named locally rather than re-importing
 * `ReferencesPicker`'s re-exported `CaptureResult` type so this file's
 * public contract is pinned to the actual function signature it wraps.
 */
type CaptureResult = Awaited<ReturnType<typeof captureDroppedOrPastedItems>>;

/**
 * Drag/paste-to-attach wiring for the prompt textarea — lifted verbatim from
 * `NewTaskForm`'s `applyCaptured` + `reportCapture` + `onPromptPaste`. An
 * outer drop zone (e.g. `NewTaskForm`'s aside-wide `onAsideDrop`) can feed a
 * `captureDroppedOrPastedItems` result into `handleResult` to share this
 * exact path instead of duplicating it.
 */
export function usePromptCapture(opts: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setReferences: Dispatch<SetStateAction<TaskReference[]>>;
}): {
  dropHint: string | null;
  clearDropHint: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void | Promise<void>;
  handleResult: (result: CaptureResult) => void;
} {
  const { textareaRef, setPrompt, setReferences } = opts;
  const [dropHint, setDropHint] = useState<string | null>(null);

  const applyCaptured = (items: CapturedItem[]) => {
    if (!items.length) return;
    setReferences((cur) => mergeRefs(cur, items.map((i) => i.ref)));
    const marker = items.map((i) => `[${i.basename}]`).join(" ");
    // Read the caret synchronously (DOM state, not React state) then drive
    // setPrompt with a functional updater so two captures landing back-to-
    // back across an async boundary don't see stale `prompt` closures.
    const selection = readCaret(textareaRef.current);
    let caret = 0;
    setPrompt((cur) => {
      const r = spliceAtSelection(cur, selection, marker);
      caret = r.caret;
      return r.next;
    });
    restoreCaret(textareaRef.current, caret);
  };

  const reportCapture = (result: {
    items: CapturedItem[];
    skipped: number;
    skippedFolders: number;
    error?: string;
  }) => {
    setDropHint(dropHintMessage(result, {
      partialFolder: "Attached the files — one folder couldn't be attached; use the folder picker.",
      allFolder: "Couldn't attach the folder — use the folder picker instead.",
      nothingToAttach: "Nothing to attach — drag a file from Finder, or paste a screenshot.",
    }));
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    // Only intercept when the clipboard actually carries a file — otherwise
    // let the default text paste run.
    const hasFile = Array.from(cd.items ?? []).some((it) => it.kind === "file");
    if (!hasFile) return;
    e.preventDefault();
    setDropHint(null);
    const result = await captureDroppedOrPastedItems(cd, { kind: "paste" });
    reportCapture(result);
    applyCaptured(result.items);
  };

  const handleResult = (result: CaptureResult) => {
    reportCapture(result);
    applyCaptured(result.items);
  };

  return {
    dropHint,
    clearDropHint: () => setDropHint(null),
    onPaste,
    handleResult,
  };
}

export interface PromptComposerProps {
  value: string;
  onChange: (next: string) => void;
  agent: string;
  workdir: string;
  branch?: string;
  references: TaskReference[];
  onReferencesChange: (refs: TaskReference[]) => void;
  /**
   * Functional-updater-capable references setter for `usePromptCapture`'s
   * internal instance (see the `capture` prop doc). When the caller already
   * tracks `references` via `useState` it can pass that setter directly and
   * get the same closure-safety `NewTaskForm` gets; when absent, one is
   * derived from `references`/`onReferencesChange` — safe as long as this
   * composer's own render is the only writer racing itself, which holds for
   * every consumer that doesn't also own an outer drop zone (see `capture`).
   */
  setReferences?: Dispatch<SetStateAction<TaskReference[]>>;
  /** The textarea this composer wraps. Only needed by a consumer that also
   *  inserts text into it itself (e.g. an outer drop zone); otherwise an
   *  internal ref is created and used. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /**
   * A pre-built `usePromptCapture` result, for a caller that owns its own
   * drop zone and wants to share this composer's drop-hint/caret path (see
   * the file header). `usePromptCapture` is always called internally too —
   * hooks can't be conditional — and is used only when this prop is absent.
   */
  capture?: ReturnType<typeof usePromptCapture>;
  rows?: number;
  placeholder?: string;
  label?: string;
  referencesLabel?: string;
  startingFolder?: string;
  disabled?: boolean;
  /** Rendered right after the drop-hint line, inside the prompt block —
   *  e.g. a Gemini prompt-overage warning box. */
  footer?: ReactNode;
  /** Extra className on the outer wrapper. */
  className?: string;
  autoFocus?: boolean;
}

/**
 * The shared prompt composer: label row + Extensions picker, the prompt
 * textarea (with `/` autocomplete and drag/paste-to-attach), and the
 * References picker. Structure and classNames match `NewTaskForm`'s
 * original JSX exactly — see the file header.
 */
export function PromptComposer({
  value,
  onChange,
  agent,
  workdir,
  branch,
  references,
  onReferencesChange,
  setReferences,
  textareaRef,
  capture,
  rows = 6,
  placeholder = "What should the agent do? Type / for commands.",
  label = "Prompt",
  referencesLabel = "Files / Folders",
  startingFolder,
  disabled,
  footer,
  className,
  autoFocus,
}: PromptComposerProps) {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? internalTextareaRef;

  const { commands, extensions } = useAgentCapabilities(agent, workdir, branch);
  const { savedPrompts, reload } = useSavedPrompts();

  // Bridges for `usePromptCapture`'s internal instance below — it needs
  // `Dispatch`-shaped setters, but this component's public props are plain
  // `value`/`onChange` pairs. When the caller supplies `setReferences`
  // directly (or its own `capture`, built off real `useState` dispatchers),
  // these bridges are unused.
  const bridgeSetPrompt: Dispatch<SetStateAction<string>> = (update) =>
    onChange(typeof update === "function" ? (update as (prev: string) => string)(value) : update);
  const bridgeSetReferences: Dispatch<SetStateAction<TaskReference[]>> = (update) =>
    onReferencesChange(typeof update === "function" ? (update as (prev: TaskReference[]) => TaskReference[])(references) : update);

  // Hooks can't be conditional, so this always runs; `capture ?? internal`
  // below picks whichever the caller actually wants driving the textarea.
  const internalCapture = usePromptCapture({
    textareaRef: ref,
    setPrompt: bridgeSetPrompt,
    setReferences: setReferences ?? bridgeSetReferences,
  });
  const activeCapture = capture ?? internalCapture;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label className="text-muted-foreground">{label}</label>
          <ExtensionPicker
            extensions={extensions}
            savedPrompts={savedPrompts}
            onPromptsOpen={reload}
            value={value}
            onChange={onChange}
            textareaRef={ref}
            placement="below"
            align="right"
            disabled={disabled || !workdir.trim()}
          />
        </div>
        {/* `relative` anchors SlashAutocomplete's popover to the textarea it
            decorates — keep the two together if this block ever moves. */}
        <div className="relative">
          <Textarea
            ref={ref}
            data-testid="prompt-textarea"
            placeholder={placeholder}
            value={value}
            onChange={(e) => { onChange(e.target.value); if (activeCapture.dropHint) activeCapture.clearDropHint(); }}
            onPaste={activeCapture.onPaste}
            // Refetch saved prompts on focus (in addition to the
            // popover-open refetch) so a deleted/edited prompt made in
            // Settings mid-session doesn't linger in the `/` autocomplete
            // indefinitely.
            onFocus={reload}
            rows={rows}
            className="resize-none"
            disabled={disabled}
            autoFocus={autoFocus}
          />
          <SlashAutocomplete
            commands={commands}
            savedPrompts={savedPrompts}
            value={value}
            onChange={onChange}
            textareaRef={ref}
          />
        </div>
        {activeCapture.dropHint && (
          <p className="text-[10px] text-muted-foreground">{activeCapture.dropHint}</p>
        )}
        {footer}
      </div>

      <ReferencesPicker
        variant="expandable"
        label={referencesLabel}
        refs={references}
        onChange={onReferencesChange}
        startingFolder={startingFolder}
      />
    </div>
  );
}
