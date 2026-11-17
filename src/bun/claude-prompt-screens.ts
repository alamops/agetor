/**
 * Pure matchers for the Claude Code screens that wait on a keypress and that
 * agetor's tmux driver has to recognise, drive or refuse to drive. No tmux,
 * no I/O, no module-level state: everything here maps a captured pane (a
 * string) to a verdict, so each shape has a fixture-backed unit test
 * (`claude-prompt-screens.test.ts`, fixtures under
 * `fixtures/claude-prompts/<claude version>/`) and `claude-tmux.ts`, which is
 * already twelve thousand lines, only wires the results in.
 *
 * Contract and decisions: docs/plans/claude-enter-to-confirm-prompts.md and
 * docs/architecture/harness-claude-code.md ("Enter-to-confirm screens").
 *
 * Every shape here was captured from, or decoded out of, claude 2.1.326. A
 * newer claude may redraw them; each fixture carries a `# claude <version> ·
 * live|binary` header so a new capture slots in next to the old one.
 */
import { createHash } from "node:crypto";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Footer vocabulary
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * `Enter to <verb>` hints claude draws as the footer of a modal that is waiting
 * for the user. The verbs are the `chord:"enter",action:"<verb>"` hints in the
 * 2.1.326 binary (`strings -a …/versions/2.1.326`), counted and classified:
 *
 * | verb (count in binary)        | class  | why                                      |
 * | ----------------------------- | ------ | ---------------------------------------- |
 * | confirm (32)                  | modal  | select / confirm dialogs                 |
 * | select (14)                   | modal  | pickers (model, theme, login method)    |
 * | continue (9), continue anyway | modal  | wizards, "Press Enter to continue"       |
 * | save (7)                      | modal  | settings editors                         |
 * | choose (2)                    | modal  | choosers                                 |
 * | apply, add, answer, connect, create | modal | single-use dialogs                |
 * | view (3), open (2), show, show all, resume, mark done, copy link, open GitHub issue | chrome | list / bar hints, shown while claude is otherwise usable |
 * | send, send your message once the session opens, review & send | chrome | composer and handoff hints |
 *
 * Only the modal class is in the allow-list. A chrome hint is drawn beside a
 * usable composer (the background-sessions bar reads `· enter to return ·
 * space to reply`), so matching it would gate the user's composer on a screen
 * that is not blocking anything. Widening this list needs a captured pane or a
 * binary string plus a negative fixture for the nearest chrome hint.
 */
export const ENTER_HINT_FOOTER_RE =
  /\benter to (?:confirm|continue(?: anyway)?|select|save|choose|apply|add|answer|connect|create)\b/i;

/**
 * The footer of an add-dir dialog that refused the last keypress ("held"):
 * claude 2.1.326 swaps `Enter to confirm · Esc to cancel` for `Esc to exit ·
 * To add it, press ↓ to Yes, then Enter` when a key arrived before the select
 * was armed (500 ms after mount and after each refusal) or when Enter did not
 * directly follow a counted Down. The window-too-short variant reads `· To add
 * it, first make the window taller`. Neither contains `enter to confirm`, so
 * every matcher that keyed on the armed footer was blind to a held dialog.
 */
export const HELD_FOOTER_RE = /press ↓ to Yes, then Enter|first make the window taller/i;

/* ────────────────────────────────────────────────────────────────────────── *
 * Add-dir dialog family
 * ────────────────────────────────────────────────────────────────────────── */

/** One directory the caller passed to claude as `--add-dir` for this spawn. */
export interface AutoTrustDirectory {
  /** Repository name shown in the status line. */
  name: string;
  /** Every spelling of the directory claude may print (as passed, and its
   *  realpath, so `/tmp` and `/private/tmp` cannot defeat the equality). */
  paths: string[];
}

export type AddDirFooter = "armed" | "held" | "cutoff";

export interface AddDirDialog {
  /** `startup` = No, exit; `later` = a mid-session `/add-dir` (No, leave it
   *  out); `move` = `/cd` (No, stay put); `apply` = the trust-apply dialog
   *  (No, keep them off). */
  variant: "startup" | "later" | "move" | "apply";
  /** `null` when the title has scrolled off (a cut-off dialog). */
  title: string | null;
  /** The directory the dialog is about, rejoined across wrapped lines. */
  path: string | null;
  /** Choice labels in screen order (cancel first, then confirm). */
  labels: string[];
  /** Row the `❯`/`›` glyph is on; `null` when no cursor row is readable. */
  cursorIndex: number | null;
  /** Row of the confirming choice. */
  yesIndex: number;
  footer: AddDirFooter;
  /** Title + path + labels. The cursor and the footer are deliberately left
   *  out: it is how a drive recognises "the same dialog" across a repaint. */
  identity: string;
}

const ADD_DIR_VARIANTS: ReadonlyArray<{
  variant: AddDirDialog["variant"];
  cancel: string;
  yes: string;
  title: string;
}> = [
  { variant: "startup", cancel: "No, exit", yes: "Yes, add it", title: "Adding a new directory:" },
  { variant: "later", cancel: "No, leave it out", yes: "Yes, add it", title: "Adding a new directory:" },
  { variant: "move", cancel: "No, stay put", yes: "Yes, move here", title: "Moving to a new directory:" },
  { variant: "apply", cancel: "No, keep them off", yes: "Yes, trust it and apply them", title: "Now in a new directory:" },
];

const ADD_DIR_TITLE_RE = /^\s*(Adding a new directory|Moving to a new directory|Now in a new directory):\s*$/;
const ADD_DIR_FOOTER_LINE_RE = /enter to confirm|press ↓ to Yes, then Enter|first make the window taller/i;
const ADD_DIR_TRAILER_RE = /^\s*Adding:\s*(\S.*)$/;
/** The longest trailer claude draws under a cut-off dialog. */
const ADD_DIR_TRAILER_MAX_LINES = 8;
/** The line after the path in the dialog body. */
const ADD_DIR_PATH_END_RE = /^\s*(This directory is part of|This session hasn't worked here|Is this a directory)/i;

/**
 * Parse the add-dir dialog family off the bottom of a pane, or `null`.
 *
 * Shape gates, all required: a footer line (armed, held or cut-off) with only a
 * `Adding:` trailer below it, exactly two choice rows directly above it whose
 * labels are one of the known cancel/confirm pairs, and a title (when present)
 * that agrees with the pair. A transcript that quotes the dialog above an idle
 * composer has no such footer at the bottom and parses to `null`.
 */
export function parseAddDirDialog(pane: string): AddDirDialog | null {
  const lines = pane.split("\n").map((l) => l.replace(/\s+$/, ""));
  let footerAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ADD_DIR_FOOTER_LINE_RE.test(lines[i]!)) {
      footerAt = i;
      break;
    }
  }
  if (footerAt < 0) return null;

  // Below the footer there may be nothing but the cut-off `Adding:` trailer.
  const after = lines.slice(footerAt + 1).filter((l) => l.trim().length > 0);
  let trailerPath: string | null = null;
  if (after.length > 0) {
    if (after.length > ADD_DIR_TRAILER_MAX_LINES) return null;
    const first = after[0]!.match(ADD_DIR_TRAILER_RE);
    if (!first) return null;
    trailerPath = [first[1]!.trim(), ...after.slice(1).map((l) => l.trim())].join("");
  }

  // Two choice rows directly above the footer (blank rows between are fine).
  let i = footerAt - 1;
  while (i >= 0 && lines[i]!.trim() === "") i--;
  const rows: Array<{ label: string; cursor: boolean }> = [];
  for (; i >= 0; i--) {
    const raw = lines[i]!;
    const cur = raw.match(/^\s*[❯›]\s+(\S.*?)\s*$/);
    if (cur) {
      rows.unshift({ label: cur[1]!, cursor: true });
      continue;
    }
    const plain = raw.match(/^\s{2,}(\S.*?)\s*$/);
    if (plain) {
      rows.unshift({ label: plain[1]!, cursor: false });
      continue;
    }
    break;
  }
  const rowsTopAt = i + 1;
  if (rows.length !== 2) return null;
  const pair = ADD_DIR_VARIANTS.find((v) => rows[0]!.label === v.cancel && rows[1]!.label === v.yes);
  if (!pair) return null;
  const cursors = rows.filter((r) => r.cursor).length;
  if (cursors > 1) return null;
  const cursorIndex = cursors === 1 ? rows.findIndex((r) => r.cursor) : null;

  // Title and path, when they are still on screen.
  let title: string | null = null;
  let path: string | null = null;
  for (let t = rowsTopAt - 1; t >= 0; t--) {
    const m = lines[t]!.match(ADD_DIR_TITLE_RE);
    if (!m) continue;
    title = `${m[1]}:`;
    const parts: string[] = [];
    for (let p = t + 1; p < rowsTopAt && parts.length < 6; p++) {
      const body = lines[p]!;
      if (body.trim() === "" || ADD_DIR_PATH_END_RE.test(body)) break;
      parts.push(body.trim());
    }
    path = parts.join("");
    break;
  }
  if (title !== null && title !== pair.title) return null;
  if (path === null || path === "") path = trailerPath;

  const footerLine = lines[footerAt]!;
  const footer: AddDirFooter =
    trailerPath !== null || /first make the window taller/i.test(footerLine)
      ? "cutoff"
      : HELD_FOOTER_RE.test(footerLine)
        ? "held"
        : "armed";
  const labels = [rows[0]!.label, rows[1]!.label];
  return {
    variant: pair.variant,
    title,
    path,
    labels,
    cursorIndex,
    yesIndex: 1,
    footer,
    identity: `${pair.variant}|${title ?? ""}|${path ?? ""}|${labels.join("/")}`,
  };
}

/**
 * Decide whether the pane shows a startup add-dir dialog for a directory agetor
 * itself passed to this spawn. The ONLY producer of an auto-confirm for this
 * dialog family: every guard below is load-bearing, because pane text is
 * agent-influenced and trusting a directory trusts its whole source repository.
 *
 * All of: the startup variant (`No, exit` / exact `Yes, add it`); a title that
 * is `Adding a new directory:` or has scrolled off under a cut-off footer; a
 * footer in the armed, held or cut-off shape at the bottom of the pane; and a
 * rejoined path equal to one of `dirs[].paths`. An empty `dirs` (the setting is
 * off, or the spawn passed no extra directory) never matches.
 */
export function matchAddDirAutoTrust(
  pane: string,
  dirs: AutoTrustDirectory[],
): {
  name: string;
  dir: AutoTrustDirectory;
  acceptIndex: number;
  cursorIndex: number | null;
  footer: AddDirFooter;
  fingerprint: string;
} | null {
  if (dirs.length === 0) return null;
  const d = parseAddDirDialog(pane);
  if (!d || d.variant !== "startup" || d.path === null) return null;
  if (d.title === null && d.footer !== "cutoff") return null;
  const dir = dirs.find((x) => x.paths.some((p) => p === d.path));
  if (!dir) return null;
  return {
    name: dir.name,
    dir,
    acceptIndex: d.yesIndex,
    cursorIndex: d.cursorIndex,
    footer: d.footer,
    fingerprint: sha1(`startup:add-dir:${d.identity}|${d.footer}|@${d.cursorIndex ?? "?"}`),
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Enter-only, paste-code and theme screens
 * ────────────────────────────────────────────────────────────────────────── */

const CURSOR_ROW_RE = /^\s*[❯›]/;
const PRESS_ENTER_RE = /\bPress Enter to (?:continue|retry)\b/i;
const PASTE_CODE_RE = /Paste code here if prompted\s*>/i;
const VOLATILE_RE = /^\s*(?:[✻✶✳✢·*]\s+\S.*…|.*\(\d+s ·.*\)|.*Tip:.*)$/;

function tailNonBlank(tail: string, n: number): string[] {
  return tail
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0 && !VOLATILE_RE.test(l))
    .slice(-n);
}

/**
 * A screen whose only action is Enter: `Login successful. Press Enter to
 * continue…`, `Security notes: … Press Enter to continue…`, `Press Enter to
 * retry.`. Offered only when the press-Enter line is among the last three
 * non-blank lines and no `❯`/`›` row is anywhere in the last twelve, so Enter
 * can never confirm a hidden default of a select, and never fires for a
 * press-Enter line quoted above a live composer or choice rows. `Enter to
 * confirm` screens belong to the choice matchers and are refused here.
 */
export function matchEnterOnlyScreen(tail: string): { paneText: string; fingerprint: string } | null {
  const region = tailNonBlank(tail, 12);
  const last3 = region.slice(-3);
  if (!last3.some((l) => PRESS_ENTER_RE.test(l))) return null;
  if (region.some((l) => CURSOR_ROW_RE.test(l))) return null;
  if (region.some((l) => /\benter to confirm\b/i.test(l))) return null;
  const paneText = region.join("\n");
  // Leading whitespace is not part of the screen's identity: `tmux capture-pane`
  // output is trimmed by the callers, which strips the first line's indent.
  const stable = region.map((l) => l.trim()).join("\n");
  return { paneText: redactPaneSecrets(paneText), fingerprint: sha1(`enter-only:${stable}`) };
}

/**
 * The OAuth manual-code prompt (`Paste code here if prompted >`). The pane text
 * and the fingerprint are built from the REDACTED text, so a code the user
 * types straight into the terminal never reaches a card, a log or the
 * fingerprint, and typing it does not make the card look "dismissed".
 */
export function matchPasteCodeScreen(tail: string): { paneText: string; fingerprint: string } | null {
  const region = tailNonBlank(tail, 12);
  if (!region.slice(-6).some((l) => PASTE_CODE_RE.test(l))) return null;
  if (region.some((l) => CURSOR_ROW_RE.test(l))) return null;
  const paneText = redactPaneSecrets(region.join("\n"));
  const stable = paneText
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/(Paste code here if prompted\s*>)\s*•+/i, "$1");
  return { paneText, fingerprint: sha1(`paste-code:${stable}`) };
}

/** Mask whatever follows `Paste code here if prompted >` on its line. Every
 *  other byte is returned unchanged. */
export function redactPaneSecrets(text: string): string {
  return text.replace(/(Paste code here if prompted\s*>)[ \t]*(\S[^\n]*)/gi, "$1 ••••");
}

/**
 * The first screen of a never-onboarded or logged-out config: a theme picker
 * with no footer at all (even at 80x40), so no footer-keyed matcher sees it.
 * Anchored on the two header lines claude draws, with the `❯` row as the
 * cursor. The `✔` marks the saved theme, not the cursor.
 */
export function matchThemePicker(tail: string): {
  paneText: string;
  choices: { key: string; label: string }[];
  cursorIndex: number;
  fingerprint: string;
} | null {
  const lines = tail.split("\n").map((l) => l.replace(/\s+$/, ""));
  const headerAt = lines.findIndex((l) => /Choose the text style that looks best with your terminal/i.test(l));
  if (headerAt < 0) return null;
  const hintAt = lines.findIndex((l, i) => i > headerAt && /To change this later, run \/theme/i.test(l));
  if (hintAt < 0) return null;
  const rows: Array<{ label: string; cursor: boolean }> = [];
  for (let i = hintAt + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") {
      if (rows.length > 0) break;
      continue;
    }
    if (/^\s*…\s*$/.test(raw)) continue; // the list scrolls: more rows below
    if (/Syntax theme:/i.test(raw)) break;
    const m = raw.match(/^\s*(❯)?\s*(?:✔\s+)?(\S.*?)\s*$/);
    if (!m) break;
    rows.push({ label: m[2]!, cursor: m[1] !== undefined });
  }
  if (rows.length < 2) return null;
  if (rows.filter((r) => r.cursor).length !== 1) return null;
  const cursorIndex = rows.findIndex((r) => r.cursor);
  const choices = rows.map((r, idx) => ({ key: String(idx + 1), label: r.label }));
  const paneText = lines.slice(headerAt, Math.min(lines.length, hintAt + 1 + rows.length + 2)).join("\n").trimEnd();
  return {
    paneText,
    choices,
    cursorIndex,
    fingerprint: sha1(`theme:${choices.map((c) => c.label).join("/")}|@${cursorIndex}`),
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * OAuth code validation: the single implementation is shared with the webview
 * and the CLI/TUI (src/shared/oauth-code.ts), re-exported here for the matchers'
 * callers.
 * ────────────────────────────────────────────────────────────────────────── */
export { OAUTH_CODE_MAX_LEN, validateOAuthCode } from "../shared/oauth-code.ts";
