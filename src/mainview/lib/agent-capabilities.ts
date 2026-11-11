// Pure union of the `/`-command and extension lists discovered for one or
// more repository scopes (issue #291). `useAgentCapabilities` in
// `PromptComposer.tsx` fetches one `GET /agent-discovery` per scope; this
// module is the deterministic merge, kept DOM-free so it can be unit-tested
// without a React harness. See docs/architecture/multi-repo-tasks.md and
// docs/architecture/at-file-references.md.

import type { AvailableCommand, AvailableExtension } from "./api";

export interface AgentCapabilities {
  commands: AvailableCommand[];
  extensions: AvailableExtension[];
}

/**
 * Union capability lists in scope order. The first occurrence of a command
 * name / extension insert wins, so a name declared in two repositories (or
 * the same repository listed twice) appears once. `null`/`undefined` entries
 * — a scope whose discovery failed — contribute nothing, exactly like a
 * single failed scope on the pre-multi path. Empty input returns empty lists.
 */
export function mergeAgentCapabilities(
  results: ReadonlyArray<AgentCapabilities | null | undefined>,
): AgentCapabilities {
  const byCommand = new Map<string, AvailableCommand>();
  const byExtension = new Map<string, AvailableExtension>();
  for (const result of results) {
    if (!result) continue;
    for (const command of result.commands) {
      if (!byCommand.has(command.name)) byCommand.set(command.name, command);
    }
    for (const extension of result.extensions) {
      if (!byExtension.has(extension.insert)) byExtension.set(extension.insert, extension);
    }
  }
  return { commands: [...byCommand.values()], extensions: [...byExtension.values()] };
}
