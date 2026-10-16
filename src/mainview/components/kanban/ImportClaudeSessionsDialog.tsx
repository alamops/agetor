import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError, type ClaudeSessionListItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { LONG_PATH_IMPORT_ERROR } from "../../../shared/claude-session-meta.ts";

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

export function ImportClaudeSessionsDialog({ open, onClose, onImported }: Props) {
  const [sessions, setSessions] = useState<ClaudeSessionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async (recheck: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = recheck ? await api.recheckClaudeSessions() : await api.listClaudeSessions();
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't list Claude Code sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load(false);
  }, [open, load]);

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
      if (row?.error || !row?.taskId) {
        setRowError((prev) => ({ ...prev, [session.sessionId]: row?.error ?? "Import failed" }));
        return;
      }
      setSessions((prev) => prev.filter((s) => s.sessionId !== session.sessionId));
      onImported?.();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [session.sessionId]: err instanceof ApiError ? err.message : "Import failed",
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

  return (
    <Dialog open={open} onClose={onClose} labelledBy="import-claude-sessions-title" className="flex max-h-[85vh] w-full max-w-lg flex-col p-0">
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
          <ul className="space-y-2">
            {sessions.map((session) => {
              const reason = rowError[session.sessionId] ?? blockedCopy(session);
              return (
                <li key={`${session.configDir}:${session.sessionId}`} className="rounded-md border border-border/60 px-3 py-2">
                  <div className="truncate text-sm">{session.title || "Untitled session"}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {basename(session.cwd)}
                    {session.gitBranch ? ` · ${session.gitBranch}` : ""}
                    {session.branchMismatch && session.liveBranch ? ` (folder is on ${session.liveBranch})` : ""}
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
                      disabled={!session.importable || busyId === session.sessionId}
                      title={blockedCopy(session) ?? undefined}
                      onClick={() => void importOne(session)}
                    >
                      Import
                    </Button>
                    {session.gitBranch && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === session.sessionId}
                        onClick={() => void checkout(session)}
                      >
                        Switch to {session.gitBranch}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="flex justify-end border-t border-border/60 px-4 py-3">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(true)}>
            Re-check
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
