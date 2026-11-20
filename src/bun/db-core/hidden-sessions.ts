import type { Runs } from "./runs.ts";
import type { Tasks } from "./tasks.ts";

export function makeHiddenSessionIds(runs: Runs, tasks: Tasks) {
  /** Session ids the Claude import list must not offer. A run already records
   *  the id, or a task's claim column holds it before the seed run exists. */
  function hiddenClaudeSessionIds(): Set<string> {
    const ids = runs.claudeSessionIds();
    for (const id of tasks.importedClaudeSessionIds()) ids.add(id);
    return ids;
  }

  /** OpenCode session ids the import list must not offer — the
   *  {@link hiddenClaudeSessionIds} counterpart: a run records the id, or a
   *  task's claim column holds it before the seed run exists. */
  function hiddenOpencodeSessionIds(): Set<string> {
    const ids = runs.opencodeSessionIdsOwned();
    for (const id of tasks.importedOpencodeSessionIds()) ids.add(id);
    return ids;
  }
  return { hiddenClaudeSessionIds, hiddenOpencodeSessionIds };
}
