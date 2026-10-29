/**
 * Classification of the free-form strings an agent lists under a handoff's
 * `artifacts` (D6/D7/D20 in `docs/plans/formatted-handoff.md`). Pure — no
 * React, no DOM — so it is importable from bun tests and from every surface
 * that renders a handoff.
 *
 * Real-world shapes (13k entries mined from persisted handoffs): relative
 * paths 70%, absolute paths 19%, URLs 6%, free text 3.5%, `path (note)` /
 * `path — note` ~1.7%, `path:line` anchors 0.4%. A head-token classifier
 * sorts them all:
 *
 *   1. `https?://…` / `mailto:…` head token → `url` (note after the token).
 *   2. a path shape → `path` (`:N`, `:N-M`, `#LN`, `#LN-LM` split into
 *      `line`; the note split off at ` (`, ` — `, ` - ` or `: `).
 *   3. anything else (a commit sentence, `jubarteai:<uuid>`, prose, an empty
 *      entry) → `text`.
 *
 * Relative paths resolve client-side against the task roots, mirroring
 * `classifyMdImageSrc` in `md-image.ts` (leading `@` and `./` stripped, roots
 * joined and normalized in order, duplicates dropped).
 */

export type HandoffArtifact =
  | { kind: "url"; raw: string; url: string; note: string | null }
  | {
      kind: "path";
      raw: string;
      display: string;
      candidates: string[];
      line: string | null;
      note: string | null;
    }
  | { kind: "text"; raw: string; text: string };

export interface HandoffArtifactContext {
  /** Roots a relative path is tried against, in order (`[worktreePath, workdir]`). */
  roots: readonly (string | null | undefined)[];
  /** The user's home directory, for `~/` paths. `null`/empty → `~/` entries are text. */
  homeDir: string | null;
}

/** Chips a handoff card shows before collapsing the rest into `+N`. */
export const HANDOFF_CARD_ARTIFACT_LIMIT = 6;

/** Note separators, in the order they can appear after a head token. */
const NOTE_SEPARATORS = [" (", " — ", " - ", ": "] as const;

/** A head token that carries its own URL scheme (`ftp://…`, `ssh://…`) is not
 *  a filesystem path — only `file:` is unwrapped. */
const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const WEB_URL_RE = /^(?:https?:\/\/\S|mailto:\S)/i;

const FILE_URL_RE = /^file:\/\/(?:localhost)?(\/.*)$/i;

/** A final path component with a real extension: starts with a letter so a
 *  version number (`v1.2`, `3.14`) is not mistaken for a file. */
const EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/** `#L12`, `#L12-L20`, `#L12-20` */
const HASH_LINE_RE = /#L(\d+)(?:-L?(\d+))?$/;
/** `:12`, `:12-20`, `:12:5` (the column is dropped) */
const COLON_LINE_RE = /:(\d+)(?:-(\d+))?(?::\d+)?$/;

/** Local copy of `md-image.ts`'s private POSIX normalizer: drop empty and `.`
 *  segments, pop one segment on `..` (never above a leading `/`), collapse
 *  repeated slashes, keep a trailing `/` so a directory stays a directory. */
function normalizePosixPath(input: string): string {
  const isAbsolute = input.startsWith("/");
  const hadTrailingSlash = input.endsWith("/");
  const out: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  const body = out.join("/");
  const prefix = isAbsolute ? "/" : "";
  const suffix = hadTrailingSlash && body !== "" ? "/" : "";
  return `${prefix}${body}${suffix}`;
}

/** Split `value` at the earliest note separator. A ` (` note drops one
 *  trailing `)`. An empty note reads as no note. */
function splitNote(value: string): { head: string; note: string | null } {
  let at = -1;
  let sep = "";
  for (const candidate of NOTE_SEPARATORS) {
    const i = value.indexOf(candidate);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      sep = candidate;
    }
  }
  if (at < 0) return { head: value.trim(), note: null };
  let note = value.slice(at + sep.length).trim();
  if (sep === " (" && note.endsWith(")")) note = note.slice(0, -1).trim();
  return { head: value.slice(0, at).trim(), note: note === "" ? null : note };
}

/** Drop closing parens that have no opener inside the URL (`…/y)` from prose
 *  like `(see https://x/y)`), keeping balanced ones (`…/Foo_(bar)`). */
function stripUnbalancedTrailingParens(url: string): string {
  let out = url;
  while (out.endsWith(")")) {
    let open = 0;
    let close = 0;
    for (const ch of out) {
      if (ch === "(") open++;
      else if (ch === ")") close++;
    }
    if (close <= open) break;
    out = out.slice(0, -1);
  }
  return out;
}

/** The note that trails a URL token: ` (note)`, ` — note`, ` - note`, `: note`
 *  or bare trailing words. */
function urlNote(rest: string): string | null {
  let note = rest.trim();
  if (note === "") return null;
  if (note.startsWith("(")) {
    note = note.slice(1);
    if (note.endsWith(")")) note = note.slice(0, -1);
  } else {
    note = note.replace(/^(?:—|-|:)\s*/, "");
  }
  note = note.trim();
  return note === "" ? null : note;
}

function classifyUrl(raw: string, trimmed: string): HandoffArtifact {
  const tokenEnd = trimmed.search(/\s/);
  const token = tokenEnd < 0 ? trimmed : trimmed.slice(0, tokenEnd);
  const rest = tokenEnd < 0 ? "" : trimmed.slice(tokenEnd);
  return {
    kind: "url",
    raw,
    url: stripUnbalancedTrailingParens(token),
    note: urlNote(rest),
  };
}

/** Peel a trailing line anchor off a path head. */
function splitLine(head: string): { path: string; line: string | null } {
  const hash = HASH_LINE_RE.exec(head);
  if (hash) {
    return {
      path: head.slice(0, hash.index),
      line: hash[2] !== undefined ? `${hash[1]}-${hash[2]}` : hash[1]!,
    };
  }
  const colon = COLON_LINE_RE.exec(head);
  if (colon) {
    return {
      path: head.slice(0, colon.index),
      line: colon[2] !== undefined ? `${colon[1]}-${colon[2]}` : colon[1]!,
    };
  }
  return { path: head, line: null };
}

function asText(raw: string, trimmed: string): HandoffArtifact {
  return { kind: "text", raw, text: trimmed };
}

/**
 * Classify one `artifacts[]` entry. Never throws; an entry that is not a URL
 * or a recognizable path (including empty and whitespace-only entries, and a
 * `~/` path when `homeDir` is unknown) is `text`.
 */
export function classifyHandoffArtifact(
  entry: string,
  ctx: HandoffArtifactContext,
): HandoffArtifact {
  const trimmed = (entry ?? "").trim();
  if (trimmed === "") return asText(entry ?? "", "");
  const raw = entry;

  if (WEB_URL_RE.test(trimmed)) return classifyUrl(raw, trimmed);

  const { head, note } = splitNote(trimmed);
  if (head === "") return asText(raw, trimmed);

  const isFileUrl = /^file:/i.test(head);
  if (!isFileUrl && SCHEME_URL_RE.test(head)) return asText(raw, trimmed);

  const { path: pathPart, line } = splitLine(head);
  if (pathPart === "") return asText(raw, trimmed);

  const explicit =
    isFileUrl ||
    pathPart.startsWith("/") ||
    pathPart.startsWith("~/") ||
    pathPart.startsWith("./") ||
    pathPart.startsWith("../");
  // Without an explicit prefix a head token must look like a path: no spaces,
  // and a `/` or a real file extension.
  if (!explicit) {
    if (/\s/.test(pathPart)) return asText(raw, trimmed);
    if (!pathPart.includes("/") && !EXTENSION_RE.test(pathPart)) {
      return asText(raw, trimmed);
    }
  }

  let display: string;
  let candidates: string[];

  if (isFileUrl) {
    const match = FILE_URL_RE.exec(pathPart.replace(/[?#].*$/, ""));
    if (!match) return asText(raw, trimmed);
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]!);
    } catch {
      return asText(raw, trimmed);
    }
    display = normalizePosixPath(decoded);
    candidates = [display];
  } else if (pathPart.startsWith("~/")) {
    const home = (ctx.homeDir ?? "").trim();
    if (home === "") return asText(raw, trimmed);
    display = pathPart;
    candidates = [normalizePosixPath(`${home}/${pathPart.slice(2)}`)];
  } else if (pathPart.startsWith("/")) {
    display = pathPart;
    candidates = [normalizePosixPath(pathPart)];
  } else {
    display = pathPart;
    let rel = pathPart;
    if (rel.startsWith("@")) rel = rel.slice(1);
    if (rel.startsWith("./")) rel = rel.slice(2);
    const seen = new Set<string>();
    candidates = [];
    for (const root of ctx.roots) {
      if (typeof root !== "string" || root.trim() === "") continue;
      const joined = normalizePosixPath(`${root}/${rel}`);
      if (seen.has(joined)) continue;
      seen.add(joined);
      candidates.push(joined);
    }
  }

  return { kind: "path", raw, display, candidates, line, note };
}

/**
 * The artifacts a handoff card shows as chips: the first `limit` non-text
 * entries. `hiddenCount` counts every remaining entry, free text included
 * (free text is modal-only, A6).
 */
export function cardArtifacts(
  list: HandoffArtifact[],
  limit: number = HANDOFF_CARD_ARTIFACT_LIMIT,
): { chips: HandoffArtifact[]; hiddenCount: number } {
  const cap = Math.max(0, Math.floor(limit));
  const chips = list.filter((a) => a.kind !== "text").slice(0, cap);
  return { chips, hiddenCount: list.length - chips.length };
}
