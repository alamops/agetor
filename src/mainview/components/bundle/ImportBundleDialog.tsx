import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useIsPresent } from "motion/react";
import { AlertTriangle, ArrowLeft, FileJson, PackagePlus, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { api, ApiError } from "@/lib/api";
import { ApiUnreachableError } from "@/lib/net-retry";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { refreshPipelines } from "@/lib/pipelines";
import {
  EMPTY_IMPORT_OPTIONS,
  autoHarnessIds,
  bundleTextTooLarge,
  countsSummary,
  harnessChoices,
  harnessOptionLabel,
  importOptionsEdited,
  importOptionsReducer,
  importStatusText,
  previewOutdatedNote,
  importSuccessText,
  ownOption,
  pastedBundleTooLarge,
  lateImportConflictText,
  lateImportErrorText,
  importErrorText,
  importRefusalText,
  lostImportLanded,
  lostImportLeftText,
  lostImportText,
  lostImportUnsettledText,
  lostImportVerdictText,
  rowFieldLabel,
  requestFailureText,
  toImportOptions,
  type ImportOptionsAction,
  type ImportOptionsState,
  type LostImportOutcome,
} from "@/lib/bundle";
import { registerLeaveGuard, type LeaveGuard } from "@/lib/leave-guard";
import { cn } from "@/lib/utils";
import { AGENT_PROFILE_LIMITS } from "../../../shared/agent-profile.ts";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type {
  BundleImportPlan,
  BundleIssue,
  PlannedAgent,
  PlannedHarness,
  PlannedPipeline,
} from "../../../shared/bundle-import.ts";
import { useBundleFileDrop } from "./useBundleFileDrop";

const TITLE_ID = "bundle-import-title";
/** Debounce for re-previewing after an option change (typing a name). */
const PREVIEW_DEBOUNCE_MS = 250;
/** How long Confirm stays disabled after a refused import swaps in the new
 *  plan: the rest of a double-click must not import a plan nobody has seen. */
const PLAN_CHANGED_SETTLE_MS = 800;
/** How long after that swap a click that is the second (or later) click of
 *  a burst still counts as the rest of the refused double-click rather than
 *  a decision about the new plan. macOS's slowest double-click setting is
 *  about 5 s; past this, every click on Confirm counts — `detail` alone
 *  would also swallow a deliberate click from someone with a long
 *  double-click interval or who clicks repeatedly. */
const PLAN_CHANGED_BURST_MS = 5000;

/** One preview the dialog wants: this text with these options, for this
 *  open of the dialog. */
interface PreviewRequest {
  text: string;
  key: string;
  epoch: number;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function Issues({ issues, kind }: { issues: BundleIssue[]; kind: "warning" | "blocking" }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {issues.map((issue, i) => (
        <li
          key={`${issue.code}-${i}`}
          data-testid={kind === "warning" ? "bundle-import-warning" : "bundle-import-blocking"}
          data-code={issue.code}
          className={cn(
            "flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] leading-snug",
            kind === "warning" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger",
          )}
        >
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Blocking issues that belong to no row (e.g. a name that can't apply). */
function planLevelIssues(plan: BundleImportPlan): BundleIssue[] {
  const key = (i: BundleIssue) => `${i.code}\u0000${i.message}`;
  const onRows = new Set([...plan.agents.flatMap((a) => a.errors), ...plan.pipelines.flatMap((p) => p.errors)].map(key));
  return plan.blocking.filter((b) => !onRows.has(key(b)));
}

function Collapsed({ label, text, testId }: { label: string; text: string; testId?: string }) {
  if (!text.trim()) return null;
  return (
    <details data-testid={testId} className="mt-1.5 text-[11px]">
      <summary className="cursor-pointer select-none text-muted-foreground">{label}</summary>
      <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-2 leading-snug">
        {text}
      </p>
    </details>
  );
}

/** A failed preview: the message, and whether trying again can help (a
 *  network or server failure can; a file the server refused can't). */
interface PreviewFailure {
  message: string;
  retryable: boolean;
}

/** A failed import, and the options key it was attempted with: a preview
 *  of other options replaces it. */
interface ImportFailure {
  message: string;
  key: string;
  /** The core wasn't answering. Any preview that lands proves it is again,
   *  so that error goes whatever the options. */
  unreachable?: boolean;
  /** The import's answer was lost: the re-preview of the same options gives
   *  the verdict (`lostImportLanded`). Until then the preview stays locked,
   *  so an option edit can't replace that re-preview and drop the verdict. */
  lost?: { fingerprint: string; cause: string };
  /** Set on a lost answer: what is known about whether it ran. Worded and
   *  toned as a warning rather than a failure. */
  outcome?: LostImportOutcome;
}

const DISCARD_IMPORT = {
  title: "Discard this import?",
  description: "Your changes to names and harnesses will be lost.",
} as const;
const DISCARD_PASTE = {
  title: "Discard the pasted JSON?",
  description: "The text you pasted will be lost.",
} as const;

/**
 * Import Agents and/or Pipelines from an agetor bundle
 * (docs/plans/agents-pipelines-import-export.md K5/K6/K8, grill D5/C10):
 * pick the text (Choose file, Paste JSON, or a dropped file via
 * `initialText`/the dialog's own drop zone), then a server-side preview shows
 * what will be created, renamed and bound. Each Agent's name and harness can
 * be changed, a disabled harness can be enabled as part of the import, and
 * every change re-runs the preview (debounced, one request in flight, stale
 * answers dropped). Confirm commits everything in one transaction and stays
 * disabled while the plan is blocked or out of date; the preview is locked
 * while it runs. Closing after editing asks to discard — and so does an
 * app-level navigation when `guardsNavigation` is set (the host unmounts with
 * the view, e.g. the Pipelines page).
 */
export function ImportBundleDialog({
  open,
  initialText,
  onClose,
  onImported,
  guardsNavigation = false,
}: {
  open: boolean;
  initialText?: string | null;
  onClose: () => void;
  onImported?: (result: { enabledHarnesses: string[] }) => void;
  guardsNavigation?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [pasteDraft, setPasteDraft] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [options, dispatch] = useReducer(importOptionsReducer, EMPTY_IMPORT_OPTIONS);
  const [plan, setPlan] = useState<BundleImportPlan | null>(null);
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<PreviewFailure | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<ImportFailure | null>(null);
  // Read when the dialog is left (closed, other text loaded, unmounted): a
  // lost import's pending verdict would be dropped unsaid, so it becomes a
  // toast — the same advice as an answer lost after the dialog closed.
  const importErrorRef = useRef(importError);
  importErrorRef.current = importError;
  const noteLeavingPendingVerdict = useCallback(() => {
    const lost = importErrorRef.current?.lost;
    importErrorRef.current = null;
    if (!lost) return;
    toast.error("Import didn't finish", {
      id: "bundle-import-left-pending",
      description: lostImportLeftText(lost.cause),
      duration: Infinity,
    });
  }, []);
  // The core refused the import (409) and sent the plan it would import now,
  // which replaced the previewed one: Confirm then reads "Import updated plan"
  // and stays disabled for a moment, so a double-click can't import it unseen.
  const [planChanged, setPlanChanged] = useState(false);
  const [settling, setSettling] = useState(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the refused import's plan was swapped in (`performance.now()`).
  const planChangedAtRef = useRef(0);
  const clearPlanChanged = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    setPlanChanged(false);
    setSettling(false);
  }, []);
  // The harness the planner picks for each Agent without an override (see
  // `autoHarnessIds`): choosing it in the select drops the override.
  const [autoHarness, setAutoHarness] = useState<Record<string, string | null>>({});
  // Bumped on every load (and by Retry), so re-loading the same text still
  // re-previews: `setText(same)` alone wouldn't re-run the preview effect.
  const [loadCount, setLoadCount] = useState(0);
  const confirm = useConfirm();
  const { refresh: refreshProfiles } = useAgentProfiles({ enabled: false });

  // Bumped on every open/close and new text: a preview answer (or a picked
  // file) from an older epoch is dropped on arrival.
  const epochRef = useRef(0);
  const wantedRef = useRef<PreviewRequest | null>(null);
  const inFlightRef = useRef(false);
  // The in-flight preview request's controller. Aborted whenever its epoch
  // ends (open/close, new text, unmount), so the next preview runs at once
  // instead of queueing behind an answer that will be dropped anyway.
  const previewAbortRef = useRef<AbortController | null>(null);
  const abortPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
  }, []);
  // Bumped per Choose file and on every open/close — not by loading text,
  // which the pick itself does: only the latest pick of this open clears
  // `picking` when it settles.
  const pickRef = useRef(0);
  // False once unmounted or leaving (the host navigated away mid-import, and
  // its page is playing its exit animation): a failure then has no dialog to
  // show in, so it goes to a toast instead.
  const aliveRef = useRef(true);
  const present = useIsPresent();
  const presentRef = useRef(present);
  presentRef.current = present;
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      abortPreview();
      noteLeavingPendingVerdict();
    };
  }, [abortPreview, noteLeavingPendingVerdict]);

  const optionsKey = useMemo(() => JSON.stringify(toImportOptions(options)), [options]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const optionsKeyRef = useRef(optionsKey);
  optionsKeyRef.current = optionsKey;

  const showPreview = text !== null;
  // What closing would lose: edited options on the preview, an unpreviewed
  // paste on the source step.
  const discardAsk = showPreview
    ? importOptionsEdited(options)
      ? DISCARD_IMPORT
      : null
    : pasteDraft.trim()
      ? DISCARD_PASTE
      : null;

  const loadText = useCallback((next: string, label: string) => {
    noteLeavingPendingVerdict();
    epochRef.current++;
    wantedRef.current = null;
    abortPreview();
    dispatch({ type: "reset" });
    setPlan(null);
    setPlanKey(null);
    setAutoHarness({});
    setPreviewError(null);
    setImportError(null);
    clearPlanChanged();
    setSourceLabel(label);
    setText(next);
    setLoadCount((n) => n + 1);
  }, [clearPlanChanged, abortPreview, noteLeavingPendingVerdict]);

  // Fresh state on every open; a drop that opened the dialog previews at once.
  useEffect(() => {
    noteLeavingPendingVerdict();
    epochRef.current++;
    wantedRef.current = null;
    abortPreview();
    dispatch({ type: "reset" });
    setPlan(null);
    setPlanKey(null);
    setAutoHarness({});
    setPreviewError(null);
    setImportError(null);
    clearPlanChanged();
    setImporting(false);
    pickRef.current++;
    setPicking(false);
    setPasteDraft("");
    setPasteError(null);
    if (open && initialText != null) {
      setSourceLabel("Dropped file");
      setText(initialText);
      setLoadCount((n) => n + 1);
    } else {
      setSourceLabel("");
      setText(null);
    }
  }, [open, initialText, clearPlanChanged, abortPreview, noteLeavingPendingVerdict]);

  // While closing would lose something, an app-level navigation that would
  // unmount this dialog asks first (lib/leave-guard.ts). Not while an import
  // runs: it commits either way, so "Discard" would be a false offer. The
  // check reads this render's state when `navigate` asks, so a dialog closed
  // normally (open=false) never blocks; "Discard" there closes the dialog
  // before the view switches.
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  leaveGuardRef.current =
    open && !importing && discardAsk ? { ...discardAsk, discard: onClose } : null;
  useEffect(() => {
    if (!guardsNavigation) return;
    return registerLeaveGuard(() => leaveGuardRef.current);
  }, [guardsNavigation]);

  /** Preview `want`, keeping at most one request in flight: a newer request
   *  made meanwhile replaces the pending one and runs when this one lands. */
  const runPreview = useCallback(async (want: PreviewRequest) => {
    wantedRef.current = want;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPreviewing(true);
    try {
      while (wantedRef.current) {
        const current: PreviewRequest = wantedRef.current;
        let result: { plan: BundleImportPlan } | { error: PreviewFailure };
        const controller = new AbortController();
        previewAbortRef.current = controller;
        try {
          result = { plan: await api.previewBundleImport(current.text, JSON.parse(current.key), controller.signal) };
        } catch (e) {
          // A 400/413 is the file (or the options) refused — the same request
          // fails the same way again.
          const refused = e instanceof ApiError && (e.status === 400 || e.status === 413);
          result = { error: { message: requestFailureText(e), retryable: !refused } };
        } finally {
          if (previewAbortRef.current === controller) previewAbortRef.current = null;
        }
        // Aborted: its epoch is over, so the checks below drop it.
        if (wantedRef.current !== current) continue; // superseded — run the newer one
        wantedRef.current = null;
        if (current.epoch !== epochRef.current) break; // dialog closed or text replaced
        if ("plan" in result) {
          const next = result.plan;
          setPlan(next);
          setPlanKey(current.key);
          setAutoHarness((prev) => autoHarnessIds(prev, next));
          setPreviewError(null);
          // An import error belongs to the options it was tried with.
          // An "isn't answering" error is disproved by this very answer.
          // A lost import's re-preview settles whether it ran.
          // A lost import whose verdict couldn't be given, or that most
          // likely ran, stays up whatever the options: nothing will say so
          // again.
          setImportError((prev) => {
            if (!prev || prev.unreachable) return null;
            if (prev.lost) {
              if (prev.key === current.key) {
                const landed = lostImportLanded(prev.lost.fingerprint, next);
                return {
                  message: lostImportVerdictText(prev.lost.cause, landed),
                  key: prev.key,
                  outcome: landed ? "ran" : "not-run",
                };
              }
              // The options changed before the verdict (only possible once a
              // failed re-preview unlocked them): nothing left to compare.
              return { message: lostImportUnsettledText(prev.lost.cause), key: current.key, outcome: "unknown" };
            }
            // So does a "most likely ran" verdict: renaming an Agent past a
            // name the import took would otherwise clear the warning and
            // re-enable Confirm with nothing left saying it already ran.
            if (prev.outcome === "unknown" || prev.outcome === "ran") return { ...prev, key: current.key };
            return prev.key === current.key ? prev : null;
          });
          // A fresh preview is what's on screen now, not the refused import's plan.
          clearPlanChanged();
        } else {
          // The last good plan stays on screen with the error and a Retry,
          // marked out of date whatever the options are now: reverting them
          // to the shown plan's key must not re-enable Confirm while the
          // error is up.
          setPlanKey(null);
          setPreviewError(result.error);
        }
      }
    } finally {
      inFlightRef.current = false;
      setPreviewing(false);
    }
  }, [clearPlanChanged]);

  // What the preview effect reads without re-running on: the shown plan's
  // key and error, and the load it last scheduled a preview for.
  const planKeyRef = useRef(planKey);
  planKeyRef.current = planKey;
  const previewErrorRef = useRef(previewError);
  previewErrorRef.current = previewError;
  const scheduledLoadRef = useRef(-1);
  useEffect(() => {
    // Nothing is previewed while an import runs: an answer landing after the
    // import's 409 would clear its "Nothing was imported" notice and the
    // settle. The import's own outcome re-previews when it has to (a bumped
    // `loadCount`), and this effect re-runs once `importing` drops.
    if (!open || text === null || importing) return;
    // Options changed and changed back within the debounce (or the import's
    // 409 already pinned its plan to these options): the shown plan is
    // already for them, so a preview would only re-ask — unless the load
    // changed (new text, Retry, a failed import), or a preview for other
    // options is in flight or queued, whose answer would otherwise be left
    // on screen as out of date with nothing coming to replace it.
    if (
      loadCount === scheduledLoadRef.current &&
      optionsKey === planKeyRef.current &&
      previewErrorRef.current === null &&
      !inFlightRef.current &&
      wantedRef.current === null
    ) {
      return;
    }
    scheduledLoadRef.current = loadCount;
    const want = { text, key: optionsKey, epoch: epochRef.current };
    // The first preview of a text runs at once; option edits are debounced.
    const delay = plan === null && previewError === null ? 0 : PREVIEW_DEBOUNCE_MS;
    const handle = setTimeout(() => void runPreview(want), delay);
    return () => clearTimeout(handle);
    // `plan`/`previewError` only pick the delay; re-running on them would
    // re-preview after every answer.
  }, [open, text, optionsKey, loadCount, importing, runPreview]);

  const retryPreview = useCallback(() => {
    setPreviewError(null);
    setLoadCount((n) => n + 1);
    // Retry unmounts itself with the error box; keep focus in the dialog
    // rather than let it fall to <body>.
    previewRef.current?.focus();
  }, []);

  // A file dropped over a preview with edits replaces it only once confirmed;
  // nothing can be dropped while the import runs.
  const { dropProps, dragging } = useBundleFileDrop(
    (dropped) => {
      void (async () => {
        if (importOptionsEdited(optionsRef.current)) {
          const ok = await confirm({
            title: "Replace this import?",
            description: DISCARD_IMPORT.description,
            confirmLabel: "Replace",
            variant: "destructive",
          });
          if (!ok) return;
        }
        loadText(dropped, "Dropped file");
        // Replacing the text unmounts the preview rows, which may hold focus
        // (a name field); keep it in the dialog rather than let it fall to
        // <body>. On the source step this is a no-op and the step-change
        // effect moves focus instead.
        previewRef.current?.focus();
      })();
    },
    { disabled: importing },
  );

  // Closing while Choose file's pick is pending is fine: the close bumps the
  // epoch (the open/close effect above), so `chooseFile` drops the answer
  // when it lands, and the reopen effect has already reset `picking`.
  const requestClose = useCallback(async () => {
    if (importing) return;
    if (discardAsk) {
      const ok = await confirm({ ...discardAsk, confirmLabel: "Discard", variant: "destructive" });
      if (!ok) return;
    }
    onClose();
  }, [confirm, discardAsk, importing, onClose]);

  // Leaving the preview for another source drops any edits — ask first, the
  // same way closing the dialog and dropping a file over it do.
  const backToSource = async () => {
    if (importing) return;
    if (importOptionsEdited(optionsRef.current)) {
      const ok = await confirm({ ...DISCARD_IMPORT, confirmLabel: "Discard", variant: "destructive" });
      if (!ok) return;
    }
    noteLeavingPendingVerdict();
    epochRef.current++;
    wantedRef.current = null;
    abortPreview();
    setText(null);
    setPlan(null);
    setPlanKey(null);
    setAutoHarness({});
    setPreviewError(null);
    setImportError(null);
    clearPlanChanged();
    dispatch({ type: "reset" });
  };

  const chooseFile = async () => {
    // A pick that lands after the dialog closed, reopened or loaded other
    // text belongs to nobody. `picking` follows the pick token instead: the
    // pick's own `loadText` bumps the epoch, and must not strand the button
    // on "Choosing…".
    const epoch = epochRef.current;
    const pick = ++pickRef.current;
    setPicking(true);
    try {
      const res = await api.pickBundleFile();
      if (epoch !== epochRef.current || "cancelled" in res) return;
      // The core caps the file at 2 MB; escaped as JSON for the preview
      // request it can still be too large to send.
      const tooLarge = bundleTextTooLarge(res.text, `"${res.filename}"`);
      if (tooLarge) {
        toast.error("Can't import that file", { description: tooLarge, duration: Infinity });
        return;
      }
      loadText(res.text, res.filename);
    } catch (e) {
      if (epoch !== epochRef.current) return;
      // No HTTP answer while the core was up: the request was dropped (the
      // webview can give up on a request the open panel holds), and the
      // panel itself may still be on screen.
      const description =
        e instanceof ApiError && e.status === 501
          ? "Choosing a file isn't available here — paste the JSON instead."
          : e instanceof ApiError
            ? message(e)
            : e instanceof ApiUnreachableError
              ? `${requestFailureText(e)} — choose the file again once it's back.`
              : `${requestFailureText(e)} — if the file panel is still open, close it and choose the file again.`;
      toast.error("Couldn't open the file", { description, duration: Infinity });
    } finally {
      if (pick === pickRef.current) setPicking(false);
    }
  };

  const previewPaste = () => {
    const tooLarge = pastedBundleTooLarge(pasteDraft);
    if (tooLarge) {
      setPasteError(tooLarge);
      return;
    }
    loadText(pasteDraft, "Pasted JSON");
  };

  const doImport = async () => {
    if (text === null || !plan?.canImport) return;
    setImporting(true);
    setImportError(null);
    clearPlanChanged();
    const key = optionsKey;
    const epoch = epochRef.current;
    const sentFingerprint = plan.fingerprint;
    // The harnesses this import would enable: a lost answer may hide a
    // commit that enabled them, so their lists are refreshed then too.
    const enabling = plan.harnesses.filter((h) => h.willEnable).map((h) => h.id);
    const refreshEnabled = () => {
      if (enabling.length > 0) onImported?.({ enabledHarnesses: enabling });
    };
    // Only the request itself sits in the failure path: a throw from the
    // success work below happens after a confirmed commit, and must never be
    // reported as a lost import ("Import may have run…").
    let result: Awaited<ReturnType<typeof api.importBundle>>;
    try {
      // The previewed plan's fingerprint: the core refuses (409, new plan)
      // when the import would now create anything other than what was shown.
      result = await api.importBundle(text, JSON.parse(key), plan.fingerprint);
    } catch (e) {
      try {
        importFailed(e);
      } finally {
        setImporting(false);
      }
      return;
    }
    try {
      void refreshProfiles();
      void refreshPipelines();
      const warnings = result.warnings.length;
      toast.success(importSuccessText(result), {
        description: warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"} — ${result.warnings[0]!.message}` : undefined,
      });
      onImported?.({ enabledHarnesses: result.enabledHarnesses });
      onClose();
    } finally {
      setImporting(false);
    }

    function importFailed(e: unknown) {
      // Whatever went wrong, the lists may be out of date: a lost answer may
      // hide a committed import, and a 409 means something changed on this
      // machine since the preview (the re-plan differs).
      void refreshProfiles();
      void refreshPipelines();
      const conflict = e instanceof ApiError && e.status === 409;
      // No answer, and the core's health check got none either: the request
      // most likely never ran.
      const unreachable = e instanceof ApiUnreachableError;
      if (!aliveRef.current || !presentRef.current || epoch !== epochRef.current) {
        // Nowhere left to show it: the dialog was unmounted, is leaving with
        // its page, or was closed while the request ran.
        if (conflict) {
          // A 409 commits nothing — the core refused before writing.
          const plan = (e.body as { plan?: BundleImportPlan } | null)?.plan;
          toast.error("Nothing was imported", {
            description: lateImportConflictText(plan, { fingerprint: sentFingerprint, message: e.message }),
            duration: Infinity,
          });
        } else if (unreachable) {
          toast.error("Couldn't import", {
            description: `${requestFailureText(e)}, so the import most likely didn't run. Open Import again once it's back.`,
            duration: Infinity,
          });
        } else if (e instanceof ApiError) {
          // The core answered with an error: it writes in one transaction,
          // so nothing was imported.
          toast.error("Nothing was imported", { description: lateImportErrorText(e.message), duration: Infinity });
        } else {
          // No answer: it may still have committed, so say where to look.
          refreshEnabled();
          toast.error("Import didn't finish", {
            description: `${requestFailureText(e)}, so the import may already have run — check your Agents and Pipelines before importing the file again.`,
            duration: Infinity,
          });
        }
        return;
      }
      const body = e instanceof ApiError ? (e.body as { plan?: BundleImportPlan } | null) : null;
      if (conflict && body?.plan) {
        // The 409's plan is for the options the import ran with. They can't
        // change while it runs (the preview is locked), but if they somehow
        // did, re-preview the current ones instead of pinning a plan to an
        // old key — that would leave Confirm waiting on a preview that never
        // comes.
        const next = body.plan;
        if (next.canImport && next.fingerprint === sentFingerprint) {
          // The core refused a plan identical to the previewed one, so
          // nothing changed to review: "the plan changed" would be false and
          // Confirm would just 409 again. Show the core's own reason.
          setImportError({ message: importRefusalText(message(e)), key });
          return;
        }
        if (key === optionsKeyRef.current) {
          setPlan(next);
          setPlanKey(key);
          setAutoHarness((prev) => autoHarnessIds(prev, next));
          // Shown as "the plan changed", not as a failure: the new plan's own
          // state (ready, or blocked) is what to read now.
          setPlanChanged(true);
          planChangedAtRef.current = performance.now();
          setSettling(true);
          if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            setSettling(false);
          }, PLAN_CHANGED_SETTLE_MS);
          return;
        }
        setLoadCount((n) => n + 1);
      } else if (unreachable) {
        // A re-preview would only fail the same way and stack a second error
        // box under this one, so the plan stays as shown. Importing again is
        // safe even if this one did land: the core re-plans, and a plan that
        // differs from the shown one (its names now taken) answers 409 with
        // the new plan instead of creating anything.
        setImportError({
          message: `${requestFailureText(e)}, so the import most likely didn't run. Import again once it's back.`,
          key,
          unreachable: true,
        });
        return;
      } else if (!(e instanceof ApiError)) {
        // No answer at all (a dropped connection — the request isn't
        // retried) may have committed anyway: refresh the lists and
        // re-preview, with the old plan marked out of date so Confirm waits
        // for it. The re-preview then says whether it ran
        // (`lostImportLanded`), and a landed import previews as
        // "(imported)" renames — or, for a typed name, as blocked
        // `name-in-use` — instead of a second click silently duplicating it.
        setPlanKey(null);
        setLoadCount((n) => n + 1);
        refreshEnabled();
      }
      // An HTTP error answer (a 500, a 400, a 409 without a plan) is the
      // core's own refusal — its single transaction wrote nothing, so the
      // shown plan stays current. No answer at all may hide a commit.
      setImportError(
        e instanceof ApiError
          ? { message: importRefusalText(requestFailureText(e)), key }
          : {
              message: lostImportText(e),
              key,
              lost: { fingerprint: sentFingerprint, cause: requestFailureText(e) },
              outcome: "unknown",
            },
      );
    }
  };

  // Move focus with the step: into the preview when it opens, back to
  // Choose file when it closes (the button that had focus is gone).
  const previewRef = useRef<HTMLDivElement>(null);
  const chooseFileRef = useRef<HTMLButtonElement>(null);
  const shownRef = useRef(showPreview);
  useEffect(() => {
    if (shownRef.current === showPreview) return;
    shownRef.current = showPreview;
    if (!open) return;
    (showPreview ? previewRef.current : chooseFileRef.current)?.focus();
  }, [open, showPreview]);

  if (!open) return null;

  const planStale = plan !== null && planKey !== optionsKey;
  // A lost import is waiting on the re-preview of the options it ran with.
  // The preview stays locked meanwhile — an edit would replace that
  // re-preview and leave the verdict unsaid — unless the re-preview failed,
  // when Retry (inside the preview) has to work.
  const verdictPending = importError?.lost !== undefined;
  const previewLocked = importing || (verdictPending && previewError === null);
  const canConfirm =
    plan !== null && plan.canImport && !planStale && !previewing && !importing && !settling && !verdictPending;
  const status = importStatusText({ showPreview, pasteError, plan, planChanged, previewing, previewError, importing, importError });

  return createPortal(
    <Dialog
      open={open}
      onClose={() => void requestClose()}
      labelledBy={TITLE_ID}
      className="flex max-h-[85vh] w-full max-w-2xl flex-col p-0"
    >
      <div
        data-testid="bundle-import-dialog"
        data-dragging={dragging ? "" : undefined}
        className={cn("flex min-h-0 flex-1 flex-col", dragging && "ring-2 ring-inset ring-info")}
        {...dropProps}
      >
        {/* Always mounted, so each change is announced as an update — and
            outside the aria-busy body, where assistive tech would hold the
            announcements back until the busy state ends. */}
        <div role="status" aria-live="polite" data-testid="bundle-import-status" className="sr-only">
          {status}
        </div>
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <h2 id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
              <PackagePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              Import Agents and Pipelines
            </h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {showPreview ? (
                <>
                  From <span className="font-medium text-foreground">{sourceLabel}</span>
                </>
              ) : (
                "An agetor bundle (.agetor.json), or a pipeline file from an older version."
              )}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            data-testid="bundle-import-close"
            onClick={() => void requestClose()}
            disabled={importing}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </header>

        {/* Busy only while the import runs, when every input in it is
            disabled: a re-preview runs while the user types a name, and a
            busy region around a focused input would mute it for assistive
            tech. Preview progress is announced through the status region. */}
        <div aria-busy={importing} className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
          {!showPreview ? (
            <SourceStep
              picking={picking}
              pasteDraft={pasteDraft}
              pasteError={pasteError}
              chooseFileRef={chooseFileRef}
              onPasteDraft={(v) => {
                setPasteDraft(v);
                setPasteError(null);
              }}
              onChooseFile={() => void chooseFile()}
              onPreviewPaste={previewPaste}
            />
          ) : (
            <div ref={previewRef} tabIndex={-1} role="region" aria-label="Import preview" className="outline-none">
              {/* Locked while the import runs (an edit then would be dropped)
                  and while a lost import's verdict is pending. */}
              <fieldset disabled={previewLocked} className="m-0 min-w-0 border-0 p-0">
                <PreviewStep
                  plan={plan}
                  options={options}
                  autoHarness={autoHarness}
                  dispatch={dispatch}
                  previewing={previewing}
                  previewError={previewError}
                  importError={importError}
                  planChanged={planChanged}
                  onRetry={retryPreview}
                />
              </fieldset>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border/60 p-3">
          <div className="min-w-0 text-[11px] text-muted-foreground">
            {showPreview && plan && !plan.canImport && (
              <span className="text-danger">
                {plan.blocking.length} blocking issue{plan.blocking.length === 1 ? "" : "s"} — fix them to import
              </span>
            )}
            {showPreview && plan?.canImport && (previewing || (planStale && !previewError)) && <span>Updating preview…</span>}
            {showPreview && plan?.canImport && !previewing && planStale && previewError && (
              <span className="text-danger">{previewOutdatedNote(previewError)}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showPreview && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="bundle-import-back"
                disabled={importing}
                onClick={() => void backToSource()}
              >
                <ArrowLeft className="mr-1 size-3.5" aria-hidden />
                Other file
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void requestClose()} disabled={importing}>
              Cancel
            </Button>
            {showPreview && (
              <Button
                size="sm"
                data-testid="bundle-import-confirm"
                // `aria-disabled`, not `disabled`: Confirm disables itself
                // while it imports, and a natively disabled button drops
                // keyboard focus to <body> — gone from the dialog when a 409
                // swaps in a changed plan.
                aria-disabled={!canConfirm || undefined}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                onClick={(e) => {
                  if (!canConfirm) return;
                  // Once a 409 swapped in a changed plan, the second click of
                  // the double-click that was refused is not a decision about
                  // the new plan. `detail` counts every click in the burst,
                  // including ones that landed while the button was disabled,
                  // so it is only consulted while that notice is up, and only
                  // within the longest double-click interval of the swap.
                  if (
                    e.detail > 1 &&
                    planChanged &&
                    performance.now() - planChangedAtRef.current < PLAN_CHANGED_BURST_MS
                  ) {
                    return;
                  }
                  void doImport();
                }}
              >
                {importing
                  ? "Importing…"
                  : plan
                    ? planChanged
                      ? "Import updated plan"
                      : `Import ${countsSummary({ agents: plan.agents.length, pipelines: plan.pipelines.length })}`
                    : "Import"}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}

/** An error (or, for a lost import's verdict, a warning) above the preview. */
function ErrorBox({ text, onRetry, tone = "danger" }: { text: string; onRetry?: () => void; tone?: "danger" | "warning" }) {
  return (
    <div
      data-testid="bundle-import-error"
      data-tone={tone}
      className={cn(
        "flex items-start justify-between gap-2 rounded-md border px-3 py-2",
        tone === "warning" ? "border-warning/40 bg-warning/10 text-warning" : "border-danger/40 bg-danger/10 text-danger",
      )}
    >
      <span className="min-w-0">{text}</span>
      {onRetry && (
        <Button size="sm" variant="outline" data-testid="bundle-import-retry" className="h-6 shrink-0 px-2 text-[11px]" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function SourceStep({
  picking,
  pasteDraft,
  pasteError,
  chooseFileRef,
  onPasteDraft,
  onChooseFile,
  onPreviewPaste,
}: {
  picking: boolean;
  pasteDraft: string;
  pasteError: string | null;
  chooseFileRef: RefObject<HTMLButtonElement | null>;
  onPasteDraft: (v: string) => void;
  onChooseFile: () => void;
  onPreviewPaste: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* `aria-disabled` while the pick runs, so a cancelled pick leaves
            keyboard focus on the button instead of <body>. */}
        <Button
          ref={chooseFileRef}
          size="sm"
          data-testid="bundle-import-choose-file"
          aria-disabled={picking || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!picking) onChooseFile();
          }}
        >
          <FileJson className="mr-1 size-3.5" aria-hidden />
          {picking ? "Choosing…" : "Choose file…"}
        </Button>
        <span className="text-muted-foreground">or drop a .json file here, or paste the JSON below.</span>
      </div>
      <Textarea
        data-testid="bundle-import-paste"
        aria-label="Bundle JSON"
        aria-invalid={pasteError ? true : undefined}
        aria-describedby={pasteError ? "bundle-import-paste-error" : undefined}
        value={pasteDraft}
        onChange={(e) => onPasteDraft(e.target.value)}
        placeholder='{ "format": "agetor-bundle", "version": 1, … }'
        className="min-h-40 font-mono text-[11px]"
        spellCheck={false}
      />
      {pasteError && (
        <p id="bundle-import-paste-error" data-testid="bundle-import-paste-error" className="text-danger">
          {pasteError}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          data-testid="bundle-import-paste-preview"
          disabled={!pasteDraft.trim()}
          onClick={onPreviewPaste}
        >
          Preview
        </Button>
      </div>
    </div>
  );
}

function PreviewStep({
  plan,
  options,
  autoHarness,
  dispatch,
  previewing,
  previewError,
  importError,
  planChanged,
  onRetry,
}: {
  plan: BundleImportPlan | null;
  options: ImportOptionsState;
  autoHarness: Readonly<Record<string, string | null>>;
  dispatch: OptionsDispatch;
  previewing: boolean;
  previewError: PreviewFailure | null;
  importError: Pick<ImportFailure, "message" | "outcome"> | null;
  planChanged: boolean;
  onRetry: () => void;
}) {
  const previewErrorBox = previewError && (
    <ErrorBox text={previewError.message} onRetry={previewError.retryable && !previewing ? onRetry : undefined} />
  );
  if (!plan) {
    return (
      previewErrorBox ?? <p className="text-muted-foreground">{previewing ? "Reading the file…" : "Preparing the preview…"}</p>
    );
  }

  const harnessesWithNotes = plan.harnesses.filter((h) => h.canEnable || h.warnings.length > 0);

  return (
    <div className="space-y-4">
      {importError && <ErrorBox text={importErrorText(importError)} tone={importError.outcome ? "warning" : "danger"} />}
      {planChanged && (
        <div
          data-testid="bundle-import-plan-changed"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Nothing was imported: something on this machine changed since the preview, so the import changed
            too. The plan below is what it would create now — review it, then import again.
          </span>
        </div>
      )}
      {previewErrorBox}
      {plan.legacy && (
        <div data-testid="bundle-import-legacy" className="rounded-md bg-info/10 px-3 py-2 text-info">
          Legacy pipeline file — its Agents are matched by name to the Agents already on this machine.
        </div>
      )}
      <div
        data-testid="bundle-import-third-party-note"
        className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning"
      >
        <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          This file is third-party content: its instructions become part of your agents' prompts. Read them
          before importing.
        </span>
      </div>

      {plan.agents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Agents ({plan.agents.length})
          </h3>
          {plan.agents.map((agent, i) => (
            <AgentRow
              key={agent.key}
              agent={agent}
              position={i}
              plan={plan}
              options={options}
              autoHarnessId={Object.hasOwn(autoHarness, agent.key) ? autoHarness[agent.key]! : undefined}
              dispatch={dispatch}
            />
          ))}
        </section>
      )}

      {harnessesWithNotes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Harnesses</h3>
          {harnessesWithNotes.map((h) => (
            <HarnessRow key={h.id} harness={h} options={options} dispatch={dispatch} />
          ))}
        </section>
      )}

      {plan.pipelines.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Pipelines ({plan.pipelines.length})
          </h3>
          {plan.pipelines.map((p) => (
            <PipelineRow
              key={p.index}
              pipeline={p}
              total={plan.pipelines.length}
              options={options}
              dispatch={dispatch}
            />
          ))}
        </section>
      )}

      <Issues issues={planLevelIssues(plan)} kind="blocking" />
    </div>
  );
}

type OptionsDispatch = Dispatch<ImportOptionsAction>;

function AgentRow({
  agent,
  position,
  plan,
  options,
  autoHarnessId,
  dispatch,
}: {
  agent: PlannedAgent;
  /** The row's 0-based place among the plan's Agents. */
  position: number;
  plan: BundleImportPlan;
  options: ImportOptionsState;
  /** The planner's own pick (null: none); undefined while unknown. */
  autoHarnessId: string | null | undefined;
  dispatch: OptionsDispatch;
}) {
  const choices = harnessChoices(agent, plan);
  const typed = ownOption(options.agentNames, agent.key);
  // No override: the planner's own pick — not the shown plan's binding, which
  // still holds a just-dropped override until the re-preview lands.
  const override = ownOption(options.agentHarness, agent.key);
  const selected = override ?? (autoHarnessId !== undefined ? autoHarnessId : agent.harnessId) ?? "";
  // A selected harness the options no longer list (the local harnesses
  // changed under an override) still shows as itself, not as the first
  // option: the select must never claim a binding the plan doesn't have.
  const missing = selected !== "" && !choices.some((h) => h.id === selected);
  const from = agent.fileHarness;
  return (
    <div
      data-testid="bundle-import-agent-row"
      data-agent-key={agent.key}
      data-resolution={agent.resolution}
      className="rounded-md border border-border/60 p-2.5"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Name</span>
          <Input
            data-testid="bundle-import-agent-name"
            // Every row's field reads "Name"; say whose, visible word first.
            aria-label={rowFieldLabel("Name", "Agent", agent.sourceName, position, plan.agents.length)}
            value={typed ?? agent.name}
            placeholder={agent.name}
            maxLength={AGENT_PROFILE_LIMITS.name}
            onChange={(e) => dispatch({ type: "agent-name", key: agent.key, name: e.target.value })}
            className="h-8 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Harness</span>
          <Select
            data-testid="bundle-import-agent-harness"
            aria-label={rowFieldLabel("Harness", "Agent", agent.sourceName, position, plan.agents.length)}
            value={selected}
            onChange={(e) => {
              const id = e.target.value;
              // Back to the planner's own pick: drop the override rather than
              // pin it (the dialog then reads as unedited again).
              dispatch({ type: "agent-harness", key: agent.key, harnessId: id === autoHarnessId ? null : id });
            }}
            className="h-8 text-xs"
          >
            {selected === "" && <option value="">Pick a harness…</option>}
            {missing && (
              <option value={selected} disabled>
                {selected} — not available
              </option>
            )}
            {choices.map((h) => (
              <option key={h.id} value={h.id}>
                {harnessOptionLabel(h)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        {agent.harnessKind && <AgentIcon kind={agent.harnessKind} className="size-3 shrink-0" />}
        <span>
          {agent.model}
          {agent.effort ? ` · ${agent.effort}` : ""}
          {agent.mode ? ` · ${agent.mode}` : ""}
        </span>
        <span>
          · from{" "}
          <span className="font-mono">
            {from.label && from.label !== from.id ? `${from.label} (${from.id})` : from.id}
          </span>{" "}
          ({from.kind})
        </span>
        {agent.renamed && typed === undefined && <span>· was "{agent.sourceName}"</span>}
      </p>
      {agent.skills.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Skills: <span className="font-mono">{agent.skills.map((s) => `/${s}`).join(", ")}</span>
        </p>
      )}
      <Collapsed label="Instructions" text={agent.instructions} testId="bundle-import-agent-instructions" />
      <Issues issues={agent.warnings} kind="warning" />
      <Issues issues={agent.errors} kind="blocking" />
    </div>
  );
}

function HarnessRow({
  harness,
  options,
  dispatch,
}: {
  harness: PlannedHarness;
  options: ImportOptionsState;
  dispatch: OptionsDispatch;
}) {
  const on = options.enableHarnesses.includes(harness.id);
  return (
    <div
      data-testid="bundle-import-harness-row"
      data-harness-id={harness.id}
      className="rounded-md border border-border/60 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <AgentIcon kind={harness.kind} className="size-3.5 shrink-0" />
          <span className="truncate">{harness.label}</span>
          <span className="font-mono text-[10px] text-muted-foreground">({harness.id})</span>
        </span>
        {harness.canEnable && (
          <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            Enable as part of the import
            <Switch
              data-testid="bundle-import-harness-enable"
              checked={on}
              onCheckedChange={(enabled) => dispatch({ type: "enable-harness", harnessId: harness.id, enabled })}
              // Starts with the visible text (WCAG 2.5.3 Label in Name), so
              // "click Enable as part of the import" works for voice users;
              // the harness label tells the rows apart.
              aria-label={`Enable as part of the import: ${harness.label}`}
            />
          </label>
        )}
      </div>
      <Issues issues={harness.warnings} kind="warning" />
    </div>
  );
}

function PipelineRow({
  pipeline,
  total,
  options,
  dispatch,
}: {
  pipeline: PlannedPipeline;
  /** How many Pipelines the plan holds. */
  total: number;
  options: ImportOptionsState;
  dispatch: OptionsDispatch;
}) {
  const typed = ownOption(options.pipelineNames, String(pipeline.index));
  return (
    <div data-testid="bundle-import-pipeline-row" className="rounded-md border border-border/60 p-2.5">
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Name</span>
        <Input
          data-testid="bundle-import-pipeline-name"
          aria-label={rowFieldLabel("Name", "Pipeline", pipeline.sourceName, pipeline.index, total)}
          value={typed ?? pipeline.name}
          placeholder={pipeline.name}
          maxLength={PIPELINE_LIMITS.name}
          onChange={(e) => dispatch({ type: "pipeline-name", index: pipeline.index, name: e.target.value })}
          className="h-8 text-xs"
        />
      </label>
      {pipeline.renamed && typed === undefined && (
        <p className="mt-1 text-[11px] text-muted-foreground">was "{pipeline.sourceName}"</p>
      )}
      <ol className="mt-2 space-y-1">
        {pipeline.steps.map((step) => (
          <li key={step.id} className="rounded-md bg-muted/30 px-2 py-1">
            <div className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
              <span className="font-medium">{step.name}</span>
              <span className="text-muted-foreground">
                →{" "}
                {step.agentName ?? (step.legacy === "dangling" ? "missing Agent" : "no Agent")}
                {step.legacy === "remapped" ? " (matched by name)" : ""}
              </span>
            </div>
            <Collapsed label="Step instructions" text={step.instructions} />
          </li>
        ))}
      </ol>
      <Issues issues={pipeline.warnings} kind="warning" />
      <Issues issues={pipeline.errors} kind="blocking" />
    </div>
  );
}
