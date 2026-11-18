/**
 * The one place a Claude Code CLI model id and an agetor model id are
 * translated into each other (dynamic-model-catalog #4).
 *
 * agetor ids are friendly (`opus-5.5`, `haiku-4.5`); the CLI's are
 * `claude-<family>-<major>[-<minor>…][-<yyyymmdd>]` (`claude-opus-5-5`,
 * `claude-haiku-4-5-20251001`). Every curated id follows the same rule, so a
 * model the CLI reports that agetor has never heard of (`claude-opus-6`)
 * derives its agetor id (`opus-6`) and its spawn argument without a table
 * edit. `CLAUDE_CLI_MODEL_EXCEPTIONS` is the escape hatch for a model whose
 * CLI id ever stops following the rule; it starts empty.
 *
 * Kept free of runtime imports from either process, like every `src/shared`
 * module.
 */

import type { DiscoveredModel } from "./model-options.ts";

/** agetor id → exact CLI id, for a model whose CLI id breaks the rule. */
export const CLAUDE_CLI_MODEL_EXCEPTIONS: Readonly<Record<string, string>> = {};

/** `claude-opus-5-5` → `opus-5.5`; null for `default`, an alias (`opus`) or
 *  anything that is not family-first `claude-…`. A trailing 8-digit date is
 *  dropped (`claude-haiku-4-5-20251001` → `haiku-4.5`). */
export function claudeIdFromCliModel(cliId: string): string | null {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*?)(?:-\d{8})?$/.exec(cliId);
  if (!m) return null;
  const family = m[1];
  const version = m[2];
  if (!family || !version) return null;
  return `${family}-${version.replace(/-/g, ".")}`;
}

/** The exact string the CLI's `--model` and `/model` want for an agetor id:
 *  exception table → the discovered row's own `cliId` → the rule → the id
 *  verbatim (a user-typed id passes through untouched). */
export function claudeCliModelFor(id: string, discovered?: readonly DiscoveredModel[]): string {
  const exception = CLAUDE_CLI_MODEL_EXCEPTIONS[id];
  if (exception) return exception;
  const row = discovered?.find((m) => m.id === id && typeof m.cliId === "string" && m.cliId.length > 0);
  if (row?.cliId) return row.cliId;
  const m = /^([a-z]+)-(\d+(?:\.\d+)*)$/.exec(id);
  if (!m) return id;
  return `claude-${m[1]}-${(m[2] ?? "").replace(/\./g, "-")}`;
}
