import path from "node:path";
import { randomUUID } from "node:crypto";
import { getClient, type Flags } from "../context.ts";
import { ApiError } from "../api-client.ts";
import { c, out, errln, printJson } from "../output.ts";
import { flagValue } from "../args.ts";
import { usageError } from "../usage.ts";
import { streamSse, type SseHandle } from "../sse.ts";
import { isGitProvider } from "../../shared/clone-input.ts";
import {
  PROVIDER_CAPS,
  type AppEvent,
  type CloneProgressPhase,
  type GitProvider,
} from "../../shared/types.ts";

/**
 * `agetor clone <url> [--provider github|gitlab|bitbucket] [--dest <path>]
 * [--no-eli5]` — clone a GitHub/GitLab/Bitbucket repo as a new registered
 * project, via the same `POST /projects/clone` route the app's "Clone
 * repository" dialog uses (plan `docs/plans/clone-repository-all-providers.md`
 * §3 D8, progress + cancel per Addendum A). `--provider` only disambiguates
 * bare `owner/repo` shorthand — a full URL's own detected provider wins
 * server-side regardless of what's passed here. `--dest` is resolved
 * against the CLI's own cwd (the daemon may be a long-lived detached
 * process with an unrelated one) since the route requires an absolute
 * path. `--no-eli5` skips creating + starting the explainer task the route
 * otherwise launches by default.
 *
 * Progress: a `cloneId` is minted client-side and sent on the request body
 * so the clone's `clone_progress` `AppEvent`s (broadcast on `GET
 * /app/events`, the same channel the webview uses — no second SSE
 * connection) can be correlated to this invocation. In `--json` mode no
 * progress is rendered (and no SSE connection is opened at all) — only the
 * final JSON result matters there. Ctrl+C during the clone cancels it via
 * `DELETE /projects/clone/:cloneId` and lets the held POST settle on its own
 * 409 rejection rather than killing the CLI process out from under it.
 */
export async function cmdClone(args: string[], flags: Flags): Promise<void> {
  const url = args[0];
  if (!url || url.startsWith("-")) throw usageError("clone");

  let provider: GitProvider | undefined;
  let dest: string | undefined;
  let eli5 = true;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--provider": {
        const v = flagValue(args, ++i, a);
        if (!isGitProvider(v)) {
          throw new Error("--provider must be one of github, gitlab, bitbucket");
        }
        provider = v;
        break;
      }
      case "--dest":
        dest = path.resolve(flagValue(args, ++i, a));
        break;
      case "--no-eli5":
        eli5 = false;
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }

  const client = await getClient(flags);
  const cloneId = randomUUID();

  let progress: SseHandle | undefined;
  let printer: CloneProgressPrinter | undefined;
  if (!flags.json) {
    printer = new CloneProgressPrinter({
      isTTY: Boolean(process.stderr.isTTY),
      write: (s) => process.stderr.write(s),
      columns: process.stderr.columns,
    });
    progress = streamSse<AppEvent>(
      "/app/events",
      (e) => {
        if (e.type === "clone_progress" && e.cloneId === cloneId) printer!.update(e);
      },
      { dataDir: flags.dataDir },
    );
  }

  // A *latched* handler (this is `process.on`, not `process.once` — it fires
  // on every SIGINT, and deliberately behaves differently the second time):
  // the first Ctrl+C asks the core to kill the in-flight git process
  // (swallowing a 404 — the clone may have already settled on its own) and
  // then returns, letting the pending `cloneProject` call below settle on
  // its own — the core's 409 cancellation rejection, a genuine success/
  // failure, or (if the cancel request itself failed) whatever the clone
  // eventually does on its own — rather than tearing the CLI process down
  // mid-request. Without the latch, a second (or third, impatient) Ctrl+C
  // would just re-issue the same cancel and the process would still block
  // on the held POST (up to 15 minutes) with no way out. So a second Ctrl+C
  // instead aborts the CLI outright: the server-side clone may keep running
  // to completion (or get cancelled on its own next tick) but the user gets
  // their terminal back. The handler is installed right before the POST is
  // sent — with the server now announcing a clone (and answering its
  // `DELETE` with `{ok:true}`) as soon as it's in flight, before git even
  // spawns, a SIGINT landing in the brief window between "handler
  // installed" and "POST sent" is still honored correctly by the pending
  // `cancelClone` call once it goes out.
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      printer?.notice(
        c.dim("cancelling… (press Ctrl+C again to abort; the server-side clone may keep running)"),
      );
      void client.cancelClone(cloneId).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return;
        // Any other cancel-request failure isn't fatal here — the pending
        // clone below still settles (success, a real failure, or the core
        // eventually noticing the request end) and drives the exit path.
      });
      return;
    }
    printer?.notice(c.dim("aborted"));
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    const result = await client.cloneProject({ url, provider, dest, eli5, cloneId });

    if (flags.json) return printJson(result);

    const { project, provider: resolvedProvider, eli5TaskId, eli5Error } = result;
    out(`${c.green("✓")} cloned ${c.bold(project.name)} ${c.dim(project.path)}`);
    // `provider` is only present when talking to a daemon new enough to send it
    // (the route change is additive) — an older already-running core clones
    // fine but omits the field, and by this point the clone + project
    // registration has already succeeded, so a missing/unknown provider must
    // not throw here and crash after the fact. Just skip the line.
    const providerName = resolvedProvider ? PROVIDER_CAPS[resolvedProvider]?.providerName : undefined;
    if (providerName) out(c.dim(`provider: ${providerName}`));
    if (eli5TaskId) {
      out(`explainer task started: ${eli5TaskId} — agetor logs ${eli5TaskId}`);
    }
    if (eli5Error) {
      out(c.yellow(`clone succeeded, but the explainer task failed: ${eli5Error}`));
    }
  } catch (e) {
    if (isCancelledCloneError(e)) {
      if (flags.json) printJson(e.body);
      else errln(c.dim("clone cancelled"));
      process.exitCode = 130;
      return;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    progress?.close();
  }
}

/** The core's held-POST rejection for a clone that `cancelClone` killed
 *  mid-flight — 409 `{ error: "clone cancelled", cancelled: true, cloneId }`
 *  (Addendum A). Narrowed as a type guard so the catch branch above can read
 *  `e.body` without a cast. */
function isCancelledCloneError(e: unknown): e is ApiError & { body: { cancelled: true } } {
  return (
    e instanceof ApiError &&
    e.status === 409 &&
    typeof e.body === "object" &&
    e.body !== null &&
    (e.body as { cancelled?: unknown }).cancelled === true
  );
}

/** Human-readable label per {@link CloneProgressPhase}, used by {@link
 *  formatCloneProgressLine}. The three terminal phases only ever reach the
 *  printer once (`cancelled`/`failed` can also arrive with a detail `line`,
 *  rendered instead of a percent — see that function). */
const CLONE_PHASE_LABELS: Record<CloneProgressPhase, string> = {
  starting: "starting…",
  counting: "counting objects",
  compressing: "compressing objects",
  receiving: "receiving objects",
  resolving: "resolving deltas",
  "checking-out": "checking out files",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** `true` for the three phases that end a clone — no further `clone_progress`
 *  event for this `cloneId` follows one of these. */
function isTerminalCloneProgressPhase(phase: CloneProgressPhase): boolean {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}

/**
 * Pure renderer for one `clone_progress` event → the single status line
 * `agetor clone` shows for it: `"<phase label> NN%"` when the event carries
 * a percent, else the phase label alone, or `"<phase label> — <line>"` when
 * git (or the server's synthetic terminal event) attached a detail string
 * (e.g. a failure's error text). Exported standalone, with no dependency on
 * a terminal, so it's covered by a plain table test.
 */
export function formatCloneProgressLine(ev: {
  phase: CloneProgressPhase;
  percent: number | null;
  line: string;
}): string {
  const label = CLONE_PHASE_LABELS[ev.phase];
  if (ev.percent !== null) return `${label} ${ev.percent}%`;
  return ev.line ? `${label} — ${ev.line}` : label;
}

/**
 * Renders a stream of `clone_progress` events to a single status line on
 * stderr — a small closure-like class over an injected `{ isTTY, write,
 * columns }` so it never touches `process` directly and is unit-testable
 * without a real terminal. TTY: overwrites in place (`\r` + the line,
 * padded to at least the previous line's length so a shorter new line
 * fully erases a longer old one) and emits no `\n` until a terminal phase,
 * which gets one so the cursor moves past the finished progress line.
 * Non-TTY: prints one line per phase change only — no per-percent spam
 * scrolling a redirected log.
 *
 * `columns` (the caller's `process.stderr.columns`, injected rather than
 * read directly so this stays unit-testable) bounds the rendered text to
 * `(columns ?? 80) - 1` — one short of the terminal width, so a `padEnd`
 * write can never itself trigger a soft-wrap that would leave a stray
 * second line behind. `lastLineLength` (used for that padding) is tracked
 * in terms of the already-truncated string, matching what's actually on
 * screen.
 */
export class CloneProgressPrinter {
  private lastPhase: CloneProgressPhase | null = null;
  private lastLineLength = 0;
  /** True (TTY only) while the last write left an unfinished `\r`-updated
   *  line on screen with no trailing `\n` yet — i.e. between a non-terminal
   *  `update()` and either the terminal `update()` or a `notice()`. */
  private pendingLine = false;

  constructor(
    private readonly opts: { isTTY: boolean; write: (s: string) => void; columns?: number },
  ) {}

  private truncate(text: string): string {
    const max = (this.opts.columns ?? 80) - 1;
    return max > 0 && text.length > max ? text.slice(0, max) : text;
  }

  update(ev: { phase: CloneProgressPhase; percent: number | null; line: string }): void {
    const text = this.truncate(formatCloneProgressLine(ev));
    if (this.opts.isTTY) {
      this.opts.write(`\r${text.padEnd(this.lastLineLength)}`);
      this.lastLineLength = text.length;
      if (isTerminalCloneProgressPhase(ev.phase)) {
        this.opts.write("\n");
        this.pendingLine = false;
      } else {
        this.pendingLine = true;
      }
    } else if (ev.phase !== this.lastPhase) {
      this.opts.write(`${text}\n`);
    }
    this.lastPhase = ev.phase;
  }

  /**
   * Prints a standalone notice line (e.g. the SIGINT cancel/abort
   * messages) that must never land mid-line: if a `\r`-updated progress
   * line is still unfinished (TTY only), first terminates it with a `\n`
   * so the notice starts on its own fresh line, then writes the notice
   * itself followed by `\n`.
   */
  notice(text: string): void {
    if (this.opts.isTTY && this.pendingLine) {
      this.opts.write("\n");
      this.pendingLine = false;
      this.lastLineLength = 0;
    }
    this.opts.write(`${text}\n`);
  }
}
