import { getClient, type Flags } from "../context.ts";
import { usageError } from "../usage.ts";
import { resolveTask } from "../resolve.ts";
import { runControl, resumableRunId } from "../run-logic.ts";
import { c, out, printJson } from "../output.ts";
import { resolveRefs, warnMissingRefs } from "../refs.ts";
import { appendReferences } from "../../shared/refs.ts";
import { discoveredExtensionNames, filterUnresolvedRefs, warnUnresolvedRefs } from "../at-warn.ts";
import { findAtTokens } from "../../shared/at-refs.ts";

export async function cmdStart(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("start");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const short = task.id.slice(0, 8);
  if (task.archivedAt != null) {
    throw new Error("task is archived — unarchive it in the app before running");
  }
  // Match the dashboard Run button: only a not-yet-run (or failed/cancelled)
  // task is runnable. Active tasks are Stop; finished tasks are continued by
  // sending a message (the app resumes rather than starting a fresh run).
  const control = runControl(task);
  if (control === "stop") {
    throw new Error(
      `task is already running — stop it with 'agetor cancel ${short}', ` +
        `answer with 'agetor answer ${short}', or continue with 'agetor send ${short} <message>'`,
    );
  }
  if (control === "open") {
    throw new Error(
      `task already has a run — continue it with 'agetor send ${short} <message>'. ` +
        "Agetor resumes the conversation rather than starting a fresh run, matching the app.",
    );
  }
  const res = await client.startTask(task.id);
  if (flags.json) return printJson(res);
  if (res.unresolvedRefs?.length) {
    const extensionNames = await discoveredExtensionNames(client, task);
    let tokens = res.unresolvedRefs;
    if (task.issueUrl) {
      // A started task's prompt is whatever `task.prompt` already holds — for
      // an issue-seeded task that's the composed thread body, and the CLI has
      // no record here of any user-typed portion to `restrictTo` against the
      // way `agetor add --issue` does (it captures `userTypedPrompt` before
      // composition, at create time; by `start` time that distinction is
      // gone). Heuristic instead of a `restrictTo` restriction: a real
      // file/dir path virtually always carries a `/` or a `.` (extension)
      // somewhere in it, while an issue-thread `@mention` (`@octocat`,
      // `@some-org`) is a bare word with neither — drop those, on top of the
      // extension-name exemption every path shares below. Plain (non-issue)
      // tasks get no such heuristic: nothing composes third-party mentions
      // into their prompt.
      tokens = tokens.filter((raw) => {
        const token = findAtTokens(raw)[0];
        return !token || token.path.includes("/") || token.path.includes(".");
      });
    }
    warnUnresolvedRefs(filterUnresolvedRefs(tokens, { extensionNames, restrictTo: null }));
  }
  out(`${c.cyan("▸")} started ${c.dim(short)} — run ${res.runId.slice(0, 8)}`);
}

export async function cmdSend(args: string[], flags: Flags): Promise<void> {
  // Pull `--ref <path>` flags out; the remaining positionals are <id> <message…>.
  const refPaths: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref") {
      const v = args[++i];
      if (v) refPaths.push(v);
    } else {
      rest.push(args[i]!);
    }
  }
  const ref = rest[0];
  const message = rest.slice(1).join(" ").trim();
  if (!ref || (!message && refPaths.length === 0)) throw usageError("send");

  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const short = task.id.slice(0, 8);
  if (task.archivedAt != null) {
    throw new Error("task is archived — unarchive it in the app before sending");
  }
  // Match the run panel: a pending question blocks sending — answer it first.
  if (task.pendingInteractionCount > 0) {
    throw new Error(`task is waiting for an answer — respond first with 'agetor answer ${short}'`);
  }
  // Resolve the run to send to the same way the app does: the live run, else
  // the most recent one so the backend can resume the session. Only fetch the
  // run list when there's no live run — resumableRunId ignores it otherwise.
  const runs = task.runId ? [] : await client.getRuns(task.id);
  const runId = resumableRunId(task, runs);
  if (!runId) {
    throw new Error(`task has no run yet — start it first: agetor start ${short}`);
  }
  // Inline any --ref paths into the message (absolute, so the agent finds them);
  // claude attaches image paths. Same plumbing as the app's send box.
  const refs = resolveRefs(refPaths);
  warnMissingRefs(refs);
  const body = refs.length ? appendReferences(message, refs) : message;
  const res = await client.sendInput(runId, body);
  if (!res.delivered) throw new Error(res.reason ?? "message was not delivered");
  // `--json` mode carries the server's raw `unresolvedRefs` in `res` as-is —
  // this discovery-filtered, human-phrased warning is a plain-mode nicety.
  if (flags.json) return printJson(res);
  if (res.unresolvedRefs?.length) {
    // `discoveredExtensionNames` is already fail-open (a discovery failure
    // must not fail an already-delivered send — falls back to no exemptions,
    // over-warn rather than crash).
    const extensionNames = await discoveredExtensionNames(client, task);
    warnUnresolvedRefs(filterUnresolvedRefs(res.unresolvedRefs, { extensionNames }));
  }
  const refNote = refPaths.length ? c.dim(` (+${refPaths.length} ref${refPaths.length > 1 ? "s" : ""})`) : "";
  out(`${c.green("→")} sent to ${c.dim(short)}${refNote}`);
}

export async function cmdCancel(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("cancel");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  // Stop is only meaningful while active (running/blocked) — same as the app.
  if (runControl(task) !== "stop" || !task.runId) {
    throw new Error("task is not running");
  }
  const res = await client.cancelRun(task.runId);
  if (flags.json) return printJson(res);
  out(`${c.yellow("■")} cancel requested for ${c.dim(task.id.slice(0, 8))}`);
}

export async function cmdRm(args: string[], flags: Flags): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const ref = positionals[0];
  const yes = args.includes("--yes") || args.includes("-y") || flags.json;
  if (!ref) throw usageError("rm");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  if (!yes) {
    out(
      c.yellow(
        `refusing to delete without --yes. Would delete "${task.title}" (${task.id.slice(0, 8)}) ` +
          "and its worktree + branch.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  await client.deleteTask(task.id);
  if (flags.json) return printJson({ deleted: task.id });
  out(`${c.red("✗")} deleted ${c.dim(task.id.slice(0, 8))}`);
}
