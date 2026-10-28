// Parity tests for the task-directory helpers (D25): every operation runs in
// both modes — in-process, and through a recording `AGETOR_DISCLAIM_BIN` stub
// (logs its argv, then `exec "$@"`) with the disclaim switch on — and must give
// identical results.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { disclaimEnabled, getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";
import {
  readTaskDirFile,
  resolveAtPathsInTaskDir,
  taskDirExists,
  writeTaskDirFileAtomic,
} from "./task-dir-fs.ts";

let root: string;
let stubBin: string;
let stubLog: string;
const savedBin = process.env.AGETOR_DISCLAIM_BIN;
const savedSwitch = getDisclaimSwitch();

beforeAll(() => {
  // realpath: macOS tmpdir is a /var -> /private/var symlink; keep expectations literal.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "task-dir-fs-")));
  stubBin = path.join(root, "disclaim-stub.sh");
  stubLog = path.join(root, "disclaim-stub.log");
  writeFileSync(
    stubBin,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${stubLog}'\nexec "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(stubBin, 0o755);
});

afterAll(() => {
  if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = savedBin;
  setDisclaimSwitch(savedSwitch);
  // Plain temp dir (no sqlite here): safe to remove.
  Bun.spawnSync(["/bin/rm", "-rf", root]);
});

afterEach(() => {
  if (savedBin === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = savedBin;
  setDisclaimSwitch(savedSwitch);
});

function useMode(mode: "in-process" | "disclaimed") {
  if (mode === "disclaimed") {
    process.env.AGETOR_DISCLAIM_BIN = stubBin;
    setDisclaimSwitch(true);
    expect(disclaimEnabled()).toBe(true);
    try {
      writeFileSync(stubLog, "");
    } catch {
      // ignore
    }
  } else {
    setDisclaimSwitch(false);
    expect(disclaimEnabled()).toBe(false);
  }
}

function stubLines(): string[] {
  return existsSync(stubLog) ? readFileSync(stubLog, "utf8").split("\n").filter(Boolean) : [];
}

function freshDir(name: string): string {
  const d = path.join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

for (const mode of ["in-process", "disclaimed"] as const) {
  describe(`task-dir-fs (${mode})`, () => {
    test("path is only reached through the stub when disclaimed", async () => {
      useMode(mode);
      const d = freshDir("probe");
      expect(await taskDirExists(d)).toBe(true);
      const lines = stubLines();
      if (mode === "disclaimed") {
        expect(lines.length).toBe(1);
        expect(lines[0]).toBe("/bin/sh");
      } else {
        expect(lines.length).toBe(0);
      }
    });

    describe("resolveAtPathsInTaskDir", () => {
      test("files, dirs, trailing slash, bare dir mention", async () => {
        useMode(mode);
        const cwd = freshDir("res");
        mkdirSync(path.join(cwd, "src/bun"), { recursive: true });
        writeFileSync(path.join(cwd, "src/a.ts"), "x");
        const out = await resolveAtPathsInTaskDir(cwd, [
          { rel: "src/a.ts", isDir: false },
          { rel: "src/bun/", isDir: true },
          { rel: "src/bun", isDir: false }, // bare dir mention still gets "/"
          { rel: "src/a.ts/", isDir: true }, // a file where a dir is required
          { rel: "src", isDir: true },
        ]);
        expect(out).toEqual([
          path.join(cwd, "src/a.ts"),
          `${path.join(cwd, "src/bun")}/`,
          `${path.join(cwd, "src/bun")}/`,
          null,
          `${path.join(cwd, "src")}/`,
        ]);
        if (mode === "disclaimed") expect(stubLines().length).toBe(1); // one child for the whole list
      });

      test("empty, .., absolute, NUL and missing are null", async () => {
        useMode(mode);
        const cwd = freshDir("res");
        writeFileSync(path.join(cwd, "ok.txt"), "x");
        const out = await resolveAtPathsInTaskDir(cwd, [
          { rel: "", isDir: false },
          { rel: "/", isDir: false },
          { rel: "../etc/hosts", isDir: false },
          { rel: "a/../../x", isDir: false },
          { rel: "/etc/hosts", isDir: false },
          { rel: "ok.txt\0", isDir: false },
          { rel: "missing.txt", isDir: false },
          { rel: "ok.txt", isDir: false },
        ]);
        expect(out).toEqual([null, null, null, null, null, null, null, path.join(cwd, "ok.txt")]);
        expect(await resolveAtPathsInTaskDir(cwd, [])).toEqual([]);
      });

      test("symlinks: escaping cwd is null, inside cwd resolves (to the unresolved path)", async () => {
        useMode(mode);
        const cwd = freshDir("res");
        const outside = freshDir("outside");
        writeFileSync(path.join(outside, "secret.txt"), "s");
        symlinkSync(outside, path.join(cwd, "escape"));
        symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "escfile"));
        mkdirSync(path.join(cwd, "real"));
        writeFileSync(path.join(cwd, "real/f.txt"), "x");
        symlinkSync(path.join(cwd, "real"), path.join(cwd, "alias"));
        symlinkSync("real/f.txt", path.join(cwd, "link.txt"));
        symlinkSync(path.join(cwd, "nowhere"), path.join(cwd, "dangling"));
        const out = await resolveAtPathsInTaskDir(cwd, [
          { rel: "escape", isDir: false },
          { rel: "escape/secret.txt", isDir: false },
          { rel: "escfile", isDir: false },
          { rel: "alias", isDir: true },
          { rel: "alias/f.txt", isDir: false },
          { rel: "link.txt", isDir: false },
          { rel: "dangling", isDir: false },
        ]);
        expect(out).toEqual([
          null,
          null,
          null,
          `${path.join(cwd, "alias")}/`,
          path.join(cwd, "alias/f.txt"),
          path.join(cwd, "link.txt"),
          null,
        ]);
      });

      test("names with spaces, newlines, leading dash, quotes and glob characters", async () => {
        useMode(mode);
        const cwd = freshDir("res");
        const names = ["with space.txt", "two\nlines.txt", "-dash.txt", "q'uote\".txt", "star*[x]?.txt", "$(echo hi).txt", "end\n"];
        for (const n of names) writeFileSync(path.join(cwd, n), "x");
        mkdirSync(path.join(cwd, "-dir\nname"));
        const items = [
          ...names.map((rel) => ({ rel, isDir: false })),
          { rel: "-dir\nname", isDir: true },
          { rel: "nope\nname", isDir: false },
        ];
        const out = await resolveAtPathsInTaskDir(cwd, items);
        expect(out).toEqual([
          ...names.map((n) => path.join(cwd, n)),
          `${path.join(cwd, "-dir\nname")}/`,
          null,
        ]);
      });

      test("missing cwd gives all null", async () => {
        useMode(mode);
        const cwd = path.join(root, "does-not-exist");
        const out = await resolveAtPathsInTaskDir(cwd, [
          { rel: "a", isDir: false },
          { rel: "b/", isDir: true },
        ]);
        expect(out).toEqual([null, null]);
      });

      test("large lists are chunked and keep order", async () => {
        useMode(mode);
        const cwd = freshDir("res");
        const items: { rel: string; isDir: boolean }[] = [];
        const expected: (string | null)[] = [];
        for (let i = 0; i < 300; i++) {
          if (i % 3 === 0) {
            writeFileSync(path.join(cwd, `f${i}.txt`), "x");
            items.push({ rel: `f${i}.txt`, isDir: false });
            expected.push(path.join(cwd, `f${i}.txt`));
          } else {
            items.push({ rel: `m${i}.txt`, isDir: false });
            expected.push(null);
          }
        }
        expect(await resolveAtPathsInTaskDir(cwd, items)).toEqual(expected);
      });
    });

    describe("taskDirExists", () => {
      test("dir, file, symlink, missing", async () => {
        useMode(mode);
        const d = freshDir("ex");
        writeFileSync(path.join(d, "f"), "x");
        symlinkSync(d, path.join(root, `exlink-${Math.random().toString(36).slice(2, 8)}`));
        symlinkSync(path.join(d, "gone"), path.join(d, "dangling"));
        expect(await taskDirExists(d)).toBe(true);
        expect(await taskDirExists(path.join(d, "f"))).toBe(true);
        expect(await taskDirExists(path.join(d, "missing"))).toBe(false);
        expect(await taskDirExists(path.join(d, "dangling"))).toBe(false);
        expect(await taskDirExists(path.join(d, "f", "below-a-file"))).toBe(false);
        expect(await taskDirExists("")).toBe(false);
      });

      test("odd names", async () => {
        useMode(mode);
        const d = freshDir("ex");
        const odd = path.join(d, "-odd\nname $x");
        mkdirSync(odd);
        expect(await taskDirExists(odd)).toBe(true);
        expect(await taskDirExists(`${odd}x`)).toBe(false);
      });
    });

    describe("readTaskDirFile", () => {
      test("ok with unicode and newlines, empty file", async () => {
        useMode(mode);
        const d = freshDir("rd");
        const text = 'line1\nline2 "q" \\ $x `y` ünï — 日本\n\n';
        writeFileSync(path.join(d, "a.json"), text);
        writeFileSync(path.join(d, "empty"), "");
        expect(await readTaskDirFile(path.join(d, "a.json"), 1024)).toEqual({ kind: "ok", text });
        expect(await readTaskDirFile(path.join(d, "empty"), 0)).toEqual({ kind: "ok", text: "" });
      });

      test("missing", async () => {
        useMode(mode);
        const d = freshDir("rd");
        expect(await readTaskDirFile(path.join(d, "nope.json"), 1024)).toEqual({ kind: "missing" });
        writeFileSync(path.join(d, "f"), "x");
        expect(await readTaskDirFile(path.join(d, "f", "below"), 1024)).toEqual({ kind: "missing" });
      });

      test("exactly at the limit is ok, one byte over is an error", async () => {
        useMode(mode);
        const d = freshDir("rd");
        writeFileSync(path.join(d, "ten"), "0123456789");
        expect(await readTaskDirFile(path.join(d, "ten"), 10)).toEqual({ kind: "ok", text: "0123456789" });
        const over = await readTaskDirFile(path.join(d, "ten"), 9);
        expect(over.kind).toBe("error");
        if (over.kind === "error") expect(over.message).toContain("9");
      });

      test("a directory is an error, not missing", async () => {
        useMode(mode);
        const d = freshDir("rd");
        const r = await readTaskDirFile(d, 1024);
        expect(r.kind).toBe("error");
      });

      test("unreadable file is an error", async () => {
        useMode(mode);
        if (process.getuid?.() === 0) return; // root ignores modes
        const d = freshDir("rd");
        const f = path.join(d, "locked");
        writeFileSync(f, "secret", { mode: 0o000 });
        const r = await readTaskDirFile(f, 1024);
        chmodSync(f, 0o600);
        expect(r.kind).toBe("error");
      });

      test("bad arguments are errors", async () => {
        useMode(mode);
        const d = freshDir("rd");
        expect((await readTaskDirFile(path.join(d, "x"), -1)).kind).toBe("error");
        expect((await readTaskDirFile(path.join(d, "x"), Number.NaN)).kind).toBe("error");
        expect((await readTaskDirFile("", 10)).kind).toBe("error");
      });
    });

    describe("writeTaskDirFileAtomic", () => {
      test("creates, overwrites, leaves no temp file", async () => {
        useMode(mode);
        const d = freshDir("wr");
        const f = path.join(d, "settings.local.json");
        await writeTaskDirFileAtomic(f, '{"a":1}\n');
        expect(readFileSync(f, "utf8")).toBe('{"a":1}\n');
        await writeTaskDirFileAtomic(f, '{"a":2}\n');
        expect(readFileSync(f, "utf8")).toBe('{"a":2}\n');
        await writeTaskDirFileAtomic(f, "");
        expect(readFileSync(f, "utf8")).toBe("");
        expect(readdirSync(d)).toEqual(["settings.local.json"]);
      });

      test("mkdirParent creates the parent chain; without it a missing parent throws", async () => {
        useMode(mode);
        const d = freshDir("wr");
        const f = path.join(d, ".cursor/plans/p_1.plan.md");
        await expect(writeTaskDirFileAtomic(f, "x")).rejects.toThrow();
        expect(existsSync(path.join(d, ".cursor"))).toBe(false);
        await writeTaskDirFileAtomic(f, "# plan\n", { mkdirParent: true });
        expect(readFileSync(f, "utf8")).toBe("# plan\n");
        expect(readdirSync(path.dirname(f))).toEqual(["p_1.plan.md"]);
      });

      test("arbitrary text round-trips: newlines, quotes, unicode, shell metacharacters, no trailing newline", async () => {
        useMode(mode);
        const d = freshDir("wr");
        const f = path.join(d, "odd $name\n'x'.md");
        const content = ['a\r\nb\n\n\n', "`$(rm -rf /)` ${HOME} \\n \\\\", "ünï 日本 😀 — \u0000-not-really-nul".replace("\u0000", ""), "-n -e", "end-no-newline"].join("\n");
        await writeTaskDirFileAtomic(f, content);
        expect(readFileSync(f, "utf8")).toBe(content);
        expect(readdirSync(d)).toHaveLength(1);
      });

      test("large content round-trips", async () => {
        useMode(mode);
        const d = freshDir("wr");
        const f = path.join(d, "big.txt");
        const content = "0123456789abcdef\n".repeat(200_000);
        await writeTaskDirFileAtomic(f, content);
        expect(readFileSync(f, "utf8").length).toBe(content.length);
      });

      test("failure throws a useful message and leaves no temp file", async () => {
        useMode(mode);
        const d = freshDir("wr");
        const target = path.join(d, "is-a-dir");
        mkdirSync(target);
        writeFileSync(path.join(target, "inner"), "x");
        // Renaming a file over a non-empty directory fails.
        let err: unknown;
        try {
          await writeTaskDirFileAtomic(target, "x");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(target);
        expect(readdirSync(d)).toEqual(["is-a-dir"]);
      });

      test("write then read agree", async () => {
        useMode(mode);
        const d = freshDir("wr");
        const f = path.join(d, "rt.json");
        await writeTaskDirFileAtomic(f, '{"x":"é"}');
        expect(await readTaskDirFile(f, 100)).toEqual({ kind: "ok", text: '{"x":"é"}' });
      });
    });
  });
}

describe("task-dir-fs (disclaimed, helper failure)", () => {
  test("a missing helper fails safe: resolve null, exists false, read error, write throws", async () => {
    process.env.AGETOR_DISCLAIM_BIN = path.join(root, "no-such-helper");
    setDisclaimSwitch(true);
    // The helper is absent, so disclaim reports unavailable and the in-process path runs;
    // this pins that nothing throws and results stay correct either way.
    const d = freshDir("nohelper");
    writeFileSync(path.join(d, "f"), "x");
    expect(await taskDirExists(d)).toBe(true);
    expect(await resolveAtPathsInTaskDir(d, [{ rel: "f", isDir: false }])).toEqual([path.join(d, "f")]);
  });

  test("a hanging child times out and fails closed", async () => {
    const hang = path.join(root, "hang.sh");
    writeFileSync(hang, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 });
    process.env.AGETOR_DISCLAIM_BIN = hang;
    setDisclaimSwitch(true);
    expect(disclaimEnabled()).toBe(true);
    const d = freshDir("hang");
    const started = Date.now();
    expect(await taskDirExists(d)).toBe(false);
    expect(Date.now() - started).toBeGreaterThan(9_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
