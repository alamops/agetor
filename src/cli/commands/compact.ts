import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, errln, isTTY, out, printJson } from "../output.ts";
import { ApiError, type AgetorClient } from "../api-client.ts";
import { usageError } from "../usage.ts";
import { escapeControlChars } from "../../shared/terminal-text.ts";
import type { DbStats } from "../../shared/types.ts";

/**
 * `agetor compact [--yes|-y] [--json]` — reclaim disk space by `VACUUM`ing the
 * core's SQLite database (`docs/plans/non-blocking-session-restore.md` §2.4),
 * the CLI twin of Settings → General → "Compact database".
 *
 * A VACUUM rewrites the whole file on the core's single main thread, so the
 * core (app, API, SSE) does not respond for the duration — the estimate shown
 * up front (`~N s`) is `DbStats.compactEstimateSec`. The core refuses a Compact
 * while any run is in flight (409); this command prints that hint up front when
 * `activeRunCount > 0` but still lets the server decide, so the answer can
 * never be stale relative to what the core will actually enforce.
 *
 * Consent: a terminal asks (default No); a script has to pass `--yes`. `--json`
 * never prompts, so `--json` WITHOUT `--yes` is a read-only report — it prints
 * `{ stats }` and compacts nothing — while `--json --yes` compacts and prints
 * `{ stats, result }`. A 409 refusal prints the server's body (`--json`) or its
 * message and sets exit status 1.
 */

/** `--yes` / `-y` — compact without asking. */
interface CompactFlags {
  yes: boolean;
}

function parseCompactFlags(args: string[]): CompactFlags {
  const f: CompactFlags = { yes: false };
  for (const a of args) {
    if (a === "--yes" || a === "-y") f.yes = true;
    else throw usageError("compact");
  }
  return f;
}

/** Binary-multiple byte formatter (`1.2 GB`), matching how the app shows the
 *  database size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The human-readable stats block printed before the confirmation. */
export function compactStatsLines(stats: DbStats): string[] {
  const total = stats.fileBytes + stats.walBytes;
  const estimate = Math.max(1, Math.round(stats.compactEstimateSec));
  const lines = [
    `${c.bold("database")}     ${formatBytes(total)} on disk ` +
      c.dim(`(file ${formatBytes(stats.fileBytes)} + wal ${formatBytes(stats.walBytes)})`),
    `${c.bold("reclaimable")}  ${formatBytes(stats.reclaimableBytes)}`,
    `${c.bold("estimate")}     ~${estimate} s ${c.dim("— Agetor won't respond while it compacts")}`,
    `${c.bold("active runs")}  ${stats.activeRunCount}`,
  ];
  if (stats.activeRunCount > 0) {
    lines.push(
      c.yellow(
        `! ${stats.activeRunCount} task(s) running — stop or wait for them first; the core will refuse to compact while they run`,
      ),
    );
  }
  return lines;
}

/** Whether to ask before compacting: a terminal on both ends, no --json, no
 *  --yes. `tty` is a test seam (mirrors `bundle.ts`'s `interactiveImport`). */
export function interactiveCompact(
  flags: Pick<Flags, "json">,
  f: CompactFlags,
  tty: { stdout: boolean; stdin: boolean } = { stdout: isTTY, stdin: Boolean(process.stdin.isTTY) },
): boolean {
  return !f.yes && !flags.json && tty.stdout && tty.stdin;
}

/** What `askCompact` prompts with; a test seam. */
export interface AskCompactIo {
  confirm: (opts: { message: string; initialValue: boolean }) => Promise<boolean | symbol>;
  isCancel: (value: unknown) => value is symbol;
  /** Watched for a raw Ctrl+C while the prompt is up. */
  stdin: Pick<NodeJS.ReadStream, "on" | "off">;
}

const defaultAskCompactIo: AskCompactIo = { confirm: p.confirm, isCancel: p.isCancel, stdin: process.stdin };

/**
 * `true` to compact, `false` for No/Esc, `null` for Ctrl+C. @clack/prompts
 * reports Esc and Ctrl+C alike as a cancel, so the raw input is watched for
 * the Ctrl+C byte (same approach as `askImport`): Esc is a plain "cancelled"
 * (exit 0), only Ctrl+C is an interrupt (exit 130).
 */
export async function askCompact(stats: DbStats, io: AskCompactIo = defaultAskCompactIo): Promise<boolean | null> {
  let interrupted = false;
  const onData = (chunk: Buffer | string) => {
    if (String(chunk).includes("\u0003")) interrupted = true;
  };
  io.stdin.on("data", onData);
  let answer: boolean | symbol;
  try {
    answer = await io.confirm({
      message: `Compact the database (~${Math.max(1, Math.round(stats.compactEstimateSec))} s, Agetor won't respond meanwhile)?`,
      initialValue: false,
    });
  } finally {
    io.stdin.off("data", onData);
  }
  if (io.isCancel(answer)) return interrupted ? null : false;
  return answer === true;
}

/** Test seams for `cmdCompact`. */
export interface CompactDeps {
  /** Replaces the terminal check + prompt: called with the fetched stats;
   *  resolve `true` to compact, `false` for No, `null` for Ctrl+C (exit 130). */
  confirm?: (stats: DbStats) => Promise<boolean | null>;
  /** Overrides the terminal check when no `confirm` is injected. */
  tty?: { stdout: boolean; stdin: boolean };
}

export async function cmdCompact(
  args: string[],
  flags: Flags,
  client?: AgetorClient,
  deps: CompactDeps = {},
): Promise<void> {
  const f = parseCompactFlags(args);
  const interactive = interactiveCompact(flags, f, deps.tty);
  // Consent is needed before anything is written: a terminal asks, a script
  // must say --yes. `--json` alone is the read-only report (never prompts).
  if (!f.yes && !flags.json && !interactive && !deps.confirm) {
    throw new Error("compact needs confirmation — pass --yes to compact without asking (usage: agetor compact [--yes|-y] [--json])");
  }
  const api = client ?? (await getClient(flags));

  let stats: DbStats;
  try {
    stats = await api.dbStats();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error("the running agetor core is older than this CLI — update it to use `agetor compact`");
    }
    throw e;
  }

  if (flags.json && !f.yes) return printJson({ stats });

  if (!flags.json) for (const line of compactStatsLines(stats)) out(line);

  if (!f.yes) {
    const confirm = deps.confirm ?? (interactive ? askCompact : null);
    if (confirm) {
      const answer = await confirm(stats);
      if (answer !== true) {
        // Ctrl+C is an interrupt, not a "No": exit 130 like any other one.
        if (answer === null) process.exitCode = 130;
        out(c.dim("cancelled — nothing was compacted"));
        return;
      }
    }
  }

  try {
    const result = await api.compactDb();
    if (flags.json) return printJson({ stats, result });
    out(
      `${c.green("✓")} Compacted: ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)} ` +
        `in ${(result.durationMs / 1000).toFixed(1)} s`,
    );
  } catch (e) {
    // The server refuses while runs are in flight (409 `{ error, activeRunCount }`);
    // surface its message verbatim and fail the command without a stack.
    if (e instanceof ApiError && e.status === 409) {
      if (flags.json) printJson(e.body);
      else errln(c.red(escapeControlChars(e.message)));
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}
