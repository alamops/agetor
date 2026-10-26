// Render-time visibility of tool events (D19). fx 0.0.14 marks some of its
// own tool calls as internal plumbing (`_meta.fx.toolCall.internal === true`
// on the `tool_call` update); the fx mapper (`mapFxUpdate` in
// `src/bun/fx-acp.ts`) stamps a top-level `"internal": true` onto both the
// `tool_use` event and its matching `tool_result`. Those rows stay persisted
// exactly as emitted — a JSONL rebuild, `--json` output and any future
// "show internal calls" toggle still have them — and are hidden only where a
// transcript is rendered for a human: RunPanel (display and message search),
// `agetor logs` and the TUI dashboard all consult this one predicate.
//
// Zero runtime imports, so both processes (and the CLI) can import it.

/** The literal every stamped event body contains (the mapper serializes with
 *  `JSON.stringify`, which never puts a space after the colon). Checked before
 *  `JSON.parse` so an ordinary — often large — tool event never pays a parse. */
const INTERNAL_MARKER = '"internal":true';

/** `true` only for a `tool_use`/`tool_result` event whose JSON body carries a
 *  TOP-LEVEL `internal === true`. The same key nested inside `input`/`content`
 *  (or quoted inside a string) doesn't count; a body that isn't a JSON object
 *  is never hidden. Never throws. */
export function isHiddenToolEvent(stream: string, data: string): boolean {
  if (stream !== "tool_use" && stream !== "tool_result") return false;
  if (typeof data !== "string" || !data.includes(INTERNAL_MARKER)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as { internal?: unknown }).internal === true
  );
}
