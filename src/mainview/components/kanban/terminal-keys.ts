/**
 * macOS word/line editing shortcuts for the task-details terminal, matching
 * VS Code's integrated terminal. xterm's `macOptionIsMeta` only rewrites
 * *printable* Opt+letter keys (Opt+B/Opt+F → Meta); it doesn't touch the
 * arrows, and ⌘ combos never reach the shell at all. For these, xterm's
 * default is either a CSI-modified arrow (\x1b[1;3D) that the default
 * zsh/readline keymap doesn't bind to word/line movement, or nothing — so we
 * translate each into the byte sequence zsh's default emacs keymap expects and
 * send it ourselves. Shell-config agnostic, the same way VS Code wires these up.
 *
 * Returns the bytes to write to the PTY, or null if the combo isn't one we
 * handle (in which case the caller should let xterm process the key normally).
 *
 * Pure + dependency-free on purpose so it can be unit-tested without xterm,
 * React, or a real KeyboardEvent — see terminal-keys.test.ts.
 */
type EditKeyEvent = Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey" | "key">;

export function macEditSequence(e: EditKeyEvent): string | null {
  // Shifted combos (⇧ + ⌘/⌥ + arrow) are selection gestures elsewhere — leave
  // them to xterm's default path rather than swallowing a whole key class.
  if (e.shiftKey) return null;

  // ⌘ — whole-line navigation / deletion.
  if (e.metaKey && !e.altKey && !e.ctrlKey) {
    switch (e.key) {
      case "ArrowLeft": return "\x01"; // ⌘← → line start (Ctrl-A)
      case "ArrowRight": return "\x05"; // ⌘→ → line end (Ctrl-E)
      // ⌘⌫ → Ctrl-U. NB: in zsh's default emacs keymap ^U is kill-whole-line
      // (deletes the entire line, not just to the left of the cursor); in
      // bash/readline it's unix-line-discard (cursor→start). Same byte VS Code
      // sends; behavior is shell-dependent.
      case "Backspace": return "\x15";
      case "Delete": return "\x0b"; // ⌘⌦ → delete to line end (Ctrl-K)
    }
    return null;
  }

  // ⌥ — word navigation / deletion.
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    switch (e.key) {
      case "ArrowLeft": return "\x1bb"; // ⌥← → word left
      case "ArrowRight": return "\x1bf"; // ⌥→ → word right
      case "Backspace": return "\x1b\x7f"; // ⌥⌫ → delete word back
      case "Delete": return "\x1bd"; // ⌥⌦ → delete word forward
    }
  }

  return null;
}
