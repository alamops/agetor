import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useFontSize } from "../font-size-provider.tsx";
import { useTheme } from "../theme-provider.tsx";
import { terminalFontSize } from "@/lib/font-size";
import { macEditSequence } from "./terminal-keys.ts";
import type { TerminalTab } from "../../../shared/types.ts";
import type { ITheme } from "@xterm/xterm";

/**
 * xterm renders to its own canvas and can't read CSS custom properties, so it
 * needs a real parallel palette per resolved theme rather than tokens.
 *
 * Dark tuned to the app's dark zinc palette (`.dark` block in index.css):
 * background matches `--background` (240 10% 3.9% = #09090b, zinc-950),
 * foreground approximates zinc-200.
 */
const XTERM_THEME_DARK: ITheme = {
  background: "#09090b", // zinc-950, matches --background
  foreground: "#e4e4e7", // zinc-200
  cursor: "#e4e4e7",
  // xterm's DOM renderer paints the cursor cell as `background: cursor;
  // color: cursorAccent`, and defaults cursorAccent to black when unset.
  // Setting it explicitly (rather than relying on the default happening to
  // match) keeps the glyph under the block cursor legible: #09090b is this
  // theme's own background, so it's the same relationship as normal text
  // (foreground-on-background) just inverted for the cursor cell — ~15.7:1
  // against `cursor` (#e4e4e7).
  cursorAccent: "#09090b",
  selectionBackground: "#3f3f46",
};

/**
 * Light palette derived from index.css's `:root` block: `--background`
 * (0 0% 100%) is white, `--foreground` (240 10% 3.9%) converts to #09090b —
 * the same near-black used as the *dark* theme's background, which is the
 * expected mirror-image relationship between the two palettes. Cursor
 * matches foreground (same pattern as the dark theme). selectionBackground
 * isn't a CSS token (xterm has no equivalent to read), so it's set to
 * Tailwind's zinc-300 (#d4d4d8) — enough contrast to be obvious against
 * white without obscuring the selected text (foreground stays #09090b).
 *
 * `white`/`brightWhite` are the only default ANSI colors overridden: xterm's
 * built-in Tango-ish palette uses #d3d7cf/#eeeeec for those two, which are
 * both light grays with <1.5:1 contrast against a white background —
 * genuinely unreadable, not just dim. The other 14 default ANSI colors were
 * checked against #ffffff and, while some (yellow, green, cyan) are dimmer
 * than ideal (~2.5-3.5:1), they remain legible, so they're left as xterm
 * defaults rather than replaced with a hand-built 16-color palette.
 */
const XTERM_THEME_LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#09090b",
  cursor: "#09090b",
  // Without this, xterm defaults cursorAccent (the glyph color painted under
  // the block cursor) to black — indistinguishable from this theme's
  // near-black `cursor` (#09090b), so the character under a blinking cursor
  // measured ~1.05:1 and was effectively invisible. #ffffff is this theme's
  // own background, mirroring the dark theme's choice below; contrast
  // against `cursor` is ~19.9:1.
  cursorAccent: "#ffffff",
  selectionBackground: "#d4d4d8",
  white: "#52525b", // zinc-600 — default #d3d7cf is ~1.5:1 on white, unreadable
  brightWhite: "#18181b", // zinc-900 — default #eeeeec is ~1.1:1 on white, unreadable
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
  // Mirrors the mount effect's local `ws` so the font-size reactivity effect
  // below can send a resize frame after a live refit without needing its own
  // WebSocket plumbing.
  const wsRef = useRef<WebSocket | null>(null);
  const { resolved } = useTheme();
  const { percent: fontSizePercent } = useFontSize();
  // Read via a ref inside the mount effect below so the effect's own
  // dependency array doesn't need `resolved` — recreating the terminal (and
  // its WebSocket) on every theme flip would drop the connection. The
  // separate effect further down re-applies the theme in place instead.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  // Same pattern for font size — the mount effect must not depend on
  // `fontSizePercent`, or every Cmd+=/− would tear down and reconnect the
  // WebSocket. The reactivity effect below re-applies it to the live
  // instance instead.
  const fontSizePercentRef = useRef(fontSizePercent);
  fontSizePercentRef.current = fontSizePercent;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontSize: terminalFontSize(fontSizePercentRef.current),
      cursorBlink: true,
      theme: resolvedRef.current === "light" ? XTERM_THEME_LIGHT : XTERM_THEME_DARK,
      scrollback: 5000,
      // Treat the macOS Option key as Meta so Alt-prefixed bindings work
      // (Opt+B/Opt+F word nav, Opt+D kill-word, Opt+. last-arg, etc.). Without
      // this, the webview emits the OS-composed glyph (Opt+B → "∫") instead of
      // the ESC-prefixed sequence readline/zsh expect, so those commands no-op.
      // This is the same behavior as iTerm2/Terminal.app "Use Option as Meta".
      // On Windows/Linux xterm already maps Alt→Meta, so this is a no-op there.
      macOptionIsMeta: true,
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
      wsRef.current = sock;
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
          // SGR 2 (faint) rather than a fixed ANSI color code (was 90,
          // bright-black): faint dims the terminal's own theme-tuned
          // foreground instead of a hardcoded gray, so it stays legible
          // without needing a light/dark-specific escape sequence.
          term.write("\r\n\x1b[2m[disconnected — reconnecting…]\x1b[22m\r\n");
          reconnectTimer = setTimeout(connect, 1000);
        } else {
          term.write("\r\n\x1b[2m[disconnected]\x1b[22m\r\n");
        }
      };
    };
    connect();

    const dataSub = term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });

    // macOS word/line editing shortcuts (⌥/⌘ + arrows/backspace/delete),
    // matching VS Code's terminal. See macEditSequence for the mapping + why
    // xterm's defaults don't work here.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const seq = macEditSequence(e);
      if (!seq) return true;
      e.preventDefault(); // keep the webview from also acting on the combo
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(seq));
      return false; // handled — don't let xterm emit its own variant
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
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, onExit]);

  // Re-apply the xterm theme in place when the resolved theme changes, so an
  // already-open terminal repaints without remounting (which would tear down
  // and reconnect its WebSocket). xterm exposes `options.theme` as settable
  // on a live instance for exactly this.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolved === "light" ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
  }, [resolved]);

  // Re-apply the xterm font size in place when the whole-app font-size
  // preference changes (Cmd+=/−/0 — see FontSizeProvider), so an already-open
  // terminal rescales without remounting (which would drop its WebSocket).
  // Changing glyph cell size changes cols/rows, so a refit + PTY resize
  // notification must follow — same sequence the ResizeObserver callback in
  // the mount effect above uses for a host-size change. The fit + resize are
  // deferred one frame via rAF: `term.options.fontSize` writes synchronously,
  // but FontSizeProvider's own effect (a sibling, mounted higher up the
  // tree) hasn't necessarily written the new `documentElement.style.fontSize`
  // yet when *this* effect runs — React flushes child effects before parent
  // effects, but siblings run in tree order, and this component doesn't
  // control which mounts first. Fitting synchronously here could measure the
  // host box before the root rem size (and therefore the host's pixel size)
  // has actually changed, shipping stale cols/rows to the PTY. One rAF is
  // enough since the root font-size write happens in a plain effect, which
  // (like this one) resolves before the next paint.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalFontSize(fontSizePercent);
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* not visible yet */ }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [fontSizePercent]);

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

      <div className="relative min-h-0 flex-1 bg-background">
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
