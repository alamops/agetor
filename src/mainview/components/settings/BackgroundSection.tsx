import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { BackgroundStatus } from "../../../shared/types.ts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { backgroundCopy, subscribeBackgroundStatus } from "@/lib/background";

/** How often the section re-reads `GET /background` while mounted. The
 *  `background_changed` event covers most changes; this catches the ones no
 *  event announces (the user flipping Login Items in System Settings, the
 *  supervisor crashing). */
const POLL_MS = 5000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Settings → General → "Keep Agetor running in the background"
 * (docs/plans/always-on-host.md §3.5, grill C9). A macOS login item keeps a
 * small background core alive so tasks survive quitting the app; this section
 * is its switch, its state line and the remote-access (preview) row. macOS is
 * the source of truth for the registration — the section only reads the
 * derived `BackgroundStatus` and asks the core to change it.
 */
export function BackgroundSection() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Newest-wins guard: a slow poll answer that lands after a mutation's
  // answer (or a newer event) must not put the older state back on screen.
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const apply = useCallback((next: BackgroundStatus) => {
    seqRef.current += 1;
    setStatus(next);
    setError(null);
  }, []);

  const load = useCallback(async (opts?: { fresh?: boolean }) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const seq = seqRef.current;
    try {
      const next = await api.getBackground(opts);
      if (!mountedRef.current || seq !== seqRef.current) return;
      setStatus(next);
      setError(null);
    } catch (e) {
      if (mountedRef.current && seq === seqRef.current) setError(errorText(e));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    const unsubscribe = subscribeBackgroundStatus((next) => {
      if (mountedRef.current) apply(next);
    });
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [load, apply]);

  const mutate = async (run: () => Promise<BackgroundStatus | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      if (!mountedRef.current) return;
      if (next) apply(next);
      else await load({ fresh: true });
    } catch (e) {
      if (mountedRef.current) setError(errorText(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const onToggle = async (on: boolean) => {
    if (!status) return;
    if (!on && status.remoteAccess) {
      const ok = await confirm({
        title: "Turn off background mode?",
        description: "This also turns off remote access.",
        confirmLabel: "Turn off",
        cancelLabel: "Keep on",
        variant: "destructive",
      });
      if (!ok) return;
    }
    await mutate(() => (on ? api.turnOnBackground() : api.turnOffBackground()));
  };

  const copy = status ? backgroundCopy(status) : null;
  const unavailable = status?.state === "unavailable";

  return (
    <section className="space-y-1" data-testid="background-section">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="background-toggle" className="text-xs text-muted-foreground">
          Keep Agetor running in the background
        </label>
        <Switch
          id="background-toggle"
          data-testid="background-toggle"
          checked={copy?.toggleChecked ?? false}
          disabled={!copy || !copy.toggleEnabled || busy}
          onCheckedChange={(on) => { void onToggle(on); }}
          aria-label="Keep Agetor running in the background"
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Tasks keep running after you quit the app. Agetor adds itself to your Login Items so a small background core can take over.
      </p>

      <p
        data-testid="background-state"
        className={status?.state === "needs-approval" ? "text-xs text-warning" : "text-xs text-foreground"}
        role="status"
        aria-live="polite"
      >
        {copy ? (unavailable ? "Unavailable" : copy.label) : "Checking…"}
      </p>
      {copy && unavailable && (
        <p data-testid="background-unavailable" className="text-[11px] text-muted-foreground">
          {copy.label}
          {copy.detail ? ` — ${copy.detail}` : ""}
        </p>
      )}
      {copy && !unavailable && copy.detail && (
        <p className="text-[11px] text-muted-foreground">{copy.detail}</p>
      )}
      {copy && copy.actions.length > 0 && (
        <div className="flex gap-2 pt-1">
          {copy.actions.includes("open-login-items") && (
            <Button
              size="sm"
              variant="outline"
              data-testid="background-open-login-items"
              disabled={busy}
              onClick={() => { void mutate(async () => { await api.openLoginItems(); }); }}
            >
              Open Login Items
            </Button>
          )}
          {copy.actions.includes("start-now") && (
            <Button
              size="sm"
              variant="outline"
              data-testid="background-start-now"
              disabled={busy}
              onClick={() => { void mutate(() => api.startBackground()); }}
            >
              Start now
            </Button>
          )}
        </div>
      )}
      {error && (
        <p data-testid="background-error" className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}

      {status && (
        <div className="mt-2 flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Remote access (preview)</div>
            <div
              data-testid="remote-access-state"
              data-enabled={status.remoteAccess ? "true" : "false"}
              className="text-[11px] text-muted-foreground"
            >
              {status.remoteAccess
                ? "On — nothing can pair with this Mac yet"
                : "Off. Turn it on from Agetor › Remote Access…"}
            </div>
          </div>
          {status.remoteAccess && (
            <Button
              size="sm"
              variant="outline"
              data-testid="remote-access-turn-off"
              disabled={busy}
              onClick={() => { void mutate(() => api.turnOffRemoteAccess().then(() => api.getBackground({ fresh: true }))); }}
            >
              Turn off
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
