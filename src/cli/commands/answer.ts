import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { usageError } from "../usage.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, isTTY } from "../output.ts";
import type { AgetorClient } from "../api-client.ts";
import type { AskQuestionsRequest, TmuxPromptRequest } from "../../bun/interactions.ts";

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

/** Sentinel option value for the "type a free-text answer" choice — distinctive
 *  enough that it can't collide with a real option label. */
const CUSTOM = "__agetor_custom__";

async function answerAsk(client: AgetorClient, req: AskQuestionsRequest): Promise<boolean> {
  const answers: Array<{ selected: string[]; custom?: string }> = [];
  for (const q of req.questions) {
    p.note(q.question, q.header ?? "question");
    const options = [
      ...q.options.map((o) => ({ value: o.label, label: o.label, hint: o.description })),
      { value: CUSTOM, label: "✎ Other — type a custom answer" },
    ];
    let selected: string[];
    let custom: string | undefined;
    if (q.multiSelect) {
      const sel = await p.multiselect({ message: "Select (space to pick)", options, required: false });
      if (p.isCancel(sel)) return cancel();
      const picks = sel as string[];
      if (picks.includes(CUSTOM)) {
        const text = await promptCustom();
        if (text === null) return cancel();
        custom = text;
      }
      selected = picks.filter((v) => v !== CUSTOM);
    } else {
      const sel = await p.select({ message: "Select", options });
      if (p.isCancel(sel)) return cancel();
      if (sel === CUSTOM) {
        const text = await promptCustom();
        if (text === null) return cancel();
        custom = text;
        selected = [];
      } else {
        selected = [sel as string];
      }
    }
    // The contract requires at least one of selected / custom per question.
    if (selected.length === 0 && !custom) {
      out(c.red("each question needs an option or a custom answer — nothing submitted"));
      return true;
    }
    answers.push(custom ? { selected, custom } : { selected });
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
