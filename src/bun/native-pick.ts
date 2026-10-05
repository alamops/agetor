/**
 * Reading Electrobun's native Open-panel answer. `Utils.openFileDialog`
 * returns the panel's paths joined with "," and split back on "," — so a
 * picked path that itself contains a comma ("Backups, 2026") arrives in
 * pieces. These helpers put such a path back together.
 *
 * The "," separator is Electrobun's own (verified in the 1.18.1 native
 * library, `package.json` pins `^1.18.1`). If an upgrade changes how the
 * answer is joined — another separator, or a real array — these helpers and
 * `native-pick.test.ts` need to follow.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The one path a single-selection panel picked, or null when it was
 * cancelled. Joining every piece back is exact because only one path was
 * chosen. A relative answer isn't a pick. The answer is never trimmed: a
 * folder name may end in a space.
 */
export function singlePickedPath(picks: readonly string[]): string | null {
  const joined = picks.join(",");
  return joined.length > 0 && path.isAbsolute(joined) ? joined : null;
}

/**
 * The paths a multi-selection panel picked. A piece that isn't absolute
 * can only be the tail of the path before it (every picked path is
 * absolute), so it's joined back on. A piece that is absolute starts a new
 * path — unless it continues the one before through a folder whose name
 * ends in "," (`/d/Backups,/2026,/f.json` arrives as `/d/Backups`, `/2026`,
 * `/f.json`). Such a run is joined back when the joined path exists while
 * the head or the joined-on tail doesn't (so a sibling named like either
 * half doesn't split it). When both halves and the join all exist the answer
 * is ambiguous: it reads as separate picks when the tail sits inside the
 * head's own folder — what one panel listing shows, so what one
 * multi-selection holds (`/d/a`, `/d/b`) — and as one path otherwise
 * (`/d/Backups,/Library`: `/Library` exists on every Mac, but a selection
 * of `/d/Backups` beside it would span two listings). Empty pieces (a
 * cancelled panel) are dropped.
 */
export function pickedPaths(picks: readonly string[], exists: (p: string) => boolean = existsSync): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < picks.length) {
    const piece = picks[i]!;
    const last = out.length - 1;
    if (last >= 0) {
      const end = path.isAbsolute(piece) ? rejoinEnd(out[last]!, picks, i, exists) : i;
      if (end >= 0) {
        out[last] = `${out[last]},${picks.slice(i, end + 1).join(",")}`;
        i = end + 1;
        continue;
      }
    }
    if (piece.length > 0) out.push(piece);
    i++;
  }
  return out.filter((p) => path.isAbsolute(p));
}

/**
 * The last index of the run of pieces from `start` that rejoins onto
 * `head`, or -1 when none does. The run only grows while the next join's
 * parent folder exists — a real continuation always sits inside an
 * existing folder (`/d/Backups,` for `/d/Backups,/2026`) — so separate
 * picks cost a couple of stats each, not one per later piece.
 */
function rejoinEnd(head: string, picks: readonly string[], start: number, exists: (p: string) => boolean): number {
  let tail = picks[start]!;
  for (let k = start; ; k++) {
    if (k > start) tail = `${tail},${picks[k]}`;
    const joined = `${head},${tail}`;
    if (exists(joined) && (!exists(head) || !exists(tail) || !insideFolderOf(tail, head))) return k;
    if (k + 1 >= picks.length || !exists(path.dirname(`${joined},${picks[k + 1]}`))) return -1;
  }
}

/** Whether `p` lies inside the folder that holds `sibling`. */
function insideFolderOf(p: string, sibling: string): boolean {
  const folder = path.dirname(sibling);
  return p.startsWith(folder === "/" ? "/" : `${folder}/`);
}
