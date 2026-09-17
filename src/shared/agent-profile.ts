/**
 * Pure grammar for {@link AgentProfile} — reusable, named launch presets
 * (harness + model + effort + mode + fast/maxMode + free-text instructions +
 * skills) picked on task launch instead of choosing each field by hand. This
 * module is shared by three surfaces that must never drift apart on "what
 * counts as a valid skill name" or "what the injected preamble looks like":
 * the bun-side orchestrator (`startTask`'s launch-prompt assembly and the
 * `/agent-profiles` route validation), the webview's client-side gemini
 * argv-budget pre-check (`promptByteOverage` must see the same text the
 * server will actually send), and the CLI (`agetor profile`/`agetor add
 * --profile`). Kept free of runtime imports from either process side — see
 * `docs/plans/agent-profiles.md` for the full design.
 */
import type { AgentKind, AgentProfile, AgentProfileSnapshot } from "./types.ts";

/** The XML-ish tag the launch-prompt preamble is wrapped in. Rendered by the
 *  webview's generic tagged-message parser (`src/shared/user-message.ts`)
 *  with a friendly "Agent instructions" label — it deliberately stays a
 *  generic tag there (not added to `MACHINE_TAGS`) so `parseMessageSegments`
 *  needs no special case for it. */
export const AGENT_INSTRUCTIONS_TAG = "agent_instructions_defined_by_the_user";

/** Field length/count caps enforced by both the server routes and the
 *  Settings form. */
export const AGENT_PROFILE_LIMITS = {
  name: 80,
  instructions: 20_000,
  skills: 50,
  skillName: 100,
} as const;

/**
 * Normalize a user-typed or autocompleted skill token: trim, strip one
 * leading `/` (the composer's own `/name` insert syntax, and a pasted slash
 * command), trim again, then collapse any run of internal whitespace to a
 * single space. Returns `""` — the caller's signal to drop the token — when
 * the result is empty or longer than {@link AGENT_PROFILE_LIMITS.skillName}.
 */
export function normalizeSkillName(raw: string): string {
  let name = raw.trim();
  if (name.startsWith("/")) name = name.slice(1);
  name = name.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > AGENT_PROFILE_LIMITS.skillName) return "";
  return name;
}

const AGENT_INSTRUCTIONS_OPEN_TAG = `<${AGENT_INSTRUCTIONS_TAG}>`;
const AGENT_INSTRUCTIONS_CLOSE_MARKER = `</${AGENT_INSTRUCTIONS_TAG}>\n\nYour task:\n`;

/**
 * Compose the launch prompt agetor actually sends to the harness. When
 * `profile` is `null`, or its trimmed `instructions` is empty AND `skills` is
 * empty, `prompt` is returned unchanged (no preamble, nothing to strip on the
 * way back out). Otherwise returns exactly:
 *
 * ```
 * <agent_instructions_defined_by_the_user>
 * {instructions.trim()}
 *
 * Skills to use for this task (invoke each with its skill tool before starting): /a, /b
 * </agent_instructions_defined_by_the_user>
 *
 * Your task:
 * {prompt}
 * ```
 *
 * The skills line — and the blank line before it — is omitted entirely when
 * `skills` is empty; when `instructions` is blank but `skills` is non-empty
 * the tag body is just the skills line. Skills render as `/name` joined by
 * `", "`. `prompt` is appended verbatim, not trimmed — it's the caller's job
 * to decide what "the prompt" is (raw vs. `@`-expanded vs. with references
 * appended).
 */
export function composeLaunchPrompt(
  profile: Pick<AgentProfileSnapshot, "instructions" | "skills"> | null,
  prompt: string,
): string {
  if (profile === null) return prompt;

  const instructions = profile.instructions.trim();
  const skills = profile.skills;
  if (instructions.length === 0 && skills.length === 0) return prompt;

  const body: string[] = [];
  if (instructions.length > 0) body.push(instructions);
  if (skills.length > 0) {
    if (body.length > 0) body.push("");
    const skillList = skills.map((s) => `/${s}`).join(", ");
    body.push(`Skills to use for this task (invoke each with its skill tool before starting): ${skillList}`);
  }

  const lines = [
    AGENT_INSTRUCTIONS_OPEN_TAG,
    ...body,
    `</${AGENT_INSTRUCTIONS_TAG}>`,
    "",
    "Your task:",
    prompt,
  ];
  return lines.join("\n");
}

/**
 * Inverse of {@link composeLaunchPrompt}, for display (the transcript's
 * "Agent instructions" block renders the tag separately, so the raw text
 * shouldn't repeat it) and for resend (`MessageHistoryPicker` must not
 * re-inject a preamble that `startTask` will add again). Returns `text`
 * unchanged unless it starts with {@link AGENT_INSTRUCTIONS_TAG}'s open tag
 * AND contains the closing tag immediately followed by `"\n\nYour task:\n"`
 * — in which case everything after that marker is returned.
 *
 * Satisfies `stripAgentInstructionsPreamble(composeLaunchPrompt(p, x)) === x`
 * for every `x` and every profile. The one acknowledged ambiguity: if `x`
 * itself starts with the tag and happens to contain the exact closing
 * marker before `composeLaunchPrompt`'s own, `indexOf` finds the earlier
 * occurrence and the round-trip splits at the wrong point — an acceptable
 * edge case for a marker a user is very unlikely to type verbatim.
 */
export function stripAgentInstructionsPreamble(text: string): string {
  if (!text.startsWith(AGENT_INSTRUCTIONS_OPEN_TAG)) return text;
  const idx = text.indexOf(AGENT_INSTRUCTIONS_CLOSE_MARKER);
  if (idx === -1) return text;
  return text.slice(idx + AGENT_INSTRUCTIONS_CLOSE_MARKER.length);
}

/** One-line "harness · model · effort · mode" summary for a profile row /
 *  card, omitting any field that's null/empty (e.g. no effort set). */
export function agentProfileSummary(p: {
  harnessLabel: string;
  model: string;
  effort: string | null;
  mode: string | null;
}): string {
  return [p.harnessLabel, p.model, p.effort, p.mode].filter(Boolean).join(" · ");
}

/**
 * Resolve a user-typed `<id|name>` reference (CLI `--profile`, `agetor
 * profile show <ref>`, …) against a list of profiles. An exact `id` match
 * wins outright; otherwise a case-insensitive, trimmed `name` match is tried
 * — exactly one hit resolves, several is `"ambiguous agent \"<ref>\": matches
 * <names>"` (comma-and-space joined, in list order), and none is
 * `"unknown agent \"<ref>\""`. `ref` is trimmed before either comparison.
 */
export function matchAgentProfileRef(
  profiles: AgentProfile[],
  ref: string,
): { profile: AgentProfile } | { error: string } {
  const trimmed = ref.trim();

  const byId = profiles.find((p) => p.id === trimmed);
  if (byId) return { profile: byId };

  const lower = trimmed.toLowerCase();
  const byName = profiles.filter((p) => p.name.trim().toLowerCase() === lower);
  if (byName.length === 1) {
    const [only] = byName;
    if (only) return { profile: only };
  }
  if (byName.length > 1) {
    return { error: `ambiguous agent "${trimmed}": matches ${byName.map((p) => p.name).join(", ")}` };
  }
  return { error: `unknown agent "${trimmed}"` };
}

/**
 * Rewrite a {@link matchAgentProfileRef} error's leading `unknown`/`ambiguous
 * agent` to `… profile` — `matchAgentProfileRef` says "agent" in its error
 * text by design (other, non-CLI consumers still use that vocabulary), but
 * the CLI's own vocabulary is `agent` = harness, `profile` = agent profile
 * (docs/plans/task-details-agent-row.md D4). Every CLI call site that
 * surfaces a `matchAgentProfileRef` error to the user (`agetor profile`,
 * `agetor add --profile`) must wrap it with this rather than let "unknown
 * agent" leak through where "unknown profile" is meant.
 */
export function asProfileError(message: string): string {
  return message.replace(/^(unknown|ambiguous) agent\b/, "$1 profile");
}

/**
 * Capture a profile as a task-bound {@link AgentProfileSnapshot} — the
 * profile's own fields plus the resolved harness identity (so a later
 * harness deletion can't blank the snapshot's display) and a `capturedAt`
 * timestamp. `skills` is copied into a fresh array so later mutation of the
 * live profile's array can never leak into an already-captured snapshot.
 */
export function snapshotFromProfile(
  p: AgentProfile,
  harness: { kind: AgentKind; label: string },
  now: number,
): AgentProfileSnapshot {
  return {
    id: p.id,
    name: p.name,
    harness: p.harness,
    harnessKind: harness.kind,
    harnessLabel: harness.label,
    model: p.model,
    effort: p.effort,
    mode: p.mode,
    fast: p.fast,
    maxMode: p.maxMode,
    instructions: p.instructions,
    skills: [...p.skills],
    capturedAt: now,
  };
}
