import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Loader2, Minus, Monitor, Moon, Plus, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, type HarnessesPayload, type HarnessInput } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { AgentProfileForm } from "@/components/kanban/AgentProfileFormDialog";
import { AgentProfilesSection } from "@/components/settings/AgentProfilesSection";
import { StackEditor } from "@/components/settings/StackEditor";
import { HarnessesPage } from "@/components/settings/HarnessesPage";
import { isExperimentalKind } from "@/components/settings/HarnessAccountRow";
import { StackHistory } from "@/components/settings/StackHistory";
import { BackgroundSection } from "@/components/settings/BackgroundSection";
import { GitHubTokensSection } from "@/components/settings/GitHubTokensSection";
import { PipelinesSection } from "@/components/settings/PipelinesSection";
import { SavedPromptsSection } from "@/components/settings/SavedPromptsSection";
import { useFontSize } from "@/components/font-size-provider";
import { useTheme } from "@/components/theme-provider";
import { isMacPlatform } from "@/lib/platform";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { ONBOARDING_DISMISSED_PREF } from "@/lib/onboarding";
import { FX_AUTO_RESUME_MAX, parseFxAutoResumeDelayInput } from "@/lib/fx-auto-resume-prefs";
import {
  ARCHIVED_HISTORY_RETENTION_PREF,
  formatBytes,
  formatDbStatsLine,
  formatRetentionValue,
  parseArchivedHistoryRetentionDays,
  retentionOptionLabel,
  retentionSelectOptions,
} from "@/lib/retention-prefs";
import { abbreviateHome, cn } from "@/lib/utils";
import { resolveTemplateInitialHome } from "@/lib/harness-template";
import { harnessEditorDirty } from "@/lib/harness-editor-dirty";
import { saveConfirmingMirrorDrop } from "@/lib/harness-edit-confirm";
import { restoreSummary } from "@/lib/stack-editor";
import {
  SETTINGS_SECTIONS,
  activeSection,
  backFromSubview,
  initialView,
  isFormSubpage,
  openAgentEditor,
  openEditor,
  openSection,
  openStackEditor,
  openStackHistory,
  openTemplates,
  resolveEscape,
  type SettingsSectionId,
  type SettingsView,
} from "@/lib/settings-dialog-view";
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FX_AUTO_RESUME_MAX_DELAY_SEC,
  FX_AUTO_RESUME_MIN_DELAY_SEC,
  HARNESS_TEMPLATES,
  THEME_PREFERENCES,
  type AgentKind,
  type DbCompactResult,
  type DbStats,
  type DiscoveredAccount,
  type Harness,
  type HarnessQuota,
  type HarnessStack,
  type HarnessTemplate,
  type ThemePreference,
  CLAUDE_SESSIONS_LAUNCH_SCAN_PREF,
} from "../../../shared/types.ts";

// Computed once at module load, same convention as `isMacPlatform()` in
// `lib/platform.ts` (the single sniff) — the Settings → General font-size
// hint text names the platform-appropriate shortcut. The non-Mac string
// calls out "outside a terminal" because `font-size-provider.tsx`'s keydown
// handler lets a focused `.xterm` pane keep Ctrl+-/Ctrl+_ for readline's
// undo/literal bindings there.
const FONT_SIZE_HINT = isMacPlatform()
  ? "⌘= and ⌘− also work anywhere; ⌘0 resets."
  : "Ctrl+= and Ctrl+− also work anywhere outside a terminal; Ctrl+0 resets.";

/** Icon shown per theme preference in the Settings → General picker. */
const THEME_PREFERENCE_ICON: Record<ThemePreference, typeof Monitor> = {
  auto: Monitor,
  dark: Moon,
  light: Sun,
};

const NO_USAGE: Record<string, HarnessQuota> = {};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Whether sent user messages pin to the top of the transcript. */
  stickyUserMessages: boolean;
  onStickyUserMessagesChange: (sticky: boolean) => void;
  /** Current fx auto-resume preference pair (`FX_AUTO_RESUME_PREF` /
   *  `FX_AUTO_RESUME_DELAY_PREF`, parsed via `parseFxAutoResumePrefs`) —
   *  see `docs/plans/fx-recovery-follow-ups.md` §3. */
  fxAutoResume: { enabled: boolean; delaySec: number };
  onFxAutoResumeChange: (next: { enabled: boolean; delaySec: number }) => void;
  /** Refresh agents/harnesses on the parent after CRUD operations. */
  onChange?: () => void;
  /** Resolved home dir from `GET /defaults` — used to expand `~` in templates. */
  homeDir: string;
  /** Active data dir from `GET /defaults` — substituted into `{dataDir}` in
   *  template `home` paths so new harnesses default under the running dir
   *  (~/.agetor for the .app, ~/.agetor-dev for `bun run dev`). */
  dataDir: string;
  /** Section to land on when the dialog opens. Applied on every open
   *  transition (not just the first) — absent/undefined preserves today's
   *  behavior of always resetting to General. */
  initialSection?: SettingsSectionId;
  /** Agent profile to open straight on its edit subpage when the dialog
   *  opens (a deep link, e.g. "Edit in Settings" from a task's agent
   *  details). Wins over `initialSection`; absent/null falls back to it. */
  initialAgentProfileId?: string | null;
  /** Navigate the app-level `view` to the pipelines page/editor — see
   *  `PipelinesSection`'s `onOpenPipelines` prop. The caller closes this
   *  dialog in the same callback. */
  onOpenPipelines: (id: string | null, editing: boolean) => void;
  /** Per-harness quota snapshots, kept live by the app's `harness_usage`
   *  event; shown as the stack members' quota meters. Never fetched here. */
  usage?: Record<string, HarnessQuota>;
}

/**
 * Parse a textarea of `KEY=value` lines into a record. Blank lines and
 * comment lines (`# …`) are skipped; lines that don't fit `KEY=value` are
 * counted as ignored so the editor can warn the user (rather than silently
 * dropping a typo).
 */
function parseEnv(raw: string): { env: Record<string, string>; ignored: number } {
  const env: Record<string, string> = {};
  let ignored = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) { ignored++; continue; }
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1);
    if (!k) { ignored++; continue; }
    env[k] = v;
  }
  return { env, ignored };
}

function stringifyEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function expandTilde(p: string | null, homeDir: string): string | null {
  if (!p) return p;
  if (!homeDir) return p;
  if (p.startsWith("~/")) return homeDir + p.slice(1);
  if (p === "~") return homeDir;
  return p;
}

/** Replace the `{dataDir}` placeholder in template paths with the active
 *  data dir resolved server-side. No-op for the `__edit` template (whose
 *  paths come from the DB and are already concrete). */
function resolveTemplate(t: HarnessTemplate, dataDir: string): HarnessTemplate {
  if (!t.home || !t.home.includes("{dataDir}")) return t;
  return { ...t, home: t.home.replaceAll("{dataDir}", dataDir) };
}

/** Bump the trailing number on `base` until it's not in `existing`. Used so
 *  picking the same template twice doesn't pre-fill a colliding id (the
 *  uniqueness check would catch it on save, but bumping up front avoids the
 *  papercut of having to manually rename every time). */
/**
 * Per-kind copy for the "Add harness" home-override field: the field label,
 * the slug used to build the suggested placeholder path, and the help text
 * explaining what env var the override sets. Table-driven rather than a
 * ternary chain because a binary claude/codex ternary can't represent every
 * kind's env var accurately — codex sets HOME+CODEX_HOME, cursor sets a
 * plain HOME with no dedicated var, gemini sets its own GEMINI_CLI_HOME.
 */
const HARNESS_HOME_COPY: Record<AgentKind, { label: string; slug: string; help: string }> = {
  "claude-code": {
    label: "CLAUDE_CONFIG_DIR override (absolute path; optional)",
    slug: "claude-2",
    help: "Sets CLAUDE_CONFIG_DIR on spawn — claude stores config, sessions, and login under this path, so a separate path gives this harness its own account. Authenticate by running: CLAUDE_CONFIG_DIR=<path> claude /login.",
  },
  codex: {
    label: "HOME override (absolute path; optional)",
    slug: "codex-2",
    help: "Sets HOME and CODEX_HOME on spawn — codex stores its login under $CODEX_HOME, so a separate path gives this harness its own account.",
  },
  cursor: {
    label: "HOME override (absolute path; optional)",
    slug: "cursor-2",
    help: "HOME override — Cursor has no config-dir env var; the harness home becomes $HOME for the spawned agent, so a separate path gives this harness its own account.",
  },
  gemini: {
    label: "GEMINI_CLI_HOME override (absolute path; optional)",
    slug: "gemini-2",
    help: "Sets GEMINI_CLI_HOME on spawn — gemini stores its login, sessions, and settings under this path (a dedicated override, not the real HOME), so a separate path gives this harness its own account.",
  },
  antigravity: {
    label: "HOME override (absolute path; optional)",
    slug: "antigravity-2",
    help: "HOME override — Antigravity (agy) stores its config, auth, and logs under $HOME/.gemini, so a separate path gives this harness its own account.",
  },
  fx: {
    label: "HOME override (absolute path; optional)",
    slug: "fx-2",
    help: "HOME override — fx has no dedicated config-dir env var; the harness home becomes $HOME for the spawned agent, so fx's state (~/.fx) lands under this path, giving this harness its own account.",
  },
  opencode: {
    label: "HOME override (absolute path; optional)",
    slug: "opencode-2",
    help: "HOME override — OpenCode has no dedicated config-dir env var; the harness home becomes $HOME for the spawned agent, with XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and XDG_CACHE_HOME pointed at directories under it, so OpenCode's config, auth and sessions land under this path, giving this harness its own account.",
  },
  copilot: {
    label: "COPILOT_HOME override (absolute path; optional)",
    slug: "copilot-2",
    help: "Sets COPILOT_HOME on spawn — GitHub Copilot CLI stores its login, config, and session history under this path (a dedicated override, not the real HOME), so a separate path gives this harness its own account. Authenticate by running: COPILOT_HOME=<path> copilot login.",
  },
};

function uniqueHarnessId(base: string, existing: Set<string>): string {
  if (!base || !existing.has(base)) return base;
  const m = base.match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : `${base}-`;
  let n = m ? parseInt(m[2]!, 10) + 1 : 2;
  while (existing.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** If `err` is the server's "harness in use" 409 (which carries structured
 *  `taskIds` and/or `profileIds` lists — a harness delete is refused when
 *  either a task or an agent profile still references it, see
 *  `HarnessInUseError`), resolve those ids to names and return a
 *  human-readable description for the failure toast. Returns null if the
 *  error isn't that shape (or carries neither list) — caller falls back to
 *  the raw `error` message. */
async function describeHarnessInUse(err: unknown): Promise<string | null> {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (!body || typeof body !== "object") return null;
  const rawTaskIds = (body as { taskIds?: unknown }).taskIds;
  const rawProfileIds = (body as { profileIds?: unknown }).profileIds;
  const taskIds = Array.isArray(rawTaskIds) ? rawTaskIds.filter((x): x is string => typeof x === "string") : [];
  const profileIds = Array.isArray(rawProfileIds)
    ? rawProfileIds.filter((x): x is string => typeof x === "string")
    : [];
  if (taskIds.length === 0 && profileIds.length === 0) return null;

  const segments: string[] = [];
  if (taskIds.length > 0) {
    let titles: string[];
    try {
      const tasks = await api.listTasks();
      const byId = new Map(tasks.map((t) => [t.id, t.title]));
      titles = taskIds.map((id) => byId.get(id) ?? `${id.slice(0, 8)}…`);
    } catch {
      // Listing tasks failed — fall back to id prefixes so the toast still
      // identifies *which* tasks are blocking, even if not by name.
      titles = taskIds.map((id) => `${id.slice(0, 8)}…`);
    }
    const noun = titles.length === 1 ? "task" : "tasks";
    segments.push(`${titles.length} ${noun}: ${titles.join(", ")}`);
  }
  if (profileIds.length > 0) {
    let names: string[];
    try {
      const profiles = await api.listAgentProfiles();
      const byId = new Map(profiles.map((p) => [p.id, p.name]));
      names = profileIds.map((id) => byId.get(id) ?? `${id.slice(0, 8)}…`);
    } catch {
      names = profileIds.map((id) => `${id.slice(0, 8)}…`);
    }
    const noun = names.length === 1 ? "agent" : "agents";
    segments.push(`${names.length} ${noun}: ${names.join(", ")}`);
  }
  return `In use by ${segments.join(" and ")}`;
}

/** The view after a subpage's async save lands: back from `saved` while it is
 *  still the view on screen, else unchanged. Compared by identity, because
 *  every navigation makes a new view object, so a reopened editor on the same
 *  stack is not the one that saved. */
export function viewAfterSave(current: SettingsView, saved: SettingsView): SettingsView {
  return current === saved ? backFromSubview(saved) : current;
}

/** StackEditor's `onSaved` for the editor rendered as `viewAtRender`. The save
 *  may land after the user left this editor (rail click, Escape-pop, the
 *  History subpage), so it pops only while this editor's own view is still the
 *  one showing: the decision reads the CURRENT view through the state updater,
 *  never the render-time one. */
export function stackSavedHandler(
  viewAtRender: SettingsView,
  setView: (update: (current: SettingsView) => SettingsView) => void,
): () => void {
  return () => setView((current) => viewAfterSave(current, viewAtRender));
}

/** The view the modal opens on: a deep-linked agent's edit subpage, else the
 *  requested section, else General. */
function entryView(
  initialSection: SettingsSectionId | undefined,
  initialAgentProfileId: string | null | undefined,
): SettingsView {
  if (initialAgentProfileId) return openAgentEditor(initialAgentProfileId);
  if (initialSection) return openSection(initialSection);
  return initialView();
}

export function SettingsDialog({ open, onClose, stickyUserMessages, onStickyUserMessagesChange, fxAutoResume, onFxAutoResumeChange, onChange, homeDir, dataDir, initialSection, initialAgentProfileId, onOpenPipelines, usage = NO_USAGE }: Props) {
  const [version, setVersion] = useState<string>("");
  const [payload, setPayload] = useState<HarnessesPayload>({ harnesses: [], statuses: [] });
  const [defaultHarness, setDefaultHarness] = useState<string>("claude-code");
  const [tmuxSource, setTmuxSource] = useState<"system" | "bundled">("system");
  const [bundledTmuxAvailable, setBundledTmuxAvailable] = useState(false);
  // The ONE macOS "disclaim" switch (D7) — see src/bun/disclaim.ts. It covers
  // agents AND the programs the core runs in the background (git, harness
  // checks). The core reads the stored value once at launch into memory
  // (`initDisclaimSwitch`, which re-asks before honouring a stored "false"),
  // and a change made here applies immediately via the preference write.
  // Only the literal stored value "false" reads as off in this UI; unset or
  // anything else reads as on.
  const [disclaimSpawnedAgents, setDisclaimSpawnedAgents] = useState(true);
  const [view, setView] = useState<SettingsView>(() => entryView(initialSection, initialAgentProfileId));
  // The view (and a per-open counter) must be correct on the very FIRST commit
  // after the modal opens: the dialog stays mounted while closed, and an
  // effect-driven reset would let that commit render the previous subpage —
  // mounting its autoFocus form (which Dialog's passive effect would then
  // record as the focus-restore target) before the reset landed. So the reset
  // is adjusted during render, on the props' change, React's "derive state
  // from props" pattern. `openCount` rides in the agent editor's `key` so a
  // reopen onto the SAME profile id still mounts a fresh form.
  const [entry, setEntry] = useState({ open, initialSection, initialAgentProfileId });
  const [openCount, setOpenCount] = useState(0);
  if (
    entry.open !== open ||
    entry.initialSection !== initialSection ||
    entry.initialAgentProfileId !== initialAgentProfileId
  ) {
    setEntry({ open, initialSection, initialAgentProfileId });
    if (open) {
      setView(entryView(initialSection, initialAgentProfileId));
      if (!entry.open) setOpenCount((n) => n + 1);
    }
  }
  // Mirrors `view` for use inside async callbacks (e.g. the Editor's
  // onSubmit) so they can tell, after an await, whether the user navigated
  // away in the meantime — see Fix 3 in the settings-sidebar review.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Whether the form subpage on screen (harness editor or agent editor) holds
  // unsaved edits — fed by each form's `onDirtyChange`, which reports `false`
  // again when the form unmounts. Read by `leaveSubpage`.
  const subpageDirtyRef = useRef(false);
  const leavingRef = useRef(false);
  // Bumped every time a harness editor view is opened. A save captures the
  // value at submit time, so its late resolution can tell whether the editor
  // that started it is still the one on screen (a reopened editor gets a new
  // token, even though `viewRef.current.kind` is "editor" again).
  const editorTokenRef = useRef(0);
  // Token of the editor whose save is in flight (null = none), so a save that
  // outlives its editor never marks a newly opened one busy.
  const [savingToken, setSavingToken] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Optimistic toggle map: harness id → the value the user *clicked toward*.
  // Lets the Switch animate the moment the user clicks even though the actual
  // mutation is gated behind a confirm dialog + network round-trip. Cleared
  // on confirm-success (refresh overwrites with the server's truth), on
  // cancel (revert), and on error (revert + surface the message).
  const [pendingToggle, setPendingToggle] = useState<Record<string, boolean>>({});
  // Same optimistic shape for the fx-only "Load profile MCP servers" switch:
  // harness id → the value clicked toward, cleared once the PATCH settles
  // (success: refresh has the truth; error: the switch reverts).
  const [pendingProfileMcp, setPendingProfileMcp] = useState<Record<string, boolean>>({});
  const confirm = useConfirm();

  const refresh = async () => {
    const [info, data, prefs, tmux] = await Promise.all([
      api.info().catch(() => ({ version: "?" })),
      api.listHarnesses().catch(() => ({ harnesses: [], statuses: [] })),
      api.listPreferences().catch((): Record<string, string> => ({})),
      api
        .getTmuxSource()
        .catch(() => ({ source: "system" as const, bundledAvailable: false, bundledPath: "", resolvedBin: "" })),
    ]);
    setVersion(info.version);
    setPayload(data);
    // The default-harness picker only lists *enabled* harnesses. If the
    // stored pref points at a now-disabled one, reconcile both local state
    // and the persisted pref to the first enabled fallback — otherwise the
    // `<Select>` value wouldn't match any `<option>` and the UI would
    // silently lie about what the stored default is.
    const stored = prefs["defaultHarness"] || "claude-code";
    const enabled = data.harnesses.filter((h) => h.enabled);
    const storedIsEnabled = enabled.some((h) => h.id === stored);
    if (!storedIsEnabled && enabled.length > 0) {
      const fallback = enabled[0]!.id;
      setDefaultHarness(fallback);
      void api.setPreference("defaultHarness", fallback).catch(() => {
        /* best-effort; the next refresh will retry. */
      });
    } else {
      setDefaultHarness(stored);
    }
    setTmuxSource(tmux.source);
    setBundledTmuxAvailable(tmux.bundledAvailable);
    // keep in sync with DISCLAIM_PREF_KEY in src/bun/disclaim.ts
    setDisclaimSpawnedAgents(prefs["disclaimSpawnedAgents"] !== "false");
  };

  const onPickTmuxSource = async (source: "system" | "bundled") => {
    setTmuxSource(source);
    try {
      await api.setTmuxSource(source);
      onChange?.();
    } catch {
      /* revert? next open re-fetches truth. */
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
    // The view itself is reset during render (see `entry` above), so a
    // half-filled editor never greets the user on the next open.
    subpageDirtyRef.current = false;
    setFormError(null);
  }, [open, initialSection, initialAgentProfileId]);

  const statusByHarness = useMemo(() => {
    const map = new Map(payload.statuses.map((s) => [s.harnessId, s]));
    return map;
  }, [payload.statuses]);

  // A bundle import (Agents / Pipelines sections) can enable a harness as
  // part of its transaction — reload the Harnesses list here and the app's
  // header state, so the change shows without reopening Settings.
  const onBundleImported = (result: { enabledHarnesses: string[] }) => {
    if (result.enabledHarnesses.length === 0) return;
    void refresh();
    onChange?.();
  };

  const onDisclaimSpawnedAgentsChange = (enabled: boolean) => {
    setDisclaimSpawnedAgents(enabled);
    // keep in sync with DISCLAIM_PREF_KEY in src/bun/disclaim.ts
    void api.setPreference("disclaimSpawnedAgents", String(enabled)).catch(() => {
      // Revert only if this failed write is still the latest selection —
      // mirrors App.tsx's onStickyUserMessagesChange guard so a subsequent
      // click can't be stomped by an older, now-resolving request.
      setDisclaimSpawnedAgents((current) => current === enabled ? !enabled : current);
    });
  };

  const onPickDefault = async (id: string) => {
    setDefaultHarness(id);
    try {
      await api.setPreference("defaultHarness", id);
      onChange?.();
    } catch {
      // Reverting on failure would just confuse the user — the next open
      // will re-fetch the truth. Silent best-effort is fine.
    }
  };

  const onDeleteHarness = async (h: Harness) => {
    const stack = (payload.stacks ?? []).find((st) => st.members.some((m) => m.harnessId === h.id));
    const ok = await confirm({
      title: `Delete "${h.label}"?`,
      description: stack
        ? `It is in the stack "${stack.label}"; deleting it removes it from that stack and stops its failover. Tasks already using it will fail to start until reassigned.`
        : "The alias will be removed. Tasks already using it will fail to start until reassigned.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteHarness(h.id);
      await refresh();
      onChange?.();
    } catch (e) {
      // HarnessesSection doesn't render `formError` (only the Editor does),
      // so a failed delete would otherwise be invisible. Surface it as a toast.
      const message = e instanceof Error ? e.message : String(e);
      const description = await describeHarnessInUse(e) ?? message;
      toast.error(`Couldn't delete "${h.label}"`, {
        description,
        duration: Infinity,
      });
    }
  };

  const [deletingStackId, setDeletingStackId] = useState<string | null>(null);

  const onDeleteStack = async (stack: HarnessStack) => {
    const ok = await confirm({
      title: `Delete stack "${stack.label}"?`,
      description:
        "Tasks keep their current account; automatic failover stops immediately. Copied session files stay with their accounts until retention removes them. Its account-switch history is deleted too.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setDeletingStackId(stack.id);
    try {
      await api.deleteHarnessStack(stack.id);
      toast.success("Stack deleted");
      await refresh();
      onChange?.();
    } catch (e) {
      toast.error("Couldn't delete the stack", {
        description: e instanceof Error ? e.message : String(e),
        duration: Infinity,
      });
    } finally {
      setDeletingStackId(null);
    }
  };

  const onClearCooldown = async (h: Harness, model: string | null) => {
    const ok = await confirm({
      title: model
        ? `Clear the ${model} cooldown on ${h.label}?`
        : `Clear the account-wide cooldown on ${h.label}?`,
      description: "The provider may still refuse until its own reset.",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    try {
      // The account-wide chip clears only the account-wide row; a per-model
      // chip clears only that model's row.
      const result = await api.clearHarnessCooldown(h.id, model ? { model } : { accountWideOnly: true });
      toast.success(`Cleared the cooldown on ${h.label}`);
      if ((result.rearmed ?? 0) > 0) toast.info("Retrying the waiting task(s) soon");
      await refresh();
      onChange?.();
    } catch (e) {
      toast.error(`Couldn't clear the cooldown on "${h.label}"`, {
        description: e instanceof Error ? e.message : String(e),
        duration: Infinity,
      });
    }
  };

  const onRestoreMirror = async (h: Harness) => {
    // A current backup of a real stack gets re-mirrored on the next stack
    // save or swap, so say so before undoing it.
    const asBackup = (payload.stacks ?? []).some(
      (st) => st.members.length >= 2 && st.members.some((m, i) => i > 0 && m.harnessId === h.id),
    );
    const ok = await confirm({
      title: `Restore pre-stack config on ${h.label}?`,
      description: asBackup
        ? "Puts back the files and settings the stack mirror replaced on this account, and removes what it added. This account is a backup in a stack, so the next mirror will re-apply the primary's config."
        : "Puts back the files and settings the stack mirror replaced on this account, and removes what it added.",
      confirmLabel: "Restore",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const result = await api.restoreHarnessMirror(h.id);
      const summary = restoreSummary(result);
      if (result.warnings.length > 0) {
        toast.warning(summary.title, { description: summary.description, duration: Infinity });
      } else if (summary.empty) {
        toast.info(summary.title);
      } else {
        toast.success(summary.title, { description: summary.description });
      }
      await refresh();
      onChange?.();
    } catch (e) {
      toast.error(`Couldn't restore "${h.label}"`, {
        description: e instanceof Error ? e.message : String(e),
        duration: Infinity,
      });
    }
  };

  const onOpenTerminal = async (h: Harness) => {
    try {
      await api.openHarnessTerminal(h.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't open a terminal for "${h.label}"`, {
        description: message,
        duration: Infinity,
      });
    }
  };

  const clearPending = (id: string) =>
    setPendingToggle((m) => {
      if (!(id in m)) return m;
      const { [id]: _, ...rest } = m;
      return rest;
    });

  const onToggleEnabled = async (h: Harness) => {
    const next = !h.enabled;
    // Flip the optimistic value first so the Switch animates immediately.
    // We'll clear it on success (refresh has the truth) or revert on
    // cancel / error.
    setPendingToggle((m) => ({ ...m, [h.id]: next }));
    // Re-enable is a one-click action; disable needs a confirmation when
    // tasks are still running (they keep using the harness until they finish)
    // so the user isn't blind-sided by background activity.
    if (h.enabled) {
      let runningCount: number | null = null;
      try {
        const usage = await api.getHarnessUsage(h.id);
        runningCount = usage.runningTaskIds.length;
      } catch {
        // Leave runningCount as null and tell the user in the confirm body —
        // silently claiming "0 running" would be a lie if the probe fails.
      }
      const description = runningCount === null
        ? "Couldn't check whether any tasks are currently using this harness. Anything in flight will keep running until it finishes. It will be hidden from the New Task picker, but historical tasks keep their reference. Disable anyway?"
        : runningCount > 0
          ? `${runningCount} task${runningCount === 1 ? "" : "s"} currently running will keep using this harness until they finish. It will be hidden from the New Task picker, but historical tasks keep their reference.`
          : "It will be hidden from the New Task picker. Historical tasks keep their reference, and you can re-enable it anytime.";
      const ok = await confirm({
        title: `Disable "${h.label}"?`,
        description,
        confirmLabel: "Disable",
        variant: "destructive",
      });
      if (!ok) {
        clearPending(h.id);
        return;
      }
    }
    try {
      await api.setHarnessEnabled(h.id, next);
      await refresh();
      clearPending(h.id);
      onChange?.();
    } catch (e) {
      clearPending(h.id);
      const message = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't ${next ? "enable" : "disable"} "${h.label}"`, {
        description: message,
        duration: Infinity,
      });
    }
  };

  const onToggleProfileMcp = async (h: Harness, next: boolean) => {
    setPendingProfileMcp((m) => ({ ...m, [h.id]: next }));
    const clear = () =>
      setPendingProfileMcp((m) => {
        if (!(h.id in m)) return m;
        const { [h.id]: _, ...rest } = m;
        return rest;
      });
    try {
      await api.updateHarness(h.id, { profileMcpServers: next });
      await refresh();
      clear();
      onChange?.();
    } catch (e) {
      clear();
      const message = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't ${next ? "enable" : "disable"} profile MCP servers for "${h.label}"`, {
        description: message,
        duration: Infinity,
      });
    }
  };

  const currentSection = activeSection(view);

  const showEditor = (harnessId: string | null, template: HarnessTemplate) => {
    editorTokenRef.current += 1;
    setView(openEditor(harnessId, template));
  };

  /** Every internal way of closing the modal (and handing off to another
   *  page) goes through here: drop the subpage back to General so a save
   *  resolving after the close finds no editor showing, then tell the parent.
   *  Opening again re-derives the view during render regardless, for closes
   *  the parent makes on its own. */
  const resetView = () => {
    setView(initialView());
    subpageDirtyRef.current = false;
  };
  const closeModal = () => {
    resetView();
    onClose();
  };

  /**
   * The one guard every way out of the current view goes through — header
   * Back, Escape/backdrop, a sidebar section click, the header X. On a form
   * subpage holding unsaved edits it asks "Discard unsaved changes?" and only
   * runs `proceed` on a yes; otherwise it runs it straight away. The forms'
   * own Cancel buttons and successful saves deliberately bypass it. `proceed`
   * must read `viewRef.current`, not the render's `view` — the view can change
   * while the confirm is open.
   */
  const leaveSubpage = async (proceed: () => void) => {
    const current = viewRef.current;
    if (isFormSubpage(current) && subpageDirtyRef.current) {
      if (leavingRef.current) return;
      leavingRef.current = true;
      let ok = false;
      try {
        ok = await confirm({
          title: "Discard unsaved changes?",
          description:
            current.kind === "agent-editor"
              ? "Your edits to this agent will be lost."
              : current.kind === "stack-editor"
                ? "Your edits to this stack will be lost."
                : "Your edits to this harness will be lost.",
          confirmLabel: "Discard",
          variant: "destructive",
        });
      } finally {
        leavingRef.current = false;
      }
      if (!ok) return;
    }
    proceed();
  };

  /** Pop the current subpage to its section, or close the modal from a
   *  section view — what Escape and a backdrop click do. */
  const popOrClose = () => {
    const current = viewRef.current;
    if (resolveEscape(current) === "pop") {
      setView(backFromSubview(current));
      return;
    }
    closeModal();
  };

  return (
    <Dialog
      open={open}
      onClose={() => void leaveSubpage(popOrClose)}
      className="flex max-h-[85vh] w-full max-w-4xl flex-col p-0"
      labelledBy="settings-dialog-title"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 p-4 pb-3">
        <div className="flex items-center gap-2">
          {view.kind !== "section" && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void leaveSubpage(() => setView(backFromSubview(viewRef.current)))}
              aria-label="Back"
            >
              <ChevronLeft className="size-4" />
            </Button>
          )}
          <h2 id="settings-dialog-title" className="text-base font-semibold">
            {view.kind === "section" && "Settings"}
            {view.kind === "templates" && "Add harness"}
            {view.kind === "editor" && (view.harnessId ? "Edit harness" : "Add harness")}
            {view.kind === "agent-editor" && (view.profileId ? "Edit agent" : view.duplicateFromId ? "Duplicate agent" : "Add agent")}
            {view.kind === "stack-editor" && (view.stackId ? "Edit stack" : "New stack")}
            {view.kind === "stack-history" && "Stack history"}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">v{version}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void leaveSubpage(closeModal)}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-2"
        >
          {SETTINGS_SECTIONS.map((s) => {
            const active = currentSection === s.id;
            return (
              <Button
                key={s.id}
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className="w-full justify-start"
                aria-current={active ? "page" : undefined}
                onClick={() => void leaveSubpage(() => setView(openSection(s.id)))}
              >
                {s.label}
              </Button>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-0">
          {view.kind === "section" &&
            (() => {
              switch (view.section) {
                case "general":
                  return (
                    <GeneralSection
                      defaultHarness={defaultHarness}
                      payload={payload}
                      onPickDefault={onPickDefault}
                      stickyUserMessages={stickyUserMessages}
                      onStickyUserMessagesChange={onStickyUserMessagesChange}
                      fxAutoResume={fxAutoResume}
                      onFxAutoResumeChange={onFxAutoResumeChange}
                      tmuxSource={tmuxSource}
                      bundledTmuxAvailable={bundledTmuxAvailable}
                      onPickTmuxSource={onPickTmuxSource}
                      disclaimSpawnedAgents={disclaimSpawnedAgents}
                      onDisclaimSpawnedAgentsChange={onDisclaimSpawnedAgentsChange}
                      onClose={closeModal}
                    />
                  );
                case "harnesses":
                  return (
                    <HarnessesPage
                      payload={payload}
                      statusByHarness={statusByHarness}
                      homeDir={homeDir}
                      canAdd={!!dataDir}
                      usage={usage}
                      onAdd={() => setView(openTemplates())}
                      onNewStack={() => setView(openStackEditor(null))}
                      onEditStack={(id) => setView(openStackEditor(id))}
                      onStackHistory={(id) => setView(openStackHistory(id))}
                      onDeleteStack={onDeleteStack}
                      deletingStackId={deletingStackId}
                      onEdit={(h) =>
                        showEditor(h.id, {
                          id: "__edit",
                          label: h.label,
                          description: "",
                          kind: h.kind,
                          suggestedHarnessId: h.id,
                          home: h.home,
                          bin: h.bin,
                          env: h.env,
                        })
                      }
                      onDelete={onDeleteHarness}
                      onToggleEnabled={onToggleEnabled}
                      onOpenTerminal={onOpenTerminal}
                      pendingToggle={pendingToggle}
                      onToggleProfileMcp={onToggleProfileMcp}
                      pendingProfileMcp={pendingProfileMcp}
                      onClearCooldown={onClearCooldown}
                      onRestore={onRestoreMirror}
                    />
                  );
                case "agents":
                  return (
                    <AgentProfilesSection
                      harnesses={payload.harnesses}
                      onAdd={() => setView(openAgentEditor(null))}
                      onEdit={(p) => setView(openAgentEditor(p.id))}
                      onDuplicate={(p) => setView(openAgentEditor(null, p.id))}
                      onImported={onBundleImported}
                    />
                  );
                case "pipelines":
                  // Rendered by the always-mounted div below instead.
                  return null;
                case "git":
                  // Rendered by the always-mounted div below instead.
                  return null;
                case "prompts":
                  // Rendered by the always-mounted div below instead.
                  return null;
                default: {
                  const _exhaustive: never = view.section;
                  void _exhaustive;
                  return null;
                }
              }
            })()}

          {/* Kept mounted regardless of the active section (unlike the
              switch above) so an in-flight delete's `busyId`/`actionError`
              survive a section switch (the list itself is module-cached and
              doesn't need it). No wrapper spacing classes here since
              PipelinesSection's own root already applies
              "space-y-4 pt-3 text-sm". */}
          <div className={cn(!(view.kind === "section" && view.section === "pipelines") && "hidden")}>
            <PipelinesSection
              onOpenPipelines={(id, editing) => {
                // The parent closes the modal for this hand-off — reset the
                // view here too, like every other close.
                resetView();
                onOpenPipelines(id, editing);
              }}
              onImported={onBundleImported}
            />
          </div>

          {/* Kept mounted regardless of the active section (unlike the
              switch above) so an unsaved host/label/token draft in
              GitHubTokensSection survives switching sections — matches the
              pre-sidebar flat-layout lifetime, where this pane never
              unmounted while the dialog was open. */}
          <div
            className={cn(
              "space-y-4 pt-3 text-sm",
              !(view.kind === "section" && view.section === "git") && "hidden",
            )}
          >
            <GitHubTokensSection />
          </div>

          {/* Same treatment as GitHubTokensSection above — kept mounted
              regardless of the active section so an in-progress
              name/content draft in SavedPromptsSection survives switching
              sections instead of being destroyed on unmount. No wrapper
              spacing classes here (unlike the GitHubTokensSection div
              above) since SavedPromptsSection's own root already applies
              "space-y-4 pt-3 text-sm". */}
          <div className={cn(!(view.kind === "section" && view.section === "prompts") && "hidden")}>
            <SavedPromptsSection />
          </div>

          {view.kind === "templates" && (
            <TemplatePicker
              onPick={(t) => showEditor(null, resolveTemplate(t, dataDir))}
            />
          )}

          {view.kind === "agent-editor" && (
            <div data-testid="agent-profile-editor" className="pt-3 text-sm">
              <AgentProfileForm
                key={`${openCount}:${view.profileId ?? view.duplicateFromId ?? "new"}`}
                variant="page"
                autoFocus
                profileId={view.profileId}
                duplicateFromId={view.duplicateFromId}
                onDirtyChange={(dirty) => {
                  subpageDirtyRef.current = dirty;
                }}
                onCancel={() => setView(backFromSubview(viewRef.current))}
                onDuplicate={() => {
                  const current = viewRef.current;
                  if (current.kind !== "agent-editor" || !current.profileId) return;
                  const id = current.profileId;
                  void leaveSubpage(() => setView(openAgentEditor(null, id)));
                }}
                onSaved={() => {
                  // The user may have left (rail click, Escape-pop) while the
                  // save was in flight — only pop if this editor is still the
                  // one showing.
                  const current = viewRef.current;
                  if (
                    current.kind === "agent-editor" &&
                    current.profileId === view.profileId &&
                    current.duplicateFromId === view.duplicateFromId
                  ) {
                    setView(backFromSubview(current));
                  }
                }}
              />
            </div>
          )}

          {view.kind === "stack-editor" && (
            <StackEditor
              key={`${openCount}:${view.stackId ?? "new"}`}
              stackId={view.stackId}
              stacks={payload.stacks ?? []}
              limitStates={payload.limitStates ?? []}
              harnesses={payload.harnesses}
              onChange={() => {
                void refresh();
                onChange?.();
              }}
              onSaved={stackSavedHandler(view, setView)}
              onDirtyChange={(dirty) => {
                subpageDirtyRef.current = dirty;
              }}
            />
          )}

          {view.kind === "stack-history" && (
            <StackHistory
              key={`${openCount}:${view.stackId}`}
              stackId={view.stackId}
              stackLabel={(payload.stacks ?? []).find((st) => st.id === view.stackId)?.label ?? "this stack"}
            />
          )}

          {view.kind === "editor" && (
            <Editor
              template={view.template}
              isEdit={view.harnessId !== null}
              homeDir={homeDir}
              dataDir={dataDir}
              existingIds={new Set(payload.harnesses.map((h) => h.id))}
              busy={savingToken === editorTokenRef.current}
              error={formError}
              onDirtyChange={(dirty) => {
                subpageDirtyRef.current = dirty;
              }}
              onCancel={() => setView(backFromSubview(viewRef.current))}
              onSubmit={async (input) => {
                const token = editorTokenRef.current;
                // Still the editor instance that started this save — a rail
                // click / Escape-pop / close may have replaced it while the
                // round-trip was in flight, and a reopened editor is a
                // different instance even though its kind is "editor" again.
                const stillShowing = () =>
                  viewRef.current.kind === "editor" && editorTokenRef.current === token;
                setSavingToken(token);
                setFormError(null);
                try {
                  if (view.harnessId) {
                    const harnessId = view.harnessId;
                    const outcome = await saveConfirmingMirrorDrop(
                      (confirmMirrorDrop) =>
                        api.updateHarness(harnessId, {
                          label: input.label,
                          home: input.home,
                          bin: input.bin,
                          env: input.env,
                          ...(confirmMirrorDrop ? { confirmMirrorDrop: true } : {}),
                        }),
                      (refusal) =>
                        confirm({
                          title: "Drop this account's mirror records?",
                          description: refusal.error,
                          confirmLabel: "Save anyway",
                          variant: "destructive",
                        }),
                    );
                    // Cancelled: nothing was saved; the editor stays open
                    // with the draft as typed.
                    if (outcome === "cancelled") return;
                  } else {
                    await api.createHarness(input);
                  }
                  await refresh();
                  onChange?.();
                  // Only pop the view if the Editor that saved is still showing.
                  if (stillShowing()) setView(backFromSubview(viewRef.current));
                } catch (e) {
                  const message = e instanceof Error ? e.message : String(e);
                  if (stillShowing()) {
                    setFormError(message);
                  } else {
                    // Editor is unmounted — setFormError would target nothing
                    // and the failure would be silent. Surface it as a toast
                    // instead, mirroring the delete-failure toast above.
                    toast.error("Couldn't save harness", {
                      description: message,
                      duration: Infinity,
                    });
                  }
                } finally {
                  setSavingToken((t) => (t === token ? null : t));
                }
              }}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** `ApiError` for a refused Compact is a 409 whose message already is the
 *  server's `error` ("N task(s) running — stop or wait for them first"). */
function compactRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body;
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return e.message;
}

/**
 * Settings → General "Archived task history": the retention age picker, the
 * database size line and the manual Compact button
 * (docs/plans/non-blocking-session-restore.md, decision F, task T11).
 *
 * Self-contained on purpose — it owns its own preference + stats fetches
 * (on mount, which is every time the General section opens), so nothing
 * threads through `SettingsDialog`'s `refresh()`. Compact is the one request
 * that deliberately freezes the core (`VACUUM`), so it runs behind a confirm
 * that states the estimate and then a blocking modal that can't be dismissed
 * until the request settles; `api.compactDb` suspends the app-level busy
 * banner for the duration, since this modal already explains the pause.
 */
function ArchivedHistorySection() {
  const confirm = useConfirm();
  const [days, setDays] = useState<number | null>(() => parseArchivedHistoryRetentionDays(undefined));
  const [loaded, setLoaded] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [stats, setStats] = useState<DbStats | null>(null);
  const [compacting, setCompacting] = useState<{ estimateSec: number } | null>(null);
  const [compactResult, setCompactResult] = useState<DbCompactResult | null>(null);
  const [compactRefused, setCompactRefused] = useState<string | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Sequence guard: a slow stats answer must never overwrite a newer one (the
  // post-compact refetch races the on-mount one when the section is reopened).
  const statsSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadStats = async (): Promise<DbStats | null> => {
    const seq = ++statsSeqRef.current;
    try {
      const fresh = await api.getDbStats();
      if (mountedRef.current && seq === statsSeqRef.current) setStats(fresh);
      return fresh;
    } catch {
      // Best-effort display line — an older core without `/db/stats` (or a
      // busy one) just leaves the previous line / none.
      return null;
    }
  };

  useEffect(() => {
    void api.listPreferences()
      .then((prefs) => {
        if (!mountedRef.current) return;
        setDays(parseArchivedHistoryRetentionDays(prefs[ARCHIVED_HISTORY_RETENTION_PREF]));
        setLoaded(true);
      })
      .catch(() => { if (mountedRef.current) setLoaded(true); });
    void loadStats();
  }, []);

  const onPickDays = (next: number | null) => {
    const previous = days;
    setDays(next);
    setPrefError(null);
    api.setPreference(ARCHIVED_HISTORY_RETENTION_PREF, formatRetentionValue(next))
      .then(() => { void loadStats(); })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        // Revert only if this failed write is still the latest selection.
        setDays((current) => (current === next ? previous : current));
        setPrefError(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
      });
  };

  const onCompact = async () => {
    setCompactResult(null);
    setCompactRefused(null);
    setCompactError(null);
    // Fresh stats first: the estimate and the active-run count both go stale.
    const fresh = (await loadStats()) ?? stats;
    if (!mountedRef.current) return;
    const estimateSec = Math.max(1, Math.round(fresh?.compactEstimateSec ?? 0));
    const ok = await confirm({
      title: "Compact the database?",
      description: (
        <>
          Rewrites the database file to give back unused space
          {fresh ? ` (about ${formatBytes(fresh.reclaimableBytes)} reclaimable)` : ""}. This takes about {estimateSec} s,
          and Agetor won't respond while it runs. Compacting is refused while any task is running.
        </>
      ),
      confirmLabel: "Compact",
    });
    if (!ok || !mountedRef.current) return;
    setCompacting({ estimateSec });
    try {
      const result = await api.compactDb();
      if (!mountedRef.current) return;
      setCompactResult(result);
      void loadStats();
    } catch (e) {
      if (!mountedRef.current) return;
      const refusal = compactRefusal(e);
      if (refusal !== null) setCompactRefused(refusal);
      else setCompactError(`Couldn't compact: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (mountedRef.current) setCompacting(null);
    }
  };

  return (
    <section className="space-y-1" data-testid="settings-archived-history">
      <label htmlFor="archived-history-retention" className="text-xs text-muted-foreground">
        Archived task history
      </label>
      <Select
        id="archived-history-retention"
        data-testid="settings-archived-history-retention"
        value={days === null ? "off" : String(days)}
        disabled={!loaded}
        onChange={(e) => onPickDays(e.target.value === "off" ? null : Number(e.target.value))}
      >
        {retentionSelectOptions(days).map((d) => (
          <option key={d === null ? "off" : d} value={d === null ? "off" : String(d)}>
            {d === null ? "Off — keep everything" : `Trim after ${retentionOptionLabel(d)}`}
          </option>
        ))}
      </Select>
      <p className="text-[11px] text-muted-foreground">
        Large tool outputs (over 4 KB) in tasks archived longer than this are trimmed to their first 4 KB. This is
        one-way: "Rebuild from session JSONL" can only restore them while Claude's own transcript still exists.
        Runs automatically after launch and daily.
      </p>
      {prefError && <p className="text-[11px] text-danger" data-testid="settings-archived-history-error">{prefError}</p>}
      {stats && (
        <p className="text-[11px] text-muted-foreground" data-testid="settings-db-stats">
          {formatDbStatsLine(stats)}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          data-testid="settings-db-compact"
          disabled={compacting !== null}
          onClick={() => { void onCompact(); }}
        >
          Compact database
        </Button>
        <span className="text-[11px] text-muted-foreground">Reclaims unused space; pauses Agetor briefly.</span>
      </div>
      {compactResult && (
        <p className="text-[11px] text-success" data-testid="settings-db-compact-result">
          Compacted: {formatBytes(compactResult.beforeBytes)} → {formatBytes(compactResult.afterBytes)}
        </p>
      )}
      {compactRefused && (
        <p className="text-[11px] text-warning" data-testid="settings-db-compact-refused">{compactRefused}</p>
      )}
      {compactError && <p className="text-[11px] text-danger" data-testid="settings-db-compact-error">{compactError}</p>}
      {/* Portaled to <body>: the blocking modal must sit above the Settings
          dialog regardless of that panel's stacking/overflow, like the
          confirm and bundle dialogs. `onClose` is a no-op — the core is
          frozen for the duration and there is nothing to dismiss to. */}
      {createPortal(
        <Dialog open={compacting !== null} onClose={() => {}} labelledBy="db-compacting-title" className="max-w-sm">
          <div className="flex items-start gap-3" data-testid="settings-db-compacting" role="status">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            <div className="space-y-1">
              <h2 id="db-compacting-title" className="text-sm font-medium">
                Compacting… ~{compacting?.estimateSec ?? 0} s
              </h2>
              <p className="text-xs text-muted-foreground">
                Agetor won't respond until this finishes. Please don't quit.
              </p>
            </div>
          </div>
        </Dialog>,
        document.body,
      )}
    </section>
  );
}

function GeneralSection({
  payload,
  defaultHarness,
  onPickDefault,
  stickyUserMessages,
  onStickyUserMessagesChange,
  fxAutoResume,
  onFxAutoResumeChange,
  tmuxSource,
  bundledTmuxAvailable,
  onPickTmuxSource,
  disclaimSpawnedAgents,
  onDisclaimSpawnedAgentsChange,
  onClose,
}: {
  payload: HarnessesPayload;
  defaultHarness: string;
  onPickDefault: (id: string) => void;
  stickyUserMessages: boolean;
  onStickyUserMessagesChange: (sticky: boolean) => void;
  fxAutoResume: { enabled: boolean; delaySec: number };
  onFxAutoResumeChange: (next: { enabled: boolean; delaySec: number }) => void;
  tmuxSource: "system" | "bundled";
  bundledTmuxAvailable: boolean;
  onPickTmuxSource: (source: "system" | "bundled") => void;
  disclaimSpawnedAgents: boolean;
  onDisclaimSpawnedAgentsChange: (enabled: boolean) => void;
  /** Closes the Settings dialog — used by "Show getting started guide" so the
   *  onboarding checklist underneath is visible after replaying it. */
  onClose: () => void;
}) {
  // Disabled harnesses are excluded from the default-harness picker so a
  // soft-deleted harness can't silently become the default for new tasks.
  const enabledHarnesses = payload.harnesses.filter((h) => h.enabled);
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const [launchScan, setLaunchScan] = useState(true);
  const launchScanTouchedRef = useRef(false);
  const launchScanDesiredRef = useRef<boolean | null>(null);
  const launchScanWriteRef = useRef(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    void api.listPreferences().then((prefs) => {
      if (cancelled || launchScanTouchedRef.current) return;
      setLaunchScan(prefs[CLAUDE_SESSIONS_LAUNCH_SCAN_PREF] !== "0");
    }).catch(() => { /* default stays on */ });
    return () => { cancelled = true; };
  }, []);
  const setLaunchScanPref = (on: boolean) => {
    launchScanTouchedRef.current = true;
    launchScanDesiredRef.current = on;
    setLaunchScan(on);
    // Writes run one at a time. A toggle that lands while an older request
    // is queued skips that request, so the stored value is the last switch.
    launchScanWriteRef.current = launchScanWriteRef.current.then(async () => {
      if (launchScanDesiredRef.current !== on) return;
      try {
        await api.setPreference(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, on ? "1" : "0");
      } catch {
        if (launchScanDesiredRef.current !== on) return;
        launchScanDesiredRef.current = !on;
        setLaunchScan(!on);
      }
    });
  };
  const { percent: fontSizePercent, increase: increaseFontSize, decrease: decreaseFontSize, reset: resetFontSize } = useFontSize();
  const canDecreaseFontSize = fontSizePercent > FONT_SIZE_MIN;
  const canIncreaseFontSize = fontSizePercent < FONT_SIZE_MAX;
  const canResetFontSize = fontSizePercent !== FONT_SIZE_DEFAULT;
  const [replayingOnboarding, setReplayingOnboarding] = useState(false);
  // Local text mirror of `fxAutoResume.delaySec` so the field can hold an
  // in-progress keystroke (e.g. a momentarily-empty box while retyping)
  // without that draft round-tripping through the parent/preferences store
  // on every keystroke. Committed (clamped) on blur or Enter; resynced
  // whenever the prop changes from outside (e.g. another Settings instance,
  // or a revert on write failure).
  const [fxDelayInput, setFxDelayInput] = useState(String(fxAutoResume.delaySec));
  useEffect(() => {
    setFxDelayInput(String(fxAutoResume.delaySec));
  }, [fxAutoResume.delaySec]);
  const commitFxDelay = () => {
    const clamped = parseFxAutoResumeDelayInput(fxDelayInput);
    setFxDelayInput(String(clamped));
    if (clamped !== fxAutoResume.delaySec) {
      onFxAutoResumeChange({ ...fxAutoResume, delaySec: clamped });
    }
  };
  return (
    <div className="space-y-4 pt-3 text-sm">
      <section className="space-y-1">
        <label className="text-xs text-muted-foreground">Default harness for new tasks</label>
        <Select value={defaultHarness} onChange={(e) => onPickDefault(e.target.value)}>
          {enabledHarnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}{" "}
              {h.label.toLowerCase() !== h.kind ? `(${h.kind})` : ""}
            </option>
          ))}
        </Select>
      </section>

      <section className="space-y-1">
        <label className="text-xs text-muted-foreground">tmux for Claude Code</label>
        <Select
          value={tmuxSource}
          onChange={(e) => onPickTmuxSource(e.target.value as "system" | "bundled")}
        >
          <option value="system">System tmux (from PATH)</option>
          <option value="bundled" disabled={!bundledTmuxAvailable}>
            {bundledTmuxAvailable
              ? "Bundled tmux (shipped with Agetor)"
              : "Bundled tmux — not available in this build"}
          </option>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Claude Code runs through a tmux session per task. Switch to the bundled
          binary if you don't want to install tmux system-wide.
        </p>
      </section>

      <section className="space-y-1">
        <label className="text-xs text-muted-foreground">Theme</label>
        <div className="grid grid-cols-3 gap-1">
          {THEME_PREFERENCES.map((t) => {
            const Icon = THEME_PREFERENCE_ICON[t.id];
            return (
              <Button
                key={t.id}
                size="sm"
                variant={themePreference === t.id ? "default" : "outline"}
                onClick={() => setThemePreference(t.id)}
                className="justify-start"
              >
                <Icon className="mr-1.5 size-3.5" />
                {t.label}
              </Button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Auto follows your system's appearance and switches live if it changes.
        </p>
      </section>

      <section className="space-y-1">
        <label className="text-xs text-muted-foreground">Font size</label>
        <div role="group" aria-label="Font size" className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="w-8 px-0 aria-disabled:cursor-default aria-disabled:opacity-50"
            aria-label="Decrease font size"
            aria-disabled={!canDecreaseFontSize}
            onClick={() => {
              if (!canDecreaseFontSize) return;
              decreaseFontSize({ silent: true });
            }}
          >
            <Minus className="size-3.5" />
          </Button>
          <span role="status" aria-live="polite" className="w-10 text-center text-xs tabular-nums">
            {fontSizePercent}%
          </span>
          <Button
            size="sm"
            variant="outline"
            className="w-8 px-0 aria-disabled:cursor-default aria-disabled:opacity-50"
            aria-label="Increase font size"
            aria-disabled={!canIncreaseFontSize}
            onClick={() => {
              if (!canIncreaseFontSize) return;
              increaseFontSize({ silent: true });
            }}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
            aria-label="Reset font size"
            aria-disabled={!canResetFontSize}
            onClick={() => {
              if (!canResetFontSize) return;
              resetFontSize({ silent: true });
            }}
          >
            Reset
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{FONT_SIZE_HINT}</p>
      </section>

      <BackgroundSection />

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="claude-sessions-launch-scan" className="text-xs text-muted-foreground">
            Look for Claude Code and OpenCode sessions on launch
          </label>
          <Switch
            id="claude-sessions-launch-scan"
            data-testid="claude-sessions-launch-scan"
            checked={launchScan}
            onCheckedChange={setLaunchScanPref}
            aria-label="Look for Claude Code and OpenCode sessions on launch"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          On startup, notice Claude Code and OpenCode sessions that were started outside Agetor so you can import them.
        </p>
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="sticky-user-messages" className="text-xs text-muted-foreground">
            Sticky user messages
          </label>
          <Switch
            id="sticky-user-messages"
            checked={stickyUserMessages}
            onCheckedChange={onStickyUserMessagesChange}
            aria-label="Sticky user messages"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Keep your latest sent message visible while its response scrolls. Turn this off for a standard chat list.
        </p>
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="disclaim-spawned-agents" className="text-xs text-muted-foreground">
            Keep Agetor's macOS permissions away from agents (macOS)
          </label>
          <Switch
            id="disclaim-spawned-agents"
            checked={disclaimSpawnedAgents}
            // keep in sync with DISCLAIM_PREF_KEY in src/bun/disclaim.ts
            onCheckedChange={onDisclaimSpawnedAgentsChange}
            aria-label="Keep Agetor's macOS permissions away from agents (macOS)"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Agents and the programs Agetor runs in the background, such as git and harness checks, ask for macOS
          permissions under their own name instead of Agetor's, so a grant sticks after you allow it once. Only this
          switch can turn it off, and Agetor asks again at the next launch.
        </p>
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="fx-auto-resume" className="text-xs text-muted-foreground">
            Auto-resume fx after a rate limit
          </label>
          <Switch
            id="fx-auto-resume"
            data-testid="settings-fx-auto-resume"
            checked={fxAutoResume.enabled}
            onCheckedChange={(enabled) => onFxAutoResumeChange({ ...fxAutoResume, enabled })}
            aria-label="Auto-resume fx after a rate limit"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          When fx pauses after repeated Gateway 429s, Agetor resumes the response automatically, up to {FX_AUTO_RESUME_MAX} times per pause.
        </p>
        <div className="flex items-center justify-between gap-4 pt-1">
          <label htmlFor="fx-auto-resume-delay" className="text-xs text-muted-foreground">
            Auto-resume delay (seconds)
          </label>
          <Input
            id="fx-auto-resume-delay"
            data-testid="settings-fx-auto-resume-delay"
            type="number"
            min={FX_AUTO_RESUME_MIN_DELAY_SEC}
            max={FX_AUTO_RESUME_MAX_DELAY_SEC}
            step={10}
            className="w-24"
            disabled={!fxAutoResume.enabled}
            value={fxDelayInput}
            onChange={(e) => setFxDelayInput(e.target.value)}
            onBlur={commitFxDelay}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              commitFxDelay();
              e.currentTarget.blur();
            }}
          />
        </div>
      </section>

      <ArchivedHistorySection />

      <section className="space-y-1">
        <label className="text-xs text-muted-foreground">Getting started</label>
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="settings-replay-onboarding"
            disabled={replayingOnboarding}
            onClick={async () => {
              if (replayingOnboarding) return;
              setReplayingOnboarding(true);
              // Await the write before closing — App re-reads preferences on
              // close, so a fire-and-forget PUT can lose the race against
              // that GET and silently discard the replay.
              await api.setPreference(ONBOARDING_DISMISSED_PREF, "false").catch(() => {
                // Best-effort, matching the theme/defaultHarness write idiom
                // above — the checklist will simply not reappear if this
                // silently fails, which is a minor papercut, not a hard
                // error worth surfacing.
              });
              setReplayingOnboarding(false);
              onClose();
            }}
          >
            Show getting started guide
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Bring back the onboarding checklist.
        </p>
      </section>
    </div>
  );
}

/** Turn a discovered account into a pre-filled editor template. The email
 *  lands in the label so two claude harnesses stay distinguishable in every
 *  picker; the config dir becomes the harness home verbatim. */
function discoveredToTemplate(a: DiscoveredAccount): HarnessTemplate {
  return {
    id: `__discovered:${a.configDir}`,
    label: `Claude (${a.email})`,
    description: "",
    kind: "claude-code",
    suggestedHarnessId: a.suggestedHarnessId,
    home: a.configDir,
    bin: null,
    env: {},
  };
}

function TemplatePicker({ onPick }: { onPick: (t: HarnessTemplate) => void }) {
  // Existing logged-in Claude config dirs no harness points at yet. Loaded
  // on open; a failed probe degrades to the static templates only.
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.discoverAccounts()
      .then((p) => { if (!cancelled) setDiscovered(p.accounts); })
      .catch(() => { /* static templates still work */ });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="space-y-2 pt-3">
      <p className="text-xs text-muted-foreground">
        Pick a starting point. You can edit every field before saving.
      </p>
      {discovered.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Detected accounts
          </p>
          {discovered.map((a) => (
            <button
              key={a.configDir}
              type="button"
              onClick={() => onPick(discoveredToTemplate(a))}
              className={cn(
                "flex w-full items-start gap-3 rounded-md border border-border/60 px-3 py-2 text-left",
                "hover:border-primary/60 hover:bg-accent/50",
              )}
            >
              <AgentIcon kind="claude-code" className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  Existing Claude account · {a.email}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {a.configDir}
                  {a.billingType && <> · {a.billingType}</>}
                  {" "}· already logged in, no setup needed
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {HARNESS_TEMPLATES.map((t) => {
          const experimental = isExperimentalKind(t.kind);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className={cn(
                "flex w-full items-start gap-3 rounded-md border border-border/60 px-3 py-2 text-left",
                "hover:border-primary/60 hover:bg-accent/50",
              )}
            >
              {experimental && (
                <span className="mt-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                  Experimental
                </span>
              )}
              <AgentIcon kind={t.kind} className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t.label}</div>
                <div className="text-[11px] text-muted-foreground">{t.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Editor({
  template,
  isEdit,
  homeDir,
  dataDir,
  existingIds,
  busy,
  error,
  onDirtyChange,
  onCancel,
  onSubmit,
}: {
  template: HarnessTemplate;
  isEdit: boolean;
  homeDir: string;
  dataDir: string;
  existingIds: Set<string>;
  busy: boolean;
  error: string | null;
  /** Reports whether any field differs from what the form opened with;
   *  reports `false` again on unmount. */
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSubmit: (input: HarnessInput) => void;
}) {
  // When creating from a template, pre-bump the suggested id past any
  // already-taken slug (claude-2 → claude-3 …) so two clicks of "Additional
  // Claude Code" don't both default to the same id. If `home` ends with the
  // original suggested id, rewrite its trailing segment so the suggested
  // HOME stays in sync. Editing an existing harness skips this so the row's
  // own id passes through unchanged.
  const initialState = useMemo(() => {
    if (isEdit) {
      return {
        id: template.suggestedHarnessId,
        home: template.home ? abbreviateHome(template.home, homeDir) : "",
      };
    }
    const uniqId = uniqueHarnessId(template.suggestedHarnessId, existingIds);
    const home = resolveTemplateInitialHome(template, uniqId);
    return { id: uniqId, home: home ? abbreviateHome(home, homeDir) : "" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [id, setId] = useState(initialState.id);
  const [label, setLabel] = useState(template.label);
  const [kind, setKind] = useState<AgentKind>(template.kind);
  const [home, setHome] = useState(initialState.home);
  const [bin, setBin] = useState(template.bin ?? "");
  const [envText, setEnvText] = useState(stringifyEnv(template.env));
  const [localError, setLocalError] = useState<string | null>(null);

  // Dirty = any field differs from what the state above was seeded with. All
  // six are seeded synchronously, so a plain value diff is exact.
  const [initialDraft] = useState(() => ({
    id: initialState.id,
    label: template.label,
    kind: template.kind as string,
    home: initialState.home,
    bin: template.bin ?? "",
    envText: stringifyEnv(template.env),
  }));
  // While a save is in flight the edits are being persisted, not discarded —
  // report clean so leaving mid-save doesn't ask "Discard unsaved changes?".
  // A failed save flips `busy` back and the form reads dirty again.
  const dirty = harnessEditorDirty({ id, label, kind, home, bin, envText }, initialDraft) && !busy;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChangeRef.current(false), []);

  // Parse once per render so we can warn about ignored lines below the
  // textarea. Cheap — the env block is tiny.
  const parsedEnv = useMemo(() => parseEnv(envText), [envText]);

  const submit = () => {
    setLocalError(null);
    const trimmedId = id.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmedId)) {
      setLocalError("id must be a slug — lowercase letters, digits, `_` or `-`, starting with a letter or digit");
      return;
    }
    if (!isEdit && existingIds.has(trimmedId)) {
      setLocalError(`a harness with id "${trimmedId}" already exists`);
      return;
    }
    if (!label.trim()) {
      setLocalError("label is required");
      return;
    }
    const homeTrim = home.trim();
    const homeAbs = expandTilde(homeTrim || null, homeDir);
    if (homeAbs && !homeAbs.startsWith("/")) {
      setLocalError("HOME must be an absolute path (use `/...` or `~/...`)");
      return;
    }
    const binTrim = bin.trim();
    if (binTrim && !binTrim.startsWith("/")) {
      setLocalError("bin must be an absolute path");
      return;
    }
    onSubmit({
      id: trimmedId,
      kind,
      label: label.trim(),
      home: homeAbs,
      bin: binTrim || null,
      env: parsedEnv.env,
    });
  };

  return (
    <div className="space-y-3 pt-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Id (slug)</label>
          <Input
            {...IDENTIFIER_INPUT_PROPS}
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit || busy}
            placeholder="claude-work"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Label</label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            placeholder="Claude (work)"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Harness type</label>
        <div className="grid grid-cols-3 gap-1 sm:grid-cols-8">
          {(["claude-code", "codex", "cursor", "gemini", "antigravity", "fx", "opencode", "copilot"] as AgentKind[]).map((k) => {
            const experimental = isExperimentalKind(k);
            return (
              <Button
                key={k}
                size="sm"
                variant={kind === k ? "default" : "outline"}
                onClick={() => setKind(k)}
                disabled={isEdit || busy}
                className="justify-start"
              >
                <AgentIcon kind={k} className="mr-1.5 size-3.5" />
                {k}
                {experimental && (
                  <span className="ml-1.5 rounded bg-warning/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-warning">
                    Exp
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          {HARNESS_HOME_COPY[kind].label}
        </label>
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          value={home}
          onChange={(e) => setHome(e.target.value)}
          disabled={busy}
          placeholder={
            dataDir
              ? abbreviateHome(`${dataDir}/harnesses/${HARNESS_HOME_COPY[kind].slug}`, homeDir)
              : "~/.agetor/harnesses/claude-2"
          }
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          {HARNESS_HOME_COPY[kind].help}
          {" "}Leave empty to share the default account.
        </p>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Bin override (absolute path; optional)</label>
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          value={bin}
          onChange={(e) => setBin(e.target.value)}
          disabled={busy}
          placeholder="/opt/homebrew/bin/claude"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Env vars (one KEY=value per line)</label>
        <Textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          disabled={busy}
          rows={3}
          className="font-mono text-xs"
        />
        {parsedEnv.ignored > 0 && (
          <p className="text-[11px] leading-snug text-warning">
            {parsedEnv.ignored} line{parsedEnv.ignored === 1 ? "" : "s"} ignored — each entry needs <code className="font-mono">KEY=value</code>.
          </p>
        )}
      </div>

      {(localError || error) && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {localError || error}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {isEdit ? "Save" : "Add harness"}
        </Button>
      </div>
    </div>
  );
}
