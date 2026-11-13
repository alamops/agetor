import type { AgetorClient } from "./api-client.ts";
import type { HarnessStack } from "../shared/types.ts";
import { escapeControlChars } from "../shared/terminal-text.ts";

/** Resolve a harness-stack ref: exact id, then exact label, then a unique id
 *  prefix (D17). A label shared by two or more stacks is an error naming their
 *  ids, like an ambiguous task prefix. Ids and refs are escaped: a label is
 *  stored as typed. */
export async function resolveStack(client: AgetorClient, ref: string): Promise<HarnessStack> {
  const { stacks } = await client.listHarnessStacks();
  const exactId = stacks.find((s) => s.id === ref);
  if (exactId) return exactId;
  const labelled = stacks.filter((s) => s.label === ref);
  if (labelled.length === 1) return labelled[0]!;
  if (labelled.length > 1) {
    throw new Error(
      `"${escapeControlChars(ref)}" is the label of ${labelled.length} stacks (${labelled.map((s) => escapeControlChars(s.id)).join(", ")}) — use an id`,
    );
  }
  const matches = stacks.filter((s) => s.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no stack matches "${escapeControlChars(ref)}"`);
  throw new Error(
    `"${escapeControlChars(ref)}" is ambiguous — ${matches.length} stacks share that prefix (${matches.map((s) => escapeControlChars(s.id)).join(", ")}); use a longer id`,
  );
}
