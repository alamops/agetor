import { useEffect, useMemo, useRef, useState } from "react";
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
import { AtFileAutocomplete } from "./AtFileAutocomplete";
import { AtHighlightBackdrop } from "./AtHighlightBackdrop";
import { useProjectFiles, type FileScope } from "@/lib/use-project-files";
import { spliceAtSelection, readCaret, restoreCaret } from "@/lib/textarea-insert";
import { unresolvedAtTokens, isSafeClientRelPath } from "@/lib/at-highlight";

/** Stable empty set so clearing the on-disk override doesn't churn state
 *  identity (and thus the warning memo) on every effect pass. */
const EMPTY_PATH_SET: ReadonlySet<string> = new Set();

/**
 * Shared prompt-composer block: the label row + Extensions picker, the
 * prompt `<Textarea>` with its `/` autocomplete and drag/paste-to-attach
 * wiring, and the References picker beneath it.
 *
 * Lifted **verbatim** out of `NewTaskForm.tsx` (its capabilities effect,
 * saved-prompts loader, `applyCaptured`/`reportCapture`/`onPromptPaste`
 * capture handlers, and the prompt-block JSX) — this module is the single
 * source of truth for that behavior now, consumed by four call sites:
 * `NewTaskForm`, `CreateTaskFromIssueDialog`, `ResolveConflictsDialog`, and
 * `RunPanel`'s send dock (via the layout slots below — `toolbar`/`actions`/
 * `notice`/`inputAdornment`/`trailing`/`hint`/`hintClassName`). There is no
 * separate copy left to keep in lockstep — this file is it.
 *
 * **The `capture` seam**: `usePromptCapture` needs a real, dispatch-shaped
 * (`Dispatch<SetStateAction<...>>`) prompt/references setter to safely
 * serialize two captures that land back-to-back across an async boundary
 * (see `applyCaptured` below). When the caller doesn't supply one, this
 * component derives a bridge from its `value`/`onChange` props, backed by a
 * ref that's refreshed on every render (see `valueRef`/`referencesRef`
 * below) — that keeps each individual functional-update call closure-safe
 * across an async boundary (e.g. one capture's `setPrompt((cur) => …)`
 * firing after a keystroke or a SlashAutocomplete/ExtensionPicker insertion
 * lands in between). What the bridge can't do is serialize *two* functional
 * updates dispatched in the same tick, before the parent has re-rendered and
 * refreshed the ref — only a real `useState` dispatcher does that. `NewTaskForm`
 * owns a full aside-wide drop zone (`onAsideDrop`) where two such
 * same-tick captures are a real scenario, so it builds its own
 * `usePromptCapture` from its actual `useState` dispatchers and passes the
 * result in via the `capture` prop, sharing the exact same drop-hint/caret
 * path the textarea's own paste handler uses. A dialog with no outer drop
 * zone has no such race in practice and can just let the composer own its
 * own internal instance.
 *
 * **The caret-before-focus rule**: any future code that inserts text into
 * the prompt textarea programmatically must call `setSelectionRange` (or
 * otherwise position the caret) *before* calling `.focus()`, never after —
 * `SlashAutocomplete` syncs its tracked caret off the native `focus` event,
 * so focusing first makes it read the stale pre-insert offset, which can
 * land inside a `/token`, pop the slash menu, and swallow the next Enter via
 * `preventDefault`. See `ExtensionPicker.tsx`'s `insertText` for the
 * canonical example of getting this right.
 *
 * **The `@` file-reference layer**: `fileScope` (a `{ dir, ref? }` pair — see
 * `useProjectFiles`/`FileScope`) tells this composer which project tree the
 * `@` popover (`AtFileAutocomplete`) lists and the in-field highlight
 * (`AtHighlightBackdrop`) validates against; `null`/omitted disables both
 * with no fetch. `AtHighlightBackdrop` must render as the FIRST child of the
 * textarea's `relative` wrapper — it paints highlight marks *behind* the
 * textarea's own text via DOM order, not z-index, so the textarea itself
 * needs `relative` (not just its wrapper) for that stacking to hold; a
 * static (non-positioned) textarea would let the absolutely-positioned
 * backdrop painted-later win instead. `AtFileAutocomplete` sits after
 * `SlashAutocomplete` in the same wrapper and shares its `placement`. The two
 * popovers coexist without fighting over the same keystroke because `/` only
 * triggers at BOF or after whitespace/a `@`-token boundary the same way `@`
 * does — `findActiveAtQuery`'s grammar excludes `/` from ever appearing
 * inside an open `@` slice, so an `@src/` query never pops the slash menu.
 */

/**
 * Fetches the `/` autocomplete commands and Extensions-picker entries
 * reachable for a given agent + workdir (+ optional branch) — lifted from
 * `NewTaskForm`'s identical effect verbatim. Empty/whitespace `workdir`
 * short-circuits to empty lists without a fetch; a failed fetch also
 * resolves to empty lists (no autocomplete is no worse than none).
 *
 * `opts.enabled` (default `true`) lets a caller that hoists this hook above
 * a conditionally-mounted `PromptComposer` skip the disk walk entirely when
 * the composer's own internal call would otherwise be idle — see
 * `PromptComposerProps.capabilities`'s doc for why that hoisting exists.
 * `enabled: false` never fetches and reports back `{ commands: [],
 * extensions: [] }`.
 */
export function useAgentCapabilities(
  agent: string,
  workdir: string,
  branch?: string,
  opts?: { enabled?: boolean },
): { commands: AvailableCommand[]; extensions: AvailableExtension[] } {
  const enabled = opts?.enabled ?? true;
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [extensions, setExtensions] = useState<AvailableExtension[]>([]);

  useEffect(() => {
    if (!enabled || !workdir.trim()) { setCommands([]); setExtensions([]); return; }
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
  }, [agent, workdir, branch, enabled]);

  return { commands, extensions };
}

/**
 * User-global saved prompts — not keyed on agent/workdir, unlike
 * `useAgentCapabilities`'s lists. Loaded once on mount; `reload` is what the
 * Extensions picker's `onPromptsOpen` and the textarea's `onFocus` call, so
 * an edit made in Settings mid-session shows up without a remount. Lifted
 * from `NewTaskForm`'s `savedPrompts`/`loadSavedPrompts` verbatim.
 *
 * `opts.enabled` (default `true`) mirrors `useAgentCapabilities`'s flag, for
 * the same hoisting reason — see `PromptComposerProps.savedPrompts`'s doc.
 * `enabled: false` skips the mount-time fetch, `reload` becomes a no-op, and
 * `savedPrompts` state settles to `[]`.
 */
export function useSavedPrompts(opts?: { enabled?: boolean }): { savedPrompts: SavedPrompt[]; reload: () => void } {
  const enabled = opts?.enabled ?? true;
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const reload = () => {
    if (!enabled) return;
    void api.listSavedPrompts().then(setSavedPrompts).catch(() => setSavedPrompts([]));
  };
  useEffect(() => {
    if (!enabled) { setSavedPrompts([]); return; }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
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
  /**
   * When supplied, capture status messages (attached/skipped/error hints)
   * are routed here INSTEAD of the hook's own `dropHint` state, which then
   * never leaves `null` (its setter is simply never called in that branch).
   * `clearDropHint()` calls `onReport(null)` the same way.
   *
   * RunPanel needs this: its `sendHint` is one shared status line written by
   * nine call sites (send, backlog CRUD, commit & push, resolve conflicts).
   * A separate drop-only hint here would let a stale send error and a fresh
   * drop hint render on screen at the same time — routing both through the
   * same setter keeps exactly one hint visible, matching RunPanel's existing
   * `reportSendCapture` → `setSendHint` behavior byte-for-byte.
   */
  onReport?: (message: string | null) => void;
}): {
  dropHint: string | null;
  clearDropHint: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void | Promise<void>;
  handleResult: (result: CaptureResult) => void;
} {
  const { textareaRef, setPrompt, setReferences, onReport } = opts;
  const [dropHint, setDropHintState] = useState<string | null>(null);
  const setDropHint = (message: string | null) => {
    if (onReport) onReport(message);
    else setDropHintState(message);
  };

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
   * Which project tree the `@` popover (`AtFileAutocomplete`) lists and the
   * in-field highlight (`AtHighlightBackdrop`) validates against. `{ dir }`
   * for a live tree — an existing worktree, or an isolation=none task's
   * workdir. `{ dir, ref }` for a not-yet-created worktree, listing tracked
   * files at the pinned base ref (the shape the worktree will actually have
   * once `startTask` materializes it). `null`/omitted disables the `@`
   * popover and highlighting entirely — no fetch is made.
   */
  fileScope?: FileScope | null;
  /** Opaque token whose CHANGE triggers a listing `refresh()` — RunPanel
   *  passes `task.column`, so a run settling (running → review/ready/blocked)
   *  re-lists the tree the agent may have just written files into. The
   *  focus-refetch misses exactly that case: the cursor is often already in
   *  the composer when the run ends, so no blur/focus ever fires. Consumers
   *  without run state simply omit it (undefined never fires). */
  fileScopeRefreshToken?: unknown;
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
  /**
   * A pre-fetched `useAgentCapabilities` result, for a caller whose own
   * `<PromptComposer>` instance is conditionally mounted/unmounted (e.g.
   * RunPanel's send dock, which swaps out for a read-only footer on every
   * Main ↔ subagent tab switch and on the archived-without-canSend state).
   * `useAgentCapabilities` is always called internally too — hooks can't be
   * conditional — but with `enabled: !capabilities`, so it never fetches
   * while this prop is supplied. Hoisting the hook to the consumer's stable
   * parent component is what keeps its disk walk (MCP/skills/plugins
   * discovery) from refiring on every remount; the other three consumers
   * mount this component once and never supply it.
   */
  capabilities?: { commands: AvailableCommand[]; extensions: AvailableExtension[] };
  /**
   * A pre-fetched `useSavedPrompts` result, for the same remount-survival
   * reason as `capabilities` above. `useSavedPrompts` is still always
   * called internally (with `enabled: !savedPrompts`) so it never
   * mount-fetches while this prop is supplied.
   */
  savedPrompts?: { savedPrompts: SavedPrompt[]; reload: () => void };
  rows?: number;
  placeholder?: string;
  /** `null` renders no `<label>` at all (RunPanel's send dock has none —
   *  its toolbar row is picker + actions only). Defaults to `"Prompt"`,
   *  matching every existing consumer. */
  label?: string | null;
  referencesLabel?: string;
  startingFolder?: string;
  disabled?: boolean;
  /** Rendered right after the drop-hint line, inside the prompt block —
   *  e.g. a Gemini prompt-overage warning box. */
  footer?: ReactNode;
  /** Extra className on the outer wrapper (merged via `cn`/`tailwind-merge`,
   *  so passing e.g. `"space-y-1.5"` cleanly overrides the default
   *  `"space-y-3"` instead of producing two conflicting classes). */
  className?: string;
  /** Extra className on the inner group wrapping the toolbar row, the
   *  textarea row, and the hint/footer line (defaults to `"space-y-1"`,
   *  matching every existing consumer). RunPanel overrides this alongside
   *  `className` so its whole dock — References picker included — reads as
   *  one uniformly-spaced `space-y-1.5` stack, exactly as it does today
   *  (where all of this is one flat list of siblings, no inner grouping). */
  innerClassName?: string;

  /** Popover placement for BOTH the Extensions picker and the `/`
   *  autocomplete. "below" (default) suits a form with room beneath the
   *  field; pass "above" for a chat-style send box pinned to a panel's
   *  bottom edge, or the popover renders off-screen. */
  placement?: "above" | "below";
  /** Whether to render the label/picker row at all. `false` fully skips it
   *  — RunPanel renders its row only in certain send-states, so it passes
   *  the same boolean condition it used to gate the row directly. */
  toolbar?: boolean;
  /** Right-hand cluster rendered in the toolbar row, after the Extensions
   *  picker, inside its own `flex items-center gap-2` wrapper. Supplying
   *  this also flips the picker's popover to `align="left"` — it's no
   *  longer the rightmost element in the row (the default, label-only row
   *  keeps `align="right"`, matching every existing consumer). */
  actions?: ReactNode;
  /** Rendered between the references picker (when `referencesPosition` is
   *  `"before"`) and the toolbar row — e.g. RunPanel's archived-task
   *  "Sending will unarchive…" notice. Renders regardless of `toolbar`,
   *  same as that notice does today. */
  notice?: ReactNode;
  /** `ReferencesPicker`'s own `variant` — `"expandable"` (default, a
   *  collapsible `<details>`) or `"inline"` (RunPanel's always-open strip). */
  referencesVariant?: "expandable" | "inline";
  /** Whether the references picker renders before or after the rest of the
   *  composer. Defaults to `"after"`, matching every existing consumer;
   *  RunPanel's dock puts it first. */
  referencesPosition?: "before" | "after";
  /** Extra element rendered inside the `relative` textarea wrapper, after
   *  `SlashAutocomplete` — e.g. RunPanel's `MessageHistoryPicker` trigger,
   *  absolutely positioned over the textarea's corner. */
  inputAdornment?: ReactNode;
  /** Extra element rendered alongside the textarea — e.g. RunPanel's Send
   *  button. When supplied, the textarea's `relative` wrapper gains
   *  `flex-1` and both are wrapped together in a `flex items-stretch
   *  gap-2` row; when absent, the wrapper renders exactly as today
   *  (`<div className="relative">`, no extra row). */
  trailing?: ReactNode;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Called after the composer's own on-focus `reload()` (saved prompts
   *  refetch) — never instead of it. */
  onFocus?: () => void;
  /** Merged (via `cn`) with the textarea's default `"resize-none"`. */
  textareaClassName?: string;
  /** `data-testid` on the prompt `<textarea>`. Defaults to
   *  `"prompt-textarea"`, matching every existing consumer/e2e locator;
   *  RunPanel uses `"send-textarea"` to stay distinguishable. */
  textareaTestId?: string;
  /**
   * External override for the hint line normally driven by
   * `activeCapture.dropHint`. `undefined` (the default) leaves that
   * internal behavior untouched. Pass a value (including `null`) when the
   * caller routes capture reports elsewhere via `usePromptCapture`'s
   * `onReport` — e.g. RunPanel passes its own `sendHint` state, since its
   * `capture.dropHint` never leaves `null` once `onReport` is wired up.
   */
  hint?: string | null;
  /** Extra className merged (via `cn`) onto the hint paragraph's default
   *  `"text-[10px] text-muted-foreground"` — applies whether the rendered
   *  text comes from `hint` or from `activeCapture.dropHint`. RunPanel
   *  passes `"mt-1"` so its dock's hint line keeps the same rendered class
   *  list it had before this prop existed. */
  hintClassName?: string;
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
  fileScope,
  fileScopeRefreshToken,
  textareaRef,
  capture,
  capabilities,
  savedPrompts: savedPromptsProp,
  rows = 6,
  placeholder = "What should the agent do? Type / for commands, @ for files.",
  label = "Prompt",
  referencesLabel = "Files / Folders",
  startingFolder,
  disabled,
  footer,
  className,
  innerClassName = "space-y-1",
  placement = "below",
  toolbar = true,
  actions,
  notice,
  referencesVariant = "expandable",
  referencesPosition = "after",
  inputAdornment,
  trailing,
  onKeyDown,
  onFocus,
  textareaClassName,
  textareaTestId = "prompt-textarea",
  hint,
  hintClassName,
}: PromptComposerProps) {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? internalTextareaRef;

  // Always call both hooks — hooks can't be conditional — but disable their
  // fetches whenever the caller supplied a pre-fetched result via
  // `capabilities`/`savedPrompts` (see those props' docs for why a caller
  // would hoist them). `?? internal` below picks whichever the caller
  // actually wants driving this render.
  const internalCapabilities = useAgentCapabilities(agent, workdir, branch, { enabled: !capabilities });
  const { commands, extensions } = capabilities ?? internalCapabilities;
  const internalSavedPrompts = useSavedPrompts({ enabled: !savedPromptsProp });
  const { savedPrompts, reload } = savedPromptsProp ?? internalSavedPrompts;

  // `null`/undefined `fileScope` (no project/scope resolved yet) short-
  // circuits to no fetch and empty results — see `useProjectFiles`.
  // `projectFiles.error` (a failed listing's message) is intentionally
  // unused here — no error UI in this pass; it's available for a future
  // inline hint if that's ever wanted.
  const projectFiles = useProjectFiles(fileScope ?? null);

  // Fire `refresh()` when the caller's run-settle token changes — never on
  // mount (the hook's own scope-change fetch covers that). Guarded by a ref
  // compare, not the effect merely running: `projectFiles` is a fresh object
  // every render, so the deps alone can't debounce this.
  const prevRefreshTokenRef = useRef(fileScopeRefreshToken);
  useEffect(() => {
    if (Object.is(prevRefreshTokenRef.current, fileScopeRefreshToken)) return;
    prevRefreshTokenRef.current = fileScopeRefreshToken;
    projectFiles.refresh();
  }, [fileScopeRefreshToken, projectFiles]);

  // Bridges for `usePromptCapture`'s internal instance below — it needs
  // `Dispatch`-shaped setters, but this component's public props are plain
  // `value`/`onChange` pairs. When the caller supplies `setReferences`
  // directly (or its own `capture`, built off real `useState` dispatchers),
  // these bridges are unused.
  //
  // A functional updater must read the *latest* prop, not the value closed
  // over at render time: `usePromptCapture.onPaste` awaits
  // `captureDroppedOrPastedItems` before calling `setPrompt((cur) => …)`, so
  // anything typed (or inserted by SlashAutocomplete/ExtensionPicker) during
  // that async window would otherwise be silently reverted by a stale `value`
  // closure. Mirroring the props into refs and reading `.current` inside the
  // bridge keeps each individual functional-update call closure-safe across
  // that boundary, because the ref is updated on every render in between.
  const valueRef = useRef(value);
  valueRef.current = value;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const bridgeSetPrompt: Dispatch<SetStateAction<string>> = (update) =>
    onChange(typeof update === "function" ? (update as (prev: string) => string)(valueRef.current) : update);
  const bridgeSetReferences: Dispatch<SetStateAction<TaskReference[]>> = (update) =>
    onReferencesChange(typeof update === "function" ? (update as (prev: TaskReference[]) => TaskReference[])(referencesRef.current) : update);

  // Hooks can't be conditional, so this always runs; `capture ?? internal`
  // below picks whichever the caller actually wants driving the textarea.
  const internalCapture = usePromptCapture({
    textareaRef: ref,
    setPrompt: bridgeSetPrompt,
    setReferences: setReferences ?? bridgeSetReferences,
  });
  const activeCapture = capture ?? internalCapture;

  // `hint` overrides the internal drop-hint rendering when a caller routes
  // capture reports elsewhere (see the prop doc) — `undefined` (the default)
  // means "not overridden", so every existing consumer falls back to
  // `activeCapture.dropHint` unchanged. `hintClassName` merges onto the
  // default classes the same way regardless of which source the text came
  // from — see that prop's doc.
  const hintText = hint !== undefined ? hint : activeCapture.dropHint;
  const hintClass = cn("text-[10px] text-muted-foreground", hintClassName);

  const referencesPicker = (
    <ReferencesPicker
      variant={referencesVariant}
      label={referencesLabel}
      refs={references}
      onChange={onReferencesChange}
      startingFolder={startingFolder}
    />
  );

  // `relative` anchors SlashAutocomplete's/AtFileAutocomplete's popovers to
  // the textarea they decorate — keep the two together if this block ever
  // moves. `AtHighlightBackdrop` must be the FIRST child here (DOM order,
  // not z-index, is what puts its marks behind the textarea's real text —
  // see the file header) and the `Textarea` itself needs `relative` too, so
  // it — a later, *positioned* sibling — wins the paint order over the
  // earlier, absolutely-positioned backdrop.
  // Both the backdrop and the popover are gated on `fileScope` being
  // non-null — a composer with no scope (no `@` project tree resolved yet)
  // must cost nothing per keystroke: no `getComputedStyle` reads, no
  // highlight re-segmenting, no popover-query recompute. `useProjectFiles`
  // itself stays an unconditional hook call above (hooks can't be
  // conditional) but already short-circuits to empty results with no fetch
  // when `fileScope` is nullish, so gating only the JSX here is sufficient —
  // `projectFiles.entries`/`.validPaths` are just `[]`/`new Set()` in that
  // case and these two components would render as no-ops anyway, but never
  // mounting them at all is what actually removes their per-keystroke work
  // (see AtHighlightBackdrop's/AtFileAutocomplete's own layout-effect and
  // memo costs).
  const hasFileScope = !!(fileScope && fileScope.dir);

  // --- Unresolved `@` reference warning -----------------------------------
  // Send-time expansion (orchestrator `startTask`/`sendInput`) silently
  // leaves unresolvable tokens verbatim — the agent just receives literal
  // `@`-text. The unhighlighted state is the only passive signal, so this
  // warns actively while the draft holds a token that won't become a path.
  // Verdict layering, cheapest first:
  //   1. listing membership — same oracle as the highlight backdrop;
  //   2. known `@name` extension mentions (the ExtensionPicker's own insert
  //      syntax, e.g. `@github`) are never file references → never warned;
  //   3. LIVE scopes only (no `ref`): a debounced `/refs/resolve` stat
  //      rescues paths that exist on disk but aren't listed (gitignored
  //      `@.env`) — send-time expansion WILL resolve those, so warning
  //      would lie. Ref scopes skip the stat: a fresh worktree at the
  //      pinned ref contains exactly the listing, so listing = truth.
  // Suppressed while the listing is loading/failed/empty or truncated — a
  // partial or absent set can't prove a token unresolved.
  const extensionNames = useMemo(
    () => new Set(extensions.map((e) => (e.insert.startsWith("@") ? e.insert.slice(1) : e.name))),
    [extensions],
  );
  const unlistedTokens = useMemo(() => {
    if (!hasFileScope || projectFiles.loading || projectFiles.error || projectFiles.truncated) return [];
    if (projectFiles.entries.length === 0) return [];
    return unresolvedAtTokens(value, projectFiles.validPaths).filter((t) => !extensionNames.has(t.path));
  }, [hasFileScope, projectFiles.loading, projectFiles.error, projectFiles.truncated, projectFiles.entries.length, projectFiles.validPaths, value, extensionNames]);
  // Paths the live-scope stat check confirmed on disk, keyed by token path
  // with any trailing "/" stripped.
  const [existsOnDisk, setExistsOnDisk] = useState<ReadonlySet<string>>(EMPTY_PATH_SET);
  // Stands in for `unlistedTokens` in the effect deps: the memo re-derives a
  // fresh array per keystroke, but an unchanged token set must not re-arm
  // the debounce timer.
  const unlistedKey = unlistedTokens.map((t) => t.path).join("\u0000");
  useEffect(() => {
    const dir = fileScope?.dir?.trim();
    const live = !!dir && !(fileScope?.ref ?? "").trim();
    const candidates = live
      ? [...new Set(unlistedTokens.map((t) => t.path.replace(/\/+$/, "")).filter(isSafeClientRelPath))]
      : [];
    if (candidates.length === 0) {
      setExistsOnDisk((prev) => (prev.size ? EMPTY_PATH_SET : prev));
      return;
    }
    let cancelled = false;
    // Debounced, and only ever in flight while the draft actually holds
    // unlisted tokens (rare) — this is not a per-keystroke request.
    const timer = setTimeout(async () => {
      try {
        const refs = await api.resolveRefs(candidates.map((p) => `${dir}/${p}`));
        if (cancelled) return;
        const found = new Set<string>();
        for (const r of refs) {
          if (r.path.startsWith(`${dir}/`)) found.add(r.path.slice(dir!.length + 1).replace(/\/+$/, ""));
        }
        setExistsOnDisk(found);
      } catch {
        // Stat unavailable — keep the listing verdict. Worst case is an
        // over-warn on a gitignored path until the next successful check;
        // it never under-warns.
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unlistedKey stands in for unlistedTokens (see above)
  }, [unlistedKey, fileScope?.dir, fileScope?.ref]);
  const unresolvedWarning = useMemo(() => {
    const seen = new Set<string>();
    const unresolved = unlistedTokens.filter((t) => {
      const key = t.path.replace(/\/+$/, "");
      if (existsOnDisk.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unresolved.length === 0) return null;
    const shown = unresolved.slice(0, 3).map((t) => t.raw).join(", ");
    const extra = unresolved.length > 3 ? ` and ${unresolved.length - 3} more` : "";
    return unresolved.length === 1
      ? `${shown} doesn't match a project file — it will be sent as plain text, not expanded to a path`
      : `${unresolved.length} @ references don't match a project file (${shown}${extra}) — they'll be sent as plain text, not expanded to paths`;
  }, [unlistedTokens, existsOnDisk]);

  const textareaBlock = (
    <div className={cn("relative", trailing && "flex-1")}>
      {hasFileScope && <AtHighlightBackdrop textareaRef={ref} value={value} validPaths={projectFiles.validPaths} />}
      <Textarea
        ref={ref}
        data-testid={textareaTestId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); if (activeCapture.dropHint) activeCapture.clearDropHint(); }}
        onPaste={activeCapture.onPaste}
        // Refetch saved prompts (in addition to the popover-open refetch) and
        // the project file listing on focus — a deleted/edited prompt made in
        // Settings, or a file created by the agent/user since the last open,
        // shouldn't linger stale in the `/`/`@` autocompletes indefinitely.
        // `useProjectFiles.refresh()` dedupes in-flight requests, so this is
        // cheap even when nothing changed. The caller's own `onFocus` (if
        // any) fires after both.
        onFocus={() => { reload(); projectFiles.refresh(); onFocus?.(); }}
        onKeyDown={onKeyDown}
        rows={rows}
        className={cn("relative resize-none", textareaClassName)}
        disabled={disabled}
      />
      <SlashAutocomplete
        commands={commands}
        savedPrompts={savedPrompts}
        value={value}
        onChange={onChange}
        textareaRef={ref}
        placement={placement}
      />
      {hasFileScope && (
        <AtFileAutocomplete
          entries={projectFiles.entries}
          truncated={projectFiles.truncated}
          value={value}
          onChange={onChange}
          textareaRef={ref}
          placement={placement}
        />
      )}
      {inputAdornment}
    </div>
  );
  // When `trailing` is supplied (e.g. RunPanel's Send button), the textarea
  // wrapper gains `flex-1` (above) and both are wrapped in a `flex
  // items-stretch gap-2` row instead of `textareaBlock` rendering standalone.
  const textareaRow = trailing ? (
    <div className="flex items-stretch gap-2">
      {textareaBlock}
      {trailing}
    </div>
  ) : textareaBlock;

  return (
    <div className={cn("space-y-3", className)}>
      {referencesPosition === "before" && referencesPicker}
      <div className={innerClassName}>
        {notice}
        {toolbar && (
          <div className="flex items-center justify-between gap-2">
            {label !== null && <label className="text-muted-foreground">{label}</label>}
            <ExtensionPicker
              extensions={extensions}
              savedPrompts={savedPrompts}
              onPromptsOpen={reload}
              value={value}
              onChange={onChange}
              textareaRef={ref}
              placement={placement}
              align={actions ? "left" : "right"}
              disabled={disabled || !workdir.trim()}
            />
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>
        )}
        {textareaRow}
        {hintText && <p className={hintClass}>{hintText}</p>}
        {unresolvedWarning && (
          <p data-testid="at-unresolved-warning" className={cn("text-[10px] text-warning", hintClassName)}>
            {unresolvedWarning}
          </p>
        )}
        {footer}
      </div>

      {referencesPosition === "after" && referencesPicker}
    </div>
  );
}
