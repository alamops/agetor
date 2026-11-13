// Filesystem access inside a TASK's directory (the worktree or workdir an agent
// runs in), done on behalf of the core: `@`-mention resolution, the
// `.claude/settings.local.json` cleanup (hook-installer.ts, and the
// multi-repository workspace-root teardown), the cursor plan-file write, the
// "does the worktree still exist" check and the "is there a `.git` entry"
// check before a workspace child is cleared (D25).
//
// Why this module exists. A task's directory can sit under a macOS-protected
// folder (Documents, Desktop, a cloud drive, ...) that the user granted to the
// AGENT's binary, not to Agetor. Any same-user agent can plant files in its
// own directory (a symlink named `x` pointing at a protected path, an
// oversized `settings.local.json`) and then trigger one of the touches above,
// either by mentioning `@x` in a message or by just running. If the core
// process did those stat/read/write calls itself, they would be made under the
// core's own TCC identity: the agent could use the core as a confused deputy
// to probe, or provoke permission prompts for, places it cannot reach on its
// own. So whenever the disclaim switch is on (`disclaimEnabled()`), every
// touch runs in a short-lived DISCLAIMED child of Apple system tools
// (`/bin/sh`, `/usr/bin/stat`, `/bin/realpath`, `/bin/cat`, `/bin/mkdir`,
// `/bin/mv`, `/bin/rm`, `/bin/rmdir`). That child is responsible for itself, so it has
// exactly the access any self-responsible process has, which is what the
// agent can already get by running the disclaim helper itself. When disclaim is
// off or unavailable (non-darwin, no helper, the user turned it off) the same
// operations stay in-process: same identity either way, the one switch (D7).
//
// Safety rules for the disclaimed path:
//  - Paths travel ONLY as argv elements of a fixed script, never interpolated
//    into script text, so no name can inject shell syntax. Every tool gets a
//    `--` before its path operands, so a leading `-` is a name, not a flag.
//  - File content travels on stdin; results come back as fixed tokens
//    (one per line) or, for a read, a token line followed by the raw bytes. A
//    path is never printed, so names containing newlines cannot desync the
//    protocol.
//  - Absolute tool paths and `LC_ALL=C`, so neither `PATH` nor the locale of
//    the core changes what runs or how its errors read.
//  - Every child has a 10 s budget (a pending TCC prompt blocks a child, not
//    the core). A timeout is a failure: resolve -> null, exists -> false, read
//    -> error, write -> throws.
//
// The in-process path is the reference implementation: `resolveAtPath`'s
// semantics (project-files.ts) are reproduced exactly by the disclaimed one.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import { disclaimEnabled } from "./disclaim.ts";
import { resolveAtPath } from "./project-files.ts";
import { isSafeRelPath } from "./worktree.ts";

/** Per-child wall-clock budget. Past it the child is killed and the call fails. */
const CHILD_TIMEOUT_MS = 10_000;
/** `@` items per child, and a byte budget for their argv, well under macOS ARG_MAX (1 MiB). */
const RESOLVE_CHUNK_ITEMS = 128;
const RESOLVE_CHUNK_ARG_BYTES = 200_000;
/** stderr is only used for an error message; keep a small prefix. */
const STDERR_CAP_BYTES = 16 * 1024;

interface ChildResult {
  /** The child ran to completion within the budget and its stdout fit `maxStdout`. */
  completed: boolean;
  timedOut: boolean;
  /** Set when stdout grew past `maxStdout` (the child was killed). */
  overflow: boolean;
  /** Spawn itself threw (helper missing, ...). */
  spawnError: string | null;
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Read a stream to the end, but stop (and report it) once more than `cap` bytes arrive. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  cap: number,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  if (!stream) return { bytes: new Uint8Array(0), overflow: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return { bytes: concat(chunks, total - value.length), overflow: true };
      }
      chunks.push(value);
    }
  } catch {
    // A killed child's pipe can error mid-read; whatever arrived is what we have.
  }
  return { bytes: concat(chunks, total), overflow: false };
}

/**
 * Run `/bin/sh -c SCRIPT sh ...args` through `coreSpawn` (disclaimed + scrubbed
 * env). Never throws.
 */
async function runScript(
  script: string,
  args: readonly string[],
  opts: { stdin?: Uint8Array; maxStdout: number },
): Promise<ChildResult> {
  const fail = (extra: Partial<ChildResult>): ChildResult => ({
    completed: false,
    timedOut: false,
    overflow: false,
    spawnError: null,
    code: null,
    stdout: new Uint8Array(0),
    stderr: "",
    ...extra,
  });
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn(["/bin/sh", "-c", script, "sh", ...args], {
      env: { ...childEnv(), LC_ALL: "C" },
      stdin: opts.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return fail({ spawnError: err instanceof Error ? err.message : String(err) });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CHILD_TIMEOUT_MS);
  });
  const work = (async (): Promise<ChildResult> => {
    const [out, err] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array> | null, opts.maxStdout),
      readCapped(proc.stderr as ReadableStream<Uint8Array> | null, STDERR_CAP_BYTES),
    ]);
    if (out.overflow) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    const code = await proc.exited;
    return {
      completed: !out.overflow,
      timedOut: false,
      overflow: out.overflow,
      spawnError: null,
      code,
      stdout: out.bytes,
      stderr: new TextDecoder().decode(err.bytes).trim(),
    };
  })();
  work.catch(() => {});
  const winner = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  if (winner === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    return fail({ timedOut: true });
  }
  return winner;
}

function describeFailure(r: ChildResult, what: string): string {
  if (r.spawnError) return `${what}: could not start helper (${r.spawnError})`;
  if (r.timedOut) return `${what}: timed out after ${CHILD_TIMEOUT_MS / 1000} s (a macOS permission prompt may be waiting)`;
  if (r.overflow) return `${what}: output too large`;
  return r.stderr ? `${what}: ${r.stderr}` : `${what}: failed (exit ${r.code})`;
}

// ---------------------------------------------------------------------------
// @-mention resolution
// ---------------------------------------------------------------------------

/**
 * Per item: `D` / `F` for a resolved directory / file, `N` otherwise. Mirrors
 * `resolveAtPath` after its in-process `isSafeRelPath` check: stat (following
 * symlinks), directory-required check, realpath containment under
 * realpath(cwd). `$1` is the cwd, then (absolute path, want-dir flag) pairs.
 * Containment compares the same strings the in-process code does:
 * `real === realCwd || real startsWith realCwd + "/"`.
 *
 * `$(...)` strips trailing newlines, so the realpaths are captured with a
 * sentinel (`&& echo x`) and the sentinel plus the one newline realpath adds
 * are cut off again; a name ending in a newline survives.
 */
const RESOLVE_SCRIPT = `
rc=$(/bin/realpath -- "$1" 2>/dev/null && echo x) || rc=
rc=\${rc%x}
rc=\${rc%?}
shift
while [ "$#" -ge 2 ]; do
  abs=$1
  want=$2
  shift 2
  if [ -z "$rc" ]; then echo N; continue; fi
  t=$(/usr/bin/stat -L -f %HT -- "$abs" 2>/dev/null) || { echo N; continue; }
  if [ "$t" = "Symbolic Link" ]; then echo N; continue; fi
  if [ "$want" = 1 ] && [ "$t" != Directory ]; then echo N; continue; fi
  ra=$(/bin/realpath -- "$abs" 2>/dev/null && echo x) || { echo N; continue; }
  ra=\${ra%x}
  ra=\${ra%?}
  case "$ra" in
    "$rc"|"$rc"/*) ;;
    *) echo N; continue ;;
  esac
  if [ "$t" = Directory ]; then echo D; else echo F; fi
done
`;

/**
 * Resolve repo-relative `@`-mention paths against `cwd`, with exactly
 * `resolveAtPath(cwd, rel, isDir)`'s answers (project-files.ts): null for
 * anything empty, unsafe, missing, wrong kind or escaping `cwd` through a
 * symlink; otherwise `path.resolve(cwd, rel)` (not the realpath) with a
 * trailing `/` iff it is a directory. Never throws. Order is preserved.
 *
 * The safe-relative-path check always runs in-process first (it is pure string
 * logic, no filesystem), so the child only ever sees paths that cannot leave
 * `cwd` lexically.
 */
export async function resolveAtPathsInTaskDir(
  cwd: string,
  items: readonly { rel: string; isDir: boolean }[],
): Promise<(string | null)[]> {
  if (!disclaimEnabled()) {
    return items.map((it) => {
      try {
        return resolveAtPath(cwd, it.rel, it.isDir);
      } catch {
        return null;
      }
    });
  }

  const results: (string | null)[] = items.map(() => null);
  const absCwd = path.resolve(cwd);
  // Indexes of items that survive the in-process lexical checks.
  const pending: { index: number; abs: string; isDir: boolean }[] = [];
  items.forEach((it, index) => {
    let rel = it.rel;
    while (rel.endsWith("/")) rel = rel.slice(0, -1);
    if (!rel) return;
    if (!isSafeRelPath(rel)) return;
    pending.push({ index, abs: path.resolve(absCwd, rel), isDir: it.isDir });
  });

  let i = 0;
  while (i < pending.length) {
    const chunk: typeof pending = [];
    let bytes = absCwd.length;
    while (i < pending.length && chunk.length < RESOLVE_CHUNK_ITEMS) {
      const next = pending[i]!;
      const cost = Buffer.byteLength(next.abs) + 4;
      if (chunk.length > 0 && bytes + cost > RESOLVE_CHUNK_ARG_BYTES) break;
      chunk.push(next);
      bytes += cost;
      i++;
    }
    const args = [absCwd];
    for (const c of chunk) args.push(c.abs, c.isDir ? "1" : "0");
    const r = await runScript(RESOLVE_SCRIPT, args, { maxStdout: chunk.length * 2 + 16 });
    // A failed chunk leaves its items null (the safe answer).
    if (!r.completed || r.code !== 0) continue;
    const tokens = new TextDecoder().decode(r.stdout).split("\n");
    chunk.forEach((c, k) => {
      const tok = tokens[k];
      if (tok === "D") results[c.index] = `${c.abs}/`;
      else if (tok === "F") results[c.index] = c.abs;
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

// macOS `stat -L` falls back to the link itself when the target is missing and
// still exits 0 ("Symbolic Link"), so a dangling link must be rejected by type:
// after a successful `-L` only a dangling link can still report "Symbolic Link".
const EXISTS_SCRIPT = `
t=$(/usr/bin/stat -L -f %HT -- "$1" 2>/dev/null) || { echo N; exit 0; }
if [ "$t" = "Symbolic Link" ]; then echo N; else echo Y; fi
`;

/**
 * Whether `p` exists (symlinks followed). A failure of the check itself
 * (timeout, an access denial, a missing helper) reads as "does not exist".
 */
export async function taskDirExists(p: string): Promise<boolean> {
  if (!disclaimEnabled()) {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  }
  if (!p || p.includes("\0")) return false;
  const r = await runScript(EXISTS_SCRIPT, [path.resolve(p)], { maxStdout: 16 });
  if (!r.completed || r.code !== 0) return false;
  return new TextDecoder().decode(r.stdout).trim() === "Y";
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export type TaskDirReadResult =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * First line is a token: `M` (no such file), `E` (message follows on line 2),
 * or `O` (raw file bytes follow). The size check runs before the read so an
 * oversized file is never streamed; the in-process side still re-checks the
 * received length, because the file can grow between the stat and the read.
 */
const READ_SCRIPT = `
out=$(/usr/bin/stat -L -f '%z %HT' -- "$1" 2>&1)
if [ "$?" -ne 0 ]; then
  case "$out" in
    *"No such file or directory"*|*"Not a directory"*) printf 'M\\n' ;;
    *) printf 'E\\n%s\\n' "$out" ;;
  esac
  exit 0
fi
size=\${out%% *}
type=\${out#* }
if [ "$type" = "Symbolic Link" ]; then printf 'M\\n'; exit 0; fi
if [ "$type" != "Regular File" ]; then
  printf 'E\\nnot a regular file (%s)\\n' "$type"
  exit 0
fi
if [ "$size" -gt "$2" ]; then
  printf 'E\\nfile is %s bytes, over the %s byte limit\\n' "$size" "$2"
  exit 0
fi
printf 'O\\n'
exec /bin/cat -- "$1"
`;

function isMissingCode(code: unknown): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Read a small text file. `missing` for a file that is not there, `error` for
 * anything else (permission, not a regular file, over `maxBytes`, timeout).
 * Never throws.
 */
export async function readTaskDirFile(p: string, maxBytes: number): Promise<TaskDirReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { kind: "error", message: `invalid maxBytes: ${maxBytes}` };
  }
  if (!p || p.includes("\0")) return { kind: "error", message: "invalid path" };

  if (!disclaimEnabled()) {
    try {
      const st = statSync(p);
      if (!st.isFile()) return { kind: "error", message: `not a regular file: ${p}` };
      if (st.size > maxBytes) {
        return { kind: "error", message: `file is ${st.size} bytes, over the ${maxBytes} byte limit` };
      }
      const buf = readFileSync(p);
      if (buf.length > maxBytes) {
        return { kind: "error", message: `file is ${buf.length} bytes, over the ${maxBytes} byte limit` };
      }
      return { kind: "ok", text: buf.toString("utf8") };
    } catch (err) {
      if (isMissingCode((err as NodeJS.ErrnoException)?.code)) return { kind: "missing" };
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Cap stdout at the limit plus the 2-byte header: a file that grew past the
  // size the script checked is cut off and reported, never buffered whole.
  const r = await runScript(READ_SCRIPT, [path.resolve(p), String(maxBytes)], { maxStdout: maxBytes + 2 });
  if (r.overflow) {
    return { kind: "error", message: `file is over the ${maxBytes} byte limit` };
  }
  if (!r.completed || r.code !== 0) return { kind: "error", message: describeFailure(r, `read ${p}`) };
  const nl = r.stdout.indexOf(0x0a);
  if (nl < 0) return { kind: "error", message: `read ${p}: unexpected helper output` };
  const token = new TextDecoder().decode(r.stdout.subarray(0, nl));
  const rest = r.stdout.subarray(nl + 1);
  if (token === "M") return { kind: "missing" };
  if (token === "E") {
    return { kind: "error", message: new TextDecoder().decode(rest).replace(/\n$/, "") || `read ${p}: failed` };
  }
  if (token === "O") {
    if (rest.length > maxBytes) {
      return { kind: "error", message: `file is ${rest.length} bytes, over the ${maxBytes} byte limit` };
    }
    return { kind: "ok", text: new TextDecoder().decode(rest) };
  }
  return { kind: "error", message: `read ${p}: unexpected helper output` };
}

// ---------------------------------------------------------------------------
// atomic write
// ---------------------------------------------------------------------------

/** `$1` target, `$2` temp file next to it, `$3` parent to create (empty = none). Content on stdin. */
const WRITE_SCRIPT = `
if [ -d "$1" ]; then
  echo "is a directory" >&2
  exit 14
fi
if [ -n "$3" ]; then
  /bin/mkdir -p -- "$3" || exit 11
fi
if ! /bin/cat > "$2"; then
  /bin/rm -f -- "$2"
  exit 12
fi
if ! /bin/mv -f -- "$2" "$1"; then
  /bin/rm -f -- "$2"
  exit 13
fi
`;

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function tempNameFor(file: string): string {
  return `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
}

/**
 * Write `content` to `p` atomically: the bytes go to a temp file in the same
 * directory, then replace the target with one rename, so a reader never sees a
 * half-written file and a failure leaves no temp file behind. With
 * `mkdirParent` the parent directory is created first (recursively).
 * Throws an Error with a useful message on any failure.
 */
export async function writeTaskDirFileAtomic(
  p: string,
  content: string,
  opts: { mkdirParent?: boolean } = {},
): Promise<void> {
  if (!p || p.includes("\0")) throw new Error("write: invalid path");
  const file = path.resolve(p);
  const tmp = tempNameFor(file);
  const parent = path.dirname(file);

  if (!disclaimEnabled()) {
    try {
      // The disclaimed script refuses a directory target too (\`mv\` would move the
      // temp file INTO it instead of failing), so both paths answer alike.
      if (isDirectory(file)) throw new Error("is a directory");
      if (opts.mkdirParent) mkdirSync(parent, { recursive: true });
      writeFileSync(tmp, content);
      renameSync(tmp, file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
      throw new Error(`write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const r = await runScript(WRITE_SCRIPT, [file, tmp, opts.mkdirParent ? parent : ""], {
    stdin: Buffer.from(content, "utf8"),
    maxStdout: 1024,
  });
  if (r.completed && r.code === 0) return;
  throw new Error(describeFailure(r, `write ${file}`));
}

// ---------------------------------------------------------------------------
// lexists (no-follow)
// ---------------------------------------------------------------------------

// `-e` follows a final symlink and `-L` catches a dangling one, so together
// they answer "is there an entry with this name" without needing its target.
const LEXISTS_SCRIPT = `
if [ -e "$1" ] || [ -L "$1" ]; then echo Y; else echo N; fi
`;

/**
 * Whether an entry named `p` exists, NOT following a final symlink (a dangling
 * link counts as present). `null` when the check itself failed (timeout,
 * missing helper), so a caller deciding whether a directory holds a git
 * checkout can treat "can't tell" as "yes" and leave it alone.
 */
export async function taskDirLexists(p: string): Promise<boolean | null> {
  if (!p || p.includes("\0")) return null;
  if (!disclaimEnabled()) {
    try {
      lstatSync(p);
      return true;
    } catch (err) {
      return isMissingCode((err as NodeJS.ErrnoException)?.code) ? false : null;
    }
  }
  const r = await runScript(LEXISTS_SCRIPT, [path.resolve(p)], { maxStdout: 16 });
  if (!r.completed || r.code !== 0) return null;
  const tok = new TextDecoder().decode(r.stdout).trim();
  return tok === "Y" ? true : tok === "N" ? false : null;
}

// ---------------------------------------------------------------------------
// multi-repository workspace root: agetor's own scratch
// ---------------------------------------------------------------------------

/**
 * Shared prelude for the two workspace-root scripts. `$1` is the absolute
 * workspace root. It `cd`s into the root and then into `.claude` with
 * `cd -P`, and after each step checks that `pwd -P` is exactly the physical
 * parent plus the expected name. A symlink anywhere on the way (the root
 * itself, `.claude`), or one swapped in between a check and the `cd`, makes
 * that comparison fail and the script answers `C` ("content": leave it
 * alone). Once the shell's cwd IS the verified directory, a later swap of the
 * name can no longer redirect anything: every remaining operation is
 * relative to the cwd, `rm` never follows its final component, and `rmdir`
 * refuses a symlink.
 *
 * Classification (the `st` variable): `M` the root is missing or not a real
 * directory, `E` it holds nothing but agetor's scratch (no entries, or only a
 * real `.claude` directory holding at most a regular `settings.local.json`),
 * `C` anything else. Names are only ever compared, never printed.
 */
const WORKSPACE_SCRATCH_PRELUDE = `
ws=$1
st=C
case "$ws" in /?*) ;; *) echo M; exit 0 ;; esac
ws=\${ws%/}
base=\${ws##*/}
parent=\${ws%/*}
[ -n "$parent" ] || parent=/
cd -P "$parent" 2>/dev/null || { echo M; exit 0; }
pp=$(pwd -P)
if [ -L "./$base" ] || [ ! -d "./$base" ]; then echo M; exit 0; fi
cd -P "./$base" 2>/dev/null || { echo M; exit 0; }
wsp=$(pwd -P)
[ "$wsp" = "\${pp%/}/$base" ] || { echo C; exit 0; }
only=1
for e in * .[!.]* ..?*; do
  if [ ! -e "$e" ] && [ ! -L "$e" ]; then continue; fi
  [ "$e" = .claude ] || { only=0; break; }
done
if [ "$only" = 1 ]; then
  if [ ! -e .claude ] && [ ! -L .claude ]; then
    st=E
  elif [ ! -L .claude ] && [ -d .claude ]; then
    st=$(
      cd -P ./.claude 2>/dev/null || { echo C; exit 0; }
      [ "$(pwd -P)" = "$wsp/.claude" ] || { echo C; exit 0; }
      for e in * .[!.]* ..?*; do
        if [ ! -e "$e" ] && [ ! -L "$e" ]; then continue; fi
        [ "$e" = settings.local.json ] || { echo C; exit 0; }
        if [ -L "$e" ] || [ ! -f "$e" ]; then echo C; exit 0; fi
      done
      echo E
    )
  fi
fi
`;

const WORKSPACE_SCRATCH_STATE_SCRIPT = `${WORKSPACE_SCRATCH_PRELUDE}
echo "$st"
`;

/**
 * Removes the scratch (from inside the verified `.claude`), then `.claude`
 * and the root with `rmdir` (empty directories only; a symlink is refused).
 * `R` when the root is gone afterwards, `K` when it was kept.
 */
const WORKSPACE_SCRATCH_REMOVE_SCRIPT = `${WORKSPACE_SCRATCH_PRELUDE}
if [ "$st" != E ]; then echo K; exit 0; fi
if [ -d .claude ] && [ ! -L .claude ]; then
  (
    cd -P ./.claude 2>/dev/null || exit 0
    [ "$(pwd -P)" = "$wsp/.claude" ] || exit 0
    if [ -f settings.local.json ] && [ ! -L settings.local.json ]; then
      /bin/rm -f ./settings.local.json
    fi
  )
  /bin/rmdir ./.claude 2>/dev/null
fi
cd -P "$pp" 2>/dev/null || { echo K; exit 0; }
/bin/rmdir "./$base" 2>/dev/null
if [ -e "./$base" ] || [ -L "./$base" ]; then echo K; else echo R; fi
`;

/**
 * True when a multi-repository task's workspace root (docs/architecture/multi-repo-tasks.md)
 * holds nothing but agetor's own scratch: no entries at all, or only a
 * `.claude` directory containing at most a regular `settings.local.json`.
 * `false` for any agent/user artifact, a missing root, a symlink on the way,
 * or a failed check.
 *
 * Always a child process, unlike the read helpers above: the answer feeds a
 * delete, and only a shell whose cwd is pinned to the verified directory can
 * act on it without following a symlink swapped in after the check (Node has
 * no `unlinkat`). The disclaim switch still decides whether that child is
 * disclaimed (`coreSpawn`), so with the switch off it runs under the core's
 * own identity, same as the in-process paths.
 */
export async function taskDirWorkspaceHasOnlyScratch(dir: string): Promise<boolean> {
  if (!dir || dir.includes("\0")) return false;
  const r = await runScript(WORKSPACE_SCRATCH_STATE_SCRIPT, [path.resolve(dir)], { maxStdout: 16 });
  if (!r.completed || r.code !== 0) return false;
  return new TextDecoder().decode(r.stdout).trim() === "E";
}

/**
 * Remove a workspace root that holds only agetor's scratch: the scratch
 * `settings.local.json`, then the empty `.claude`, then the empty root. Never
 * recursive, never follows a symlink (see the prelude above). Returns whether
 * the root is gone afterwards; any failure leaves it in place and returns
 * false. Never throws.
 */
export async function removeTaskDirWorkspaceIfOnlyScratch(dir: string): Promise<boolean> {
  if (!dir || dir.includes("\0")) return false;
  const r = await runScript(WORKSPACE_SCRATCH_REMOVE_SCRIPT, [path.resolve(dir)], { maxStdout: 16 });
  if (!r.completed || r.code !== 0) return false;
  return new TextDecoder().decode(r.stdout).trim() === "R";
}
