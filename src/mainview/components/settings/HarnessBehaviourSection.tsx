import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FX_AUTO_RESUME_MAX, parseFxAutoResumeDelayInput } from "@/lib/fx-auto-resume-prefs";
import { CLAUDE_AUTO_TRUST_PREF, isClaudeAutoTrustOn } from "../../../shared/claude-auto-trust.ts";
import {
  CLAUDE_SESSIONS_LAUNCH_SCAN_PREF,
  FX_AUTO_RESUME_MAX_DELAY_SEC,
  FX_AUTO_RESUME_MIN_DELAY_SEC,
} from "../../../shared/types.ts";

/**
 * One chain per preference key, shared by every mounted copy of the page: a
 * load waits for the writes queued before it, and writes land in the order
 * they were made, so an older write can never land after a newer one.
 */
const preferenceQueues = new Map<string, Promise<void>>();

function enqueuePreferenceOp(key: string, op: () => Promise<void>): void {
  const next = (preferenceQueues.get(key) ?? Promise.resolve()).then(op).catch(() => { /* each op handles its own failure */ });
  preferenceQueues.set(key, next);
}

/**
 * A boolean preference the page reads once on mount and writes through a
 * last-write-wins queue: writes run one at a time, and a toggle that lands
 * while an older request is queued skips that request, so the stored value is
 * always the last switch. A failed write puts the switch back to the last
 * value the server confirmed. A load never overwrites a switch made after it
 * began.
 */
function useBooleanPreference(key: string, parse: (stored: string | undefined) => boolean, write: (on: boolean) => string) {
  const [value, setValue] = useState(() => parse(undefined));
  const touchedRef = useRef(false);
  const desiredRef = useRef<boolean | null>(null);
  // The last value the server is known to hold (loaded, or written successfully).
  const confirmedRef = useRef<boolean>(parse(undefined));
  useEffect(() => {
    let cancelled = false;
    enqueuePreferenceOp(key, async () => {
      try {
        const prefs = await api.listPreferences();
        if (cancelled) return;
        const stored = parse(prefs[key]);
        // The queue ran every earlier write first, so this is what the server
        // holds now, even when the switch was moved after the load began.
        confirmedRef.current = stored;
        if (touchedRef.current) return;
        setValue(stored);
      } catch { /* the default stays */ }
    });
    return () => { cancelled = true; };
    // `parse` is a module-level function at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (on: boolean) => {
    touchedRef.current = true;
    desiredRef.current = on;
    setValue(on);
    enqueuePreferenceOp(key, async () => {
      if (desiredRef.current !== on) return;
      try {
        await api.setPreference(key, write(on));
        confirmedRef.current = on;
      } catch {
        if (desiredRef.current !== on) return;
        desiredRef.current = confirmedRef.current;
        setValue(confirmedRef.current);
      }
    });
  };
  return [value, set] as const;
}

export interface HarnessBehaviourProps {
  tmuxSource: "system" | "bundled";
  bundledTmuxAvailable: boolean;
  onPickTmuxSource: (source: "system" | "bundled") => void;
  fxAutoResume: { enabled: boolean; delaySec: number };
  onFxAutoResumeChange: (next: { enabled: boolean; delaySec: number }) => void;
}

/**
 * Settings → Harnesses → Behaviour: the settings that belong to one kind of
 * harness rather than to the app. Each control writes the same preference or
 * route it wrote when it lived on the General page.
 */
export function HarnessBehaviourSection({
  tmuxSource,
  bundledTmuxAvailable,
  onPickTmuxSource,
  fxAutoResume,
  onFxAutoResumeChange,
}: HarnessBehaviourProps) {
  const [launchScan, setLaunchScan] = useBooleanPreference(
    CLAUDE_SESSIONS_LAUNCH_SCAN_PREF,
    (stored) => stored !== "0",
    (on) => (on ? "1" : "0"),
  );
  const [autoTrust, setAutoTrust] = useBooleanPreference(
    CLAUDE_AUTO_TRUST_PREF,
    isClaudeAutoTrustOn,
    (on) => (on ? "1" : "0"),
  );

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
    <section className="space-y-4" data-testid="harness-behaviour-section" aria-label="Harness behaviour">
      <h3 className="text-xs font-medium text-muted-foreground">Behaviour</h3>

      <div className="space-y-3 rounded-md border p-3" data-testid="harness-behaviour-claude">
        <h4 className="text-xs font-medium">Claude Code</h4>

        <div className="space-y-1">
          <label htmlFor="claude-tmux-source" className="text-xs text-muted-foreground">tmux for Claude Code</label>
          <Select
            id="claude-tmux-source"
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
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="claude-auto-trust" className="text-xs text-muted-foreground">
              Auto-trust a task's repositories
            </label>
            <Switch
              id="claude-auto-trust"
              data-testid="claude-auto-trust"
              checked={autoTrust}
              onCheckedChange={setAutoTrust}
              aria-label="Auto-trust a task's repositories"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            When a task spans several repositories, Claude Code asks you to trust each checkout every time it starts or
            resumes. With this on, Agetor answers "Yes, add it" for the checkouts it created for the task, for that
            session only. Turn it off to be asked each time.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="claude-sessions-launch-scan" className="text-xs text-muted-foreground">
              Look for Claude Code and OpenCode sessions on launch
            </label>
            <Switch
              id="claude-sessions-launch-scan"
              data-testid="claude-sessions-launch-scan"
              checked={launchScan}
              onCheckedChange={setLaunchScan}
              aria-label="Look for Claude Code and OpenCode sessions on launch"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            On startup, notice Claude Code and OpenCode sessions that were started outside Agetor so you can import them.
          </p>
        </div>
      </div>

      <div className="space-y-3 rounded-md border p-3" data-testid="harness-behaviour-fx">
        <h4 className="text-xs font-medium">fx</h4>
        <div className="space-y-1">
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
        </div>
      </div>
    </section>
  );
}
