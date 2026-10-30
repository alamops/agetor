import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ApiError, type AgetorClient } from "../api-client.ts";
import type { AnyRequest } from "../../bun/interactions.ts";
import { buildAskAnswer } from "../answer-logic.ts";
import { CURSOR_ASK_FREEFORM } from "../../shared/cursor-ask-verdict.ts";
import { cursorAskOptionChoiceLabel, cursorAskOptionValue, cursorAskPicksFromValues } from "../../shared/cursor-ask.ts";
import { sanitizeDrop } from "./paste.ts";

const OTHER = "✎ Other — type a custom answer";
const SKIP = "Skip";

/**
 * Answer a task's pending interaction inline — the in-dashboard equivalent of
 * `agetor answer`. Walks an ask_questions request question-by-question (↑/↓ to
 * move, space to toggle in multi-select, enter to advance/submit), with an
 * "Other" row that drops into a one-line text field for a free-text answer; or
 * a tmux_prompt or fx_permission as a single choice list (fx's trailing row is
 * "Dismiss (reject)" rather than "Reject / Esc"). Esc always just closes the
 * overlay (`onCancel`) without answering — the interaction stays pending for
 * a later `agetor answer` / re-open, it does not submit a rejection to the
 * server. Mounted only in answer mode, so its useInput owns the keyboard.
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
  const [answers, setAnswers] = useState<Array<{ selected: string[]; selectedOptionIds?: string[]; custom?: string }>>([]);
  // null = picking options; a string = typing a custom answer for this question.
  const [custom, setCustom] = useState<string | null>(null);
  const [hint, setHint] = useState("");

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

  // Record this question's answer, then advance or submit. Returns false when
  // the (selected, custom) pair is empty so the caller can surface a hint.
  const commitAnswer = (selected: string[], customText: string | null): boolean => {
    if (!req || req.kind !== "ask_questions") return true;
    const entry = buildAskAnswer(selected, customText);
    if (!entry) return false;
    const question = req.questions[qIndex];
    let posted: { selected: string[]; selectedOptionIds?: string[]; custom?: string } = entry;
    if (req.source === "cursor" && question) {
      const mapped = cursorAskPicksFromValues(question.options, entry.selected);
      posted = entry.custom ? { ...mapped, custom: entry.custom } : mapped;
    }
    if (
      req.source === "cursor"
      && CURSOR_ASK_FREEFORM === "unsupported"
      && entry.custom
    ) {
      // Options plus typed text (multi-select Other) must not submit: Cursor
      // would receive only the options, and the overlay would say answered.
      setHint("Cursor cannot accept a custom answer — pick an option");
      setCustom(null);
      return false;
    }
    const next = [...answers, posted];
    if (qIndex + 1 < req.questions.length) {
      setAnswers(next);
      setQIndex((i) => i + 1);
      setCursor(0);
      setToggled(new Set());
      setCustom(null);
      setHint("");
    } else {
      setSubmitting(true);
      client
        .answerAskQuestions(req.id, next)
        .then((r) => onDone(r.ok ? "✓ answered" : "answer failed"))
        .catch((e) => {
          // A 400 leaves the card pending. Closing the overlay here stranded
          // the question with no way to pick an option except reopening.
          if (e instanceof ApiError && e.status === 400) {
            setSubmitting(false);
            setCustom(null);
            setHint(e.message || "Cursor cannot accept a custom answer — pick an option");
            return;
          }
          onDone(`! ${(e as Error).message}`);
        });
    }
    return true;
  };

  useInput(
    (input, key) => {
      if (loading || submitting || !req) {
        if (key.escape) return onCancel();
        return;
      }

      // Typing a custom (free-text) answer.
      if (custom !== null) {
        if (key.escape) return setCustom(null); // back to the option list
        if (key.return) {
          const text = custom.trim();
          if (!text) return setCustom(null);
          const q = req.kind === "ask_questions" ? req.questions[qIndex] : undefined;
          const selected = q?.multiSelect
            ? [...toggled].filter((i) => i < q.options.length).map((i) => optionPickValue(req, q.options[i]!))
            : [];
          commitAnswer(selected, text);
          return;
        }
        if (key.backspace || key.delete) return setCustom((s) => (s ?? "").slice(0, -1));
        if (input && !key.ctrl && !key.meta) {
          const chunk = input.length > 1 ? sanitizeDrop(input) : input;
          return setCustom((s) => (s ?? "") + chunk);
        }
        return;
      }

      if (key.escape) return onCancel();
      if (key.upArrow || input === "k") {
        setHint("");
        if (labels.length > 0) setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setHint("");
        if (labels.length > 0) setCursor((c) => Math.min(labels.length - 1, c + 1));
        return;
      }

      if (req.kind === "ask_questions") {
        const q = req.questions[qIndex]!;
        const otherIndex = q.options.length; // the appended "✎ Other" row
        const skipIndex = req.source === "cursor" ? otherIndex + 1 : -1;
        if (skipIndex >= 0 && cursor === skipIndex && (key.return || input === " ")) {
          setSubmitting(true);
          client
            .answerAskQuestions(req.id, { skip: true })
            .then((r) => onDone(r.ok ? "✓ skipped" : "answer failed"))
            .catch((e) => {
              // A 400 leaves the card pending. Closing here stranded Skip
              // the same way a refused submit used to.
              if (e instanceof ApiError && e.status === 400) {
                setSubmitting(false);
                setHint(e.message || "could not skip");
                return;
              }
              onDone(`! ${(e as Error).message}`);
            });
          return;
        }
        if (q.multiSelect && input === " ") {
          setHint("");
          return setToggled((s) => {
            const n = new Set(s);
            if (n.has(cursor)) n.delete(cursor);
            else n.add(cursor);
            return n;
          });
        }
        if (key.return) {
          if (q.multiSelect) {
            if (toggled.has(otherIndex)) return setCustom(""); // collect free text, then submit
            const selected = [...toggled].filter((i) => i < q.options.length).map((i) => optionPickValue(req, q.options[i]!));
            if (!commitAnswer(selected, null)) setHint("pick an option or ✎ Other to answer");
            return;
          }
          if (cursor === otherIndex) return setCustom(""); // single-select "Other"
          const pick = q.options[cursor];
          if (!pick) return;
          commitAnswer([optionPickValue(req, pick)], null);
          return;
        }
        return;
      }

      // tmux_prompt — last entry is the synthetic "reject".
      if (key.return && req.kind === "tmux_prompt") {
        const isReject = cursor === req.choices.length;
        setSubmitting(true);
        const body = isReject ? { reject: true } : { key: req.choices[cursor]!.key };
        client
          .answerTmuxPrompt(req.id, body)
          .then((r) => onDone(r.ok ? "✓ answered" : `! ${r.error ?? "failed"}`))
          .catch((e) => onDone(`! ${(e as Error).message}`));
      }

      // fx_permission — last entry is the synthetic "Dismiss (reject)".
      if (key.return && req.kind === "fx_permission") {
        const isDismiss = cursor === req.options.length;
        setSubmitting(true);
        const body = isDismiss
          ? ({ cancel: true } as const)
          : { optionId: req.options[cursor]!.optionId };
        client
          .answerFxPermission(req.id, body)
          .then((r) =>
            onDone(r.ok ? (isDismiss ? "✓ dismissed" : "✓ answered") : "already resolved"),
          )
          .catch((e) => onDone(`! ${(e as Error).message}`));
      }
    },
    { isActive: true },
  );

  if (loading) return <Text dimColor>loading question…</Text>;
  if (submitting) return <Text dimColor>submitting…</Text>;
  if (!req) return <Text dimColor>nothing pending — esc to close</Text>;

  const multi = req.kind === "ask_questions" && !!req.questions[qIndex]?.multiSelect;
  const width = (process.stdout.columns || 80) - 6;
  return (
    <Box flexDirection="column">
      {req.kind === "ask_questions" && req.title ? (
        <Text bold wrap="truncate-end">{req.title}</Text>
      ) : null}
      <Text bold color="yellow">
        {req.kind === "ask_questions"
          ? `Question ${qIndex + 1}/${req.questions.length}`
          : "Prompt"}
        {/* A pipeline parent's pending list aggregates its hidden step
            tasks' cards — name the step task when it isn't the one the
            user pressed `g` on. */}
        {req.taskId !== taskId ? <Text dimColor> ↳ on step task {req.taskId.slice(0, 8)}</Text> : null}
      </Text>
      {req.kind === "ask_questions" ? (
        <Text wrap="truncate-end">{req.questions[qIndex]?.question}</Text>
      ) : req.kind === "fx_permission" ? (
        <Text dimColor wrap="truncate-end">
          {(req.toolCall.title ?? req.toolCall.kind ?? "tool call") +
            (req.toolCall.kind ? `  [${req.toolCall.kind}]` : "") +
            `  (${req.mode})`}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {req.paneText.split("\n").filter(Boolean).slice(-2).join("  ")}
        </Text>
      )}
      {custom !== null ? (
        <Box marginTop={1} width={width}>
          <Text wrap="truncate-start">
            <Text color="cyan">✎ </Text>
            {custom}
            <Text color="cyan">▏</Text>
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {labels.map((label, i) => (
            <Text key={i} color={i === cursor ? "cyan" : undefined}>
              {i === cursor ? "▸ " : "  "}
              {multi ? (toggled.has(i) ? "[x] " : "[ ] ") : ""}
              {label}
            </Text>
          ))}
        </Box>
      )}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}

function optionPickValue(req: AnyRequest, option: { id?: string; label: string }): string {
  return req.kind === "ask_questions" && req.source === "cursor" ? cursorAskOptionValue(option) : option.label;
}

function optionLabels(req: AnyRequest | null, qIndex: number): string[] {
  if (!req) return [];
  if (req.kind === "ask_questions") {
    const options = req.questions[qIndex]?.options ?? [];
    const labels = [
      ...options.map((option) => req.source === "cursor" ? cursorAskOptionChoiceLabel(option, options) : option.label),
      OTHER,
    ];
    if (req.source === "cursor") labels.push(SKIP);
    return labels;
  }
  if (req.kind === "fx_permission") {
    return [...req.options.map((o) => o.name), "Dismiss (reject)"];
  }
  return [...req.choices.map((ch) => ch.label), "Reject / Esc"];
}
