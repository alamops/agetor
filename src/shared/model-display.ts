/**
 * How a model is named wherever a person reads one (task card, run panel,
 * badges, CLI/TUI output). A model that has a catalog or curated label shows
 * that label; any other id is prettified (`opus-5.5` → `Opus 5.5`) so a model
 * agetor has no row for yet still reads like a name instead of a slug.
 *
 * Also the one sanitizer for text a CLI reports about a model (labels,
 * descriptions): third-party text must not carry invisible or control
 * characters into the webview or a terminal.
 */

import { AGENT_OPTIONS, CURSOR_MODEL_SPECS, type AgentKind } from "./types.ts";

/** Drop zero-width characters (U+200B–U+200D, U+2060, U+FEFF) and C0/C1
 *  controls, collapse whitespace, trim, cap at 80 characters. */
export function sanitizeCliLabel(s: string): string {
  if (typeof s !== "string") return "";
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u200b-\u200d\u2060\ufeff\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Like {@link sanitizeCliLabel} for a longer description (cap 240). */
export function sanitizeCliDescription(s: string): string {
  if (typeof s !== "string") return "";
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u200B-\u200D\u2060\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const BRAND_WORDS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  deepseek: "DeepSeek",
  glm: "GLM",
  llama: "Llama",
  qwen: "Qwen",
  xai: "xAI",
  moonshot: "Moonshot",
};

const VERSION_RE = /^\d+(?:\.\d+)*$/;
const SHORT_CODE_RE = /^[a-z]\d+$/;

function prettifyWord(w: string): string {
  const brand = BRAND_WORDS[w];
  if (brand) return brand;
  if (VERSION_RE.test(w)) return w;
  if (SHORT_CODE_RE.test(w)) return w.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** `opus-5.5` → `Opus 5.5`, `gpt-6.1-sol` → `GPT-6.1 Sol`,
 *  `deepseek/deepseek-v4-flash` → `DeepSeek V4 Flash`. Only the part after
 *  the last `/` is used (an opencode `provider/model` id). */
export function prettifyModelId(id: string): string {
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const words = tail.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return id;
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const next = words[i + 1];
    // "gpt-6.1" reads as one token: GPT-6.1.
    if (w === "gpt" && next !== undefined && VERSION_RE.test(next)) {
      out.push(`GPT-${next}`);
      i++;
      continue;
    }
    out.push(prettifyWord(w));
  }
  return out.join(" ");
}

/**
 * The name to show for `id` on `kind`: the label of a non-`unlisted` catalog
 * row (`rows`, the merged picker rows) → the curated label → the prettified
 * id. `kind` may be null when the caller only has a harness alias id (a board
 * card): the curated rows of every kind are then searched. Never used for
 * matching; ids stay the identity everywhere else.
 */
export function modelDisplayName(
  kind: AgentKind | null,
  id: string,
  rows?: readonly { id: string; label: string; unlisted?: boolean }[],
): string {
  if (!id) return id;
  const row = rows?.find((r) => r.id === id && !r.unlisted && r.label);
  if (row) return row.label;
  const kinds = kind ? [kind] : (Object.keys(AGENT_OPTIONS) as AgentKind[]);
  for (const k of kinds) {
    const curated = AGENT_OPTIONS[k]?.models.find((m) => m.id === id);
    if (curated?.label) return curated.label;
    if (k === "cursor") {
      const spec = CURSOR_MODEL_SPECS[id];
      if (spec?.label) return spec.label;
    }
  }
  return prettifyModelId(id);
}

/** True for a value that is one of agetor's harness kinds (a built-in
 *  harness's id equals its kind; an alias's does not). */
export function asAgentKind(value: string | null | undefined): AgentKind | null {
  return value && Object.prototype.hasOwnProperty.call(AGENT_OPTIONS, value) ? (value as AgentKind) : null;
}
