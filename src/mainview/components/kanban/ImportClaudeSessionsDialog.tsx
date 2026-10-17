import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError, type ClaudeSessionListItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { LONG_PATH_IMPORT_ERROR } from "../../../shared/claude-session-meta.ts";
import type { DiscoveredAccount } from "../../../shared/types.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after at least one session was imported, so the board can refresh. */
  onImported?: () => void;
}

function blockedCopy(session: ClaudeSessionListItem): string | null {
  if (session.importable) return null;
  if (session.blockedReason === "long-path") return LONG_PATH_IMPORT_ERROR;
  if (session.blockedReason === "live") return session.liveHint ?? "Close it in your terminal first";
  if (session.blockedReason === "no-harness") return "Account isn't set up in Agetor — Add it to import";
  if (session.liveness === "unknown") return "Couldn't tell if this session is still open — Re-check";
  return "This session can't be imported";
}

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

export function ImportClaudeSessionsDialog({ open, onClose, onImported }: Props) {
  const [sessions, setSessions] = useState<ClaudeSessionListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [harnessIds, setHarnessIds] = useState<Set<string>>(new Set());

  const load = useCallback(async (recheck: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = recheck ? await api.recheckClaudeSessions() : await api.listClaudeSessions();
      setSessions(res.sessions);
      // A fresh probe replaces row errors. Keeping them would hide the new
      // blocked reason (or a now-importable row) behind the previous failure.
      if (recheck) setRowError({});
      const importable = new Set(res.sessions.filter((s) => s.importable).map((s) => s.sessionId));
      setSelected((prev) => new Set([...prev].filter((id) => importable.has(id))));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't list Claude Code sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load(false);
    let cancelled = false;
    void Promise.all([api.discoverAccounts(), api.listHarnesses()])
      .then(([discovered, listed]) => {
        if (cancelled) return;
        setAccounts(discovered.accounts);
        setHarnessIds(new Set(listed.harnesses.map((h) => h.id)));
      })
      .catch(() => { /* the row stays without an Add control */ });
    return () => { cancelled = true; };
  }, [open, load]);

  const accountFor = (session: ClaudeSessionListItem) =>
    accounts.find((account) => sameDir(account.configDir, session.configDir)) ?? null;

  const applyImportResults = (results: { id: string; taskId?: string; error?: string }[]) => {
    const failed: Record<string, string> = {};
    const ok = new Set<string>();
    for (const row of results) {
      if (row.error || !row.taskId) failed[row.id] = row.error ?? "Import failed";
      else ok.add(row.id);
    }
    if (Object.keys(failed).length > 0) {
      setRowError((prev) => ({ ...prev, ...failed }));
    }
    if (ok.size > 0) {
      setSessions((prev) => prev.filter((s) => !ok.has(s.sessionId)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ok) next.delete(id);
        return next;
      });
      onImported?.();
    }
  };

  const importOne = async (session: ClaudeSessionListItem) => {
    setBusyId(session.sessionId);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[session.sessionId];
      return next;
    });
    try {
      const res = await api.importClaudeSessions([session.sessionId]);
      const row = res.results[0];
      if (!row) {
        setRowError((prev) => ({ ...prev, [session.sessionId]: "Import failed" }));
        return;
      }
      applyImportResults([row]);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [session.sessionId]: err instanceof ApiError ? err.message : "Import failed",
      }));
    } finally {
      setBusyId(null);
    }
  };

  const importSelected = async () => {
    const ids = sessions.filter((s) => s.importable && selected.has(s.sessionId)).map((s) => s.sessionId);
    if (ids.length === 0) return;
    setBusyId("batch");
    setRowError((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    try {
      const res = await api.importClaudeSessions(ids);
      applyImportResults(res.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusyId(null);
    }
  };

  const addAccount = async (session: ClaudeSessionListItem) => {
    const account = accountFor(session);
    if (!account) return;
    setBusyId(session.sessionId);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[session.sessionId];
      return next;
    });
    try {
      const id = uniqueHarnessId(account.suggestedHarnessId, harnessIds);
      await api.createHarness({
        id,
        kind: "claude-code",
        label: `Claude (${account.email})`,
        home: account.configDir,
        bin: null,
        env: {},
      });
      setHarnessIds((prev) => new Set([...prev, id]));
      setAccounts((prev) => prev.filter((row) => !sameDir(row.configDir, account.configDir)));
      // A plain list keeps the previous liveness cache. Unknown liveness
      // still disables Import after the harness exists. Re-check probes.
      await load(true);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [session.sessionId]: err instanceof ApiError ? err.message : "Couldn't add this account",
      }));
    } finally {
      setBusyId(null);
    }
  };

  const checkout = async (session: ClaudeSessionListItem) => {
    setBusyId(session.sessionId);
    try {
      const res = await api.checkoutClaudeSession(session.sessionId);
      if ("error" in res) {
        setRowError((prev) => ({ ...prev, [session.sessionId]: res.error }));
        return;
      }
      setRowError((prev) => {
        if (!(session.sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[session.sessionId];
        return next;
      });
      await load(false);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [session.sessionId]: err instanceof ApiError ? err.message : "Couldn't switch branch",
      }));
    } finally {
      setBusyId(null);
    }
  };

  const importableIds = sessions.filter((s) => s.importable).map((s) => s.sessionId);
  const allSelected = importableIds.length > 0 && importableIds.every((id) => selected.has(id));
  const selectedCount = importableIds.filter((id) => selected.has(id)).length;
  const busy = busyId !== null;

  const toggle = (sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(importableIds));
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="import-claude-sessions-title" className="flex max-h-[85vh] w-full max-w-2xl flex-col p-0">
      <div data-testid="import-claude-sessions-dialog" className="contents">
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 id="import-claude-sessions-title" className="text-sm font-semibold">
            Import Claude Code sessions
          </h2>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          {loading && sessions.length === 0 && (
            <p className="text-xs text-muted-foreground">Looking for sessions…</p>
          )}
          {!loading && sessions.length === 0 && !error && (
            <p className="text-xs text-muted-foreground">No Claude Code sessions to import.</p>
          )}
          {importableIds.length > 0 && (
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
            {sessions.map((session) => {
              const reason = rowError[session.sessionId] ?? blockedCopy(session);
              const activity = formatActivity(session.lastActivity);
              return (
                <li key={`${session.configDir}:${session.sessionId}`} className="flex gap-2 rounded-md border border-border/60 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-3.5 shrink-0 accent-primary disabled:opacity-40"
                    checked={selected.has(session.sessionId)}
                    disabled={!session.importable || busy}
                    data-testid="import-claude-session-select"
                    aria-label={`Select ${session.title || "Untitled session"}`}
                    onChange={() => toggle(session.sessionId)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 truncate text-sm">{session.title || "Untitled session"}</div>
                      {session.liveness === "live" && (
                        <span
                          data-testid="import-claude-session-live"
                          className="shrink-0 rounded bg-warning/15 px-1 py-px text-[10px] font-medium text-warning"
                        >
                          Live
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      <span className="truncate">{basename(session.cwd)}</span>
                      {session.gitBranch ? ` · ${session.gitBranch}` : ""}
                      {session.branchMismatch && session.liveBranch ? ` (folder is on ${session.liveBranch})` : ""}
                      {session.model ? (
                        <span data-testid="import-claude-session-model">{` · ${session.model}`}</span>
                      ) : null}
                      {activity ? (
                        <span data-testid="import-claude-session-activity">{` · ${activity}`}</span>
                      ) : null}
                      {` · ${session.messageCount} messages`}
                    </div>
                    {reason && (
                      <p className="mt-1 text-[11px] text-warning" data-testid="import-claude-session-reason">
                        {reason}
                      </p>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        disabled={!session.importable || busy}
                        title={blockedCopy(session) ?? undefined}
                        onClick={() => void importOne(session)}
                      >
                        Import
                      </Button>
                      {session.branchMismatch && session.gitBranch && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="import-claude-session-switch"
                          disabled={busy || session.liveness === "live" || session.blockedReason === "live"}
                          title={session.liveness === "live" || session.blockedReason === "live"
                            ? (session.liveHint ?? "Close it in your terminal first")
                            : undefined}
                          onClick={() => void checkout(session)}
                        >
                          Switch to {session.gitBranch}
                        </Button>
                      )}
                      {session.blockedReason === "no-harness" && accountFor(session) && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="import-claude-session-add"
                          disabled={busy}
                          onClick={() => void addAccount(session)}
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
          <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => void load(true)}>
            Re-check
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
