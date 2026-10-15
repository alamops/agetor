/**
 * Event-loop-lag monitor (docs/plans/non-blocking-session-restore.md, T3 /
 * decision C).
 *
 * The Bun main process is ONE thread: a synchronous stretch of work (a
 * `bun:sqlite` query, a big `readFileSync` + `JSON.parse`, a `VACUUM`) stalls
 * every HTTP route, SSE stream, tmux op and pipeline runner at once. Before
 * this module existed such a stall was invisible — the only symptom was every
 * other task panel sitting on `Loading messages…` — so this is the breadcrumb
 * that names the operation responsible.
 *
 * How it works:
 *   - A `.unref()`'d `setTimeout` chain samples the loop every `sampleMs`.
 *     A tick that fires `lag = elapsed − sampleMs` late means something held
 *     the thread for about that long. A lag of at least `stallMs` is a stall.
 *   - Call sites bracket suspect work with `beginLagLabel(label, ctx?)`, which
 *     returns a disposer. The sampler only gets to run AFTER the blocking
 *     stretch ends — by which point the disposer has usually already run — so
 *     attribution can't just peek at the live stack. Every label records its
 *     `[begin, end]` interval, and a stall is attributed to the label whose
 *     interval overlaps the late period (expected fire time → actual fire
 *     time) the most, preferring the most recently begun of the near-ties
 *     (the innermost, for properly nested labels; for labels that interleave
 *     across `await`s — several tasks' watchers restoring at once — the one
 *     begun last is the work that actually reached the blocking call). A
 *     `beginLagLabel → Bun.sleepSync(1200) → dispose` sequence therefore still
 *     reports that label.
 *   - A stall logs exactly one `console.warn` line and calls the installed
 *     sink once with `{ lagMs, label, ctx }` (the orchestrator turns a labelled
 *     task's stall into a status line on its run). Back-to-back stalls under
 *     the same label collapse into the first report: a chunked job that blocks
 *     on every chunk is one problem, not forty log lines.
 *
 * Deliberately a leaf: ZERO imports from the rest of `src/bun`, so db.ts,
 * claude-subagents.ts, claude-tmux.ts, the orchestrator and the server can all
 * import it without a cycle.
 *
 * Enablement: on by default, EXCEPT under `bun test` (`NODE_ENV === "test"`)
 * where a sampler would add timers and noise to every suite. `AGETOR_LAG_MONITOR=1`
 * forces it on anywhere, `=0` forces it off anywhere; the `force` option of
 * `startLagMonitor` is the programmatic override for the unit test and wins
 * over both.
 */

/** Which task (and run, when known) a labelled operation is working for. */
export interface LagContext {
  taskId: string;
  runId?: string;
}

/** One reported stall. `label` is null when no labelled operation overlapped it. */
export interface LagStall {
  lagMs: number;
  label: string | null;
  ctx: LagContext | null;
}

interface LabelEntry {
  label: string;
  ctx: LagContext | null;
  /** Monotonic begin order — "most recently begun wins" among near-ties. */
  seq: number;
  startedAt: number;
  /** Set when the disposer runs; null while the label is still live. */
  endedAt: number | null;
}

const DEFAULT_SAMPLE_MS = 500;
const DEFAULT_STALL_MS = 1000;
/** Upper bound on ended labels remembered between two ticks. A hot loop that
 *  begins/ends thousands of labels per sample would otherwise grow without
 *  bound; past the cap the SHORTEST interval is dropped, since the long one is
 *  the stall suspect. */
const MAX_ENDED_PER_TICK = 256;
/** A label counts as "the" culprit when it overlaps the late period at least
 *  this fraction as much as the best-overlapping label; among those, the most
 *  recently begun wins (so an outer `boot reattach` label doesn't mask the inner
 *  `attach subagent watcher` label that actually held the thread, and a
 *  long-lived async label doesn't swallow a synchronous call — a native file
 *  dialog — begun inside it). Begin order rather than stack depth: labels that
 *  span `await`s interleave, so a label begun later can sit at a SHALLOWER
 *  depth than an earlier one still live (A, B, C begun; A and B end; a label
 *  begun now gets depth 1 while C keeps depth 2). For properly nested labels
 *  the two orders agree. */
const NEAR_BEST_FRACTION = 0.5;

/** Live labels, outermost first. */
const stack: LabelEntry[] = [];
/** Labels that ended since the last tick (only tracked while the sampler runs). */
let ended: LabelEntry[] = [];
let seqCounter = 0;

let sink: ((stall: LagStall) => void) | null = null;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let sampleMs = DEFAULT_SAMPLE_MS;
let stallMs = DEFAULT_STALL_MS;
let nowFn: () => number = defaultNow;
let lastTickAt = 0;
/** Previous tick was a stall — with `lastStallKey`, drives the collapse rule. */
let lastTickWasStall = false;
let lastStallKey: string | null = null;

function defaultNow(): number {
  return performance.now();
}

function lagMonitorEnabled(force: boolean | undefined): boolean {
  if (force !== undefined) return force;
  const env = process.env.AGETOR_LAG_MONITOR;
  if (env === "0") return false;
  if (env === "1") return true;
  return process.env.NODE_ENV !== "test";
}

/**
 * Start the sampler. Idempotent (a second call while running is ignored, even
 * with different options — call `stopLagMonitor()` first to reconfigure) and a
 * no-op when the monitor is disabled for this environment.
 */
export function startLagMonitor(
  opts: { sampleMs?: number; stallMs?: number; now?: () => number; force?: boolean } = {},
): void {
  if (running) return;
  if (!lagMonitorEnabled(opts.force)) return;
  sampleMs = opts.sampleMs !== undefined && opts.sampleMs > 0 ? opts.sampleMs : DEFAULT_SAMPLE_MS;
  stallMs = opts.stallMs !== undefined && opts.stallMs > 0 ? opts.stallMs : DEFAULT_STALL_MS;
  nowFn = opts.now ?? defaultNow;
  running = true;
  lastTickAt = nowFn();
  lastTickWasStall = false;
  lastStallKey = null;
  ended = [];
  schedule();
}

/** Stop the sampler and forget per-tick history. Labels still in flight stay on
 *  the stack (their disposers remain valid); the installed sink is untouched. */
export function stopLagMonitor(): void {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  ended = [];
  lastTickWasStall = false;
  lastStallKey = null;
}

/** Install (or clear with `null`) the callback invoked once per reported stall. */
export function setLagStallSink(fn: ((stall: LagStall) => void) | null): void {
  sink = fn;
}

/**
 * Mark the start of a potentially blocking stretch of work. Returns a disposer
 * that ends the label; it is idempotent and removes exactly its own entry, so
 * out-of-order disposal of nested labels is safe. Labels may span `await`s —
 * the interval bookkeeping, not the live stack, is what attributes a stall.
 */
export function beginLagLabel(label: string, ctx?: LagContext): () => void {
  const entry: LabelEntry = {
    label,
    ctx: ctx ?? null,
    seq: seqCounter++,
    startedAt: nowFn(),
    endedAt: null,
  };
  stack.push(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    entry.endedAt = nowFn();
    const at = stack.lastIndexOf(entry);
    if (at !== -1) stack.splice(at, 1);
    if (running) rememberEnded(entry);
  };
}

/** The innermost live label, or null when nothing labelled is in flight. */
export function currentLagLabel(): { label: string; ctx: LagContext | null } | null {
  const top = stack[stack.length - 1];
  return top ? { label: top.label, ctx: top.ctx } : null;
}

function rememberEnded(entry: LabelEntry): void {
  if (ended.length < MAX_ENDED_PER_TICK) {
    ended.push(entry);
    return;
  }
  const duration = (e: LabelEntry) => (e.endedAt ?? 0) - e.startedAt;
  let shortest = 0;
  for (let i = 1; i < ended.length; i++) {
    if (duration(ended[i]!) < duration(ended[shortest]!)) shortest = i;
  }
  if (duration(entry) > duration(ended[shortest]!)) ended[shortest] = entry;
}

function schedule(): void {
  timer = setTimeout(tick, sampleMs);
  // Never keep the process (or a `bun test` run) alive for the sampler.
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Pick the label to blame for a stall. The late period is
 * `[lastTickAt + sampleMs, now]`: the tick WOULD have fired at its start, and
 * only fired at its end because something held the thread. Both live and
 * just-ended labels are candidates; the best overlap wins, near-ties go to the
 * most recently begun (see {@link NEAR_BEST_FRACTION}).
 */
function attribute(now: number): LabelEntry | null {
  const lateStart = lastTickAt + sampleMs;
  const candidates = [...ended, ...stack];
  let best = 0;
  const overlaps = new Map<LabelEntry, number>();
  for (const entry of candidates) {
    const from = Math.max(entry.startedAt, lateStart);
    const to = Math.min(entry.endedAt ?? now, now);
    const overlap = to - from;
    if (overlap <= 0) continue;
    overlaps.set(entry, overlap);
    if (overlap > best) best = overlap;
  }
  if (best <= 0) return null;
  let pick: LabelEntry | null = null;
  for (const [entry, overlap] of overlaps) {
    if (overlap < best * NEAR_BEST_FRACTION) continue;
    if (pick === null || entry.seq > pick.seq) pick = entry;
  }
  return pick;
}

function tick(): void {
  timer = null;
  if (!running) return;
  const now = nowFn();
  const elapsed = now - lastTickAt;
  const lagMs = elapsed - sampleMs;
  const stalled = lagMs >= stallMs;
  const culprit = stalled ? attribute(now) : null;

  lastTickAt = now;
  ended = [];
  // Re-arm BEFORE reporting so a sink that itself blocks (or throws) can't
  // leave the sampler dead.
  schedule();

  if (!stalled) {
    lastTickWasStall = false;
    lastStallKey = null;
    return;
  }

  // Collapse consecutive over-threshold samples under one label: only the first
  // of a run is reported. The key is the label plus its task so two tasks'
  // identically named labels stay distinct.
  const key = culprit ? `${culprit.label}\u0000${culprit.ctx?.taskId ?? ""}` : "";
  const collapse = lastTickWasStall && lastStallKey === key;
  lastTickWasStall = true;
  lastStallKey = key;
  if (collapse) return;

  const stall: LagStall = {
    lagMs,
    label: culprit?.label ?? null,
    ctx: culprit?.ctx ?? null,
  };
  console.warn(
    `[agetor] core was unresponsive for ${(lagMs / 1000).toFixed(1)}s during ${stall.label ?? "idle"}`,
  );
  if (sink) {
    try {
      sink(stall);
    } catch (e) {
      console.warn("[agetor] lag stall sink threw:", e instanceof Error ? e.message : e);
    }
  }
}
