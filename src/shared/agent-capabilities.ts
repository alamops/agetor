// Pure union of the `/`-command and extension lists discovered for one or
// more repository scopes (issue #291). The webview composer
// (`useAgentCapabilities` in `PromptComposer.tsx`, via
// `src/mainview/lib/agent-capabilities.ts`) and the CLI's `agetor commands`
// (`src/cli/commands/discovery.ts`) each fetch one `GET /agent-discovery` per
// scope and merge the results here, so both surfaces list the same entries in
// the same order. Generic over the entry shapes because each side has its own
// copy of the discovery types; this module only reads `name` and `insert`.
// Must stay free of runtime imports from either process.
// See docs/architecture/multi-repo-tasks.md and
// docs/architecture/at-file-references.md.

/** One scope's discovery result: the slash commands and extensions found there. */
export interface CapabilityLists<C extends { name: string }, E extends { insert: string }> {
  commands: C[];
  extensions: E[];
}

/**
 * Union capability lists in scope order. The first occurrence of a command
 * name / extension insert wins, so a name declared in two repositories (or
 * the same repository listed twice) appears once. `null`/`undefined` entries
 * — a scope whose discovery failed — contribute nothing, exactly like a
 * single failed scope on the pre-multi path. Empty input returns empty lists.
 */
export function mergeAgentCapabilities<C extends { name: string }, E extends { insert: string }>(
  results: ReadonlyArray<CapabilityLists<C, E> | null | undefined>,
): CapabilityLists<C, E> {
  const byCommand = new Map<string, C>();
  const byExtension = new Map<string, E>();
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
