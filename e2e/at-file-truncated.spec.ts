import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the `@` file-reference feature PAST the 20k listing cap
 * (`MAX_PROJECT_FILES` in `src/shared/at-refs.ts`, feature landed in commit
 * `720dffd`): once a project's file count exceeds the cap, the base listing
 * (`GET /files/index?dir=&ref=`, no `q`) comes back `truncated: true` and
 * simply omits everything past the cap. Two client surfaces then fall back to
 * a server-side full-listing search (`GET /files/index?q=`, ranked via the
 * shared `filterFileEntries` scorer over the FULL tree, not just the capped
 * slice):
 *
 *   - `AtFileAutocomplete`'s popover (see its "Truncated-scope fallback" doc
 *     comment) debounces a `searchProjectFiles` call so a past-the-cap file
 *     still autocompletes, with a "Large repo — matches searched server-side
 *     footer replacing the generic truncation notice.
 *   - `PromptComposer`'s unresolved-`@`-reference warning (see its "Truncated-
 *     scope verification" block) individually verifies each unlisted token
 *     via the same search before ever warning on it — an unproven token never
 *     warns, only one the search positively confirms absent from the full
 *     listing does. The same verified hit is unioned into the highlight
 *     backdrop's `validPaths` so a past-the-cap token still gets a mark.
 *
 * Fixture: one temp git repo with `README.md`, a `bulk/` directory holding
 * 20,050 empty files (`aaa-00001.txt`..`aaa-20050.txt`, zero-padded), and
 * `src/zzz-target.ts`. A plain code-unit sort (`R` < `b` < `s`) puts
 * `README.md` first, the whole of `bulk/` next, and `src/zzz-target.ts` dead
 * last — so the 20,000-file display cap swallows `README.md` plus
 * `bulk/aaa-00001.txt`..`bulk/aaa-19999.txt` (exactly 20,000 entries) and
 * `src/zzz-target.ts` (entry #20,052) never makes the capped listing. The
 * first test pins that premise directly against the API before any UI
 * assertion leans on it.
 *
 * Every scenario uses the New Task form with Isolate left ON (the default),
 * which resolves the `@` file scope to `{ dir: repoPath, ref: "HEAD" }` (see
 * `NewTaskForm.tsx`'s `fileScope` memo) — a `git ls-tree` listing at the
 * pinned ref, exercising the truncated-listing fallback in "ref scope" mode
 * (as opposed to a live worktree's `git ls-files`).
 */

const CONVERGE_TIMEOUT = 15_000;

let projectDir: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Temp git repo with `README.md`, a `bulk/` directory of 20,050 empty files,
 * and `src/zzz-target.ts` — see the file header for why this exact shape puts
 * `src/zzz-target.ts` past the 20k display cap. The 20,050 empty files are
 * generated with ONE shell invocation (`seq | xargs touch`) rather than 20k
 * individual awaited `fs` calls, which would make this fixture build
 * unworkably slow.
 */
async function initTruncatedRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-at-trunc-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(dir, "README.md"), "e2e at-file-truncated fixture repo\n");

  const bulkDir = path.join(dir, "bulk");
  await mkdir(bulkDir, { recursive: true });
  execSync("seq -f 'aaa-%05.0f.txt' 1 20050 | xargs touch", { cwd: bulkDir });

  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "zzz-target.ts"), "export {};\n");

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit (20,052 files)"]);

  return dir;
}

/** Registers `dir` as a project via the plain global `fetch` (not
 *  Playwright's `request` fixture, unavailable in `beforeAll`) — mirrors
 *  `e2e/at-file-autocomplete.spec.ts`'s `registerProject`. */
async function registerProject(apiBase: string, apiToken: string, dir: string): Promise<void> {
  const res = await fetch(`${apiBase}/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  if (!res.ok) {
    throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
  }
}

// ---- Locator helpers (mirrors e2e/at-file-autocomplete.spec.ts) -----------

/** The New Task sidebar — always the first `<aside>` in DOM order. */
function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

function promptTextarea(scope: Locator): Locator {
  return scope.getByTestId("prompt-textarea");
}

function atPopover(scope: Locator): Locator {
  return scope.getByTestId("at-file-autocomplete");
}

/** A specific popover row by its exact listed path (`data-path`). */
function atRow(scope: Locator, filePath: string): Locator {
  return scope.locator(`[data-testid="at-file-autocomplete-row"][data-path="${filePath}"]`);
}

function highlightMarks(scope: Locator): Locator {
  return scope.getByTestId("at-highlight-mark");
}

test.beforeAll(async ({ backend }) => {
  // Generous: building 20,052 files + one commit measured ~2s locally, but
  // this also boots a fresh page + waits on the popover's server round-trip
  // in every scenario below, so give the whole file's hooks + first test
  // plenty of headroom on a loaded machine.
  test.setTimeout(180_000);
  projectDir = await initTruncatedRepo();
  await registerProject(backend.apiBase, backend.apiToken, projectDir);
});

test.afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

test.describe("@ file references past the truncation cap", () => {
  test("Sanity + popover: the listing is truncated past the cap, and the popover falls back to server-side search", async ({
    page,
    request,
    backend,
  }) => {
    // Pin the fixture premise via the real API before trusting any UI
    // assertion below on it: the ref-scope listing at HEAD must be truncated,
    // and `src/zzz-target.ts` must NOT be among the (capped) returned files.
    const res = await request.get(`${backend.apiBase}/files/index`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      params: { dir: projectDir, ref: "HEAD" },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { files: string[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.files).not.toContain("src/zzz-target.ts");

    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();
    await page.keyboard.type("@zzz");

    // The popover must find the past-the-cap file via the debounced
    // server-side search (150ms debounce + roundtrip) — CONVERGE_TIMEOUT
    // covers that.
    const row = atRow(form, "src/zzz-target.ts");
    await expect(row).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(
      atPopover(form).getByText("Large repo — matches searched server-side"),
    ).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(textarea).toHaveValue("@src/zzz-target.ts ");
    await expect(atPopover(form)).toBeHidden();
  });

  test("Highlight: a past-the-cap token is verified and marked, and never triggers the unresolved warning", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    const warning = form.getByTestId("at-unresolved-warning");
    await textarea.click();

    await textarea.fill("see @src/zzz-target.ts");
    // `.fill()` sets the value programmatically without firing the native
    // keyup AtFileAutocomplete's caret-sync listener relies on — harmless
    // here (no popover interaction follows), but matches the "sync after a
    // programmatic fill" idiom used elsewhere.
    await textarea.dispatchEvent("keyup");

    // The base (capped) listing doesn't include this path, so the highlight
    // backdrop can only mark it once the truncated-scope verification's
    // debounced server-side search (300ms + roundtrip) confirms it's listed
    // and unions it into `validPaths` — CONVERGE_TIMEOUT covers that.
    await expect(highlightMarks(form)).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(highlightMarks(form)).toHaveText("@src/zzz-target.ts");

    // An unproven token never warns, and a verified-listed one never becomes
    // "checked missing" — the warning must stay hidden throughout, including
    // after the mark has settled.
    await expect(warning).toBeHidden();
  });

  test("Warning stays honest past the cap: only a token the server-side search confirms absent ever warns", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    const warning = form.getByTestId("at-unresolved-warning");
    await textarea.click();

    // A typo'd path that exists nowhere in the (full, past-cap) listing: the
    // warning must not fire until the verification search positively
    // confirms it's missing (CONVERGE_TIMEOUT covers the 300ms debounce +
    // roundtrip) — it must never warn merely because the base capped listing
    // doesn't contain it.
    await textarea.fill("see @src/zzz-nope.ts");
    await textarea.dispatchEvent("keyup");
    await expect(warning).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(warning).toContainText("@src/zzz-nope.ts");

    // Fixing the token to one that IS present past the cap clears the
    // warning again — it's never stuck warning off a stale verification.
    await textarea.fill("see @src/zzz-target.ts");
    await textarea.dispatchEvent("keyup");
    await expect(warning).toBeHidden();
  });

  test("Below-cap behavior is unchanged: a file inside the capped listing still autocompletes instantly", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const form = newTaskForm(page);
    const textarea = promptTextarea(form);
    await textarea.click();
    await page.keyboard.type("@REA");

    // README.md is well inside the capped set — the instant client-side
    // filter over `entries` matches it with no server round-trip needed.
    await expect(atRow(form, "README.md")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  });
});
