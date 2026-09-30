/** The harness editor's six editable fields, as the form holds them (raw
 *  strings — `envText` is the `KEY=value` textarea, not the parsed record). */
export interface HarnessEditorDraft {
  id: string;
  label: string;
  kind: string;
  home: string;
  bin: string;
  envText: string;
}

/** Whether any editor field differs from the value the form opened with.
 *  All six are seeded synchronously from the template, so a plain value diff
 *  is exact — an untouched form never reads dirty. */
export function harnessEditorDirty(current: HarnessEditorDraft, initial: HarnessEditorDraft): boolean {
  return (
    current.id !== initial.id ||
    current.label !== initial.label ||
    current.kind !== initial.kind ||
    current.home !== initial.home ||
    current.bin !== initial.bin ||
    current.envText !== initial.envText
  );
}
