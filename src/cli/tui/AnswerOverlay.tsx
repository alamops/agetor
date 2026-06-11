import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgetorClient } from "../api-client.ts";
import type { AnyRequest } from "../../bun/interactions.ts";

/**
 * Answer a task's pending interaction inline — the in-dashboard equivalent of
 * `agetor answer`. Walks an ask_questions request question-by-question (↑/↓ to
 * move, space to toggle in multi-select, enter to advance/submit) or a
 * tmux_prompt as a single choice list. Esc cancels. Mounted only in answer
 * mode, so its useInput owns the keyboard while open.
 */
export function AnswerOverlay({
  client,
  taskId,
  onDone,
  onCancel,
}: {
  client: AgetorClient;
  taskId: string;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [req, setReq] = useState<AnyRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [qIndex, setQIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [toggled, setToggled] = useState<Set<number>>(new Set());
  const [answers, setAnswers] = useState<Array<{ selected: string[] }>>([]);

  useEffect(() => {
    let alive = true;
    client
      .pendingInteractions(taskId)
      .then((pending) => {
        if (!alive) return;
        if (!pending[0]) {
          onDone("nothing pending");
          return;
        }
        setReq(pending[0]);
        setLoading(false);
      })
      .catch((e) => {
        if (alive) onDone(`! ${(e as Error).message}`);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, taskId]);

  const labels = optionLabels(req, qIndex);

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (loading || submitting || !req) return;
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j") return setCursor((c) => Math.min(labels.length - 1, c + 1));

      if (req.kind === "ask_questions") {
        const q = req.questions[qIndex]!;
        if (q.multiSelect && input === " ") {
          return setToggled((s) => {
            const n = new Set(s);
            if (n.has(cursor)) n.delete(cursor);
            else n.add(cursor);
            return n;
          });
        }
        if (key.return) {
          let selected: string[];
          if (q.multiSelect) {
            selected = [...toggled].map((i) => q.options[i]!.label);
          } else {
            const pick = q.options[cursor];
            if (!pick) return; // empty/malformed question — nothing to submit
            selected = [pick.label];
          }
          const next = [...answers, { selected }];
          if (qIndex + 1 < req.questions.length) {
            setAnswers(next);
            setQIndex((i) => i + 1);
            setCursor(0);
            setToggled(new Set());
          } else {
            setSubmitting(true);
            client
              .answerAskQuestions(req.id, next)
              .then((r) => onDone(r.ok ? "✓ answered" : "answer failed"))
              .catch((e) => onDone(`! ${(e as Error).message}`));
          }
        }
        return;
      }

      // tmux_prompt — last entry is the synthetic "reject".
      if (key.return) {
        const isReject = cursor === req.choices.length;
        setSubmitting(true);
        const body = isReject ? { reject: true } : { key: req.choices[cursor]!.key };
        client
          .answerTmuxPrompt(req.id, body)
          .then((r) => onDone(r.ok ? "✓ answered" : `! ${r.error ?? "failed"}`))
          .catch((e) => onDone(`! ${(e as Error).message}`));
      }
    },
    { isActive: true },
  );

  if (loading) return <Text dimColor>loading question…</Text>;
  if (submitting) return <Text dimColor>submitting…</Text>;
  if (!req) return <Text dimColor>nothing pending — esc to close</Text>;

  const multi = req.kind === "ask_questions" && !!req.questions[qIndex]?.multiSelect;
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        {req.kind === "ask_questions"
          ? `Question ${qIndex + 1}/${req.questions.length}`
          : "Prompt"}
      </Text>
      {req.kind === "ask_questions" ? (
        <Text wrap="truncate-end">{req.questions[qIndex]?.question}</Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {req.paneText.split("\n").filter(Boolean).slice(-2).join("  ")}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {labels.map((label, i) => (
          <Text key={i} color={i === cursor ? "cyan" : undefined}>
            {i === cursor ? "▸ " : "  "}
            {multi ? (toggled.has(i) ? "[x] " : "[ ] ") : ""}
            {label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function optionLabels(req: AnyRequest | null, qIndex: number): string[] {
  if (!req) return [];
  if (req.kind === "ask_questions") {
    return req.questions[qIndex]?.options.map((o) => o.label) ?? [];
  }
  return [...req.choices.map((ch) => ch.label), "Reject / Esc"];
}
