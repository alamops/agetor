import { Check, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { cn } from "@/lib/utils";
import type { OnboardingStep, OnboardingStepId } from "@/lib/onboarding";
import type { AgentKind, Harness, HarnessStatus } from "../../../shared/types.ts";

interface Props {
  steps: OnboardingStep[];
  statuses: HarnessStatus[];
  /** Harness rows (carries `enabled`), or `null` while that fetch hasn't
   *  landed yet — in which case the disabled/enabled distinction is skipped
   *  rather than guessed. */
  harnessRows: Harness[] | null;
  /** `false` renders the full centered card (zero-task state); `true`
   *  renders the slim strip that sits above the columns once tasks exist. */
  compact: boolean;
  onOpenSettingsHarnesses: () => void;
  onFocusNewTask: () => void;
  /** Best-effort — failures (e.g. the 501 a headless build returns) are the
   *  caller's responsibility to surface (toast), not this component's. */
  onOpenTerminal: (harnessId: string) => void;
  onDismiss: () => void;
}

const STEP_LABEL: Record<OnboardingStepId, string> = {
  harness: "Get an agent ready",
  project: "Add a project",
  task: "Create your first task",
  run: "Run it",
};

/** Exact login command per harness kind — shown in the harness step's login
 *  guidance block. Kept local (not imported from SettingsDialog) since that
 *  file's `HARNESS_HOME_COPY` documents the *env var* a home override sets,
 *  not the literal login invocation. Gemini is deliberately absent: `gemini`
 *  on its own isn't a login command, it's the CLI itself — see the prose
 *  fallback below. */
const LOGIN_COMMAND: Partial<Record<AgentKind, string>> = {
  "claude-code": "claude /login",
  codex: "codex login",
  cursor: "cursor-agent login",
  fx: "fx login",
};

/** fx ≥0.0.5 supports logging into a subscription provider (Codex/Grok
 *  accounts) in addition to the default Vercel AI Gateway login — shown
 *  wherever `LOGIN_COMMAND.fx` itself is shown, so the user isn't left
 *  thinking `fx login` is the only option. */
function FxLoginHint({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] text-muted-foreground", className)}>
      or <code className="rounded bg-muted px-1 py-0.5 font-mono">fx login codex</code> /{" "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono">fx login grok</code> for a
      subscription provider
    </p>
  );
}

function StepIcon({ done, index }: { done: boolean; index: number }) {
  if (done) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium text-muted-foreground">
      {index + 1}
    </span>
  );
}

function HarnessStepDetail({
  statuses,
  harnessRows,
  onOpenSettingsHarnesses,
  onOpenTerminal,
}: {
  statuses: HarnessStatus[];
  harnessRows: Harness[] | null;
  onOpenSettingsHarnesses: () => void;
  onOpenTerminal: (harnessId: string) => void;
}) {
  const rowById = new Map((harnessRows ?? []).map((h) => [h.id, h] as const));
  const harnessesWithHome = (harnessRows ?? []).filter((h) => h.home);
  // Only show login guidance for kinds actually present (deduped) — no point
  // walking a user with only claude-code through codex/cursor/gemini copy.
  const presentKinds = Array.from(new Set(statuses.map((s) => s.kind)));

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-1.5">
        {statuses.map((s) => {
          const row = rowById.get(s.harnessId);
          const label = row?.label ?? s.harnessId;
          const disabled = harnessRows !== null && row ? !row.enabled : false;
          if (s.available && disabled) {
            return (
              <div key={s.harnessId} className="flex items-center gap-2 text-xs">
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                <AgentIcon kind={s.kind} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {label} — installed but disabled
                </span>
                <Button variant="outline" size="sm" onClick={onOpenSettingsHarnesses}>
                  Enable in Settings…
                </Button>
              </div>
            );
          }
          if (s.available && s.loggedIn === false) {
            return (
              <div key={s.harnessId} className="space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="inline-block size-1.5 shrink-0 rounded-full bg-warning" />
                  <AgentIcon kind={s.kind} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {label} — installed but not logged in
                  </span>
                </div>
                {LOGIN_COMMAND[s.kind] && (
                  <code className="ml-5 block truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                    {LOGIN_COMMAND[s.kind]}
                  </code>
                )}
                {s.kind === "fx" && <FxLoginHint className="ml-5" />}
                {s.authHelp && (
                  <p className="ml-5 text-[11px] text-muted-foreground">{s.authHelp}</p>
                )}
              </div>
            );
          }
          if (s.available) {
            return (
              <div key={s.harnessId} className="flex items-center gap-2 text-xs">
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-success-solid" />
                <AgentIcon kind={s.kind} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {label}
                  {s.version && <span className="text-muted-foreground"> · {s.version}</span>}
                </span>
              </div>
            );
          }
          return (
            <div key={s.harnessId} className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-danger-solid" />
                <AgentIcon kind={s.kind} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {label} — not found{disabled ? " — disabled" : ""}
                </span>
              </div>
              {s.installHint && (
                <code className="ml-5 block truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                  {s.installHint}
                </code>
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-1 border-t border-border/60 pt-2">
        <p className="text-[11px] text-muted-foreground">Just installed one? Log it in first:</p>
        <div className="space-y-1">
          {presentKinds.map((kind) =>
            kind === "gemini" ? (
              <p key={kind} className="text-[11px] text-muted-foreground">
                Gemini: run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">gemini</code> once and
                follow the browser sign-in.
              </p>
            ) : kind === "fx" ? (
              <div key={kind} className="space-y-1">
                <code className="block rounded bg-muted px-2 py-1 font-mono text-[11px]">
                  {LOGIN_COMMAND[kind]}
                </code>
                <FxLoginHint />
              </div>
            ) : LOGIN_COMMAND[kind] ? (
              <code key={kind} className="block rounded bg-muted px-2 py-1 font-mono text-[11px]">
                {LOGIN_COMMAND[kind]}
              </code>
            ) : null,
          )}
        </div>
      </div>

      {harnessRows !== null && harnessRows.length > 0 && harnessesWithHome.length > 0 && (
        <div className="space-y-1 border-t border-border/60 pt-2">
          <p className="text-[11px] text-muted-foreground">
            Additional accounts have their own login — open a terminal with that harness's env loaded:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {harnessesWithHome.map((h) => (
              <Button
                key={h.id}
                variant="outline"
                size="sm"
                onClick={() => onOpenTerminal(h.id)}
              >
                <Terminal className="mr-1.5 size-3.5" />
                Open {h.label} in Terminal
              </Button>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Running multiple accounts? Add more harnesses in Settings → Harnesses.
      </p>
    </div>
  );
}

function StepDetail({
  id,
  statuses,
  harnessRows,
  onOpenSettingsHarnesses,
  onFocusNewTask,
  onOpenTerminal,
}: {
  id: OnboardingStepId;
  statuses: HarnessStatus[];
  harnessRows: Harness[] | null;
  onOpenSettingsHarnesses: () => void;
  onFocusNewTask: () => void;
  onOpenTerminal: (harnessId: string) => void;
}) {
  switch (id) {
    case "harness":
      return (
        <HarnessStepDetail
          statuses={statuses}
          harnessRows={harnessRows}
          onOpenSettingsHarnesses={onOpenSettingsHarnesses}
          onOpenTerminal={onOpenTerminal}
        />
      );
    case "project":
      return (
        <div className="space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">
            Register the folder of a repo you want agents to work in.
          </p>
          <Button variant="outline" size="sm" onClick={onFocusNewTask}>
            Choose a project…
          </Button>
        </div>
      );
    case "task":
      return (
        <div className="space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">
            Give it a title and a prompt — the panel on the left has everything else prefilled.
          </p>
          <Button variant="outline" size="sm" onClick={onFocusNewTask}>
            Create your first task
          </Button>
        </div>
      );
    case "run":
      return (
        <p className="pt-2 text-xs text-muted-foreground">
          Press Run on your task's card, then watch the agent stream its work live.
        </p>
      );
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/**
 * Live "Getting started" checklist. Steps are derived elsewhere
 * (`deriveOnboardingSteps`) — this component is purely presentational plus
 * event wiring. Two layouts: a centered full card (zero tasks) and a slim
 * strip (once tasks exist) — see `compact`.
 */
export function OnboardingChecklist({
  steps,
  statuses,
  harnessRows,
  compact,
  onOpenSettingsHarnesses,
  onFocusNewTask,
  onOpenTerminal,
  onDismiss,
}: Props) {
  const firstNotDoneId = steps.find((s) => !s.done)?.id;

  if (compact) {
    return (
      <Card data-testid="onboarding-checklist" className="py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4">
          <span className="text-xs font-medium text-muted-foreground">Getting started</span>
          {steps.map((step, i) => (
            <div
              key={step.id}
              data-testid={`onboarding-step-${step.id}`}
              data-done={step.done ? "true" : "false"}
              className="flex items-center gap-1.5"
            >
              <StepIcon done={step.done} index={i} />
              <span className={cn("text-xs", step.done ? "text-muted-foreground line-through" : "text-foreground")}>
                {STEP_LABEL[step.id]}
              </span>
            </div>
          ))}
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={onDismiss}>
            Dismiss — I know my way around
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card data-testid="onboarding-checklist" className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Welcome to Agetor</CardTitle>
        <p className="text-xs text-muted-foreground">
          Create your first task to run an agent on a project.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {steps.map((step, i) => (
          <div key={step.id} data-testid={`onboarding-step-${step.id}`} data-done={step.done ? "true" : "false"}>
            <div className="flex items-center gap-2">
              <StepIcon done={step.done} index={i} />
              <span className={cn("text-sm", step.done ? "text-muted-foreground line-through" : "font-medium text-foreground")}>
                {STEP_LABEL[step.id]}
              </span>
            </div>
            {!step.done && step.id === firstNotDoneId && (
              <StepDetail
                id={step.id}
                statuses={statuses}
                harnessRows={harnessRows}
                onOpenSettingsHarnesses={onOpenSettingsHarnesses}
                onFocusNewTask={onFocusNewTask}
                onOpenTerminal={onOpenTerminal}
              />
            )}
          </div>
        ))}
        <div className="border-t border-border/60 pt-3 text-center">
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Dismiss — I know my way around
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
