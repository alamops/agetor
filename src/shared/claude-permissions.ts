/**
 * Translation layer between agetor's UI "Allow always" choices and Claude
 * Code's `permissions.allow` string format.
 *
 * IMPORTANT: claude itself never consults these entries in our setup —
 * our PreToolUse hook always returns a terminal `allow` / `deny` / `ask`
 * before claude's permission engine runs. We use claude's format purely
 * as our storage format because it is:
 *
 *   1. Human-readable — users can `cat .claude/settings.local.json` and
 *      reason about their saved rules.
 *   2. Version-controllable — a settings file in a repo travels naturally.
 *   3. Aligned with claude's own conventions — no parallel system to learn.
 *
 * Format reference (verified against `claude --help` and against literal
 * permission-entry examples embedded in the claude 2.1.143 binary —
 * `Bash(git *)`, `Bash(npm run build)`, `Edit(docs/**)`, `WebFetch(domain:example.com)`
 * all appear as sample strings):
 *
 *   Bash                            allow every Bash call
 *   Bash(git status)                exact command (after trim)
 *   Bash(git *)                     command begins with "git " (word boundary)
 *   Edit                            allow every Edit call
 *   Edit(/repo/src/a.ts)            exact file_path
 *   Edit(/repo/src/**)              file_path under /repo/src/ recursively
 *   WebFetch                        allow every WebFetch call
 *   WebFetch(domain:api.github.com) URL hostname (case-insensitive)
 *
 * The legacy `Bash(git:*)` colon-prefix form appears in the binary as
 * `"Bash(npm run:*) - prefix matching (legacy)"` — current syntax is
 * `<prefix> *` with a space, which is what we emit.
 *
 * If a future claude version changes the format, the `derivePermissionEntry`
 * / `matchesPermissionEntry` pair still works as a self-consistent matcher
 * (we control both ends) — but the entries we write would no longer be
 * recognised by claude itself in `--permission-mode auto` (where claude's
 * engine reads `permissions.allow` before the classifier). Update the
 * table and the derive/match functions in lockstep when that happens.
 */

/* No Node-specific imports: this module is shared between the Bun main
 * process and the React webview. Keep it dependency-free so both bundles
 * can include it without runtime breakage. */

export type ApprovalRememberScope =
  | "tool"
  | "bash_exact"
  | "bash_prefix"
  | "path_exact"
  | "path_prefix"
  | "host_exact";

/**
 * Bash wrappers whose first argument is *the actual command*. When the
 * command starts with one of these, `bash_prefix` derivation is hidden in
 * the UI because a `Bash(env *)` rule would auto-allow every wrapped
 * command, not what the user means by "all env-prefixed commands".
 * `bash_exact` and `tool` scopes remain available — those are unambiguous.
 */
const BASH_WRAPPERS = new Set(["env", "sudo", "time", "nice", "xargs", "doas"]);

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function readString(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function bashTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function hostFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * derivePermissionEntry — produce the literal string we save
 * ────────────────────────────────────────────────────────────────────────── */

export function derivePermissionEntry(
  toolName: string,
  toolInput: unknown,
  scope: ApprovalRememberScope,
): string | null {
  if (scope === "tool") return toolName;

  if (scope === "bash_exact" || scope === "bash_prefix") {
    const command = readString(toolInput, "command");
    if (command === null) return null;
    const trimmed = command.trim();
    if (!trimmed) return null;
    if (scope === "bash_exact") return `Bash(${trimmed})`;
    const tokens = bashTokens(trimmed);
    if (tokens.length === 0) return null;
    if (BASH_WRAPPERS.has(tokens[0]!)) return null;
    return `Bash(${tokens[0]} *)`;
  }

  if (scope === "path_exact" || scope === "path_prefix") {
    const filePath = readString(toolInput, "file_path");
    if (filePath === null) return null;
    if (!filePath) return null;
    if (scope === "path_exact") return `${toolName}(${filePath})`;
    // path_prefix → dir-recursive glob. Manual lastIndexOf so this module
    // stays Node-import-free (shared with the webview).
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash <= 0) return null; // top-level path or bare filename
    const dir = filePath.slice(0, lastSlash);
    if (!dir) return null;
    return `${toolName}(${dir}/**)`;
  }

  if (scope === "host_exact") {
    const url = readString(toolInput, "url");
    if (url === null) return null;
    const host = hostFromUrl(url);
    if (!host) return null;
    return `${toolName}(domain:${host})`;
  }

  return null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * matchesPermissionEntry — does this stored entry match a live tool call?
 * ────────────────────────────────────────────────────────────────────────── */

export function matchesPermissionEntry(
  entry: string,
  toolName: string,
  toolInput: unknown,
): boolean {
  const parsed = parsePermissionEntryRaw(entry);
  if (!parsed) return false;
  if (parsed.toolName !== toolName) return false;

  // Bare tool name: matches any call to this tool.
  if (parsed.pattern === null) return true;

  // Bash patterns.
  if (toolName === "Bash") {
    const command = readString(toolInput, "command");
    if (command === null) return false;
    const trimmedCommand = command.trim();
    if (parsed.pattern.endsWith(" *")) {
      // Prefix: pattern is "<prefix> *". Match when command begins with
      // "<prefix> " (word boundary on space) OR equals "<prefix>" exactly.
      const prefix = parsed.pattern.slice(0, -2); // drop " *"
      return trimmedCommand === prefix || trimmedCommand.startsWith(prefix + " ");
    }
    return trimmedCommand === parsed.pattern;
  }

  // Path patterns (Edit / Write / MultiEdit / Read / etc.).
  if (FILE_TOOLS.has(toolName)) {
    const filePath = readString(toolInput, "file_path");
    if (filePath === null) return false;
    if (parsed.pattern.endsWith("/**")) {
      const prefix = parsed.pattern.slice(0, -2); // drop "**" — keep trailing "/"
      return filePath.startsWith(prefix);
    }
    return filePath === parsed.pattern;
  }

  // WebFetch host pattern.
  if (toolName === "WebFetch") {
    const url = readString(toolInput, "url");
    if (url === null) return false;
    if (parsed.pattern.startsWith("domain:")) {
      const wantHost = parsed.pattern.slice("domain:".length).toLowerCase();
      const host = hostFromUrl(url);
      return host === wantHost;
    }
    // No URL-exact form for WebFetch yet; only domain: prefix is supported.
    return false;
  }

  // Unknown tool with a parenthesised pattern: we don't know how to match.
  // Be conservative — refuse the auto-allow rather than over-match.
  return false;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/* ────────────────────────────────────────────────────────────────────────── *
 * parsePermissionEntry — for the rules-manager UI (and matcher internals)
 * ────────────────────────────────────────────────────────────────────────── */

interface ParsedEntry {
  toolName: string;
  /** Null when the entry is a bare tool name. */
  pattern: string | null;
}

function parsePermissionEntryRaw(entry: string): ParsedEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const open = trimmed.indexOf("(");
  if (open === -1) {
    // Bare tool name (e.g. "Bash") — must be a single token.
    if (/^[A-Za-z_][\w]*$/.test(trimmed)) return { toolName: trimmed, pattern: null };
    return null;
  }
  if (!trimmed.endsWith(")")) return null;
  const toolName = trimmed.slice(0, open).trim();
  if (!/^[A-Za-z_][\w]*$/.test(toolName)) return null;
  const pattern = trimmed.slice(open + 1, -1);
  return { toolName, pattern };
}

/**
 * Public parser for the rules-manager UI. Returns the scope inferred from
 * the pattern shape (best-effort — we lose the original UI intent but can
 * label rules accurately enough for display).
 */
export function parsePermissionEntry(entry: string): {
  toolName: string;
  scope: ApprovalRememberScope;
  displayPattern: string;
} | null {
  const raw = parsePermissionEntryRaw(entry);
  if (!raw) return null;
  if (raw.pattern === null) {
    return { toolName: raw.toolName, scope: "tool", displayPattern: `All ${raw.toolName} calls` };
  }
  if (raw.toolName === "Bash") {
    if (raw.pattern.endsWith(" *")) {
      const prefix = raw.pattern.slice(0, -2);
      return { toolName: raw.toolName, scope: "bash_prefix", displayPattern: `All "${prefix} *" commands` };
    }
    return { toolName: raw.toolName, scope: "bash_exact", displayPattern: `"${raw.pattern}"` };
  }
  if (FILE_TOOLS.has(raw.toolName)) {
    if (raw.pattern.endsWith("/**")) {
      return { toolName: raw.toolName, scope: "path_prefix", displayPattern: `All files in ${raw.pattern.slice(0, -2)}` };
    }
    return { toolName: raw.toolName, scope: "path_exact", displayPattern: raw.pattern };
  }
  if (raw.toolName === "WebFetch" && raw.pattern.startsWith("domain:")) {
    return { toolName: raw.toolName, scope: "host_exact", displayPattern: `All requests to ${raw.pattern.slice("domain:".length)}` };
  }
  // Unknown shape — surface the raw pattern in the manager UI anyway.
  return { toolName: raw.toolName, scope: "tool", displayPattern: raw.pattern };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * proposeAllowRules — the radio options the UI renders on the chooser
 * ────────────────────────────────────────────────────────────────────────── */

export interface AllowRuleProposal {
  /** Stable id for radio `value`. */
  scope: ApprovalRememberScope;
  /** Distinct sub-id for the 2-token bash prefix case (which shares
   *  `bash_prefix` scope with the 1-token case). Empty string otherwise. */
  variant: string;
  /** The exact `permissions.allow` entry string this option would save. */
  entry: string;
  /** Human label rendered next to the radio. */
  label: string;
}

/**
 * Build the chooser options for a given tool call, ordered most-specific
 * to broadest. The first element is the default-selected one.
 *
 * Bash with ≥2 tokens (and no wrapper) gets BOTH a 1-token and a 2-token
 * prefix option — they share the `bash_prefix` scope but produce different
 * entries.
 */
export function proposeAllowRules(
  toolName: string,
  toolInput: unknown,
): AllowRuleProposal[] {
  const out: AllowRuleProposal[] = [];

  if (toolName === "Bash") {
    const command = readString(toolInput, "command");
    if (command !== null) {
      const trimmed = command.trim();
      const exactEntry = derivePermissionEntry(toolName, toolInput, "bash_exact");
      if (exactEntry) out.push({ scope: "bash_exact", variant: "", entry: exactEntry, label: `Just "${trimmed}"` });
      const tokens = bashTokens(trimmed);
      const hasWrapper = tokens.length > 0 && BASH_WRAPPERS.has(tokens[0]!);
      if (!hasWrapper) {
        if (tokens.length >= 1) {
          const entry = `Bash(${tokens[0]} *)`;
          out.push({ scope: "bash_prefix", variant: "1", entry, label: `All "${tokens[0]} *" commands` });
        }
        if (tokens.length >= 2) {
          const entry = `Bash(${tokens[0]} ${tokens[1]} *)`;
          out.push({ scope: "bash_prefix", variant: "2", entry, label: `All "${tokens[0]} ${tokens[1]} *" commands` });
        }
      }
    }
    out.push({ scope: "tool", variant: "", entry: "Bash", label: "All Bash commands" });
    return out;
  }

  if (FILE_TOOLS.has(toolName)) {
    const filePath = readString(toolInput, "file_path");
    if (filePath !== null) {
      const exactEntry = derivePermissionEntry(toolName, toolInput, "path_exact");
      if (exactEntry) out.push({ scope: "path_exact", variant: "", entry: exactEntry, label: "Just this file" });
      const prefixEntry = derivePermissionEntry(toolName, toolInput, "path_prefix");
      if (prefixEntry) {
        const lastSlash = filePath.lastIndexOf("/");
        const dir = lastSlash > 0 ? filePath.slice(0, lastSlash) : filePath;
        out.push({ scope: "path_prefix", variant: "", entry: prefixEntry, label: `All files in ${dir}/` });
      }
    }
    out.push({ scope: "tool", variant: "", entry: toolName, label: `All ${toolName} calls` });
    return out;
  }

  if (toolName === "WebFetch") {
    const url = readString(toolInput, "url");
    if (url !== null) {
      const hostEntry = derivePermissionEntry(toolName, toolInput, "host_exact");
      if (hostEntry) {
        const host = hostFromUrl(url);
        out.push({ scope: "host_exact", variant: "", entry: hostEntry, label: `All requests to ${host}` });
      }
    }
    out.push({ scope: "tool", variant: "", entry: "WebFetch", label: "All WebFetch calls" });
    return out;
  }

  // Unknown tools: only the all-of-tool scope is available.
  out.push({ scope: "tool", variant: "", entry: toolName, label: `All ${toolName} calls` });
  return out;
}
