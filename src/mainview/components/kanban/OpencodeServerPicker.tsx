import { Button } from "@/components/ui/button";
import { opencodeMajor } from "../../../shared/opencode.ts";
import {
  OPENCODE_SERVER_MODES,
  type AgentKind,
  type Harness,
  type OpencodeServerMode,
} from "../../../shared/types.ts";

const LABELS: Record<OpencodeServerMode, string> = {
  shared: "Shared",
  standalone: "Standalone",
};

const HINTS: Record<OpencodeServerMode, string> = {
  shared: "Runs through OpenCode's background service (faster start, shared with your other OpenCode clients)",
  standalone: "Starts a private OpenCode server for each turn",
};

/** The locked-note copy for a harness with a home (G3a, spike A14). */
const HOME_LOCK_REASON =
  "This harness has its own home, so it always runs OpenCode standalone (a shared server would mix accounts).";

/** Whether to show the picker at all: the kind is `opencode` and the
 *  harness's CLI is v2 or of unknown version (an unparseable, empty or
 *  missing `--version` reads as v2, same as `opencodeMajor`). v1 has no
 *  `--standalone` and no shared service, so there is nothing to pick. */
export function showOpencodeServerPicker(kind: AgentKind | null | undefined, cliVersion: string | null | undefined): boolean {
  return kind === "opencode" && opencodeMajor(cliVersion) === 2;
}

/** `{reason}` when the harness has a home — Standalone is then forced
 *  (`effectiveOpencodeServer`), because the shared service binds a fixed
 *  port that HOME/XDG isolation can't separate — else `undefined`. */
export function opencodeServerLock(harness: Pick<Harness, "home"> | null | undefined): { reason: string } | undefined {
  const home = harness?.home;
  if (typeof home === "string" && home.trim() !== "") return { reason: HOME_LOCK_REASON };
  return undefined;
}

export interface OpencodeServerPickerProps {
  value: OpencodeServerMode;
  onChange: (v: OpencodeServerMode) => void;
  /** Harness has a home → Standalone is forced; renders the locked note (test id `opencode-server-locked-note`) with this reason. */
  locked?: { reason: string };
  disabled?: boolean;
  testId: string;
}

/**
 * OpenCode server option (`shared | standalone`, D-4) — a two-segment
 * button group shared by the launch dialogs (`launch-opencode-server`), the
 * New Task form (`new-task-opencode-server`) and RunPanel's task details
 * (`task-opencode-server`). Looks and behaves like `SpeedPicker`: a
 * `role="group"` of outline/default buttons, each segment
 * `<testId>-shared` / `<testId>-standalone` carrying `aria-pressed`, the
 * root carrying `data-value` (the value shown). No label of its own —
 * consumers render theirs, gated on {@link showOpencodeServerPicker}.
 *
 * `locked` shows Standalone pressed and both segments disabled, with the
 * reason as a note underneath. It does not touch `value`: the caller keeps
 * sending the stored choice, and the server computes the effective mode
 * (`effectiveOpencodeServer`), so moving the task to a home-less harness
 * later restores whatever was picked.
 */
export function OpencodeServerPicker({ value, onChange, locked, disabled, testId }: OpencodeServerPickerProps) {
  const shown: OpencodeServerMode = locked ? "standalone" : value;
  return (
    <div className="space-y-1">
      <div
        data-testid={testId}
        data-value={shown}
        data-locked={locked ? "true" : undefined}
        role="group"
        aria-label="OpenCode server"
        className="flex gap-1"
      >
        {OPENCODE_SERVER_MODES.map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={shown === id ? "default" : "outline"}
            data-testid={`${testId}-${id}`}
            aria-pressed={shown === id}
            title={locked ? locked.reason : HINTS[id]}
            disabled={disabled || locked !== undefined}
            onClick={() => {
              if (id !== value) onChange(id);
            }}
            className="min-w-0 flex-1 px-2"
          >
            <span className="truncate">{LABELS[id]}</span>
          </Button>
        ))}
      </div>
      {locked && (
        <p data-testid="opencode-server-locked-note" className="text-[11px] text-muted-foreground">
          {locked.reason}
        </p>
      )}
    </div>
  );
}
