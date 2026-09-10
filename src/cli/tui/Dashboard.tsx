import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgetorClient, CoreInfo } from "../api-client.ts";
import type { Task, RunEvent } from "../../shared/types.ts";
import { FX_RECOVERY_STATUS_PREFIX, commitPushPrompt, isInternalStatusSentinel } from "../../shared/types.ts";
import {
  fxAutoResumeCountdownText,
  fxRecoveryNoticeText,
  isTaskFxPaused,
  parseFxRecoveryPayload,
} from "../../shared/fx-recovery.ts";
import { userMessageLines, type PlainLine } from "../../shared/user-message.ts";
import {
  parseSentFilesToolUse,
  parseSentFilesToolResult,
  sanitizeToolResultAttachments,
  sentFilesSummaryLine,
  type SentFilesRequest,
  type SentFilesResult,
} from "../../shared/sent-files.ts";
import { useTasks } from "./useTasks.ts";
import { useCoalescedStream, eventKey } from "./useCoalescedStream.ts";
import { useSpinner } from "./useSpinner.ts";
import { useGlobalEvents, type Toast } from "./useGlobalEvents.ts";
import { Composer } from "./Composer.tsx";
import { AnswerOverlay } from "./AnswerOverlay.tsx";
import { runControl, resumableRunId } from "../run-logic.ts";
import { Logo } from "./logo.tsx";
import { fileScopeForTask } from "./at-complete.ts";
import { buildFileEntries, type FileEntry } from "../../shared/at-file-filter.ts";
// `../at-warn.ts` is owned by a sibling — import its pure exports only, never edit the file.
import { discoveredExtensionNames, filterUnresolvedRefs } from "../at-warn.ts";

type Mode = "nav" | "compose" | "answer";

// Surface the most actionable columns first.
const COLUMN_ORDER = ["running", "blocked", "review", "ready", "backlog", "done"];

export function Dashboard({
  client,
  core,
  dataDir,
}: {
  client: AgetorClient;
  core: CoreInfo;
  dataDir?: string;
}) {
  const { exit } = useApp();
  const tasks = useTasks(client);
  const sorted = useMemo(
    () =>
      tasks
        .filter((t) => t.archivedAt == null)
        .sort((a, b) => COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column)),
    [tasks],
  );
  const [rawSel, setSel] = useState(0);
  const sel = sorted.length ? Math.min(rawSel, sorted.length - 1) : 0;
  const selected = sorted[sel];
  const events = useCoalescedStream(selected?.id ?? null, dataDir);
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<Mode>("nav");
  // The compose/answer target is PINNED by id when the mode opens — the 1.5s
  // poll re-sorts the board, so following `sorted[sel]` could redirect a send
  // or answer to whatever task slid into that slot. Resolve by id each render
  // so runId / pendingInteractionCount stay fresh but the task can't change.
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = targetId ? sorted.find((t) => t.id === targetId) ?? null : null;
  const toast = useGlobalEvents(dataDir);

  // Never let a mode get stranded (and the keyboard dead) if the target task
  // disappears from the board while composing / answering.
  useEffect(() => {
    if (mode !== "nav" && !target) setMode("nav");
  }, [mode, target]);

  const anyRunning = useMemo(() => sorted.some((t) => t.column === "running"), [sorted]);
  const frame = useSpinner(anyRunning);
  // Countdown clock for the `⏸ auto-resume m:ss` row/detail hints
  // (`docs/plans/fx-recovery-follow-ups.md` §2/T6) — same "decoupled from
  // data, zero cost when idle" shape as `useSpinner`/`frame` above: only
  // ticks (1/s) while some VISIBLE (non-archived, currently `sorted`) task
  // has a pending `fxRecovery.autoResume` timer, and every countdown read
  // (`fxAutoResumeCountdownText`) takes this shared `now` rather than
  // calling `Date.now()` per row, so all rows/the detail pane repaint in
  // lockstep on the same tick.
  const hasPendingAutoResume = useMemo(
    () => sorted.some((t) => t.fxRecovery?.autoResume != null),
    [sorted],
  );
  const now = useClockTick(hasPendingAutoResume);

  // `@` file-reference listing for the composer's popover — see at-complete.ts
  // and CLAUDE.md §12. Cached by SCOPE (dir+ref), not by task id: a task
  // cached pre-run under `{dir: workdir, ref: baseRef}` must NOT keep serving
  // that listing once its worktree materializes and `fileScopeForTask` starts
  // returning `{dir: worktreePath}` — same `cacheKey` shape as the webview's
  // `use-project-files.ts`. A fetch failure degrades to no suggestions rather
  // than blocking the composer.
  const [composeFileEntries, setComposeFileEntries] = useState<FileEntry[]>([]);
  const [composeListingError, setComposeListingError] = useState<string | null>(null);
  // Whether the last fetch for the CURRENT scope hit the server's
  // `MAX_PROJECT_FILES` cap (CLAUDE.md §12's monorepo fallback) — when true,
  // the local `composeFileEntries` listing is known-incomplete, so the
  // composer's `@` popover falls back to a per-keystroke server-side search
  // instead of ranking only the capped local set (see `composeRemoteSearch`
  // below).
  const [composeTruncated, setComposeTruncated] = useState(false);
  // Entries are cached per SCOPE but only trusted while the task's column is
  // unchanged: a column transition means a run settled (or started) and the
  // agent may have written files since the fetch — the TUI mirror of the
  // webview composer's `fileScopeRefreshToken={task.column}`.
  const fileEntriesCache = useRef<Map<string, { entries: FileEntry[]; column: string; truncated: boolean }>>(new Map());
  // `target` is resolved by id (see above) so this stays valid even though
  // `sorted` reshuffles every 1.5s poll.
  const composeScope = target ? fileScopeForTask(target) : null;
  const composeScopeKey = composeScope ? `${composeScope.dir} ${composeScope.ref ?? ""}` : null;
  // Stable string (unlike `target`'s per-poll identity) — its CHANGE is the
  // run-settle signal that invalidates the listing cache below.
  const composeColumn = target ? target.column : null;

  // `agentDiscovery`'s `@name` extension names for a task (the ExtensionPicker's
  // own mention syntax, e.g. `@github` — never a file reference). Delegates
  // the actual fetch/mapping to `discoveredExtensionNames` (`../at-warn.ts`,
  // owned by a sibling — shared with `commands/add.ts`/`commands/lifecycle.ts`
  // so all three surfaces agree on what's exempt and on fail-open-to-empty
  // behavior), adding only a per-task-id cache on top: unlike the file-listing
  // scope, agent/workdir/branch don't change mid-task the way a worktree
  // materializing does, so there's no need to key this on scope.
  const extensionNamesCache = useRef<Map<string, Set<string>>>(new Map());
  const getExtensionNames = async (task: Task): Promise<Set<string>> => {
    const cached = extensionNamesCache.current.get(task.id);
    if (cached) return cached;
    const names = await discoveredExtensionNames(client, task);
    extensionNamesCache.current.set(task.id, names);
    return names;
  };

  useEffect(() => {
    if (mode !== "compose" || !targetId || !target || !composeScope || !composeScopeKey) return;
    // Fire-and-forget: warm the `@name` extension-exemption set used by the
    // post-send/post-start "won't resolve" warning (see `getExtensionNames`
    // below) — independent of, and no slower than, the file listing fetch.
    void getExtensionNames(target);
    setComposeListingError(null);
    const cached = fileEntriesCache.current.get(composeScopeKey);
    if (cached && cached.column === composeColumn) {
      setComposeFileEntries(cached.entries);
      setComposeTruncated(cached.truncated);
      return;
    }
    let alive = true;
    // No cache at all → clear so a previous scope's suggestions can't leak.
    // A stale-COLUMN hit keeps showing while the refetch runs (better than
    // flashing the popover empty mid-compose).
    if (!cached) {
      setComposeFileEntries([]);
      setComposeTruncated(false);
    } else {
      setComposeFileEntries(cached.entries);
      setComposeTruncated(cached.truncated);
    }
    const columnAtFetch = composeColumn ?? "";
    void (async () => {
      try {
        const { files, truncated } = await client.listProjectFiles(composeScope);
        if (!alive) return;
        const entries = buildFileEntries(files);
        fileEntriesCache.current.set(composeScopeKey, { entries, column: columnAtFetch, truncated });
        setComposeFileEntries(entries);
        setComposeTruncated(truncated);
      } catch (e) {
        // Best-effort: no suggestions this time, composer still usable — but
        // tell it WHY, so an @ query renders a notice instead of silently
        // never suggesting (a failed listing must not read as an empty repo).
        if (alive) setComposeListingError((e as Error).message || "file listing unavailable");
      }
    })();
    return () => {
      alive = false;
    };
    // `sorted`/`target`/`composeScope` change every 1.5s poll (new object
    // identity even when the scope is unchanged) and must NOT retrigger this
    // fetch on their own — only a compose-mode open for a different task OR
    // an actual scope change (tracked via the stable `composeScopeKey`
    // string) should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetId, composeScopeKey, composeColumn, client]);

  // Monorepo fallback (CLAUDE.md §12): once the local listing for the
  // current scope came back `truncated` (the 20k `MAX_PROJECT_FILES` cap),
  // per-keystroke ranking over only that capped set would miss real matches
  // further down the tree — so hand the composer a server-side search
  // instead, via `GET /files/index`'s additive `q`/`limit` params. `scope`
  // is captured from whichever render created this memo; its `dir`/`ref`
  // content is guaranteed identical across every render for which
  // `composeScopeKey` (the actual dep below) is unchanged, so a stale
  // object reference here is never a stale VALUE — same trick the file-
  // listing effect above already relies on to stay poll-stable.
  const composeRemoteSearch = useMemo(() => {
    if (!composeTruncated || !composeScope) return undefined;
    const scope = composeScope;
    return async (q: string): Promise<FileEntry[] | null> => {
      try {
        const { files } = await client.listProjectFiles({ ...scope, q, limit: 5 });
        return files.map((path) => ({ path, isDirectory: path.endsWith("/") }));
      } catch {
        // `null`, not `[]` — a request failure must not be indistinguishable
        // from a genuine "zero matches" answer, or Composer.tsx would treat
        // it as authoritative and blank the popover's local rows on a
        // transient network hiccup (review finding, commit 720dffd).
        return null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeTruncated, composeScopeKey, client]);

  const sendMessage = (task: Task, text: string, okLabel = "→ sent") => {
    if (task.pendingInteractionCount > 0) {
      setStatus("answer the pending question first (g)");
      return;
    }
    void (async () => {
      try {
        // Mirror `agetor send`: the live run if any, else the newest so the
        // backend resumes the session.
        const runs = task.runId ? [] : await client.getRuns(task.id);
        const runId = resumableRunId(task, runs);
        if (!runId) {
          setStatus("no run yet — press s to start");
          return;
        }
        const res = await client.sendInput(runId, text);
        if (res.delivered === false) {
          setStatus(`! ${res.reason ?? "not delivered"}`);
        } else if (res.unresolvedRefs?.length) {
          // Surface the send-time expansion's leftovers inline — a transient
          // one-line heads-up after the message is already gone, mirroring
          // the webview's "won't resolve" warning at send time. Filtered
          // through the same discovery-based exemption `agetor send`/`agetor
          // add --issue` use (`filterUnresolvedRefs` in `../at-warn.ts`) so an
          // `@name` extension mention (e.g. `@github`) doesn't false-warn.
          const extensionNames = await getExtensionNames(task);
          const filtered = filterUnresolvedRefs(res.unresolvedRefs, { extensionNames });
          const fragment = unresolvedWarningFragment(filtered);
          setStatus(fragment ? truncate(`${okLabel}${fragment}`, 120) : okLabel);
        } else {
          setStatus(okLabel);
        }
      } catch (e) {
        setStatus(`! ${(e as Error).message}`);
      }
    })();
  };

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === "j") setSel((s) => Math.min(sorted.length - 1, s + 1));
    if (input === "m" && selected) {
      setTargetId(selected.id);
      return setMode("compose");
    }
    if (input === "g" && selected) {
      if (selected.pendingInteractionCount > 0) {
        setTargetId(selected.id);
        return setMode("answer");
      }
      setStatus("nothing to answer");
      return;
    }
    if (input === "c" && selected) {
      // No column gate: committing mid-turn is supported (the prompt folds
      // into the in-flight run), and a task held in `running` by background
      // agents may have finished work ready to commit anyway.
      sendMessage(selected, commitPushPrompt(selected), "→ commit & push requested");
      return;
    }
    if (input === "s" && selected) {
      const sid = selected.id.slice(0, 8);
      const ctrl = runControl(selected);
      if (ctrl === "run") {
        const task = selected;
        void (async () => {
          try {
            const res = await client.startTask(task.id);
            if (res.unresolvedRefs?.length) {
              // The discovery set may not be warmed yet — this task may never
              // have been composed to (`getExtensionNames` fails open to an
              // empty set on a discovery error, so a missing/erroring
              // `agentDiscovery` never blocks the "started" status).
              const extensionNames = await getExtensionNames(task);
              const filtered = filterUnresolvedRefs(res.unresolvedRefs, { extensionNames });
              const fragment = unresolvedWarningFragment(filtered);
              if (fragment) {
                setStatus(truncate(`▸ started ${sid}${fragment}`, 120));
                return;
              }
            }
            setStatus(`▸ started ${sid}`);
          } catch (e) {
            setStatus(`! ${(e as Error).message}`);
          }
        })();
      } else if (ctrl === "stop") {
        setStatus("already running — press x to stop");
      } else {
        setStatus(`finished — continue with: agetor send ${sid}`);
      }
    }
    if (input === "x" && selected) {
      const sid = selected.id.slice(0, 8);
      if (runControl(selected) === "stop" && selected.runId) {
        void client
          .cancelRun(selected.runId)
          .then(() => setStatus(`■ stopped ${sid}`))
          .catch((e) => setStatus(`! ${e.message}`));
      } else if (selected.fxRecovery?.autoResume) {
        // Not running (the branch above owns that case) but sitting on a
        // pending fx auto-resume timer — `x` calls it off without resuming
        // the paused response itself (`docs/plans/
        // fx-recovery-follow-ups.md` §3.4/T6).
        void client
          .cancelFxAutoResume(selected.id)
          .then(() => setStatus(`■ auto-resume cancelled ${sid}`))
          .catch((e) => setStatus(`! ${e.message}`));
      } else {
        setStatus("task is not running");
      }
    }
    // Continue an fx response the Vercel AI Gateway (or another recoverable
    // provider error) paused mid-turn — `docs/plans/
    // fix-fx-harness-rate-limit.md` §3.5/T6. No gate on the key itself (a
    // non-fx or non-paused task simply gets the server's `{error}` text back
    // via the `.catch` below, same posture as every other one-shot action
    // here) — the Detail header's "⚠ paused — press r to resume" hint is
    // what tells the user when this key actually does something.
    if (input === "r" && selected) {
      const sid = selected.id.slice(0, 8);
      void client
        .resumeFxRecovery(selected.id)
        .then((r) => setStatus(`▸ resuming ${sid} (run ${r.runId.slice(0, 8)})`))
        .catch((e) => setStatus(`! ${(e as Error).message}`));
      return;
    }
  }, { isActive: mode === "nav" });

  const rows = process.stdout.rows || 30;
  const cols = process.stdout.columns || 90;
  // Fixed character width (not a %) so the rows have a definite budget to
  // truncate against — percentage widths and double-width glyphs are what make
  // rows wrap unexpectedly in a real terminal.
  const listWidth = Math.max(26, Math.min(50, Math.floor(cols * 0.38)));
  const detailWidth = cols - listWidth - 4; // detail box minus list, borders, paddingX
  const visible = events.slice(-Math.max(8, rows - 9));

  return (
    <Box flexDirection="column" height={rows}>
      <Header core={core} count={tasks.length} />
      <Box flexGrow={1} minHeight={0}>
        <Box
          flexDirection="column"
          width={listWidth}
          flexShrink={0}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          {sorted.length === 0 ? (
            <Text dimColor>no tasks — run 'agetor add'</Text>
          ) : (
            sorted.map((t, i) => (
              <TaskRow
                key={t.id}
                task={t}
                active={i === sel}
                frame={frame}
                now={now}
                width={listWidth}
              />
            ))
          )}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          {selected ? (
            <Detail task={selected} events={visible} now={now} />
          ) : (
            <Box flexDirection="column">
              <Logo maxWidth={detailWidth} />
              <Box marginTop={1}>
                <Text dimColor>select a task to watch its conversation</Text>
              </Box>
            </Box>
          )}
        </Box>
      </Box>
      {mode === "compose" && target ? (
        <Composer
          active
          width={cols}
          label={`→ ${target.id.slice(0, 8)}`}
          fileEntries={composeFileEntries}
          listingError={composeListingError}
          remoteSearch={composeRemoteSearch}
          onSubmit={(t) => sendMessage(target, t)}
          onCancel={() => setMode("nav")}
        />
      ) : null}
      {mode === "answer" && target ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} overflow="hidden">
          <AnswerOverlay
            client={client}
            taskId={target.id}
            onDone={(msg) => {
              setStatus(msg);
              setMode("nav");
            }}
            onCancel={() => setMode("nav")}
          />
        </Box>
      ) : null}
      <Footer status={status} toast={toast} mode={mode} />
    </Box>
  );
}

function Header({ core, count }: { core: CoreInfo; count: number }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text color="cyan" bold>
          Agetor
        </Text>
        <Text dimColor> · {count} task{count === 1 ? "" : "s"}</Text>
      </Text>
      <Text dimColor>
        {core.kind} · 127.0.0.1:{core.port} · v{core.version}
      </Text>
    </Box>
  );
}

const TaskRow = memo(function TaskRow({
  task,
  active,
  frame,
  now,
  width,
}: {
  task: Task;
  active: boolean;
  frame: string;
  now: number;
  width: number;
}) {
  const id = task.id.slice(0, 6);
  const needs = task.pendingInteractionCount;
  // fx-pause hint (`docs/plans/fx-recovery-follow-ups.md` §2/T6), same gate
  // as the board card badge and `agetor ls`'s "needs" column: `⏸ paused (r)`
  // with no timer pending, `⏸ auto-resume m:ss` while one counts down.
  const autoResume = task.fxRecovery?.autoResume;
  const pauseText = isTaskFxPaused(task)
    ? autoResume
      ? `⏸ auto-resume ${fxAutoResumeCountdownText(autoResume.at, now)}`
      : "⏸ paused (r)"
    : null;
  // Budget the title so the row can never need to wrap, even if a glyph renders
  // a cell wider than measured in some terminal. The fixed prefix is the marker
  // (2) + glyph (1) + " <id> " (id length + 2); the badge is " !N"; the pause
  // hint (when present) is " · <pauseText>". `pauseText` always leads with a
  // single "⏸" (U+23F8 PAUSE SYMBOL) — code-review fix: most terminals render
  // it double-width, but `.length` (a UTF-16 code-unit count) counts it as 1,
  // so the budget below used to underestimate the hint's true on-screen width
  // by one column. Since `pauseText` is the LAST thing on the row and the row
  // is `wrap="truncate"`, that off-by-one let `titleMax` overrun by one cell,
  // and Ink's own (wcwidth-aware) truncation would then shear a column off
  // whatever renders last — the countdown text itself (e.g. "⏸ auto-resume
  // 1:5" missing its final digit) — rather than the title. The flat `+ 1`
  // below accounts for that one double-width glyph.
  const inner = width - 4; // border (2) + paddingX (2)
  const prefixW = 2 + 1 + (id.length + 2);
  const badgeW = needs > 0 ? String(needs).length + 2 : 0;
  const pauseW = pauseText ? pauseText.length + 3 + 1 : 0;
  const titleMax = Math.max(6, inner - prefixW - badgeW - pauseW);
  return (
    <Text wrap="truncate">
      <Text color="cyan">{active ? "▸ " : "  "}</Text>
      {columnGlyph(task, frame)}
      <Text dimColor> {id} </Text>
      <Text bold={active}>{truncate(task.title, titleMax)}</Text>
      {needs > 0 ? <Text color="yellow"> !{needs}</Text> : null}
      {pauseText ? <Text color="yellow"> · {pauseText}</Text> : null}
    </Text>
  );
});

function Detail({ task, events, now }: { task: Task; events: RunEvent[]; now: number }) {
  // One pass over the visible window pairs every `SendUserFile` tool_use
  // with its (possibly not-yet-arrived) tool_result and formats the result
  // as a PRIMITIVE per event — never a Map. `events` (the `visible` slice in
  // the parent) is a new array reference on every coalesced flush even when
  // its content is unchanged, so a Map computed from it and handed to every
  // `EventLine` as a prop would also be a new reference every flush,
  // defeating `EventLine`'s `memo` for the entire (up to 500-line) window and
  // re-running `tryParseJson` on every tool_use/tool_result each time
  // (review finding). A primitive (`string | null | undefined`) compares by
  // value, so an unrelated line's `sentLine` prop stays `undefined` across
  // flushes and `EventLine`'s shallow memo bails out for it.
  const sentLines = useMemo(() => buildSentFilesLines(events), [events]);
  // Same primitive-not-Map-lookup-in-render discipline as `sentLines` above
  // (see its own doc comment) — `buildFxRecoveryLines` returns the per-event
  // notice text (or `null`) already resolved, so `EventLine`'s memo isn't
  // defeated by handing it a Map reference that's fresh every flush.
  const recoveryLines = useMemo(() => buildFxRecoveryLines(events), [events]);
  // "⚠ paused — press r to resume" header hint (`docs/plans/
  // fx-recovery-follow-ups.md` §2/T6): now driven by the server-managed
  // `task.fxRecovery` field (`isTaskFxPaused`) instead of rescanning this
  // window's events for the newest run's recovery sentinel — the field is
  // written by the SAME settlement path (`attachDoneHandler` →
  // `tasks.setFxRecovery`) that used to be reconstructed here, so this is a
  // read of the persisted result rather than a re-derivation, and it stays
  // correct even when the window (`visible`, capped by terminal rows) has
  // scrolled the relevant run's events out of view. `isTaskFxPaused` already
  // encodes the same "not `running`" guard the old `=== "ready"` check was
  // protecting.
  const showResumeHint = isTaskFxPaused(task);
  const autoResume = task.fxRecovery?.autoResume;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text bold>{task.title}</Text> <Text dimColor>{task.id.slice(0, 8)}</Text>{" "}
        <Text color={columnColor(task.column)}>{task.column}</Text>
        {task.pendingInteractionCount > 0 ? (
          <Text color="yellow"> · ! press g to answer</Text>
        ) : null}
        {showResumeHint ? (
          autoResume ? (
            <Text color="yellow">
              {" "}
              · ⏸ auto-resume in {fxAutoResumeCountdownText(autoResume.at, now)} — r resumes now,
              x cancels
            </Text>
          ) : (
            <Text color="yellow"> · ⚠ paused — press r to resume</Text>
          )
        ) : null}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {events.length === 0 ? (
          <Text dimColor>no events yet</Text>
        ) : (
          events.map((e) => (
            <EventLine
              key={eventKey(e)}
              e={e}
              sentLine={sentLines.get(eventKey(e))}
              recoveryLine={recoveryLines.get(eventKey(e))}
            />
          ))
        )}
      </Box>
    </Box>
  );
}

/** Shape of a `tool_result` event's parsed JSON, minus `toolUseId` (added
 *  separately where the caller needs to key on it). */
interface RawToolResult {
  content?: unknown;
  isError?: boolean;
  attachments?: unknown;
}

/** Cheap literal substring every raw `SendUserFile` tool_use JSON blob
 *  contains — checked before `JSON.parse` so an unrelated tool_use event
 *  (`TodoWrite`, `Bash`, `Read`, …) never pays a parse here. */
const SEND_USER_FILE_MARKER = '"name":"SendUserFile"';

/** Extracts a `tool_result`'s `toolUseId` without a full `JSON.parse` — lets
 *  callers skip parsing a result that can't possibly pair with a known
 *  `SendUserFile` tool_use id. */
const TOOL_RESULT_ID_RE = /"toolUseId":"([^"]*)"/;

/** `toolUseId → { req, result }` for every `SendUserFile` tool_use visible in
 *  `events`, `result` being `null` until a matching `tool_result` arrives.
 *  Mirrors `agetor logs`' closure map (`src/cli/commands/logs.ts`) but as a
 *  pure one-shot pass over a fixed window rather than a streaming reducer —
 *  the dashboard re-derives it every time the visible window changes instead
 *  of mutating a map incrementally. Every event outside this pairing is
 *  skipped without a `JSON.parse`: a `tool_use` must contain
 *  {@link SEND_USER_FILE_MARKER} before it's parsed, and a `tool_result` is
 *  parsed only once its (regex-extracted) `toolUseId` matches one of the ids
 *  collected from the first pass — a `bash`/`Read`/`TodoWrite` tool line
 *  never reaches `JSON.parse` here. */
function buildSentFilesIndex(
  events: RunEvent[],
): Map<string, { req: SentFilesRequest; result: SentFilesResult | null }> {
  const reqById = new Map<string, SentFilesRequest>();
  for (const e of events) {
    if (e.stream !== "tool_use" || !e.data.includes(SEND_USER_FILE_MARKER)) continue;
    const t = tryParseJson(e.data) as { id?: string; name?: string; input?: unknown } | null;
    if (t?.id && t.name) {
      const req = parseSentFilesToolUse(t.name, t.input);
      if (req) reqById.set(t.id, req);
    }
  }
  if (reqById.size === 0) return new Map();

  const rawResultById = new Map<string, RawToolResult>();
  for (const e of events) {
    if (e.stream !== "tool_result") continue;
    const id = TOOL_RESULT_ID_RE.exec(e.data)?.[1];
    if (!id || !reqById.has(id)) continue;
    const t = tryParseJson(e.data) as (RawToolResult & { toolUseId?: string }) | null;
    if (t?.toolUseId) rawResultById.set(t.toolUseId, t);
  }

  const index = new Map<string, { req: SentFilesRequest; result: SentFilesResult | null }>();
  for (const [id, req] of reqById) {
    const raw = rawResultById.get(id);
    const result = raw
      ? parseSentFilesToolResult(raw.content, raw.isError, sanitizeToolResultAttachments(raw.attachments))
      : null;
    index.set(id, { req, result });
  }
  return index;
}

/** `eventKey(e) → already-formatted "📎 …" line` for a `SendUserFile`
 *  tool_use, `null` for its paired tool_result (renders nothing — the
 *  tool_use line already covers it), or simply ABSENT from the map for
 *  every unrelated event. That absence is what makes this safe to hand to
 *  `EventLine` as a prop: `Map.get` on a missing key always returns the same
 *  `undefined` primitive, so an unrelated line's prop is value-equal across
 *  flushes even though the Map itself is a fresh object every time —
 *  exported for the primitive-prop shape assertion in Dashboard.test.tsx. */
export function buildSentFilesLines(events: RunEvent[]): Map<string, string | null> {
  const index = buildSentFilesIndex(events);
  if (index.size === 0) return new Map();

  const lines = new Map<string, string | null>();
  for (const e of events) {
    if (e.stream === "tool_use") {
      if (!e.data.includes(SEND_USER_FILE_MARKER)) continue;
      const t = tryParseJson(e.data) as { id?: string } | null;
      const entry = t?.id ? index.get(t.id) : undefined;
      if (entry) lines.set(eventKey(e), `📎 ${sentFilesSummaryLine(entry.req, entry.result)}`);
    } else if (e.stream === "tool_result") {
      const id = TOOL_RESULT_ID_RE.exec(e.data)?.[1];
      if (id && index.has(id)) lines.set(eventKey(e), null);
    }
  }
  return lines;
}

/**
 * `eventKey(e) → notice text | null` pre-pass for fx's model-response-
 * recovery sentinel (`FX_RECOVERY_STATUS_PREFIX`, see `src/shared/
 * fx-recovery.ts` and `docs/plans/fix-fx-harness-rate-limit.md`), mirroring
 * `buildSentFilesLines` exactly — same primitive-per-event-key shape for
 * the same reason (a Map handed to a memoized `EventLine` must compare by
 * VALUE across flushes, not by a fresh-every-render Map reference). Every
 * recovery-sentinel event maps to `null` (nothing to show — the `status`
 * case already hides it via `isInternalStatusSentinel`, same as the
 * usage/provider/title sentinels) EXCEPT the LAST `state === "active"`
 * sentinel per `runId`, which maps to `fxRecoveryNoticeText(p)` — fx's own
 * live retry-progress line, rendered in place of that one row instead of
 * being suppressed. A payload with `replayed === true` is treated exactly
 * like `null` here — never eligible to become that run's "latest active"
 * line: on `session/resume` fx replays the prior turn's recovery updates
 * (including a terminal `active` one) onto the NEW run, and the driver
 * stamps every replayed sentinel with `replayed: true`. Without this check
 * a replayed `active` update would win the "last active sentinel" race for
 * a run that hasn't actually made a new attempt yet, showing stale retry
 * progress as if it were live. A row whose body fails to parse renders as
 * `null`. Absent entirely (`undefined` on `.get`) for every non-recovery
 * event, same convention as `buildSentFilesLines`.
 */
export function buildFxRecoveryLines(events: RunEvent[]): Map<string, string | null> {
  const lines = new Map<string, string | null>();
  // `runId → { key, text }` of the LAST live (non-replayed) active sentinel
  // seen so far for that run — array order is wire/event order, so the
  // final write per runId wins, matching `latestFxRecoveryByRun`'s "last
  // sentinel per run wins".
  const lastActiveByRun = new Map<string, { key: string; text: string }>();
  for (const e of events) {
    if (e.stream !== "status" || !e.data.startsWith(FX_RECOVERY_STATUS_PREFIX)) continue;
    const key = eventKey(e);
    lines.set(key, null);
    const payload = parseFxRecoveryPayload(e.data.slice(FX_RECOVERY_STATUS_PREFIX.length));
    if (payload?.state === "active" && !payload.replayed) {
      lastActiveByRun.set(e.runId, { key, text: fxRecoveryNoticeText(payload) });
    }
  }
  for (const { key, text } of lastActiveByRun.values()) lines.set(key, text);
  return lines;
}

const EventLine = memo(function EventLine({
  e,
  sentLine,
  recoveryLine,
}: {
  e: RunEvent;
  sentLine: string | null | undefined;
  recoveryLine: string | null | undefined;
}) {
  switch (e.stream) {
    // `userMessageLines` (src/shared/user-message.ts) is the single source of
    // truth for rendering a raw user-turn string across all three surfaces —
    // the webview's transcript bubble, the CLI's `agetor logs`, and this
    // dashboard — so a tagged message (slash-command XML, local-command
    // output, a forked-skill launch, a shell escape, …) prints labeled lines
    // instead of raw `<tag>` text. Ordinary messages render one `you› ` line,
    // identical to today.
    case "user":
      return (
        <Box flexDirection="column">
          {userMessageLines(e.data).map((line, i) => (
            <UserPlainLine key={i} line={line} />
          ))}
        </Box>
      );
    case "assistant":
      return <Text wrap="truncate-end">{e.data}</Text>;
    case "thinking":
      return (
        <Text dimColor wrap="truncate-end">
          {e.data}
        </Text>
      );
    case "status": {
      // `recoveryLine` (from `buildFxRecoveryLines`, computed once per
      // window in `Detail`) is the already-formatted fx-recovery notice for
      // an "active" sentinel, `null` for every other recovery sentinel
      // (hidden), or simply `undefined` for a non-recovery status line —
      // fall through to today's rendering for that last case.
      if (typeof recoveryLine === "string") {
        return (
          <Text color="yellow" wrap="truncate-end">
            {recoveryLine}
          </Text>
        );
      }
      if (recoveryLine === null) return null;
      // Internal-only sentinel status chunks (permission-mode chip, fx usage
      // chip, …) are UI-plumbing, not transcript content — see
      // `isInternalStatusSentinel` in shared/types.ts, the one predicate every
      // raw-status renderer must consult. Skip rendering them.
      if (isInternalStatusSentinel(e.data)) return null;
      return (
        <Text dimColor wrap="truncate-end">
          • {e.data}
        </Text>
      );
    }
    case "stderr":
      return (
        <Text color="red" wrap="truncate-end">
          {e.data}
        </Text>
      );
    case "tool_use": {
      // `sentLine` is the already-formatted "📎 …" text for a `SendUserFile`
      // call (computed once, above, in `buildSentFilesLines`) — `undefined`
      // for every other tool, in which case fall back to the generic
      // `▸ <name>` line (a fresh, but cheap, per-line parse just for the name).
      if (typeof sentLine === "string") {
        return (
          <Text color="magenta" wrap="truncate-end">
            {sentLine}
          </Text>
        );
      }
      const t = tryParseJson(e.data) as { name?: string } | null;
      return (
        <Text color="magenta" wrap="truncate-end">
          ▸ {t?.name ?? "tool"}
        </Text>
      );
    }
    case "tool_result": {
      // A `SendUserFile` result is folded into its paired tool_use line
      // above (once it arrives) — `sentLine === null` marks that pairing;
      // nothing to render here for it.
      if (sentLine === null) return null;
      return <Text dimColor>  ↳ result</Text>;
    }
    case "interaction":
      return (
        <Text color="yellow" wrap="truncate-end">
          ! needs answer — press g
        </Text>
      );
    case "interaction_resolved":
      return <Text dimColor>✓ answered</Text>;
    default:
      return <Text wrap="truncate-end">{e.data}</Text>;
  }
});

/** One `PlainLine` from `userMessageLines`, rendered to match today's
 *  `<Text color="cyan">you› </Text>{data}` shape for the ordinary ("user")
 *  case: label colored, a space, then the text. An `error` line (shell
 *  stderr) colors the whole line red; `machine`/`tag` lines dim only the
 *  label so the text itself (shell stdout, a skill launch line, …) stays
 *  readable. */
function UserPlainLine({ line }: { line: PlainLine }) {
  if (line.tone === "error") {
    return (
      <Text color="red" wrap="truncate-end">
        {line.label} {line.text}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={line.tone === "user" ? "cyan" : undefined} dimColor={line.tone !== "user"}>
        {line.label}{" "}
      </Text>
      {line.text}
    </Text>
  );
}

function Footer({
  status,
  toast,
  mode,
}: {
  status: string;
  toast: Toast | null;
  mode: Mode;
}) {
  const hint =
    mode === "compose"
      ? "type a message · enter send · esc cancel"
      : mode === "answer"
        ? "↑/↓ move · space toggle · enter submit · esc cancel"
        : "↑/↓ select · s run · x stop · m msg · c commit · g answer · r resume · q quit";
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>{hint}</Text>
      {toast ? (
        <Text color={toast.color}>{toast.text}</Text>
      ) : status ? (
        <Text color="cyan">{status}</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

/** Ticks once per second, ONLY while `active` — the "decoupled from data,
 *  zero cost when idle" shape `useSpinner` already uses for `frame`, reused
 *  here so the `⏸ auto-resume m:ss` row/detail-pane countdowns
 *  (`docs/plans/fx-recovery-follow-ups.md` §2/T6) repaint live without
 *  spinning up a timer on a dashboard where nothing is currently paused
 *  with a pending timer. Returns the epoch ms read at the moment the tick
 *  fired, which is exactly what `fxAutoResumeCountdownText(at, now)` wants;
 *  every row/detail pane reads the SAME `now` value from one shared timer
 *  rather than each calling `Date.now()` independently, so they repaint in
 *  lockstep.
 *
 *  Code-review fix: `now`'s initial `useState` runs once, at Dashboard's own
 *  mount — which can be long before `active` ever flips true (nothing was
 *  paused yet when the dashboard opened). Without reseeding, the FIRST
 *  countdown paint after a task pauses used that stale mount-time `now`
 *  against a freshly-scheduled `at`, showing a wrong (too-long) duration for
 *  up to a second until the interval's first tick corrected it. Seeding
 *  `now` synchronously when `active` becomes true — before the interval is
 *  armed — closes that window. */
function useClockTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function columnGlyph(t: Task, frame: string) {
  if (t.column === "running") return <Text color="cyan">{frame}</Text>;
  if (t.column === "blocked") return <Text color="yellow">!</Text>;
  if (t.column === "review" || t.column === "done") return <Text color="green">✓</Text>;
  if (t.column === "ready") return <Text color="blue">○</Text>;
  return <Text dimColor>·</Text>;
}

function columnColor(col: string): string {
  if (col === "running") return "cyan";
  if (col === "blocked") return "yellow";
  if (col === "review" || col === "done") return "green";
  return "white";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** `" · ⚠ N @ ref(s) won't resolve: ..."` fragment for a non-empty, already
 *  discovery-filtered list of raw unresolved `@`-tokens; `""` (nothing to
 *  append) for an empty list. Shared by the post-send and post-start status
 *  lines so the two surfaces can't drift in wording. */
function unresolvedWarningFragment(tokens: string[]): string {
  if (tokens.length === 0) return "";
  const n = tokens.length;
  const preview = tokens.slice(0, 2).join(", ");
  return ` · ⚠ ${n} @ ref${n === 1 ? "" : "s"} won't resolve: ${preview}`;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
