import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { TerminalTab } from "../../../shared/types.ts";

/** xterm theme tuned to the app's dark zinc palette. */
const XTERM_THEME = {
  background: "#09090b", // zinc-950, matches --background
  foreground: "#e4e4e7", // zinc-200
  cursor: "#e4e4e7",
  selectionBackground: "#3f3f46",
};

/**
 * One xterm.js instance bound to a backend PTY over a WebSocket. The PTY is the
 * source of truth and lives on the bun side even when this component unmounts;
 * on (re)mount the server replays its ring buffer so scrollback is restored.
 *
 * All open panes stay mounted (positioned absolutely so each always has the
 * container's real size — `display:none` would zero the size and break fit()).
 * Only the active one is visible; the rest keep streaming in the background.
 */
function TerminalPane({
  terminalId,
  visible,
  onExit,
}: {
  terminalId: string;
  visible: boolean;
  /** Called when the backend reports the shell exited, so the tab can be
   *  removed (the PTY is gone server-side — reconnecting would be pointless). */
  onExit: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontSize: 12,
      cursorBlink: true,
      theme: XTERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* host may be 0-size on first paint */ }

    const enc = new TextEncoder();
    let ws: WebSocket | null = null;
    // `disposed` guards against reconnecting after unmount OR after a real
    // server-side exit (both terminal); `attempts` bounds the retry loop.
    let disposed = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const sendResize = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    const connect = () => {
      const sock = new WebSocket(api.terminalSocketUrl(terminalId));
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onopen = () => { attempts = 0; sendResize(); };
      sock.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Control frame (currently only "exit").
          try {
            const msg = JSON.parse(ev.data) as { t?: string; code?: number | null };
            if (msg.t === "exit") {
              disposed = true; // server-side exit — don't reconnect
              onExit(terminalId);
            }
          } catch { /* ignore */ }
          return;
        }
        term.write(new Uint8Array(ev.data));
      };
      sock.onclose = () => {
        if (disposed) return;
        // Unexpected drop while the PTY may still be alive (e.g. dev-server
        // restart). The server replays its ring buffer on reattach, so a
        // bounded reconnect restores the session instead of freezing silently.
        if (attempts < 3) {
          attempts++;
          term.write("\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m\r\n");
          reconnectTimer = setTimeout(connect, 1000);
        } else {
          term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
        }
      };
    };
    connect();

    const dataSub = term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* not visible yet */ }
      sendResize();
    });
    ro.observe(host);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      dataSub.dispose();
      ro.disconnect();
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, onExit]);

  // Refit + focus when this pane becomes the active one (its size is stable
  // because the host is absolutely positioned, but the fit on a freshly-shown
  // pane keeps cols/rows exact).
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  return (
    <div
      ref={hostRef}
      className={cn(
        "absolute inset-0 p-1",
        visible ? "z-10 opacity-100" : "-z-10 opacity-0 pointer-events-none",
      )}
    />
  );
}

/**
 * Terminal tab strip + the active terminal, for the task details sidebar.
 * Tabs are backed by per-task PTYs on the bun side (`src/bun/terminals.ts`).
 */
export function TerminalView({ taskId }: { taskId: string }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTerminals(taskId);
      setTabs(list);
      setActiveId((cur) => {
        if (cur && list.some((t) => t.id === cur)) return cur;
        return list.length ? list[list.length - 1]!.id : null;
      });
    } catch { /* transient — the 2s task poll keeps the badge honest */ }
  }, [taskId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Drop a tab locally (its pane unmounts → WebSocket closes). Stable identity
  // so it can be a TerminalPane effect dep without re-running on every render.
  const removeTab = useCallback((id: string) => {
    setTabs((cur) => cur.filter((t) => t.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const openTerminal = useCallback(async () => {
    setBusy(true);
    try {
      const tab = await api.createTerminal(taskId);
      setTabs((cur) => [...cur, tab]);
      setActiveId(tab.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not open terminal");
    } finally {
      setBusy(false);
    }
  }, [taskId]);

  const closeTab = useCallback(async (id: string) => {
    // Optimistic: drop locally first so the pane unmounts before the round-trip.
    removeTab(id);
    try { await api.closeTerminal(id); } catch { /* best-effort */ }
  }, [removeTab]);

  // Keep an active selection as tabs change.
  useEffect(() => {
    if (!activeId && tabs.length) setActiveId(tabs[tabs.length - 1]!.id);
  }, [tabs, activeId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border/60 px-1 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={cn(
                "group flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px]",
                t.id === activeId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/40",
              )}
            >
              <button type="button" className="flex items-center gap-1" onClick={() => setActiveId(t.id)}>
                <TerminalSquare className="size-3" />
                {t.title}
              </button>
              <button
                type="button"
                className="rounded p-0.5 opacity-60 hover:bg-destructive/20 hover:opacity-100"
                title="Close terminal"
                onClick={() => void closeTab(t.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
          title="New terminal"
          disabled={busy}
          onClick={() => void openTerminal()}
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-[#09090b]">
        {tabs.length === 0 ? (
          <button
            type="button"
            className="flex h-full w-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={() => void openTerminal()}
          >
            <TerminalSquare className="size-6" />
            <span>Open a terminal in this task's worktree</span>
          </button>
        ) : (
          tabs.map((t) => (
            <TerminalPane
              key={t.id}
              terminalId={t.id}
              visible={t.id === activeId}
              onExit={removeTab}
            />
          ))
        )}
      </div>
    </div>
  );
}
