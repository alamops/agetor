import type { DiffFile } from "../shared/types.ts";

// Hunks larger than this (per file) are truncated before crossing the API so
// a generated lockfile or vendored blob can't bloat the payload / freeze the
// renderer. The viewer surfaces the truncation.
const PER_FILE_HUNK_CAP = 200_000;
export const MAX_DIFF_FILES = 500;

/** Strip a leading `a/` or `b/` prefix and un-quote git's C-style path. */
function cleanPath(raw: string): string | null {
  let p = raw.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    // git quotes paths containing unusual bytes; the escaping overlaps with
    // JSON for the common cases (spaces, unicode). Best-effort un-quote.
    try { p = JSON.parse(p) as string; } catch { /* keep quoted form */ }
  }
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

/**
 * Parse `git diff` (unified, --no-color) output into one entry per file.
 * Sections start at each `diff --git …` line; the body keeps the extended
 * header (`new file mode`, `rename to`, `Binary files …`) plus the `@@` hunks.
 */
export function parseGitDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const headerRe = /^diff --git .*$/gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(raw))) starts.push(m.index);

  for (let i = 0; i < starts.length; i++) {
    const section = raw.slice(starts[i], starts[i + 1] ?? raw.length);
    const lines = section.split("\n");
    const header = /^diff --git (.+) (.+)$/.exec(lines[0] ?? "");
    const headerOldPath = header ? cleanPath(header[1]!) : null;
    const headerNewPath = header ? cleanPath(header[2]!) : null;
    let status: DiffFile["status"] = "modified";
    let binary = false;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let hunkStart = -1;

    for (let j = 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.startsWith("new file mode")) status = "added";
      else if (l.startsWith("deleted file mode")) status = "deleted";
      else if (l.startsWith("rename from ")) { renameFrom = cleanPath(l.slice(12)); status = "renamed"; }
      else if (l.startsWith("rename to ")) { renameTo = cleanPath(l.slice(10)); status = "renamed"; }
      else if (l.startsWith("Binary files") || l.startsWith("GIT binary patch")) binary = true;
      else if (l.startsWith("--- ")) oldPath = cleanPath(l.slice(4));
      else if (l.startsWith("+++ ")) newPath = cleanPath(l.slice(4));
      else if (l.startsWith("@@")) { hunkStart = j; break; }
    }

    const fullHunks = hunkStart >= 0 ? lines.slice(hunkStart).join("\n") : "";

    let additions = 0;
    let deletions = 0;
    for (const l of fullHunks.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) additions++;
      else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
    }

    let hunks = fullHunks;
    let truncated = false;
    if (fullHunks.length > PER_FILE_HUNK_CAP) {
      const cut = fullHunks.lastIndexOf("\n", PER_FILE_HUNK_CAP);
      hunks = fullHunks.slice(0, cut > 0 ? cut : PER_FILE_HUNK_CAP);
      truncated = true;
    }

    files.push({
      path: renameTo ?? newPath ?? headerNewPath ?? oldPath ?? headerOldPath ?? "(unknown)",
      oldPath: status === "renamed" ? renameFrom ?? oldPath ?? headerOldPath : null,
      status,
      additions,
      deletions,
      binary,
      hunks: binary ? "" : hunks,
      truncated,
    });
  }
  return files;
}
