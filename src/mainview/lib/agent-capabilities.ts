// The webview's view of the multi-scope `/`-command and extension merge
// (issue #291). `useAgentCapabilities` in `PromptComposer.tsx` fetches one
// `GET /agent-discovery` per scope and merges with `mergeAgentCapabilities`,
// whose single implementation lives in `src/shared/agent-capabilities.ts` so
// the CLI's `agetor commands` unions the same way. See
// docs/architecture/multi-repo-tasks.md and
// docs/architecture/at-file-references.md.

import type { CapabilityLists } from "../../shared/agent-capabilities";
import type { AvailableCommand, AvailableExtension } from "./api";

export { mergeAgentCapabilities } from "../../shared/agent-capabilities";

export type AgentCapabilities = CapabilityLists<AvailableCommand, AvailableExtension>;
