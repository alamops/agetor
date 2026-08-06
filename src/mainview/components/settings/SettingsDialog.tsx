import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Plus, Terminal, Trash2, X } from "lucide-react";
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
import { GitHubTokensSection } from "@/components/settings/GitHubTokensSection";
import { abbreviateHome, cn } from "@/lib/utils";
import {
  HARNESS_TEMPLATES,
  type AgentKind,
  type Harness,
  type HarnessTemplate,
} from "../../../shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Refresh agents/harnesses on the parent after CRUD operations. */
  onChange?: () => void;
  /** Resolved home dir from `GET /defaults` — used to expand `~` in templates. */
  homeDir: string;
  /** Active data dir from `GET /defaults` — substituted into `{dataDir}` in
   *  template `home` paths so new harnesses default under the running dir
   *  (~/.agetor for the .app, ~/.agetor-dev for `bun run dev`). */
  dataDir: string;
}

type View =
  | { kind: "list" }
  | { kind: "templates" }
  | { kind: "editor"; harnessId: string | null; template: HarnessTemplate };

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
 * ternary chain because a third kind (gemini) made the binary claude/codex
 * ternary genuinely hard to read.
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
  gemini: {
    label: "GEMINI_CLI_HOME override (absolute path; optional)",
    slug: "gemini-2",
    help: "Sets GEMINI_CLI_HOME on spawn — gemini stores its login, sessions, and settings under this path (a dedicated override, not the real HOME), so a separate path gives this harness its own account.",
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

/** If `err` is the server's "harness in use" 409 (which carries a structured
 *  `taskIds` list), resolve those ids to titles and return a human-readable
 *  description for the failure toast. Returns null if the error isn't that
 *  shape — caller falls back to the raw `error` message. */
async function describeHarnessInUse(err: unknown): Promise<string | null> {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (!body || typeof body !== "object") return null;
  const taskIds = (body as { taskIds?: unknown }).taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0) return null;
  const ids = taskIds.filter((x): x is string => typeof x === "string");
  if (ids.length === 0) return null;
  let titles: string[];
  try {
    const tasks = await api.listTasks();
    const byId = new Map(tasks.map((t) => [t.id, t.title]));
    titles = ids.map((id) => byId.get(id) ?? `${id.slice(0, 8)}…`);
  } catch {
    // Listing tasks failed — fall back to id prefixes so the toast still
    // identifies *which* tasks are blocking, even if not by name.
    titles = ids.map((id) => `${id.slice(0, 8)}…`);
  }
  const noun = titles.length === 1 ? "task" : "tasks";
  return `In use by ${titles.length} ${noun}: ${titles.join(", ")}`;
}

export function SettingsDialog({ open, onClose, onChange, homeDir, dataDir }: Props) {
  const [version, setVersion] = useState<string>("");
  const [payload, setPayload] = useState<HarnessesPayload>({ harnesses: [], statuses: [] });
  const [defaultHarness, setDefaultHarness] = useState<string>("claude-code");
  const [tmuxSource, setTmuxSource] = useState<"system" | "bundled">("system");
  const [bundledTmuxAvailable, setBundledTmuxAvailable] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Optimistic toggle map: harness id → the value the user *clicked toward*.
  // Lets the Switch animate the moment the user clicks even though the actual
  // mutation is gated behind a confirm dialog + network round-trip. Cleared
  // on confirm-success (refresh overwrites with the server's truth), on
  // cancel (revert), and on error (revert + surface the message).
  const [pendingToggle, setPendingToggle] = useState<Record<string, boolean>>({});
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
    // Reset to list view on every open so a half-filled editor doesn't
    // greet the user next time.
    setView({ kind: "list" });
    setFormError(null);
  }, [open]);

  const statusByHarness = useMemo(() => {
    const map = new Map(payload.statuses.map((s) => [s.harnessId, s]));
    return map;
  }, [payload.statuses]);

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
    const ok = await confirm({
      title: `Delete "${h.label}"?`,
      description: "The alias will be removed. Tasks already using it will fail to start until reassigned.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteHarness(h.id);
      await refresh();
      onChange?.();
    } catch (e) {
      // ListView doesn't render `formError` (only the Editor does), so a
      // failed delete would otherwise be invisible. Surface it as a toast.
      const message = e instanceof Error ? e.message : String(e);
      const description = await describeHarnessInUse(e) ?? message;
      toast.error(`Couldn't delete "${h.label}"`, {
        description,
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-2xl"
      labelledBy="settings-dialog-title"
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          {view.kind !== "list" && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setView({ kind: "list" })}
              aria-label="Back"
            >
              <ChevronLeft className="size-4" />
            </Button>
          )}
          <h2 id="settings-dialog-title" className="text-base font-semibold">
            {view.kind === "list" && "Settings"}
            {view.kind === "templates" && "Add harness"}
            {view.kind === "editor" && (view.harnessId ? "Edit harness" : "Add harness")}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">v{version}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {view.kind === "list" && (
        <ListView
          payload={payload}
          statusByHarness={statusByHarness}
          defaultHarness={defaultHarness}
          homeDir={homeDir}
          onPickDefault={onPickDefault}
          tmuxSource={tmuxSource}
          bundledTmuxAvailable={bundledTmuxAvailable}
          onPickTmuxSource={onPickTmuxSource}
          canAdd={!!dataDir}
          onAdd={() => setView({ kind: "templates" })}
          onEdit={(h) =>
            setView({
              kind: "editor",
              harnessId: h.id,
              template: {
                id: "__edit",
                label: h.label,
                description: "",
                kind: h.kind,
                suggestedHarnessId: h.id,
                home: h.home,
                bin: h.bin,
                env: h.env,
              },
            })
          }
          onDelete={onDeleteHarness}
          onToggleEnabled={onToggleEnabled}
          onOpenTerminal={onOpenTerminal}
          pendingToggle={pendingToggle}
        />
      )}

      {view.kind === "templates" && (
        <TemplatePicker
          onPick={(t) =>
            setView({
              kind: "editor",
              harnessId: null,
              template: resolveTemplate(t, dataDir),
            })
          }
        />
      )}

      {view.kind === "editor" && (
        <Editor
          template={view.template}
          isEdit={view.harnessId !== null}
          homeDir={homeDir}
          dataDir={dataDir}
          existingIds={new Set(payload.harnesses.map((h) => h.id))}
          busy={busy}
          error={formError}
          onCancel={() => setView({ kind: "list" })}
          onSubmit={async (input) => {
            setBusy(true);
            setFormError(null);
            try {
              if (view.harnessId) {
                await api.updateHarness(view.harnessId, {
                  label: input.label,
                  home: input.home,
                  bin: input.bin,
                  env: input.env,
                });
              } else {
                await api.createHarness(input);
              }
              await refresh();
              onChange?.();
              setView({ kind: "list" });
            } catch (e) {
              setFormError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Dialog>
  );
}

function ListView({
  payload,
  statusByHarness,
  defaultHarness,
  homeDir,
  onPickDefault,
  tmuxSource,
  bundledTmuxAvailable,
  onPickTmuxSource,
  canAdd,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
  onOpenTerminal,
  pendingToggle,
}: {
  payload: HarnessesPayload;
  statusByHarness: Map<string, HarnessesPayload["statuses"][number]>;
  defaultHarness: string;
  homeDir: string;
  onPickDefault: (id: string) => void;
  tmuxSource: "system" | "bundled";
  bundledTmuxAvailable: boolean;
  onPickTmuxSource: (source: "system" | "bundled") => void;
  /** False while `dataDir` is still loading from `GET /defaults`. Adding a
   *  harness with an unresolved data dir would persist a broken HOME path
   *  (`/harnesses/claude-2` instead of `<dataDir>/harnesses/claude-2`). */
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (h: Harness) => void;
  onDelete: (h: Harness) => void;
  onToggleEnabled: (h: Harness) => void;
  /** Open a new Terminal.app window with this harness's env loaded so the
   *  user can authenticate or inspect it (e.g. `claude /login`). */
  onOpenTerminal: (h: Harness) => void;
  /** Optimistic toggle state — keyed by harness id, value is what the user
   *  clicked toward. Lets the Switch animate before the confirm/round-trip
   *  resolves. Missing keys mean "use the server's `h.enabled`". */
  pendingToggle: Record<string, boolean>;
}) {
  // Disabled harnesses are excluded from the default-harness picker so a
  // soft-deleted harness can't silently become the default for new tasks.
  const enabledHarnesses = payload.harnesses.filter((h) => h.enabled);
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

      <GitHubTokensSection />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Harnesses</label>
          <Button
            variant="outline"
            size="sm"
            onClick={onAdd}
            disabled={!canAdd}
            title={canAdd ? undefined : "Loading defaults…"}
          >
            <Plus className="mr-1 size-3.5" /> Add harness
          </Button>
        </div>
        <div className="space-y-1.5">
          {payload.harnesses.map((h) => {
            const status = statusByHarness.get(h.id);
            const available = status?.available ?? false;
            return (
              <div
                key={h.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-border/60 px-3 py-2",
                  !h.enabled && "opacity-60",
                )}
              >
                <AgentIcon kind={h.kind} className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{h.label}</span>
                    {h.isBuiltin && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        built-in
                      </span>
                    )}
                    {!h.enabled && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        disabled
                      </span>
                    )}
                    {(h.kind === "codex" || h.kind === "gemini") && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
                        experimental
                      </span>
                    )}
                    <span
                      className={cn(
                        "inline-block size-1.5 rounded-full",
                        available ? "bg-emerald-500" : "bg-red-500",
                      )}
                      title={status?.reason ?? status?.path ?? ""}
                    />
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {h.id} · {h.kind}
                    {h.home && <> · HOME={abbreviateHome(h.home, homeDir)}</>}
                    {status?.version && <> · {status.version}</>}
                  </div>
                </div>
                <Switch
                  checked={pendingToggle[h.id] ?? h.enabled}
                  onCheckedChange={() => onToggleEnabled(h)}
                  aria-label={h.enabled ? `Disable ${h.label}` : `Enable ${h.label}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => onOpenTerminal(h)}
                  aria-label={`Open ${h.label} in Terminal`}
                  title="Open in Terminal — load this harness's env to log in or inspect it"
                >
                  <Terminal className="size-4" />
                </Button>
                {!h.isBuiltin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => onEdit(h)}>
                      Edit
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onDelete(h)}
                      aria-label={`Delete ${h.label}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function TemplatePicker({ onPick }: { onPick: (t: HarnessTemplate) => void }) {
  return (
    <div className="space-y-2 pt-3">
      <p className="text-xs text-muted-foreground">
        Pick a starting point. You can edit every field before saving.
      </p>
      <div className="space-y-1.5">
        {HARNESS_TEMPLATES.map((t) => {
          const experimental = t.kind === "codex" || t.kind === "gemini";
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
                <span className="mt-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
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
    let home = template.home;
    const orig = template.suggestedHarnessId;
    if (home && orig && uniqId !== orig && home.endsWith(`/${orig}`)) {
      home = `${home.slice(0, -orig.length)}${uniqId}`;
    }
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
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit}
            placeholder="claude-work"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Label</label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Claude (work)"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Harness type</label>
        <div className="grid grid-cols-3 gap-1">
          {(["claude-code", "codex", "gemini"] as AgentKind[]).map((k) => {
            const experimental = k === "codex" || k === "gemini";
            return (
              <Button
                key={k}
                size="sm"
                variant={kind === k ? "default" : "outline"}
                onClick={() => setKind(k)}
                disabled={isEdit}
                className="justify-start"
              >
                <AgentIcon kind={k} className="mr-1.5 size-3.5" />
                {k}
                {experimental && (
                  <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-500">
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
          value={home}
          onChange={(e) => setHome(e.target.value)}
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
          value={bin}
          onChange={(e) => setBin(e.target.value)}
          placeholder="/opt/homebrew/bin/claude"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Env vars (one KEY=value per line)</label>
        <Textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          rows={3}
          className="font-mono text-xs"
        />
        {parsedEnv.ignored > 0 && (
          <p className="text-[11px] leading-snug text-amber-500">
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
