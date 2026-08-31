import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgetorClient, CoreInfo } from "../api-client.ts";
import type { Task, RunEvent } from "../../shared/types.ts";
import { commitPushPrompt, isInternalStatusSentinel } from "../../shared/types.ts";
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

  // `@` file-reference listing for the composer's popover — see at-complete.ts
  // and CLAUDE.md §12. Cached by SCOPE (dir+ref), not by task id: a task
  // cached pre-run under `{dir: workdir, ref: baseRef}` must NOT keep serving
  // that listing once its worktree materializes and `fileScopeForTask` starts
  // returning `{dir: worktreePath}` — same `cacheKey` shape as the webview's
  // `use-project-files.ts`. A fetch failure degrades to no suggestions rather
  // than blocking the composer.
  const [composeFileEntries, setComposeFileEntries] = useState<FileEntry[]>([]);
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
      } catch {
        // Best-effort: no suggestions this time, composer still usable.
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
    return async (q: string): Promise<FileEntry[]> => {
      try {
        const { files } = await client.listProjectFiles({ ...scope, q, limit: 5 });
        return files.map((path) => ({ path, isDirectory: path.endsWith("/") }));
      } catch {
        return [];
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
      } else {
        setStatus("task is not running");
      }
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
            <Detail task={selected} events={visible} />
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
  width,
}: {
  task: Task;
  active: boolean;
  frame: string;
  width: number;
}) {
  const id = task.id.slice(0, 6);
  const needs = task.pendingInteractionCount;
  // Budget the title so the row can never need to wrap, even if a glyph renders
  // a cell wider than measured in some terminal. The fixed prefix is the marker
  // (2) + glyph (1) + " <id> " (id length + 2); the badge is " !N".
  const inner = width - 4; // border (2) + paddingX (2)
  const prefixW = 2 + 1 + (id.length + 2);
  const badgeW = needs > 0 ? String(needs).length + 2 : 0;
  const titleMax = Math.max(6, inner - prefixW - badgeW);
  return (
    <Text wrap="truncate">
      <Text color="cyan">{active ? "▸ " : "  "}</Text>
      {columnGlyph(task, frame)}
      <Text dimColor> {id} </Text>
      <Text bold={active}>{truncate(task.title, titleMax)}</Text>
      {needs > 0 ? <Text color="yellow"> !{needs}</Text> : null}
    </Text>
  );
});

function Detail({ task, events }: { task: Task; events: RunEvent[] }) {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text bold>{task.title}</Text> <Text dimColor>{task.id.slice(0, 8)}</Text>{" "}
        <Text color={columnColor(task.column)}>{task.column}</Text>
        {task.pendingInteractionCount > 0 ? (
          <Text color="yellow"> · ! press g to answer</Text>
        ) : null}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {events.length === 0 ? (
          <Text dimColor>no events yet</Text>
        ) : (
          events.map((e) => <EventLine key={eventKey(e)} e={e} />)
        )}
      </Box>
    </Box>
  );
}

const EventLine = memo(function EventLine({ e }: { e: RunEvent }) {
  switch (e.stream) {
    case "user":
      return (
        <Text wrap="truncate-end">
          <Text color="cyan">you› </Text>
          {e.data}
        </Text>
      );
    case "assistant":
      return <Text wrap="truncate-end">{e.data}</Text>;
    case "thinking":
      return (
        <Text dimColor wrap="truncate-end">
          {e.data}
        </Text>
      );
    case "status":
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
    case "stderr":
      return (
        <Text color="red" wrap="truncate-end">
          {e.data}
        </Text>
      );
    case "tool_use":
      return (
        <Text color="magenta" wrap="truncate-end">
          ▸ {jsonField(e.data, "name") ?? "tool"}
        </Text>
      );
    case "tool_result":
      return <Text dimColor>  ↳ result</Text>;
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
        : "↑/↓ select · s run · x stop · m msg · c commit · g answer · q quit";
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

function jsonField(s: string, field: string): string | undefined {
  try {
    const v = JSON.parse(s) as Record<string, unknown>;
    return typeof v[field] === "string" ? (v[field] as string) : undefined;
  } catch {
    return undefined;
  }
}
