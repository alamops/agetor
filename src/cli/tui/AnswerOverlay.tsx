import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ApiError, type AgetorClient } from "../api-client.ts";
import type { AnyRequest, AskQuestionsRequest, FxPermissionRequest } from "../../bun/interactions.ts";
import {
  buildAskAnswer,
  buildOpencodeAnswerByIndex,
  isOpencodeAsk,
  isOpencodePermission,
  OPENCODE_REJECT_OPTION,
  planOpencodePermissionReply,
} from "../answer-logic.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";
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
 * "Dismiss (reject)" rather than "Reject / Esc"). OpenCode cards differ in
 * three ways: a permission has its own Reject, which asks for an optional
 * reason (none skips the action and the agent continues); a question has the "Other" row only
 * where it takes typed text; and a "Skip" row that also asks for a reason.
 * Esc always just closes the
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
  // OpenCode only: null = no reason being typed; a string = typing the reason
  // for a Reject (`reject`) or a Skip (`skip`). Enter with nothing typed sends
  // no reason.
  const [reason, setReason] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<"reject" | "skip">("reject");

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
  // `indexes` are the picked rows' positions in `question.options`: an OpenCode
  // card is answered by position, so a model-chosen id equal to a sentinel
  // (`__agetor_custom__`) is still just an option.
  const commitAnswer = (selected: string[], customText: string | null, indexes: number[] = []): boolean => {
    if (!req || req.kind !== "ask_questions") return true;
    const question = req.questions[qIndex];
    let posted: { selected: string[]; selectedOptionIds?: string[]; custom?: string };
    // The typed text a Cursor card cannot take (only a non-OpenCode card has any).
    let typed: string | undefined;
    if (isOpencodeAsk(req) && question) {
      // Option ids and typed text, checked against what the question takes.
      const built = buildOpencodeAnswerByIndex(question, indexes, customText);
      if (!built.ok) {
        setHint(built.error);
        setCustom(null);
        return false;
      }
      posted = built.entry;
    } else {
      const entry = buildAskAnswer(selected, customText);
      if (!entry) return false;
      posted = entry;
      typed = entry.custom;
      if (req.source === "cursor" && question) {
        const mapped = cursorAskPicksFromValues(question.options, entry.selected);
        posted = entry.custom ? { ...mapped, custom: entry.custom } : mapped;
      }
    }
    if (
      req.source === "cursor"
      && CURSOR_ASK_FREEFORM === "unsupported"
      && typed
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
            setHint(
              e.message || (req.source === "cursor" ? "Cursor cannot accept a custom answer — pick an option" : "could not answer"),
            );
            return;
          }
          onDone(`! ${(e as Error).message}`);
        });
    }
    return true;
  };

  // Skip a question. `message` is the reason an OpenCode skip may carry.
  const postSkip = (r: AskQuestionsRequest, message?: string) => {
    setSubmitting(true);
    client
      .answerAskQuestions(r.id, { skip: true, ...(message ? { message } : {}) })
      .then((res) => onDone(res.ok ? "✓ skipped" : "answer failed"))
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
  };

  // Answer an OpenCode permission card. A reason rides Reject only; a Reject
  // with none skips the action and the agent continues (the driver sends the
  // one space OpenCode needs for that), which the closing message says.
  const postOpencodePermission = (r: FxPermissionRequest, optionId: string, text: string | undefined) => {
    const plan = planOpencodePermissionReply(optionId, text);
    if (!plan.ok) {
      setHint(plan.error);
      return;
    }
    const rejected = optionId === OPENCODE_REJECT_OPTION;
    setSubmitting(true);
    client
      .answerFxPermission(r.id, plan.body)
      .then((res) => {
        if (!res.ok) return onDone("already resolved");
        if (!rejected) return onDone("✓ answered");
        onDone(plan.body.message ? "✓ rejected with a reason" : "✓ rejected — the agent continues without it");
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 400) {
          setSubmitting(false);
          setHint(e.message || "could not answer");
          return;
        }
        onDone(`! ${(e as Error).message}`);
      });
  };

  useInput(
    (input, key) => {
      if (loading || submitting || !req) {
        if (key.escape) return onCancel();
        return;
      }

      // Typing the reason for an OpenCode Reject or Skip. Enter with nothing
      // typed sends no reason; Esc goes back to the list.
      if (reason !== null) {
        if (key.escape) return setReason(null);
        if (key.return) {
          const text = reason.trim();
          setReason(null);
          if (reasonFor === "skip" && isOpencodeAsk(req)) postSkip(req, text || undefined);
          else if (isOpencodePermission(req)) postOpencodePermission(req, OPENCODE_REJECT_OPTION, text || undefined);
          return;
        }
        if (key.backspace || key.delete) return setReason((s) => (s ?? "").slice(0, -1));
        if (input && !key.ctrl && !key.meta) {
          const chunk = input.length > 1 ? sanitizeDrop(input) : input;
          return setReason((s) => (s ?? "") + chunk);
        }
        return;
      }

      // Typing a custom (free-text) answer.
      if (custom !== null) {
        if (key.escape) return setCustom(null); // back to the option list
        if (key.return) {
          const text = custom.trim();
          if (!text) return setCustom(null);
          const q = req.kind === "ask_questions" ? req.questions[qIndex] : undefined;
          const indexes = q?.multiSelect ? [...toggled].filter((i) => i < q.options.length) : [];
          const selected = q ? indexes.map((i) => optionPickValue(req, q.options[i]!)) : [];
          commitAnswer(selected, text, indexes);
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
        const opencode = isOpencodeAsk(req);
        // An OpenCode question shows "✎ Other" only where it takes typed text.
        const hasOther = !opencode || q.allowCustom === true;
        const otherIndex = hasOther ? q.options.length : -1; // the appended "✎ Other" row
        const skipIndex = req.source === "cursor" || opencode ? q.options.length + (hasOther ? 1 : 0) : -1;
        if (skipIndex >= 0 && cursor === skipIndex && (key.return || input === " ")) {
          if (opencode && req.allowReason) {
            setReasonFor("skip");
            setReason("");
            return;
          }
          postSkip(req);
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
            const indexes = [...toggled].filter((i) => i < q.options.length);
            const selected = indexes.map((i) => optionPickValue(req, q.options[i]!));
            if (!commitAnswer(selected, null, indexes)) setHint("pick an option or ✎ Other to answer");
            return;
          }
          if (cursor === otherIndex) return setCustom(""); // single-select "Other"
          const pick = q.options[cursor];
          if (!pick) return;
          commitAnswer([optionPickValue(req, pick)], null, [cursor]);
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
        if (isOpencodePermission(req)) {
          // OpenCode's own three options, Reject included: no Dismiss row.
          const opt = req.options[cursor];
          if (!opt) return;
          if (opt.optionId === OPENCODE_REJECT_OPTION && req.allowReason) {
            setReasonFor("reject");
            setReason("");
            return;
          }
          postOpencodePermission(req, opt.optionId, undefined);
          return;
        }
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
        <Text bold wrap="truncate-end">{shown(req, req.title)}</Text>
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
        <Text wrap="truncate-end">{shown(req, req.questions[qIndex]?.question ?? "")}</Text>
      ) : req.kind === "fx_permission" ? (
        <Text dimColor wrap="truncate-end">
          {shown(
            req,
            (req.toolCall.title ?? req.toolCall.kind ?? "tool call") +
              (req.toolCall.kind ? `  [${req.toolCall.kind}]` : ""),
          ) + `  (${req.mode})`}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {req.paneText.split("\n").filter(Boolean).slice(-2).join("  ")}
        </Text>
      )}
      {reason !== null ? (
        <Box flexDirection="column" marginTop={1} width={width}>
          <Text dimColor wrap="truncate-end">
            {reasonFor === "skip"
              ? "Reason for skipping (Enter with none skips without one, Esc goes back)"
              : "Reason (Enter with none skips this action and the agent continues, Esc goes back)"}
          </Text>
          <Text wrap="truncate-start">
            <Text color="cyan">✎ </Text>
            {reason}
            <Text color="cyan">▏</Text>
          </Text>
        </Box>
      ) : custom !== null ? (
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
  if (req.kind === "ask_questions" && req.source === "cursor") return cursorAskOptionValue(option);
  // An OpenCode option is picked by its id, so two options sharing a label stay distinct.
  if (isOpencodeAsk(req)) return option.id ?? option.label;
  return option.label;
}

/** Text from a card for one terminal line. An OpenCode card's text comes from
 *  the model and the server, so it is escaped; the other cards print as before. */
function shown(req: AnyRequest, text: string): string {
  return isOpencodeAsk(req) || isOpencodePermission(req) ? escapeFreeText(text) : text;
}

function optionLabels(req: AnyRequest | null, qIndex: number): string[] {
  if (!req) return [];
  if (req.kind === "ask_questions") {
    const question = req.questions[qIndex];
    const options = question?.options ?? [];
    if (isOpencodeAsk(req)) {
      return [
        ...options.map((option) => escapeFreeText(option.label)),
        ...(question?.allowCustom ? [OTHER] : []),
        SKIP,
      ];
    }
    const labels = [
      ...options.map((option) => req.source === "cursor" ? cursorAskOptionChoiceLabel(option, options) : option.label),
      OTHER,
    ];
    if (req.source === "cursor") labels.push(SKIP);
    return labels;
  }
  if (req.kind === "fx_permission") {
    if (isOpencodePermission(req)) return req.options.map((o) => escapeControlChars(o.name));
    return [...req.options.map((o) => o.name), "Dismiss (reject)"];
  }
  return [...req.choices.map((ch) => ch.label), "Reject / Esc"];
}
