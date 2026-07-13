// Turn a unified-diff hunk body (the `@@ … @@` sections, without the
// `diff --git`/`+++`/`---` header) into per-line rows carrying the resolved
// old/new line numbers. Those line numbers feed real GitHub line-comment POSTs,
// so the LEFT (`old`) / RIGHT (`neu`) mapping has to stay exact — hence the
// dedicated, unit-tested module rather than an inline helper.

export interface DiffRow {
  old: number | null;
  neu: number | null;
  kind: "ctx" | "add" | "del" | "hunk" | "meta";
  text: string;
}

export function toRows(hunks: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of hunks.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      rows.push({ old: null, neu: null, kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ old: null, neu: newNo++, kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ old: oldNo++, neu: null, kind: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      rows.push({ old: null, neu: null, kind: "meta", text: line });
    } else {
      rows.push({ old: oldNo++, neu: newNo++, kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  if (rows.length && rows[rows.length - 1]!.kind === "ctx" && rows[rows.length - 1]!.text === "") rows.pop();
  return rows;
}
