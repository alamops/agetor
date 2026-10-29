// Minimal tar reader for `caller-fs.ts`'s CLI-caller project-tree loader (D24).
//
// Why this exists: for a CLI-token caller the core must not read the project's
// capability files (`.claude/skills/*/SKILL.md`, `.mcp.json`, …) itself — a
// protected folder would then be opened with Agetor.app's macOS identity. A
// disclaimed `/usr/bin/tar` child reads them instead (a disclaimed child of a
// system tool has only the access any self-responsible process has) and ships
// them back as an archive on stdout. This module turns that archive into
// `{ path, data }` entries. It is pure (no fs, no spawn, no dependencies).
//
// Format handled: POSIX ustar blocks plus pax extended headers (`x` per-file,
// `g` global — `path`, `size`, `linkpath`), which is what
// `tar --format=pax` (bsdtar/libarchive) writes, and the GNU `L` long-name
// record for tolerance. 512-byte blocks, UTF-8 names.
//
// Output is regular files only. Directories are skipped (the tree derives them
// from path prefixes). Symlinks cannot appear because the caller passes `-L`
// (follow), but a hard link can: bsdtar writes a second occurrence of the same
// inode — which `-L` produces whenever two paths reach one file, e.g. a skill
// directory symlinked to a sibling — as a type-`1` entry with a `linkpath` and
// no data. Dropping those would make the tar view disagree with a live-disk
// walk, so a hard link whose target was already read from the archive is
// emitted as a file carrying the same bytes.
//
// Truncation is expected, not an error: the caller stops reading stdout at a
// byte cap, so the final entry may be cut anywhere. The parser stops cleanly
// at the first block it cannot trust (short block, bad checksum, data past the
// end of input) and returns what it fully parsed.

export interface TarFileEntry {
  /** Archive-relative path, forward slashes, no leading `./`. */
  path: string;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder("utf-8");

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[off + i] !== 0) return false;
  return true;
}

/** NUL-terminated (or field-length-terminated) UTF-8 string. */
function cstr(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(off, end));
}

/** Octal number field, or GNU/star base-256 when the high bit of byte 0 is set. */
function numField(buf: Uint8Array, off: number, len: number): number {
  const first = buf[off]!;
  if (first & 0x80) {
    // Base-256: big-endian two's complement with the marker bit stripped.
    // Sizes beyond 2^53 are not representable; treat them as invalid.
    let n = first & 0x3f;
    for (let i = 1; i < len; i++) n = n * 256 + buf[off + i]!;
    return Number.isSafeInteger(n) ? n : -1;
  }
  let n = 0;
  let seen = false;
  for (let i = 0; i < len; i++) {
    const c = buf[off + i]!;
    if (c === 0x20 || c === 0) {
      if (seen) break;
      continue;
    }
    if (c < 0x30 || c > 0x37) return -1;
    seen = true;
    n = n * 8 + (c - 0x30);
  }
  return n;
}

function checksumOk(buf: Uint8Array, off: number): boolean {
  const stored = numField(buf, off + 148, 8);
  if (stored < 0) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : buf[off + i]!;
  }
  return sum === stored;
}

/** Parse pax records (`<len> <key>=<value>\n`, len counts the whole record in bytes). */
export function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    let sp = pos;
    let len = 0;
    while (sp < data.length && data[sp]! >= 0x30 && data[sp]! <= 0x39) {
      len = len * 10 + (data[sp]! - 0x30);
      sp++;
    }
    if (sp === pos || data[sp] !== 0x20 || len < sp - pos + 2 || pos + len > data.length) break;
    // Record body = bytes after "<len> " up to (but excluding) the trailing "\n".
    const bodyStart = sp + 1;
    const bodyEnd = pos + len - 1;
    if (data[bodyEnd] !== 0x0a) break;
    const body = decoder.decode(data.subarray(bodyStart, bodyEnd));
    const eq = body.indexOf("=");
    if (eq > 0) out.set(body.slice(0, eq), body.slice(eq + 1));
    pos += len;
  }
  return out;
}

function cleanPath(p: string): string {
  let s = p;
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/\/+$/, "");
}

/**
 * Parse an in-memory tar archive (possibly truncated) into its regular files,
 * in archive order. Later entries for the same path replace earlier ones in
 * the caller's map; this function does not dedupe.
 */
export function parseTar(buf: Uint8Array): TarFileEntry[] {
  const files: TarFileEntry[] = [];
  const byPath = new Map<string, Uint8Array>();
  const globals = new Map<string, string>();
  let pendingPax: Map<string, string> | null = null;
  let pendingLongName: string | null = null;
  let off = 0;

  while (off + BLOCK <= buf.length) {
    if (isZeroBlock(buf, off)) break; // end-of-archive marker
    if (!checksumOk(buf, off)) break; // not a header we can trust

    const typeflag = String.fromCharCode(buf[off + 156]!);
    const hdrSize = numField(buf, off + 124, 12);
    if (hdrSize < 0) break;

    const eff = new Map(globals);
    if (pendingPax) for (const [k, v] of pendingPax) eff.set(k, v);

    // Pax `size` overrides the header size for the entry's data; it only
    // applies to entries that carry file data (not to the pax record itself).
    const isMeta = typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K";
    let size = hdrSize;
    if (!isMeta && eff.has("size")) {
      const s = Number(eff.get("size"));
      if (Number.isSafeInteger(s) && s >= 0) size = s;
    }

    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) break; // truncated final entry
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const next = dataStart + padded;

    if (typeflag === "x") {
      pendingPax = parsePaxRecords(buf.subarray(dataStart, dataEnd));
      off = next;
      continue;
    }
    if (typeflag === "g") {
      for (const [k, v] of parsePaxRecords(buf.subarray(dataStart, dataEnd))) globals.set(k, v);
      off = next;
      continue;
    }
    if (typeflag === "L") {
      pendingLongName = cstr(buf, dataStart, size);
      off = next;
      continue;
    }
    if (typeflag === "K") {
      // GNU long link name: irrelevant (links are not followed), consume it.
      off = next;
      continue;
    }

    let name = eff.get("path");
    if (name === undefined) {
      if (pendingLongName !== null) {
        name = pendingLongName;
      } else {
        const base = cstr(buf, off, 100);
        const magic = cstr(buf, off + 257, 5);
        const prefix = magic === "ustar" ? cstr(buf, off + 345, 155) : "";
        name = prefix ? `${prefix}/${base}` : base;
      }
    }
    const entryPath = cleanPath(name);

    if (typeflag === "0" || typeflag === "\0") {
      if (entryPath) {
        // A copy: the caller's buffer may be reused, and the entry outlives it.
        const data = buf.slice(dataStart, dataEnd);
        files.push({ path: entryPath, data });
        byPath.set(entryPath, data);
      }
    } else if (typeflag === "1") {
      // Hard link to an earlier entry in this archive — see header comment.
      const linkpath = eff.get("linkpath") ?? cstr(buf, off + 157, 100);
      const target = byPath.get(cleanPath(linkpath));
      if (entryPath && target) {
        files.push({ path: entryPath, data: target });
        byPath.set(entryPath, target);
      }
    }
    // Directories (5), symlinks (2), devices, fifos: skipped.

    pendingPax = null;
    pendingLongName = null;
    off = next;
  }
  return files;
}
