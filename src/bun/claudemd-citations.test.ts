import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Static guard for code comments that cite the root CLAUDE.md by a section
// number. Those sections moved to docs/architecture/ (one doc per subsystem)
// and the numbering is gone, so a numbered citation points nowhere. A comment
// cites the doc by its path instead (`docs/architecture/<doc>.md`); the
// mapping from the old numbering lives in docs/architecture/README.md, for
// the `docs/plans/` notes and old commits that still use it.
//
// Comment-prefix line breaks are folded first, so a citation wrapped across
// two `//` or ` * ` lines is still caught.

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "e2e", "scripts", "native"];
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".build"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".sql", ".sh", ".swift", ".m", ".h"];
const SELF = path.relative(ROOT, import.meta.path);

/** `CLAUDE.md` (or `CLAUDE.md's`), up to two words, then item/§/section and a digit. */
const NUMBERED_CITATION = /CLAUDE\.md(?:'s)?\s+(?:[\w-]+\s+){0,2}(?:items?|§|section)\s*\d/g;

function listSources(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...listSources(rel));
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext)) && rel !== SELF) {
      out.push(rel);
    }
  }
  return out;
}

/** Joins wrapped comment lines (`//`, ` * `, `#` prefixes) into one line. */
function foldCommentLines(source: string): string {
  return source.replace(/\n\s*(?:\/\/|\*|#)?\s*/g, " ");
}

function findNumberedCitations(source: string): string[] {
  return [...foldCommentLines(source).matchAll(NUMBERED_CITATION)].map((m) => m[0]);
}

describe("CLAUDE.md citations in code", () => {
  test("the matcher catches numbered citations, including wrapped ones", () => {
    expect(findNumberedCitations("// see CLAUDE.md §12.")).toHaveLength(1);
    expect(findNumberedCitations("// see CLAUDE.md item 19")).toHaveLength(1);
    expect(findNumberedCitations("/* CLAUDE.md orchestration-flow item\n *  15 */")).toHaveLength(1);
    expect(findNumberedCitations("// underneath it (CLAUDE.md\n// §5): routes")).toHaveLength(1);
    expect(findNumberedCitations("// CLAUDE.md section 12")).toHaveLength(1);
    expect(findNumberedCitations("// CLAUDE.md items 13/14")).toHaveLength(1);
  });

  test("the matcher leaves doc paths and named sections alone", () => {
    expect(findNumberedCitations("// see docs/architecture/pipelines.md")).toEqual([]);
    expect(findNumberedCitations("// in CLAUDE.md § Agent kinds at a glance")).toEqual([]);
    expect(findNumberedCitations("// the UI conventions in CLAUDE.md")).toEqual([]);
  });

  test("no source file cites a CLAUDE.md section by number", () => {
    const files = SCAN_DIRS.flatMap(listSources);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of findNumberedCitations(readFileSync(path.join(ROOT, file), "utf8"))) {
        offenders.push(`${file}: "${hit}" — cite docs/architecture/<doc>.md instead`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
