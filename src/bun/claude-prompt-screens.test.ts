import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENTER_HINT_FOOTER_RE,
  HELD_FOOTER_RE,
  OAUTH_CODE_MAX_LEN,
  matchAddDirAutoTrust,
  matchEnterOnlyScreen,
  matchPasteCodeScreen,
  matchThemePicker,
  parseAddDirDialog,
  redactPaneSecrets,
  validateOAuthCode,
} from "./claude-prompt-screens.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "claude-prompts", "2.1.326");

/** A captured pane, minus the `# claude <version> · live|binary` provenance line. */
function pane(name: string): string {
  const text = readFileSync(join(FIXTURE_DIR, `${name}.txt`), "utf8");
  const [first, ...rest] = text.split("\n");
  if (!/^# claude 2\.1\.326 · (live|binary)/.test(first ?? "")) {
    throw new Error(`${name}: missing version/provenance header`);
  }
  return rest.join("\n");
}

const WT = "/Users/me/.agetor/worktrees/4c34cf8f-a6fd-4f75-865c-92d7dbafa101";
const REPO_E = `${WT}/repo-e`;
const REPO_F = `${WT}/repo-f`;
const DIRS = [
  { name: "repo-e", paths: [REPO_E] },
  { name: "repo-f", paths: [REPO_F] },
];

describe("parseAddDirDialog", () => {
  test("startup dialog, armed: title, path, labels, cursor on No", () => {
    const d = parseAddDirDialog(pane("add-dir-startup-armed"))!;
    expect(d.variant).toBe("startup");
    expect(d.title).toBe("Adding a new directory:");
    expect(d.path).toBe(REPO_E);
    expect(d.labels).toEqual(["No, exit", "Yes, add it"]);
    expect(d.cursorIndex).toBe(0);
    expect(d.yesIndex).toBe(1);
    expect(d.footer).toBe("armed");
  });

  test("cursor on Yes is read as 1, and the identity ignores the cursor", () => {
    const a = parseAddDirDialog(pane("add-dir-startup-armed"))!;
    const b = parseAddDirDialog(pane("add-dir-startup-cursor-yes"))!;
    expect(b.cursorIndex).toBe(1);
    expect(b.identity).toBe(a.identity);
  });

  test("held footer is read as held with the cursor still readable", () => {
    const d = parseAddDirDialog(pane("add-dir-startup-held"))!;
    expect(d.footer).toBe("held");
    expect(d.cursorIndex).toBe(0);
    expect(d.path).toBe(REPO_E);
  });

  test("cut-off dialog: title scrolled off, a ~450-char path reassembled from a six-row Adding: trailer", () => {
    const raw = pane("add-dir-startup-cutoff");
    const trailerAt = raw.split("\n").findIndex((l) => l.startsWith(" Adding:"));
    const trailerRows = raw.split("\n").slice(trailerAt).filter((l) => l.trim().length > 0);
    expect(trailerRows.length).toBe(6);
    const d = parseAddDirDialog(raw)!;
    expect(d.footer).toBe("cutoff");
    expect(d.title).toBeNull();
    const expected = `/Users/me/.agetor/worktrees/long/ws/${"d".repeat(404)}/repo-long`;
    expect(expected.length).toBe(450);
    expect(d.path).toBe(expected);
    expect(d.cursorIndex).toBe(0);
  });

  test("mid-session variants are parsed as their own variant", () => {
    expect(parseAddDirDialog(pane("add-dir-later"))!.variant).toBe("later");
    expect(parseAddDirDialog(pane("cd-move"))!.variant).toBe("move");
    expect(parseAddDirDialog(pane("add-dir-apply"))!.variant).toBe("apply");
  });

  test("two repositories give two identities", () => {
    const a = parseAddDirDialog(pane("add-dir-startup-armed"))!;
    const b = parseAddDirDialog(pane("add-dir-startup-armed-repo-f"))!;
    expect(a.identity).not.toBe(b.identity);
  });

  test("a transcript quoting the dialog above an idle composer is not a dialog", () => {
    expect(parseAddDirDialog(pane("add-dir-quoted-in-transcript"))).toBeNull();
  });

  test("a title that disagrees with the labels is refused", () => {
    const swapped = pane("add-dir-startup-armed").replace("Adding a new directory:", "Moving to a new directory:");
    expect(parseAddDirDialog(swapped)).toBeNull();
  });

  test("a footer with text other than a trailer below it is refused", () => {
    expect(parseAddDirDialog(`${pane("add-dir-startup-armed")}\nsome other output\n`)).toBeNull();
  });

  test("no cursor row is readable → cursorIndex null (never guessed)", () => {
    const noCursor = pane("add-dir-startup-armed").replace(" ❯ No, exit", "   No, exit");
    const d = parseAddDirDialog(noCursor)!;
    expect(d.cursorIndex).toBeNull();
  });
});

describe("matchAddDirAutoTrust", () => {
  test("startup fixture + listed path → accept index 1, cursor 0, armed", () => {
    const m = matchAddDirAutoTrust(pane("add-dir-startup-armed"), DIRS)!;
    expect(m.name).toBe("repo-e");
    expect(m.acceptIndex).toBe(1);
    expect(m.cursorIndex).toBe(0);
    expect(m.footer).toBe("armed");
  });

  test("held and cut-off footers still match (the drive handles them)", () => {
    expect(matchAddDirAutoTrust(pane("add-dir-startup-held"), DIRS)!.footer).toBe("held");
    const long = parseAddDirDialog(pane("add-dir-startup-cutoff"))!.path!;
    const m = matchAddDirAutoTrust(pane("add-dir-startup-cutoff"), [{ name: "repo-long", paths: [long] }])!;
    expect(m.footer).toBe("cutoff");
  });

  test("the path must be one agetor passed", () => {
    expect(matchAddDirAutoTrust(pane("add-dir-startup-armed"), [{ name: "other", paths: ["/Users/me/other"] }])).toBeNull();
  });

  test("an empty list (setting off) never matches", () => {
    expect(matchAddDirAutoTrust(pane("add-dir-startup-armed"), [])).toBeNull();
  });

  test("a prefix of the path is not equality", () => {
    expect(matchAddDirAutoTrust(pane("add-dir-startup-armed"), [{ name: "x", paths: [`${REPO_E}/sub`] }])).toBeNull();
    expect(matchAddDirAutoTrust(pane("add-dir-startup-armed"), [{ name: "x", paths: [WT] }])).toBeNull();
  });

  test("a realpath spelling in paths[] matches", () => {
    const m = matchAddDirAutoTrust(pane("add-dir-startup-armed"), [{ name: "repo-e", paths: ["/elsewhere/repo-e", REPO_E] }]);
    expect(m?.name).toBe("repo-e");
  });

  test("later / move / apply variants are never auto-trusted", () => {
    for (const f of ["add-dir-later", "cd-move", "add-dir-apply"]) {
      expect(matchAddDirAutoTrust(pane(f), DIRS)).toBeNull();
    }
  });

  test("the transcript-quoted dialog is never auto-trusted", () => {
    expect(matchAddDirAutoTrust(pane("add-dir-quoted-in-transcript"), DIRS)).toBeNull();
  });

  test("different repositories → different fingerprints", () => {
    const a = matchAddDirAutoTrust(pane("add-dir-startup-armed"), DIRS)!;
    const b = matchAddDirAutoTrust(pane("add-dir-startup-armed-repo-f"), DIRS)!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("the fingerprint tracks the cursor (a landed Down changes it)", () => {
    const a = matchAddDirAutoTrust(pane("add-dir-startup-armed"), DIRS)!;
    const b = matchAddDirAutoTrust(pane("add-dir-startup-cursor-yes"), DIRS)!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("matchEnterOnlyScreen", () => {
  test.each(["login-successful", "security-notes", "press-enter-retry"])("%s is an enter-only screen", (name) => {
    const m = matchEnterOnlyScreen(pane(name));
    expect(m).not.toBeNull();
    expect(m!.paneText).toMatch(/Press Enter to (continue|retry)/);
  });

  test("a press-Enter line quoted above an idle composer is not one", () => {
    expect(matchEnterOnlyScreen(pane("chrome-press-enter-quoted-above-composer"))).toBeNull();
  });

  test("a press-Enter line above choice rows is not one", () => {
    const withRows = `${pane("login-successful")}\n ❯ 1. Yes\n   2. No\n`;
    expect(matchEnterOnlyScreen(withRows)).toBeNull();
  });

  test("a select with a cursor row is not one even with the words on screen", () => {
    expect(matchEnterOnlyScreen(" Press Enter to continue…\n ❯ No, exit\n   Yes, add it\n Enter to confirm · Esc to cancel\n")).toBeNull();
  });

  test("the fingerprint is stable and changes with the text", () => {
    const a = matchEnterOnlyScreen(pane("login-successful"))!;
    expect(matchEnterOnlyScreen(pane("login-successful"))!.fingerprint).toBe(a.fingerprint);
    expect(matchEnterOnlyScreen(pane("press-enter-retry"))!.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("matchPasteCodeScreen + redactPaneSecrets", () => {
  test("matches the paste-code prompt, with and without a typed code", () => {
    expect(matchPasteCodeScreen(pane("paste-code"))).not.toBeNull();
    expect(matchPasteCodeScreen(pane("paste-code-typed"))).not.toBeNull();
  });

  test("a code typed in the terminal never reaches the pane text", () => {
    const m = matchPasteCodeScreen(pane("paste-code-typed"))!;
    expect(m.paneText).not.toContain("abc123");
    expect(m.paneText).toContain("Paste code here if prompted > ••••");
  });

  test("typing a code does not change the fingerprint", () => {
    expect(matchPasteCodeScreen(pane("paste-code"))!.fingerprint).toBe(matchPasteCodeScreen(pane("paste-code-typed"))!.fingerprint);
  });

  test("redactPaneSecrets masks the remainder of the line and nothing else", () => {
    expect(redactPaneSecrets("Paste code here if prompted > abc123")).toBe("Paste code here if prompted > ••••");
    const untouched = "line one\n  Paste code here if prompted > \nthe end\n";
    expect(redactPaneSecrets(untouched)).toBe(untouched);
    const multi = "a\nPaste code here if prompted > secret-1\n\nb\nPaste code here if prompted >secret-2\n\nc";
    expect(redactPaneSecrets(multi)).toBe("a\nPaste code here if prompted > ••••\n\nb\nPaste code here if prompted > ••••\n\nc");
    expect(redactPaneSecrets("nothing to mask here")).toBe("nothing to mask here");
  });

  test("a code wrapped onto the lines below the prompt is masked too, and the fingerprint is unchanged", () => {
    const wrapped = [
      " Paste code here if prompted > wrapped-secret-part-one-abcdefghijklmnop",
      "qrstuvwxyz-wrapped-secret-part-two#state-value",
      "",
      " ❯ ",
    ].join("\n").replace(" ❯ ", " Esc to cancel");
    const out = redactPaneSecrets(wrapped);
    expect(out).not.toContain("wrapped-secret");
    expect(out).not.toContain("state-value");
    expect(out).toContain("Paste code here if prompted > ••••");
    expect(out).toContain("Esc to cancel");
    const base = matchPasteCodeScreen(" Welcome\n Paste code here if prompted >\n Esc to cancel\n")!;
    const typed = matchPasteCodeScreen(" Welcome\n Paste code here if prompted > wrapped-secret-part-one-abcdefghijklmnop\nqrstuvwxyz-wrapped-secret-part-two#state-value\n Esc to cancel\n")!;
    expect(typed.paneText).not.toContain("wrapped-secret");
    expect(typed.paneText).not.toContain("state-value");
    expect(typed.fingerprint).toBe(base.fingerprint);
  });

  test("the fingerprint is stable on a full login screen when a wrapped code adds lines below the prompt", () => {
    const head = Array.from({ length: 14 }, (_, i) => ` Login screen line ${i + 1}`).join("\n");
    const base = matchPasteCodeScreen(`${head}\n Paste code here if prompted >\n Esc to cancel\n`)!;
    const typed = matchPasteCodeScreen(
      `${head}\n Paste code here if prompted > wrapped-secret-part-one-abcdefghijklmnop\nqrstuvwxyz-wrapped-secret-part-two\nmore-wrapped-secret-part-three#state-value\n Esc to cancel\n`,
    )!;
    expect(typed.fingerprint).toBe(base.fingerprint);
    expect(typed.paneText).not.toContain("wrapped-secret");
    expect(typed.paneText).not.toContain("state-value");
  });

  test("a code that starts on the row under a bare marker is masked, prose under an empty prompt is not", () => {
    const code = `${"a".repeat(80)}${"b".repeat(80)}#state-value`;
    const pane = ` Welcome\n Paste code here if prompted >\n${code.slice(0, 80)}\n${code.slice(80)}\n\n Esc to cancel`;
    const out = redactPaneSecrets(pane);
    expect(out).not.toContain("aaaa");
    expect(out).not.toContain("bbbb");
    expect(out).not.toContain("state-value");
    expect(out).toContain("Paste code here if prompted > ••••");
    expect(out).toContain("Esc to cancel");
    expect(redactPaneSecrets(out)).toBe(out);
    const m = matchPasteCodeScreen(pane)!;
    expect(m.paneText).not.toContain("aaaa");
    expect(m.fingerprint).toBe(matchPasteCodeScreen(" Welcome\n Paste code here if prompted >\n\n Esc to cancel")!.fingerprint);
  });

  test("a full-length code wrapped past six rows still matches, with the same fingerprint", () => {
    const code = "c".repeat(500) + "#xyz";
    const rows = [` Paste code here if prompted > ${code.slice(0, 49)}`];
    for (let i = 49; i < code.length; i += 80) rows.push(code.slice(i, i + 80));
    expect(rows.length).toBeGreaterThan(6);
    const typed = matchPasteCodeScreen(` Welcome\n${rows.join("\n")}\n Esc to cancel\n`);
    expect(typed).not.toBeNull();
    expect(typed!.paneText).not.toContain("cccc");
    expect(typed!.fingerprint).toBe(matchPasteCodeScreen(" Welcome\n Paste code here if prompted >\n Esc to cancel\n")!.fingerprint);
  });

  test("an old prompt with unrelated output under it is not a paste-code screen", () => {
    const below = Array.from({ length: 6 }, (_, i) => ` some later output line ${i + 1}`).join("\n");
    expect(matchPasteCodeScreen(` Paste code here if prompted >\n${below}\n`)).toBeNull();
    const tokens = Array.from({ length: 20 }, () => "x".repeat(40)).join("\n");
    expect(matchPasteCodeScreen(` Paste code here if prompted > abc\n${tokens}\n${below}\n`)).toBeNull();
  });

  test("redaction is idempotent", () => {
    const once = redactPaneSecrets("Paste code here if prompted > abc");
    expect(redactPaneSecrets(once)).toBe(once);
  });

  test("a pane with a cursor row is not a paste-code screen", () => {
    expect(matchPasteCodeScreen(" Paste code here if prompted > \n ❯ 1. Yes\n   2. No\n")).toBeNull();
  });
});

describe("matchThemePicker", () => {
  test("the logged-out first screen: rows, cursor, the saved ✔ is not the cursor", () => {
    const m = matchThemePicker(pane("theme-picker"))!;
    expect(m.choices.map((c) => c.label)).toEqual(["Auto (match terminal)", "Dark mode", "Light mode"]);
    expect(m.cursorIndex).toBe(0);
    expect(m.choices[0]!.key).toBe("1");
  });

  test("other screens are not a theme picker", () => {
    expect(matchThemePicker(pane("login-method"))).toBeNull();
    expect(matchThemePicker(pane("add-dir-startup-armed"))).toBeNull();
  });

  test("the cursor moving changes the fingerprint", () => {
    const moved = pane("theme-picker").replace(" ❯ ✔ Auto (match terminal)", "   ✔ Auto (match terminal)").replace("     Dark mode", " ❯   Dark mode");
    const a = matchThemePicker(pane("theme-picker"))!;
    const b = matchThemePicker(moved)!;
    expect(b.cursorIndex).toBe(1);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("footer vocabulary", () => {
  const MODAL_VERBS = ["confirm", "select", "continue", "continue anyway", "save", "choose", "apply", "add", "answer", "connect", "create"];
  test.each(MODAL_VERBS)("modal verb %s is an Enter-hint footer", (verb) => {
    expect(ENTER_HINT_FOOTER_RE.test(` Enter to ${verb} · Esc to cancel`)).toBe(true);
    expect(ENTER_HINT_FOOTER_RE.test(` enter to ${verb}`)).toBe(true);
  });

  const CHROME = [
    "1 background session · enter to return · space to reply",
    "Enter to view",
    "Enter to open",
    "Enter to show all",
    "Enter to send",
    "Enter to review & send",
    "Enter to resume",
    "Enter to mark done",
    "Enter to copy link",
  ];
  test.each(CHROME)("chrome hint %s is not a modal footer", (hint) => {
    expect(ENTER_HINT_FOOTER_RE.test(hint)).toBe(false);
  });

  test("the chrome fixture is not a footer match", () => {
    expect(ENTER_HINT_FOOTER_RE.test(pane("chrome-background-sessions-bar"))).toBe(false);
  });

  test("HELD_FOOTER_RE matches the held and window-too-short footers only", () => {
    expect(HELD_FOOTER_RE.test("Esc to exit · To add it, press ↓ to Yes, then Enter")).toBe(true);
    expect(HELD_FOOTER_RE.test("Esc to cancel · To add it, first make the window taller")).toBe(true);
    expect(HELD_FOOTER_RE.test("Enter to confirm · Esc to cancel")).toBe(false);
  });
});

describe("validateOAuthCode", () => {
  test("accepts a normal code and trims surrounding spaces", () => {
    expect(validateOAuthCode("  abc123#xyz  ")).toEqual({ ok: true, code: "abc123#xyz" });
  });
  test("512 chars ok, 513 too long", () => {
    expect(validateOAuthCode("a".repeat(OAUTH_CODE_MAX_LEN)).ok).toBe(true);
    expect(validateOAuthCode("a".repeat(OAUTH_CODE_MAX_LEN + 1)).ok).toBe(false);
    const r = validateOAuthCode("a".repeat(OAUTH_CODE_MAX_LEN + 1));
    expect(!r.ok && r.error).toBe("too-long");
  });
  test("newlines are multi-line", () => {
    for (const v of ["a\nb", "a\rb", "a\r\nb", "\n"]) {
      const r = validateOAuthCode(v);
      expect(!r.ok && r.error).toBe("multi-line");
    }
  });
  test.each(["a\tb", "a\u001bb", "a\u007fb", "a\u0085b", "a\u009fb", "a\u0000b"])("control character %j is refused", (v) => {
    const r = validateOAuthCode(v);
    expect(!r.ok && r.error).toBe("control-char");
  });
  test("non-strings and whitespace-only", () => {
    for (const v of [undefined, null, 5, {}, ["a"]]) {
      const r = validateOAuthCode(v);
      expect(!r.ok && r.error).toBe("not-a-string");
    }
    for (const v of ["", "   "]) {
      const r = validateOAuthCode(v);
      expect(!r.ok && r.error).toBe("empty");
    }
  });
  test("the result never carries the submitted value on failure", () => {
    const secret = "super-secret-code\n";
    const r = validateOAuthCode(secret);
    expect(JSON.stringify(r)).not.toContain("super-secret-code");
  });
});
