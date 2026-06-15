import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeDrop } from "./paste.ts";

/**
 * A minimal single-line text input, hand-rolled on `useInput` (no extra dep).
 * Stays mounted across sends so you can fire several messages in a row; clears
 * on submit, exits on Esc. Only active while `active` so it never competes with
 * the dashboard's nav keys.
 */
export function Composer({
  active,
  label,
  width,
  onSubmit,
  onCancel,
}: {
  active: boolean;
  label: string;
  width?: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");

  useInput(
    (input, key) => {
      if (key.escape) {
        setText("");
        onCancel();
        return;
      }
      if (key.return) {
        const t = text.trim();
        if (t) {
          onSubmit(t);
          setText("");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setText((s) => s.slice(0, -1));
        return;
      }
      // Append printable input only — skip control/meta chords (arrows, Ctrl-C).
      // A multi-char chunk is a paste/drop; normalize a dragged file path.
      if (input && !key.ctrl && !key.meta) {
        const chunk = input.length > 1 ? sanitizeDrop(input) : input;
        setText((s) => s + chunk);
      }
    },
    { isActive: active },
  );

  return (
    // truncate-start keeps the caret (and the text you just typed) on screen
    // when the message outgrows the terminal width.
    <Box paddingX={1} width={width}>
      <Text wrap="truncate-start">
        <Text color="cyan">{label} </Text>
        {text}
        <Text color="cyan">▏</Text>
      </Text>
    </Box>
  );
}
