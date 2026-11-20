import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, KeyRound, Terminal } from "lucide-react";
import { api, type PendingTmuxPrompt } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cleanPromptPane } from "@/lib/prompt-noise";
import { checkOAuthCodeInput, OAUTH_CODE_INPUT_MAX_LEN } from "@/lib/tmux-prompt";

/**
 * The card for a `tmux_prompt` that is not a menu: an Enter-only screen
 * (`Login successful. Press Enter to continue…`) or Claude's OAuth
 * `Paste code here if prompted >` line. `RunPanel`'s `TmuxPromptCard` hands
 * `answerKind: "enter" | "code"` requests here (docs/plans/claude-enter-to-
 * confirm-prompts.md T11).
 *
 * - **enter**: a primary "Continue (press Enter)" button that posts
 *   `{ enter: true }`, plus "Open in Terminal". Never pressed automatically: the
 *   user sees "Login successful" first.
 * - **code**: a one-line box (no autocomplete, no spellcheck, at most 512
 *   characters, Enter submits) and "Submit code", which posts `{ code }`. The
 *   typed value lives only in this component's state: it is not persisted, not
 *   put in a URL, not logged, and is cleared on unmount, on a successful submit
 *   and whenever the card is replaced (the card is keyed by `req.id` by its
 *   caller, so a new request is a new instance).
 *
 * All state is local to the card instance (never `RunPanelBody`), so the
 * long-lived RunPanel's per-task reset has nothing to add. `{ ok: false }`
 * (HTTP 200) means the prompt was already resolved server-side and just removes
 * the card; a 409 (the prompt changed on screen), 410 (the session is gone) or
 * 500 shows the server's message and keeps the card.
 */
export function TmuxPromptAnswerControls({
  req,
  onResolved,
}: {
  req: PendingTmuxPrompt;
  onResolved: (id: string) => void;
}) {
  const isCode = req.answerKind === "code";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Never leave a typed code behind in a retained closure.
      setCode("");
    };
  }, []);

  const check = isCode ? checkOAuthCodeInput(code) : null;

  const post = async (body: { enter: true } | { code: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.answerTmuxPrompt(req.id, body);
      if (!mounted.current) return;
      setCode("");
      onResolved(req.id);
    } catch (e) {
      if (!mounted.current) return;
      // The message is the server's fixed text; it never echoes a submitted code.
      setError(e instanceof Error ? e.message : "Failed to send.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const submitCode = () => {
    if (!check || !check.ok) {
      if (check && !check.ok) setError(check.reason);
      return;
    }
    void post({ code: check.code });
  };

  const openInTerminal = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await api.openTmux(req.taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not attach to tmux session");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div
      className="rounded-md border border-warning/60 bg-card p-3 ring-1 ring-warning/40"
      data-testid={isCode ? "tmux-prompt-code-card" : "tmux-prompt-enter-card"}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-warning">
          {isCode ? <KeyRound className="size-3.5" aria-hidden /> : <CornerDownLeft className="size-3.5" aria-hidden />}
          {isCode ? "Claude is waiting for a sign-in code" : "Claude is waiting for Enter"}
        </span>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/40 p-2 font-mono text-[11px] leading-snug">
        {cleanPromptPane(req.paneText)}
      </pre>
      {req.held === true && (
        <p className="mt-2 text-[11px] text-warning" data-testid="tmux-prompt-held-hint">
          Claude didn’t take the first keypress — choose again.
        </p>
      )}
      {isCode ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitCode();
          }}
        >
          <Input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the code from your browser"
            aria-label="Sign-in code"
            data-testid="tmux-prompt-code-input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={OAUTH_CODE_INPUT_MAX_LEN}
            disabled={busy}
            className="h-8 font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={busy || !check?.ok} data-testid="tmux-prompt-code-submit">
            {busy ? "Sending…" : "Submit code"}
          </Button>
        </form>
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            onClick={() => void openInTerminal()}
            size="sm"
            variant="outline"
            disabled={opening || busy}
          >
            <Terminal className="mr-1 size-3.5" aria-hidden />
            {opening ? "Opening…" : "Open in Terminal"}
          </Button>
          <Button
            onClick={() => void post({ enter: true })}
            size="sm"
            disabled={busy}
            data-testid="tmux-prompt-continue"
          >
            {busy ? "Sending…" : "Continue (press Enter)"}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-right text-[11px] text-destructive" data-testid="tmux-prompt-error">{error}</p>}
    </div>
  );
}
