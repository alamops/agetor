import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for binary diff previews in the Task Details Diff modal
 * (docs/plans/binary-diff-previews.md §5) — the 2-up image and PDF preview
 * panes `BinaryFilePreview.tsx` renders for `DiffFile.binary` entries,
 * gated correctly so an ordinary text file still gets the textual diff.
 *
 * Runs Chromium against the real webview + real Bun API (a per-worker
 * headless backend from `e2e/fixtures.ts`) — no mocked fetches. Each test
 * builds its own throwaway git repo under the OS tmpdir (parallel-safe: a
 * fresh `mkdtemp` per test, cleaned up in `afterAll`), commits a binary
 * fixture file, then dirties the working tree so `GET /tasks/:id/diff`
 * (which — for an `isolation: "none"` task — always diffs literal `HEAD`
 * against the on-disk working tree, per `getTaskDiff` in
 * `src/bun/worktree.ts`) has something to show. The task is created via the
 * API and never started: the diff endpoint works on any task whose workdir
 * is a git repo with at least one commit, worktree or not.
 *
 * PNG and PDF fixtures are generated on the fly (raw PNG chunk/CRC32
 * encoding, hand-assembled multi-object PDF with a real xref table) rather
 * than hardcoded base64 blobs — both encoders were validated standalone
 * against `pdfjs-dist`'s legacy Node build (page count + viewport) and the
 * PNG dimensions decoded by macOS `sips`/`file` before being folded into
 * this spec, so the bytes are known-good rather than asserted-and-hoped.
 * Distinct, deliberately-mismatched dimensions per side (e.g. 4×4 vs 8×6)
 * let the test assert the *actual* pixel dimensions pdf.js/the browser
 * decoded, not just "an image loaded" — a stronger signal that the old and
 * new blob endpoints really served different bytes.
 */

test.describe.configure({ mode: "serial" });

const cleanupDirs: string[] = [];

test.afterAll(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/* --------------------------- git repo fixtures --------------------------- */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** A fresh, isolated git repo (own author identity, gpg signing forced off
 *  so a machine with `commit.gpgsign=true` in its global config doesn't
 *  hang the test on a passphrase prompt) with one commit: a `.gitattributes`
 *  that force-marks `*.png`/`*.pdf` as `binary`. Without it, git's own
 *  binary-detection heuristic (scan for a NUL byte in the first ~8000
 *  bytes) is content-dependent — a hand-built minimal PDF with only
 *  uncompressed text content streams has no NUL bytes at all and git
 *  diffs it as plain text, never emitting the "Binary files … differ"
 *  marker `parseGitDiff` (src/bun/git-diff.ts) keys `DiffFile.binary` off
 *  of. The `.gitattributes` rule makes binary-ness deterministic
 *  regardless of what bytes the fixture actually contains. Registered for
 *  `afterAll` cleanup immediately — a failure partway through a test's
 *  setup still gets the directory removed. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-diff-"));
  cleanupDirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, ".gitattributes"), "*.png binary\n*.pdf binary\n");
  await commitAll(dir, "gitattributes: force binary diffing for png/pdf fixtures");
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

/* ------------------------------ PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Minimal valid 8-bit RGB, no-interlace, single-solid-color PNG of exactly
 *  `width`x`height` — hand-encoded (IHDR + one zlib-deflated IDAT scanline
 *  block + IEND) rather than a hardcoded blob, so distinct fixture dims are
 *  cheap and self-evidently correct (verified against `sips`/`file` and
 *  Node's `zlib` during authoring). */
function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = pngChunk("IHDR", ihdrData);

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }
  const idat = pngChunk("IDAT", zlib.deflateSync(raw));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/* ------------------------------ PDF encoder ------------------------------ */

/** Hand-assembled multi-page PDF (real byte-offset xref table, one Type1
 *  Helvetica content stream per page) — one entry in `pages` per page, its
 *  string rendered as the page's only text. Validated standalone against
 *  `pdfjs-dist`'s legacy Node build (`getPage(1).getViewport()`, page count)
 *  during authoring, so pdf.js parsing it in Chromium is expected to work,
 *  not merely hoped. */
function makePdf(pages: string[]): Buffer {
  const numPages = pages.length;
  const objects: string[] = [];
  const pageObjNumStart = 3;
  const fontObjNum = pageObjNumStart + numPages;
  const contentObjNumStart = fontObjNum + 1;

  const kids = Array.from({ length: numPages }, (_, i) => `${pageObjNumStart + i} 0 R`).join(" ");
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${numPages} >>\nendobj\n`;
  for (let i = 0; i < numPages; i++) {
    const pageNum = pageObjNumStart + i;
    const contentNum = contentObjNumStart + i;
    objects[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`;
  }
  objects[fontObjNum] = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;
  for (let i = 0; i < numPages; i++) {
    const contentNum = contentObjNumStart + i;
    const streamText = `BT /F1 24 Tf 50 100 Td (${pages[i]}) Tj ET`;
    objects[contentNum] =
      `${contentNum} 0 obj\n<< /Length ${streamText.length} >>\nstream\n${streamText}\nendstream\nendobj\n`;
  }

  const totalObjs = contentObjNumStart + numPages - 1;
  let body = "%PDF-1.4\n";
  const offsets: number[] = new Array(totalObjs + 1).fill(0);
  for (let n = 1; n <= totalObjs; n++) {
    offsets[n] = Buffer.byteLength(body, "latin1");
    body += objects[n];
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  body += xref + trailer;
  return Buffer.from(body, "latin1");
}

/* ------------------------------- API + UI -------------------------------- */

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", `workdir` = a real git repo) via the
 *  worker's API. Deliberately never started — `GET /tasks/:id/diff` works
 *  on any `isolation: "none"` task whose workdir is a git repo with a
 *  commit, per `getTaskDiff` (src/bun/worktree.ts): it diffs literal `HEAD`
 *  against the on-disk working tree directly, no worktree/run required. */
async function createDiffTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  workdir: string,
): Promise<TaskRow> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { title, prompt: title, isolation: "none", workdir },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as TaskRow;
}

/** The kanban Card for a task, scoped by its (unique, uuid-suffixed) title
 *  text — `TaskCard.tsx` puts `cursor-grab` on the Card root unconditionally
 *  (draggable via dnd-kit), which is the only stable hook available since
 *  this feature ships no `data-testid`s. Titles carry a `randomUUID()` per
 *  test so `hasText` substring matching can't cross-match another task. */
function taskCard(page: Page, title: string): Locator {
  return page.locator('[class*="cursor-grab"]').filter({ hasText: title });
}

/** Click a task card's "View changes (git diff)" icon button (present on
 *  every card, independent of column/run state — TaskCard.tsx:198) and wait
 *  for the resulting dialog to render. */
async function openDiffDialog(page: Page, title: string): Promise<Locator> {
  const card = taskCard(page, title);
  await expect(card).toBeVisible();
  await card.getByTitle("View changes (git diff)").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Changes")).toBeVisible();
  return dialog;
}

/** Scope to one file's `FileBlock` root inside the diff dialog. Starts from
 *  the file path's own text node (matched exactly, so "image.png" doesn't
 *  also match "new-image.png") and walks up to the nearest ancestor `<div>`
 *  carrying `overflow-hidden`/`rounded-md` — the class combination unique to
 *  `FileBlock`'s root in DiffDialog.tsx. XPath ancestor walk rather than
 *  `locator(...).filter({ has })`, which resolves `has` against the whole
 *  page rather than the outer locator's subtree and produced false negatives
 *  here. */
function fileBlock(dialog: Locator, filePath: string): Locator {
  return dialog
    .getByText(filePath, { exact: true })
    .locator(
      "xpath=ancestor::div[" +
        "contains(concat(' ', normalize-space(@class), ' '), ' overflow-hidden ') and " +
        "contains(concat(' ', normalize-space(@class), ' '), ' rounded-md ')" +
        "][1]",
    );
}

/* --------------------------------- tests ---------------------------------- */

test.describe("binary diff previews", () => {
  test("renders 2-up image previews (modified + untracked) and still renders textual diff for a modified .txt", async ({
    page,
    request,
    backend,
  }) => {
    const dir = await initRepo();
    const title = `binary-diff-image-${randomUUID()}`;

    // image.png: committed 4x4 red, then overwritten (uncommitted) with an
    // 8x6 blue PNG -> "modified", both sides present.
    const imageOld = makePng(4, 4, [220, 40, 40]);
    const imageNew = makePng(8, 6, [40, 120, 220]);
    await writeFile(path.join(dir, "image.png"), imageOld);
    // notes.txt: committed one line, then a second line appended
    // (uncommitted) -> "modified", exercises the plain-text row rendering
    // that must still work for a non-binary file in the same diff.
    await writeFile(path.join(dir, "notes.txt"), "line one\n");
    await commitAll(dir, "initial commit");

    await writeFile(path.join(dir, "image.png"), imageNew);
    await writeFile(path.join(dir, "notes.txt"), "line one\nline two\n");
    // new-image.png: never committed -> "added" via the untracked-file path,
    // old side must render the one-sided "no previous version" placeholder.
    const imageUntracked = makePng(5, 5, [40, 200, 90]);
    await writeFile(path.join(dir, "new-image.png"), imageUntracked);

    await createDiffTask(request, backend, title, dir);

    await gotoApp(page, backend.bootBase);
    const dialog = await openDiffDialog(page, title);

    // --- image.png: both sides present, real distinct pixel dimensions ---
    const modifiedBlock = fileBlock(dialog, "image.png");
    await expect(modifiedBlock).toBeVisible();

    const oldImg = modifiedBlock.locator('img[src*="side=old"]');
    const newImg = modifiedBlock.locator('img[src*="side=new"]');
    await expect(oldImg).toHaveCount(1);
    await expect(newImg).toHaveCount(1);
    await expect(oldImg).toHaveAttribute("src", /\/tasks\/.*\/diff\/blob\?/);
    await expect(newImg).toHaveAttribute("src", /\/tasks\/.*\/diff\/blob\?/);

    await expect
      .poll(() => oldImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect
      .poll(() => newImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    // Distinct real dimensions on each side proves old/new served different
    // bytes, not just "something loaded".
    await expect(modifiedBlock.getByText("4 × 4 px")).toBeVisible();
    await expect(modifiedBlock.getByText("8 × 6 px")).toBeVisible();

    // --- new-image.png: untracked -> one-sided, "no previous version" ----
    const untrackedBlock = fileBlock(dialog, "new-image.png");
    await expect(untrackedBlock).toBeVisible();
    await expect(untrackedBlock.getByText("Added — no previous version")).toBeVisible();
    await expect(untrackedBlock.locator('img[src*="side=old"]')).toHaveCount(0);

    const untrackedNewImg = untrackedBlock.locator('img[src*="side=new"]');
    await expect(untrackedNewImg).toHaveCount(1);
    await expect
      .poll(() => untrackedNewImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(untrackedBlock.getByText("5 × 5 px")).toBeVisible();

    // --- notes.txt: negative case — a modified text file must still get --
    // --- the textual row diff, not fall through the binary-preview gate --
    const notesBlock = fileBlock(dialog, "notes.txt");
    await expect(notesBlock).toBeVisible();
    await expect(notesBlock.locator('[data-diff-path="notes.txt"]').filter({ hasText: "line two" })).toBeVisible();
    await expect(notesBlock.locator("img")).toHaveCount(0);
    await expect(notesBlock.locator("canvas")).toHaveCount(0);
    await expect(notesBlock.getByText("Binary file — no textual diff.")).toHaveCount(0);
  });

  test("renders a 2-up PDF preview with a working page pager", async ({ page, request, backend }) => {
    test.setTimeout(60_000); // pdf.js is a lazily-loaded ~1MB chunk; first fetch can be slow.

    const dir = await initRepo();
    const title = `binary-diff-pdf-${randomUUID()}`;

    const pdfOld = makePdf(["Committed page one", "Committed page two"]);
    const pdfNew = makePdf(["Modified page one", "Modified page two"]);
    await writeFile(path.join(dir, "doc.pdf"), pdfOld);
    await commitAll(dir, "add pdf");
    await writeFile(path.join(dir, "doc.pdf"), pdfNew);

    await createDiffTask(request, backend, title, dir);

    await gotoApp(page, backend.bootBase);
    const dialog = await openDiffDialog(page, title);

    const block = fileBlock(dialog, "doc.pdf");
    await expect(block).toBeVisible();

    const oldImg = block.locator('img[src*="side=old"]');
    const newImg = block.locator('img[src*="side=new"]');
    // PDFs render via <canvas>, never <img> — confirms the pdf branch, not
    // a mis-detected image preview.
    await expect(oldImg).toHaveCount(0);
    await expect(newImg).toHaveCount(0);

    const canvases = block.locator("canvas");
    await expect(canvases).toHaveCount(2, { timeout: 20_000 });
    for (let i = 0; i < 2; i++) {
      const canvas = canvases.nth(i);
      await expect(canvas).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).width), { timeout: 20_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).height))
        .toBeGreaterThan(0);
    }

    // Pager only renders when the diff's max page count across both sides
    // is >1 (BinaryFilePreview.tsx's `showPager`) — both sides here are
    // 2-page PDFs, so it must be visible and start on page 1.
    const pager = block.getByText(/^Page \d+ \/ \d+$/);
    await expect(pager).toBeVisible();
    await expect(pager).toHaveText("Page 1 / 2");

    const prevBtn = block.getByRole("button", { name: "Previous page" });
    const nextBtn = block.getByRole("button", { name: "Next page" });
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    await nextBtn.click();
    await expect(pager).toHaveText("Page 2 / 2");
    await expect(prevBtn).toBeEnabled();
    await expect(nextBtn).toBeDisabled();
  });
});
