import { forwardRef, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Copy, Download, Package, RefreshCw, Terminal, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after the user successfully resolves the missing-tmux state. */
  onResolved?: () => void;
}

type View = "choice" | "instructions";

interface InstallCommand {
  label: string;
  cmd: string;
  hint?: string;
}

const INSTALL_COMMANDS: InstallCommand[] = [
  {
    label: "Homebrew",
    cmd: "brew install tmux",
    hint: "Recommended if you already have Homebrew.",
  },
  {
    label: "MacPorts",
    cmd: "sudo port install tmux",
  },
];

/**
 * Modal shown when claude-code is selected but tmux can't be found. Offers
 * two paths: use the bundled binary that ships inside the .app, or install
 * tmux manually with commands the user can copy-paste. Either way, the
 * choice flows back into `tmux_source` and `/agents` re-probes pick it up
 * within the next polling cycle.
 */
export function TmuxInstallDialog({ open, onClose, onResolved }: Props) {
  const [view, setView] = useState<View>("choice");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundledAvailable, setBundledAvailable] = useState<boolean | null>(null);
  const useBundledRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setView("choice");
    setError(null);
    setBusy(false);
    void api
      .getTmuxSource()
      .then((s) => setBundledAvailable(s.bundledAvailable))
      .catch(() => setBundledAvailable(null));
  }, [open]);

  const useBundled = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setTmuxSource("bundled");
      onResolved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const recheck = () => {
    onResolved?.();
    onClose();
  };

  // Swap views without leaking stale error/busy state from the other side.
  const showChoice = () => {
    setError(null);
    setBusy(false);
    setView("choice");
  };
  const showInstructions = () => {
    setError(null);
    setBusy(false);
    setView("instructions");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-xl"
      labelledBy="tmux-install-title"
      describedBy="tmux-install-desc"
      initialFocusRef={view === "choice" ? useBundledRef : undefined}
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          {view === "instructions" && (
            <Button
              variant="ghost"
              size="icon"
              onClick={showChoice}
              aria-label="Back"
            >
              <ChevronLeft className="size-4" />
            </Button>
          )}
          <div className="rounded-md bg-amber-500/10 p-1.5 text-amber-500">
            <Terminal className="size-4" />
          </div>
          <h2 id="tmux-install-title" className="text-base font-semibold">
            {view === "choice" ? "tmux is required for Claude Code" : "Install tmux"}
          </h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      {view === "choice" ? (
        <ChoiceView
          bundledAvailable={bundledAvailable}
          busy={busy}
          error={error}
          useBundledRef={useBundledRef}
          onUseBundled={useBundled}
          onShowInstructions={showInstructions}
        />
      ) : (
        <InstructionsView busy={busy} onRecheck={recheck} />
      )}
    </Dialog>
  );
}

function ChoiceView({
  bundledAvailable,
  busy,
  error,
  useBundledRef,
  onUseBundled,
  onShowInstructions,
}: {
  bundledAvailable: boolean | null;
  busy: boolean;
  error: string | null;
  useBundledRef: React.RefObject<HTMLButtonElement | null>;
  onUseBundled: () => void;
  onShowInstructions: () => void;
}) {
  return (
    <div className="space-y-4 pt-4 text-sm">
      <p id="tmux-install-desc" className="text-muted-foreground">
        Agetor drives the Claude Code REPL through a per-task{" "}
        <span className="font-mono text-foreground/80">tmux</span> session, but we
        couldn't find <span className="font-mono text-foreground/80">tmux</span> on
        your <span className="font-mono">PATH</span>. Pick how you'd like to
        resolve this — Agetor will remember your choice.
      </p>

      <div className="space-y-2">
        <Option
          ref={useBundledRef}
          icon={<Package className="size-5" />}
          title="Use Agetor's bundled tmux"
          description={
            bundledAvailable === false
              ? "Not available in this build. Use the manual install option instead."
              : "Runs the copy of tmux that ships inside Agetor. No extra installation, works offline."
          }
          recommended
          disabled={bundledAvailable === false || busy}
          onClick={onUseBundled}
        />
        <Option
          icon={<Download className="size-5" />}
          title="I'll install tmux myself"
          description="Show install commands for Homebrew or MacPorts."
          disabled={busy}
          onClick={onShowInstructions}
        />
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface OptionProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  recommended?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

const Option = forwardRef<HTMLButtonElement, OptionProps>(function Option(
  { icon, title, description, recommended, disabled, onClick },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex w-full items-start gap-3 rounded-md border border-border bg-background px-4 py-3 text-left transition-colors",
        "hover:border-primary/60 hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-background",
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {recommended && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase text-primary">
              recommended
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
});

function InstructionsView({
  busy,
  onRecheck,
}: {
  busy: boolean;
  onRecheck: () => void;
}) {
  return (
    <div className="space-y-4 pt-4 text-sm">
      <p className="text-muted-foreground">
        Run one of these in your terminal, then click <strong>Re-check</strong>{" "}
        below.
      </p>
      <div className="space-y-2">
        {INSTALL_COMMANDS.map((c) => (
          <CommandRow key={c.label} command={c} />
        ))}
      </div>
      <div className="flex justify-end pt-2">
        <Button onClick={onRecheck} disabled={busy}>
          <RefreshCw className={cn("mr-2 size-3.5", busy && "animate-spin")} />
          Re-check
        </Button>
      </div>
    </div>
  );
}

function CommandRow({ command }: { command: InstallCommand }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable in some webviews — silent */
    }
  };
  return (
    <div className="rounded-md border border-border/70 bg-muted/30 p-3">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{command.label}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
        >
          {copied ? (
            <>
              <Check className="size-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto rounded bg-background/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
        {command.cmd}
      </pre>
      {command.hint && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{command.hint}</p>
      )}
    </div>
  );
}
