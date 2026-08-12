import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  /** "Get started" — dismisses the dialog for this session only, leaving the
   *  checklist card visible underneath. */
  onAcknowledge: () => void;
  /** "Skip — I know my way around" — persists the dismissal server-side so
   *  neither the welcome dialog nor the checklist appear again. */
  onSkip: () => void;
}

/**
 * First-run welcome dialog. Shown once for a brand-new user (see
 * `resolveOnboardingVisibility` in `lib/onboarding.ts`), explaining the core
 * workflow before the "Getting started" checklist takes over. Copy is seeded
 * from README.md's "Getting started" section.
 */
export function WelcomeDialog({ open, onAcknowledge, onSkip }: Props) {
  return (
    <Dialog
      open={open}
      onClose={onAcknowledge}
      className="max-w-lg"
      labelledBy="onboarding-welcome-title"
      describedBy="onboarding-welcome-desc"
    >
      <div data-testid="onboarding-welcome">
        <div className="flex items-center gap-2 border-b border-border/60 pb-3">
          <div className="rounded-md bg-primary/10 p-1.5 text-primary">
            <Sparkles className="size-4" />
          </div>
          <h2 id="onboarding-welcome-title" className="text-base font-semibold">
            Welcome to Agetor
          </h2>
        </div>

        <div id="onboarding-welcome-desc" className="space-y-3 pt-4 text-sm text-muted-foreground">
          <p>
            Agetor turns a kanban board into a control plane for AI coding agents. A{" "}
            <span className="text-foreground">task</span> is just a prompt, a project folder,
            and a coding agent — Claude Code, Codex, Cursor, or Gemini.
          </p>
          <p>
            Run it and the card moves to <span className="text-foreground">Running</span> while
            the agent's output streams live; it lands in{" "}
            <span className="text-foreground">Review</span> when the agent finishes (or{" "}
            <span className="text-foreground">Blocked</span> / back to{" "}
            <span className="text-foreground">Ready</span> if something goes wrong), and you
            mark it <span className="text-foreground">Done</span>.
          </p>
          <p>
            The checklist that's about to appear walks through the handful of things a fresh
            install needs: a ready agent, a registered project, and your first task.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip — I know my way around
          </Button>
          <Button size="sm" onClick={onAcknowledge}>
            Get started
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
