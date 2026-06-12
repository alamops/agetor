import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { usageError } from "../usage.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import type { AgetorClient } from "../api-client.ts";
import type { AskQuestionsRequest, TmuxPromptRequest } from "../../bun/interactions.ts";
import { buildAskAnswer, CUSTOM_OPTION } from "../answer-logic.ts";

export async function cmdAnswer(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw usageError("answer");
  if (!isTTY) {
    throw new Error("agetor answer needs an interactive terminal (TTY)");
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const pending = await client.pendingInteractions(task.id);
  if (pending.length === 0) {
    out(c.dim("nothing pending for this task"));
    return;
  }

  for (const req of pending) {
    if (req.kind === "ask_questions") {
      const ok = await answerAsk(client, req);
      if (!ok) return; // cancelled
    } else {
      const ok = await answerTmux(client, req);
      if (!ok) return;
    }
  }
}

async function answerAsk(client: AgetorClient, req: AskQuestionsRequest): Promise<boolean> {
  const answers: Array<{ selected: string[]; custom?: string }> = [];
  for (const q of req.questions) {
    p.note(q.question, q.header ?? "question");
    const options = [
      ...q.options.map((o) => ({ value: o.label, label: o.label, hint: o.description })),
      { value: CUSTOM_OPTION, label: "✎ Other — type a custom answer" },
    ];
    // Re-prompt this question until it has at least one option or custom text.
    let entry: { selected: string[]; custom?: string } | null = null;
    while (entry === null) {
      let picks: string[];
      if (q.multiSelect) {
        const sel = await p.multiselect({ message: "Select (space to pick)", options, required: false });
        if (p.isCancel(sel)) return cancel();
        picks = sel as string[];
      } else {
        const sel = await p.select({ message: "Select", options });
        if (p.isCancel(sel)) return cancel();
        picks = [sel as string];
      }
      let custom: string | null = null;
      if (picks.includes(CUSTOM_OPTION)) {
        custom = await promptCustom();
        if (custom === null) return cancel();
      }
      entry = buildAskAnswer(picks, custom);
      if (entry === null) p.note("Pick an option or add a custom answer.", "required");
    }
    answers.push(entry);
  }
  const res = await client.answerAskQuestions(req.id, answers);
  out(res.ok ? c.green("✓ answered") : c.red("failed to answer"));
  return true;
}

/** Prompt for a non-empty free-text custom answer. Returns null on cancel. */
async function promptCustom(): Promise<string | null> {
  const text = await p.text({
    message: "Your answer",
    validate: (v) => (v && v.trim() ? undefined : "type an answer (or Esc to cancel)"),
  });
  if (p.isCancel(text)) return null;
  return (text as string).trim();
}

async function answerTmux(client: AgetorClient, req: TmuxPromptRequest): Promise<boolean> {
  out(c.dim(req.paneText));
  const choice = await p.select({
    message: "Choose",
    options: [
      ...req.choices.map((ch) => ({ value: ch.key, label: ch.label })),
      { value: "__reject__", label: "Reject / Esc" },
    ],
  });
  if (p.isCancel(choice)) return cancel();
  const res =
    choice === "__reject__"
      ? await client.answerTmuxPrompt(req.id, { reject: true })
      : await client.answerTmuxPrompt(req.id, { key: choice });
  out(res.ok ? c.green("✓ answered") : c.red(res.error ?? "failed to answer"));
  return true;
}

function cancel(): boolean {
  p.cancel("cancelled");
  return false;
}
