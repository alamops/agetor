import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError, type ClaudeSessionList, type ClaudeSessionListItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  claudeRowKey,
  groupOpencodeImports,
  mergeByActivity,
  opencodeBlockedCopy,
  opencodeRowKey,
  opencodeWarningCopy,
} from "@/lib/import-sessions";
import { LONG_PATH_IMPORT_ERROR, MISSING_FOLDER_IMPORT_ERROR } from "../../../shared/claude-session-meta.ts";
import {
  CLAUDE_SESSIONS_LIVENESS_STALE_MS,
  type DiscoveredAccount,
  type OpencodeSessionListItem,
} from "../../../shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after at least one session was imported, so the board can refresh. */
  onImported?: () => void;
}

type ImportResult = { id: string; taskId?: string; error?: string };

/** One listed row. Claude and OpenCode rows share the list, the selection
 *  and the Import buttons; everything else is per kind. */
type Row =
  | { kind: "claude-code"; key: string; session: ClaudeSessionListItem }
  | { kind: "opencode"; key: string; session: OpencodeSessionListItem };

function blockedCopy(session: ClaudeSessionListItem): string | null {
  if (session.importable) return null;
  if (session.blockedReason === "long-path") return LONG_PATH_IMPORT_ERROR;
  if (session.blockedReason === "missing-folder") return MISSING_FOLDER_IMPORT_ERROR;
  if (session.blockedReason === "live") return session.liveHint ?? "Close it in your terminal first";
  if (session.blockedReason === "no-harness") return "Account isn't set up in Agetor — Add it to import";
  if (session.liveness === "unknown") return "Couldn't tell if this session is still open — Re-check";
  return "This session can't be imported";
}

const rowBlockedCopy = (row: Row): string | null =>
  row.kind === "claude-code" ? blockedCopy(row.session) : opencodeBlockedCopy(row.session);

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const sameDir = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function formatActivity(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function uniqueHarnessId(base: string, existing: Set<string>): string {
  if (!base || !existing.has(base)) return base;
  const match = base.match(/^(.*?)(\d+)$/);
  const prefix = match ? match[1]! : `${base}-`;
  let n = match ? parseInt(match[2]!, 10) + 1 : 2;
  while (existing.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const omitKeys = (prev: Record<string, string>, keys: Iterable<string>): Record<string, string> => {
  const next = { ...prev };
  let changed = false;
  for (const key of keys) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : prev;
};

export function ImportSessionsDialog({ open, onClose, onImported }: Props) {
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSessionListItem[]>([]);
  const [opencodeSessions, setOpencodeSessions] = useState<OpencodeSessionListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [opencodeLoading, setOpencodeLoading] = useState(false);
  /** One error line per kind, so a failing kind never hides the other's rows. */
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [opencodeError, setOpencodeError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [harnessIds, setHarnessIds] = useState<Set<string>>(new Set());
  const [harnessLabels, setHarnessLabels] = useState<Map<string, string>>(new Map());
  /** When each row key was imported here. A list that started before that
   *  time was computed without the new task and would bring the row back. */
  const importedAtRef = useRef(new Map<string, number>());

  const loadClaude = useCallback(async (recheck: boolean): Promise<ClaudeSessionList | null> => {
    const startedAt = Date.now();
    setClaudeLoading(true);
    setClaudeError(null);
    try {
      const res = recheck ? await api.recheckClaudeSessions() : await api.listClaudeSessions();
      const imported = importedAtRef.current;
      setClaudeSessions(res.sessions.filter((s) => (imported.get(claudeRowKey(s.sessionId)) ?? -Infinity) < startedAt));
      // A fresh probe replaces row errors. Keeping them would hide the new
      // blocked reason (or a now-importable row) behind the previous failure.
      if (recheck) setRowError((prev) => omitKeys(prev, Object.keys(prev).filter((k) => k.startsWith("claude-code:"))));
      return res;
    } catch (err) {
      setClaudeError(err instanceof ApiError ? err.message : "Couldn't list Claude Code sessions");
      return null;
    } finally {
      setClaudeLoading(false);
    }
  }, []);

  const loadOpencode = useCallback(async (recheck: boolean): Promise<void> => {
    const startedAt = Date.now();
    setOpencodeLoading(true);
    setOpencodeError(null);
    try {
      const res = recheck ? await api.recheckOpencodeSessions() : await api.listOpencodeSessions();
      const imported = importedAtRef.current;
      setOpencodeSessions(res.sessions.filter((s) => (imported.get(opencodeRowKey(s)) ?? -Infinity) < startedAt));
      if (recheck) setRowError((prev) => omitKeys(prev, Object.keys(prev).filter((k) => k.startsWith("opencode:"))));
    } catch (err) {
      setOpencodeError(err instanceof ApiError ? err.message : "Couldn't list OpenCode sessions");
    } finally {
      setOpencodeLoading(false);
    }
  }, []);

  const recheckAll = useCallback(async () => {
    await Promise.all([loadClaude(true), loadOpencode(true)]);
  }, [loadClaude, loadOpencode]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      // Show the cached list at once, then probe again when that liveness is
      // missing (launch scan off, or a failed probe) or older than a minute:
      // a session opened or closed since would otherwise show the wrong state.
      const res = await loadClaude(false);
      if (cancelled || !res) return;
      const checkedAt = res.livenessCheckedAt;
      if (checkedAt === null || Date.now() - checkedAt > CLAUDE_SESSIONS_LIVENESS_STALE_MS) {
        await loadClaude(true);
      }
    })();
    // OpenCode's list is cached for only a few seconds server-side and its
    // busy check runs on every scan, so a plain list is fresh enough.
    void loadOpencode(false);
    void Promise.all([api.discoverAccounts(), api.listHarnesses()])
      .then(([discovered, listed]) => {
        if (cancelled) return;
        setAccounts(discovered.accounts);
        setHarnessIds(new Set(listed.harnesses.map((h) => h.id)));
        setHarnessLabels(new Map(listed.harnesses.map((h) => [h.id, h.label] as const)));
      })
      .catch(() => { /* the row stays without an Add control */ });
    return () => { cancelled = true; };
  }, [open, loadClaude, loadOpencode]);

  const rows = useMemo<Row[]>(() => mergeByActivity<Row, Row>(
    claudeSessions.map((session) => ({ kind: "claude-code", key: claudeRowKey(session.sessionId), session })),
    (row) => (row.kind === "claude-code" ? row.session.lastActivity : row.session.updatedAt),
    opencodeSessions.map((session) => ({ kind: "opencode", key: opencodeRowKey(session), session })),
    (row) => (row.kind === "claude-code" ? row.session.lastActivity : row.session.updatedAt),
  ), [claudeSessions, opencodeSessions]);

  const importableKeys = useMemo(
    () => rows.filter((row) => row.session.importable).map((row) => row.key),
    [rows],
  );

  // Drop selections whose row vanished or stopped being importable.
  useEffect(() => {
    const importable = new Set(importableKeys);
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => importable.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [importableKeys]);

  const accountFor = (session: ClaudeSessionListItem) =>
    accounts.find((account) => sameDir(account.configDir, session.configDir)) ?? null;

  const harnessCell = (row: Row): string => {
    if (row.kind === "opencode") return row.session.harnessLabel || row.session.harnessId;
    const id = row.session.harnessId;
    if (id) return harnessLabels.get(id) ?? id;
    // No harness for this config dir yet: name the folder, as the Add
    // control below does.
    return basename(row.session.configDir);
  };

  /** Apply one import call's results. `keyFor` maps a result id back to its
   *  row key. */
  const applyImportResults = (results: ImportResult[], keyFor: (id: string) => string): boolean => {
    const failed: Record<string, string> = {};
    const ok = new Set<string>();
    const now = Date.now();
    for (const result of results) {
      const key = keyFor(result.id);
      if (result.error || !result.taskId) failed[key] = result.error ?? "Import failed";
      else {
        ok.add(key);
        importedAtRef.current.set(key, now);
      }
    }
    if (Object.keys(failed).length > 0) {
      setRowError((prev) => ({ ...prev, ...failed }));
    }
    if (ok.size > 0) {
      setClaudeSessions((prev) => prev.filter((s) => !ok.has(claudeRowKey(s.sessionId))));
      setOpencodeSessions((prev) => prev.filter((s) => !ok.has(opencodeRowKey(s))));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const key of ok) next.delete(key);
        return next;
      });
    }
    return ok.size > 0;
  };

  const importClaude = async (ids: string[]): Promise<boolean> => {
    const res = await api.importClaudeSessions(ids);
    const missing = ids.filter((id) => !res.results.some((r) => r.id === id));
    return applyImportResults(
      [...res.results, ...missing.map((id) => ({ id, error: "Import failed" }))],
      claudeRowKey,
    );
  };

  const importOpencode = async (harnessId: string, ids: string[]): Promise<boolean> => {
    const res = await api.importOpencodeSessions(ids, harnessId);
    const missing = ids.filter((id) => !res.results.some((r) => r.id === id));
    return applyImportResults(
      [...res.results, ...missing.map((id) => ({ id, error: "Import failed" }))],
      (id) => opencodeRowKey({ harnessId, sessionId: id }),
    );
  };

  const importOne = async (row: Row) => {
    setBusyId(row.key);
    setRowError((prev) => omitKeys(prev, [row.key]));
    try {
      const imported = row.kind === "claude-code"
        ? await importClaude([row.session.sessionId])
        : await importOpencode(row.session.harnessId, [row.session.sessionId]);
      if (imported) onImported?.();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [row.key]: err instanceof ApiError ? err.message : "Import failed",
      }));
    } finally {
      setBusyId(null);
    }
  };

  const importSelected = async () => {
    const picked = rows.filter((row) => row.session.importable && selected.has(row.key));
    if (picked.length === 0) return;
    setBusyId("batch");
    setRowError((prev) => omitKeys(prev, picked.map((row) => row.key)));
    const claudeIds = picked.flatMap((row) => (row.kind === "claude-code" ? [row.session.sessionId] : []));
    const opencodeGroups = groupOpencodeImports(
      picked.flatMap((row) => (row.kind === "opencode" ? [row.session] : [])),
    );
    let importedAny = false;
    const failures: string[] = [];
    try {
      if (claudeIds.length > 0) {
        setClaudeError(null);
        try {
          if (await importClaude(claudeIds)) importedAny = true;
        } catch (err) {
          setClaudeError(err instanceof ApiError ? err.message : "Import failed");
        }
      }
      if (opencodeGroups.size > 0) setOpencodeError(null);
      // One call per harness, one after another: each import exports its
      // sessions through that harness's CLI.
      for (const [harnessId, ids] of opencodeGroups) {
        try {
          if (await importOpencode(harnessId, ids)) importedAny = true;
        } catch (err) {
          failures.push(err instanceof ApiError ? err.message : "Import failed");
        }
      }
      if (failures.length > 0) setOpencodeError([...new Set(failures)].join(" · "));
      if (importedAny) onImported?.();
    } finally {
      setBusyId(null);
    }
  };

  const addAccount = async (session: ClaudeSessionListItem) => {
    const account = accountFor(session);
    if (!account) return;
    const key = claudeRowKey(session.sessionId);
    setBusyId(key);
    setRowError((prev) => omitKeys(prev, [key]));
    try {
      const id = uniqueHarnessId(account.suggestedHarnessId, harnessIds);
      const label = `Claude (${account.email})`;
      await api.createHarness({
        id,
        kind: "claude-code",
        label,
        home: account.configDir,
        bin: null,
        env: {},
      });
      setHarnessIds((prev) => new Set([...prev, id]));
      setHarnessLabels((prev) => new Map(prev).set(id, label));
      setAccounts((prev) => prev.filter((row) => !sameDir(row.configDir, account.configDir)));
      // A plain list keeps the previous liveness cache. Unknown liveness
      // still disables Import after the harness exists. Re-check probes.
      await loadClaude(true);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [key]: err instanceof ApiError ? err.message : "Couldn't add this account",
      }));
    } finally {
      setBusyId(null);
    }
  };

  const checkout = async (session: ClaudeSessionListItem) => {
    const key = claudeRowKey(session.sessionId);
    setBusyId(key);
    try {
      const res = await api.checkoutClaudeSession(session.sessionId, session.gitBranch ?? undefined);
      if ("error" in res) {
        setRowError((prev) => ({ ...prev, [key]: res.error }));
        return;
      }
      setRowError((prev) => omitKeys(prev, [key]));
      await loadClaude(false);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [key]: err instanceof ApiError ? err.message : "Couldn't switch branch",
      }));
    } finally {
      setBusyId(null);
    }
  };

  const loading = claudeLoading || opencodeLoading;
  const allSelected = importableKeys.length > 0 && importableKeys.every((key) => selected.has(key));
  const selectedCount = importableKeys.filter((key) => selected.has(key)).length;
  const busy = busyId !== null;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(importableKeys));
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="import-claude-sessions-title" className="flex max-h-[85vh] w-full max-w-2xl flex-col p-0">
      <div data-testid="import-claude-sessions-dialog" className="contents">
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <h2 id="import-claude-sessions-title" className="text-sm font-semibold">
              Import sessions
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Claude Code and OpenCode sessions started outside Agetor
            </p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {claudeError && (
            <p className="mb-2 text-xs text-destructive" data-testid="import-sessions-error" data-kind="claude-code">
              Claude Code: {claudeError}
            </p>
          )}
          {opencodeError && (
            <p className="mb-2 text-xs text-destructive" data-testid="import-sessions-error" data-kind="opencode">
              OpenCode: {opencodeError}
            </p>
          )}
          {loading && rows.length === 0 && (
            <p className="text-xs text-muted-foreground">Looking for sessions…</p>
          )}
          {!loading && rows.length === 0 && !claudeError && !opencodeError && (
            <p className="text-xs text-muted-foreground">No sessions to import.</p>
          )}
          {importableKeys.length > 0 && (
            <label className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={allSelected}
                disabled={busy}
                data-testid="import-claude-sessions-select-all"
                onChange={toggleAll}
              />
              Select importable
            </label>
          )}
          <ul className="space-y-2">
            {rows.map((row) => {
              const blocked = rowBlockedCopy(row);
              const reason = rowError[row.key] ?? blocked;
              const warning = row.kind === "opencode" && !rowError[row.key] ? opencodeWarningCopy(row.session) : null;
              const title = row.session.title || "Untitled session";
              const activity = formatActivity(row.kind === "claude-code" ? row.session.lastActivity : row.session.updatedAt);
              return (
                <li
                  key={row.kind === "claude-code" ? `${row.session.configDir}:${row.session.sessionId}` : row.key}
                  data-testid="import-session-row"
                  data-kind={row.kind}
                  className="flex gap-2 rounded-md border border-border/60 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1 size-3.5 shrink-0 accent-primary disabled:opacity-40"
                    checked={selected.has(row.key)}
                    disabled={!row.session.importable || busy}
                    data-testid="import-claude-session-select"
                    aria-label={`Select ${title}`}
                    onChange={() => toggle(row.key)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-sm">{title}</div>
                      {row.kind === "claude-code" && row.session.liveness === "live" && (
                        <span
                          data-testid="import-claude-session-live"
                          className="shrink-0 rounded bg-warning/15 px-1 py-px text-[10px] font-medium text-warning"
                        >
                          Live
                        </span>
                      )}
                      <span
                        data-testid="import-sessions-harness"
                        className="max-w-[40%] shrink-0 truncate rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
                        title={row.kind === "claude-code" ? row.session.configDir : row.session.harnessId}
                      >
                        {harnessCell(row)}
                      </span>
                    </div>
                    {row.kind === "claude-code" ? (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        <span className="truncate">{basename(row.session.cwd)}</span>
                        {row.session.gitBranch ? ` · ${row.session.gitBranch}` : ""}
                        {row.session.branchMismatch && row.session.liveBranch ? ` (folder is on ${row.session.liveBranch})` : ""}
                        {row.session.model ? (
                          <span data-testid="import-claude-session-model">{` · ${row.session.model}`}</span>
                        ) : null}
                        {activity ? (
                          <span data-testid="import-claude-session-activity">{` · ${activity}`}</span>
                        ) : null}
                        {` · ${row.session.messageCount} messages`}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-[11px] text-muted-foreground" title={row.session.directory}>
                        <span className="truncate">{basename(row.session.directory)}</span>
                        {activity ? (
                          <span data-testid="import-claude-session-activity">{` · ${activity}`}</span>
                        ) : null}
                      </div>
                    )}
                    {reason && (
                      <p className="mt-1 text-[11px] text-warning" data-testid="import-claude-session-reason">
                        {reason}
                      </p>
                    )}
                    {warning && (
                      <p className="mt-1 text-[11px] text-warning" data-testid="import-session-warning">
                        {warning}
                      </p>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        disabled={!row.session.importable || busy}
                        title={blocked ?? undefined}
                        onClick={() => void importOne(row)}
                      >
                        Import
                      </Button>
                      {row.kind === "claude-code" && row.session.branchMismatch && row.session.gitBranch && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="import-claude-session-switch"
                          disabled={busy || row.session.liveness === "live" || row.session.blockedReason === "live"}
                          title={row.session.liveness === "live" || row.session.blockedReason === "live"
                            ? (row.session.liveHint ?? "Close it in your terminal first")
                            : undefined}
                          onClick={() => void checkout(row.session)}
                        >
                          Switch to {row.session.gitBranch}
                        </Button>
                      )}
                      {row.kind === "claude-code" && row.session.blockedReason === "no-harness" && accountFor(row.session) && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="import-claude-session-add"
                          disabled={busy}
                          onClick={() => void addAccount(row.session)}
                        >
                          Add
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="flex items-center justify-between border-t border-border/60 px-4 py-3">
          <Button
            size="sm"
            data-testid="import-claude-sessions-import-selected"
            disabled={busy || selectedCount === 0}
            onClick={() => void importSelected()}
          >
            {selectedCount > 0 ? `Import selected (${selectedCount})` : "Import selected"}
          </Button>
          <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => void recheckAll()}>
            Re-check
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
