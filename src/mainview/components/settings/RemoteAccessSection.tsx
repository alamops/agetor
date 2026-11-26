import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { RemoteDevicesResult, RemoteLogResult } from "../../../shared/remote-types.ts";
import type { RemoteAccessStatus } from "../../../shared/types.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  MAC_NAME_MAX,
  deviceRowView,
  logRowView,
  macNameProblem,
  remoteSectionVisible,
  subscribeRemoteChanged,
} from "@/lib/remote-access-store";
import { subscribeBackgroundStatus } from "@/lib/background";

const POLL_MS = 10_000;
const LOG_PAGE = 20;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What the view draws. The container below owns fetching; this takes plain data so a static render can pin the markup. */
export interface RemoteAccessViewProps {
  status: RemoteAccessStatus;
  devices: RemoteDevicesResult["devices"];
  log: RemoteLogResult | null;
  nameDraft: string;
  busy: boolean;
  error: string | null;
  now?: number;
  onNameChange(v: string): void;
  onNameSave(): void;
  onRevoke(id: string, name: string): void;
  onRevokeAll(): void;
  onMoreLog(): void;
}

export function RemoteAccessView(p: RemoteAccessViewProps) {
  const nameProblem = macNameProblem(p.nameDraft);
  const nameDirty = p.nameDraft.trim() !== p.status.macName;
  const rows = p.devices.map((d) => deviceRowView(d, p.now));
  return (
    <section className="space-y-3" data-testid="remote-access-section">
      <div className="space-y-0.5">
        <div className="text-xs text-muted-foreground">Remote access</div>
        <div
          data-testid="remote-access-switch-state"
          data-enabled={p.status.enabled ? "true" : "false"}
          className="text-2xs text-muted-foreground"
        >
          {p.status.enabled ? "On. Phones you paired can reach this Mac." : "Off. Turn it on from Agetor › Remote Access…"}
        </div>
        <div data-testid="remote-access-relay" className="text-2xs text-muted-foreground">
          {p.status.relay.url ? `Relay: ${p.status.relay.url} (${p.status.relay.state})` : "No relay configured"}
        </div>
        {p.status.bindWarning && (
          <p data-testid="remote-access-bind-warning" className="text-2xs text-warning" role="alert">
            {p.status.bindWarning}
          </p>
        )}
      </div>

      <Field controlId="remote-mac-name">
        <FieldLabel>This Mac's name</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id="remote-mac-name"
            data-testid="remote-mac-name"
            value={p.nameDraft}
            maxLength={MAC_NAME_MAX * 2}
            aria-invalid={nameProblem !== null}
            onChange={(e) => p.onNameChange(e.target.value)}
          />
          <Button size="sm" variant="outline" data-testid="remote-mac-name-save" disabled={p.busy || nameProblem !== null || !nameDirty} onClick={p.onNameSave}>
            Save
          </Button>
        </div>
        <FieldDescription>{nameProblem ?? "Phones show this name for your Mac."}</FieldDescription>
      </Field>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Paired phones</div>
        {rows.length === 0 ? (
          <p data-testid="remote-devices-empty" className="text-2xs text-muted-foreground">
            No phones are paired. Pair a phone from the menu bar: Agetor › Pair a Phone…
          </p>
        ) : (
          <ul className="space-y-1" data-testid="remote-devices">
            {rows.map((r) => (
              <li key={r.id} data-testid={`remote-device-${r.id}`} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  {/* A phone supplies its name: rendered as plain text, never as markup. */}
                  <div className="truncate text-xs text-foreground" data-testid="remote-device-name">{r.name}</div>
                  <div className="text-2xs text-muted-foreground">
                    {r.platform} · {r.level} · {r.lastSeen}
                    {r.online ? " · connected now" : ""}
                  </div>
                  {r.notTrusted && (
                    <div className="text-2xs text-danger" data-testid="remote-device-not-trusted">{r.notTrusted}</div>
                  )}
                </div>
                {r.canRevoke && (
                  <Button size="sm" variant="outline" data-testid={`remote-device-revoke-${r.id}`} disabled={p.busy} onClick={() => p.onRevoke(r.id, r.name)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {rows.some((r) => r.canRevoke) && (
          <Button size="sm" variant="outline" data-testid="remote-revoke-all" disabled={p.busy} onClick={p.onRevokeAll}>
            Revoke all
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Activity</div>
        {p.log === null ? (
          <p className="text-2xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p
              data-testid="remote-log-chain"
              data-ok={p.log.chain.ok ? "true" : "false"}
              className={p.log.chain.ok ? "text-2xs text-muted-foreground" : "text-2xs text-danger"}
              role="status"
            >
              {p.log.chain.ok ? "The log is intact." : `The log was altered at entry ${p.log.chain.firstBadSeq}.`}
            </p>
            <ul className="space-y-0.5" data-testid="remote-log">
              {p.log.rows.map((r) => {
                const v = logRowView(r, p.devices);
                return (
                  <li key={r.seq} data-testid={`remote-log-row-${r.seq}`} className="text-2xs text-muted-foreground">
                    <span className="text-foreground">{v.text}</span> · {v.when}
                    {v.outcomeUnknown && <span className="text-warning" data-testid="remote-log-unknown"> · outcome unknown (the Mac stopped before it finished)</span>}
                  </li>
                );
              })}
            </ul>
            {p.log.nextBeforeSeq !== null && (
              <Button size="sm" variant="outline" data-testid="remote-log-more" disabled={p.busy} onClick={p.onMoreLog}>
                Show older
              </Button>
            )}
          </>
        )}
      </div>

      <p data-testid="remote-pair-hint" className="text-2xs text-muted-foreground">
        Pair a phone from the menu bar: Agetor › Pair a Phone…. Pairing happens in a native window, never from here.
      </p>
      {p.error && (
        <p data-testid="remote-access-error" className="text-2xs text-danger" role="alert">
          {p.error}
        </p>
      )}
    </section>
  );
}

/**
 * Settings → Remote access (docs/architecture/remote-gateway.md). Hidden in a build without the Companion. It only reads, revokes and
 * turns remote access off; pairing and turning it on belong to the app's native windows, so there is no button for either.
 */
export function RemoteAccessSection() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevicesResult["devices"]>([]);
  const [log, setLog] = useState<RemoteLogResult | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const nameTouchedRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const s = await api.getRemoteAccess();
      if (!mountedRef.current) return;
      setStatus(s);
      if (!nameTouchedRef.current) setNameDraft(s.macName);
      if (!s.companion) return;
      const [d, l] = await Promise.all([api.getRemoteDevices(), api.getRemoteLog({ limit: LOG_PAGE })]);
      if (!mountedRef.current) return;
      setDevices(d.devices);
      setLog(l);
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(errorText(e));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    // The existing app-event stream (forwarded by App.tsx), never a stream of its own.
    const offRemote = subscribeRemoteChanged(() => { void load(); });
    const offBackground = subscribeBackgroundStatus(() => { void load(); });
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      offRemote();
      offBackground();
    };
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      if (mountedRef.current) setError(errorText(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  if (!remoteSectionVisible(status) || status === null) return null;

  return (
    <RemoteAccessView
      status={status}
      devices={devices}
      log={log}
      nameDraft={nameDraft}
      busy={busy}
      error={error}
      onNameChange={(v) => {
        nameTouchedRef.current = true;
        setNameDraft(v);
      }}
      onNameSave={() => {
        void run(async () => {
          await api.setMacName(nameDraft.trim());
          nameTouchedRef.current = false;
        });
      }}
      onRevoke={(id, name) => {
        void (async () => {
          const ok = await confirm({
            title: `Revoke ${name}?`,
            description: "This phone loses access at once and any session it has open ends. It has to be paired again to come back.",
            confirmLabel: "Revoke",
            cancelLabel: "Keep",
            variant: "destructive",
          });
          if (ok) await run(() => api.revokeRemoteDevice(id));
        })();
      }}
      onRevokeAll={() => {
        void (async () => {
          const ok = await confirm({
            title: "Revoke all phones?",
            description: "Every phone loses access at once and this Mac's key is replaced, so each phone has to be paired again.",
            confirmLabel: "Revoke all",
            cancelLabel: "Keep",
            variant: "destructive",
          });
          if (ok) await run(() => api.revokeAllRemoteDevices());
        })();
      }}
      onMoreLog={() => {
        void run(async () => {
          const last = log?.nextBeforeSeq;
          if (last === null || last === undefined) return;
          const more = await api.getRemoteLog({ limit: LOG_PAGE, beforeSeq: last });
          if (mountedRef.current) setLog({ rows: [...(log?.rows ?? []), ...more.rows], chain: more.chain, nextBeforeSeq: more.nextBeforeSeq });
        });
      }}
    />
  );
}
