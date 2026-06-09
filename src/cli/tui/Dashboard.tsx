import { memo, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgetorClient, CoreInfo } from "../api-client.ts";
import type { Task, RunEvent } from "../../shared/types.ts";
import { useTasks } from "./useTasks.ts";
import { useCoalescedStream, eventKey } from "./useCoalescedStream.ts";
import { useSpinner } from "./useSpinner.ts";

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
      [...tasks].sort(
        (a, b) => COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column),
      ),
    [tasks],
  );
  const [rawSel, setSel] = useState(0);
  const sel = sorted.length ? Math.min(rawSel, sorted.length - 1) : 0;
  const selected = sorted[sel];
  const events = useCoalescedStream(selected?.id ?? null, dataDir);
  const [status, setStatus] = useState("");

  const anyRunning = useMemo(() => sorted.some((t) => t.column === "running"), [sorted]);
  const frame = useSpinner(anyRunning);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === "j") setSel((s) => Math.min(sorted.length - 1, s + 1));
    if (input === "s" && selected) {
      void client
        .startTask(selected.id)
        .then(() => setStatus(`▸ started ${selected.id.slice(0, 8)}`))
        .catch((e) => setStatus(`! ${e.message}`));
    }
    if (input === "x" && selected?.runId) {
      void client
        .cancelRun(selected.runId)
        .then(() => setStatus(`■ cancel ${selected.id.slice(0, 8)}`))
        .catch((e) => setStatus(`! ${e.message}`));
    }
  });

  const rows = process.stdout.rows || 30;
  const visible = events.slice(-Math.max(8, rows - 9));

  return (
    <Box flexDirection="column" height={rows}>
      <Header core={core} count={tasks.length} />
      <Box flexGrow={1} minHeight={0}>
        <Box
          flexDirection="column"
          width="44%"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          {sorted.length === 0 ? (
            <Text dimColor>no tasks — run `agetor add` to create one</Text>
          ) : (
            sorted.map((t, i) => (
              <TaskRow key={t.id} task={t} active={i === sel} frame={frame} />
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
            <Text dimColor>select a task to watch its conversation</Text>
          )}
        </Box>
      </Box>
      <Footer status={status} />
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
}: {
  task: Task;
  active: boolean;
  frame: string;
}) {
  const glyph = columnGlyph(task, frame);
  const id = task.id.slice(0, 8);
  const title = truncate(task.title, 26);
  const needs = task.pendingInteractionCount > 0 ? ` ‼${task.pendingInteractionCount}` : "";
  return (
    <Text inverse={active} wrap="truncate">
      {active ? "›" : " "} {glyph} <Text dimColor>{id}</Text> {title}
      <Text color="yellow">{needs}</Text>
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
          <Text color="yellow"> · ‼ answer: agetor answer {task.id.slice(0, 8)}</Text>
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
          ⚙ {jsonField(e.data, "name") ?? "tool"}
        </Text>
      );
    case "tool_result":
      return <Text dimColor>  ↳ result</Text>;
    case "interaction":
      return (
        <Text color="yellow" wrap="truncate-end">
          ‼ needs answer — agetor answer {e.taskId.slice(0, 8)}
        </Text>
      );
    case "interaction_resolved":
      return <Text dimColor>✓ answered</Text>;
    default:
      return <Text wrap="truncate-end">{e.data}</Text>;
  }
});

function Footer({ status }: { status: string }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>↑/↓ select · s start · x cancel · q quit</Text>
      {status ? <Text color="cyan">{status}</Text> : <Text> </Text>}
    </Box>
  );
}

function columnGlyph(t: Task, frame: string) {
  if (t.column === "running") return <Text color="cyan">{frame}</Text>;
  if (t.column === "blocked") return <Text color="yellow">‼</Text>;
  if (t.column === "review") return <Text color="green">✓</Text>;
  if (t.column === "done") return <Text color="green">✓</Text>;
  if (t.column === "ready") return <Text dimColor>○</Text>;
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

function jsonField(s: string, field: string): string | undefined {
  try {
    const v = JSON.parse(s) as Record<string, unknown>;
    return typeof v[field] === "string" ? (v[field] as string) : undefined;
  } catch {
    return undefined;
  }
}
