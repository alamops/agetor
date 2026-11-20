// Call-site allowlist for the preview twins (docs/plans/picked-image-preview-tcc.md,
// U3 / invariant 1). A twin write makes the core READ a file in its own process,
// so it may happen only inside the three user-gesture handlers in server.ts
// (pick in both its fake-seam and native branches, drag, and resolve with an app
// caller + `previewTwins: true`). A new caller, in particular one that reaches an
// agent-chosen path, must change this list on purpose.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const countMatches = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe("who may write a preview twin", () => {
  const CALL = /\bwritePreviewTwin(sForRefs)?\(/g;

  test("calls exist only in preview-twins.ts and in exactly four places in server.ts", () => {
    const hits = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const n = countMatches(readFileSync(file, "utf8"), CALL);
      if (n > 0) hits.set(rel(file), n);
    }
    expect([...hits.keys()].sort()).toEqual(["bun/preview-twins.ts", "bun/server.ts"]);
    // /refs/pick (fake-dir seam + native panel), /refs/drag, /refs/resolve.
    expect(hits.get("bun/server.ts")).toBe(4);
  });

  test("preview-twins.ts is imported only by server.ts, index.ts and headless.ts, with exact names", () => {
    // Pins the import list too, so an aliased import (`writePreviewTwin as w`) or
    // a write function handed out as a callback can't slip past the call count.
    const imports = new Map<string, string[]>();
    for (const file of sourceFiles(SRC)) {
      if (rel(file) === "bun/preview-twins.ts") continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("preview-twins")) continue;
      const lines = text.split("\n").filter((l) => l.includes("preview-twins") && /\bimport\b|\bfrom\b/.test(l));
      imports.set(rel(file), lines.map((l) => l.trim()));
    }
    expect(Object.fromEntries([...imports].sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      "bun/headless.ts": ['import { requestPreviewTwinSweep } from "./preview-twins.ts";'],
      "bun/index.ts": ['import { requestPreviewTwinSweep } from "./preview-twins.ts";'],
      "bun/server.ts": ['import { previewTwinPath, writePreviewTwinsForRefs } from "./preview-twins.ts";'],
    });
  });

  test("the /refs/resolve call is guarded by the app caller and the previewTwins flag", () => {
    const server = readFileSync(path.join(SRC, "bun/server.ts"), "utf8");
    expect(server).toMatch(/caller === "app" && body\.previewTwins === true\) \{[^}]*await writePreviewTwinsForRefs\(dataDir, refs, \(ref\) => names\.has\(/);
  });
});

describe("who may ask /refs/resolve for twins", () => {
  test("`previewTwins` appears in the webview only in api.ts", () => {
    const files = sourceFiles(path.join(SRC, "mainview")).filter((f) =>
      readFileSync(f, "utf8").includes("previewTwins"),
    );
    expect(files.map(rel)).toEqual(["mainview/lib/api.ts"]);
  });

  test("api.resolveRefs never sends the flag; resolveCapturedRefs does", () => {
    const api = readFileSync(path.join(SRC, "mainview/lib/api.ts"), "utf8");
    expect(api).toContain("body: JSON.stringify({ paths }),");
    expect(countMatches(api, /body: JSON\.stringify\(\{ paths, names, previewTwins: true \}\)/g)).toBe(1);
  });

  test("resolveCapturedRefs is referenced only by api.ts and capture-refs.ts", () => {
    const files = sourceFiles(path.join(SRC, "mainview")).filter((f) =>
      readFileSync(f, "utf8").includes("resolveCapturedRefs"),
    );
    expect(files.map(rel).sort()).toEqual(["mainview/lib/api.ts", "mainview/lib/capture-refs.ts"]);
  });
});
