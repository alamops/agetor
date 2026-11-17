/**
 * Validation of the text a user types into the OAuth `Paste code here if
 * prompted >` box, before it is typed into the pane. Shared by the answer route
 * (the authority), the webview card and `agetor answer` / the TUI (which
 * validate locally to say why Submit is disabled). No runtime imports.
 */

/** The most a code may be, in characters. */
export const OAUTH_CODE_MAX_LEN = 512;

export type OAuthCodeError = "not-a-string" | "empty" | "too-long" | "multi-line" | "control-char";

/**
 * One line, at most {@link OAUTH_CODE_MAX_LEN} characters, no control character
 * (C0, DEL, C1: nothing that tmux or claude's TUI could read as a key). Leading
 * and trailing spaces are trimmed. The error code is fixed text; the offending
 * value is never part of the result.
 */
export function validateOAuthCode(raw: unknown): { ok: true; code: string } | { ok: false; error: OAuthCodeError } {
  if (typeof raw !== "string") return { ok: false, error: "not-a-string" };
  if (/[\r\n]/.test(raw)) return { ok: false, error: "multi-line" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return { ok: false, error: "control-char" };
  const code = raw.trim();
  if (code.length === 0) return { ok: false, error: "empty" };
  if (code.length > OAUTH_CODE_MAX_LEN) return { ok: false, error: "too-long" };
  return { ok: true, code };
}

/** The fixed sentence for each error (used by every surface; never quotes the value). */
export function oauthCodeErrorText(error: OAuthCodeError): string {
  switch (error) {
    case "not-a-string": return "The code must be text.";
    case "empty": return "Paste the code first.";
    case "too-long": return `The code is longer than ${OAUTH_CODE_MAX_LEN} characters.`;
    case "multi-line": return "The code must be a single line.";
    case "control-char": return "The code can't contain control characters.";
  }
}
