/**
 * Pure helpers for the `opencode` agent kind (OpenCode, `anomalyco/opencode`,
 * binary `opencode`) shared by the bun side (`buildCommand`, the driver, the
 * routes), the webview (the OpenCode server picker) and the CLI. Kept free of
 * runtime imports from either process side, like every other `src/shared/`
 * module — the only import is a type.
 *
 * Two OpenCode lines ship side by side and take different flags
 * (`docs/plans/add-opencode-harness.md` G1, spike Q5): v1 (`opencode-ai`
 * 1.x) and v2 (`@opencode/cli` / Homebrew 2.x). v1 rejects `--standalone`
 * and v2 rejects `--variant`, so every argv decision is gated on
 * {@link opencodeMajor} of the probed `--version`.
 */
import type { OpencodeServerMode } from "./types.ts";

/**
 * The curated "OpenCode default" model row (`DEFAULT_MODEL.opencode`): no
 * `-m` at all, so OpenCode runs whatever model its own config names (G4,
 * D-5). It is the one sentinel model id in agetor — every other kind's
 * default is a real model id. It carries no `/`, so it can never collide
 * with a discovered `provider/model` id (Zen's `opencode/…` included), and
 * it is not the bare `"default"` the old placeholder guard forbids.
 */
export const OPENCODE_DEFAULT_MODEL = "opencode-default";

/**
 * Finds the `major.minor.patch` triple in an `opencode --version` output.
 * Unanchored on purpose: v2 prints `opencode v2.1.3`, v1 prints `1.19.4`
 * (spike Q1, amendment A2), so a leading-digit check would miss v2.
 */
export const OPENCODE_VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

/** OpenCode's own per-session id prefix (`ses_…`), discovered from the
 *  `run --format json` stream. Never collides with a Claude session uuid. */
export const OPENCODE_SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

/**
 * Which OpenCode line a probed `--version` belongs to: `1` for a parsed
 * major below 2, else `2` — including an unparseable, empty or missing
 * version (D-2: the newer line is the safe default, and its flags are the
 * ones the docs describe).
 */
export function opencodeMajor(version: string | null | undefined): 1 | 2 {
  if (!version) return 2;
  const m = OPENCODE_VERSION_RE.exec(version);
  if (!m) return 2;
  const major = Number(m[1]);
  return Number.isFinite(major) && major < 2 ? 1 : 2;
}

/**
 * The server mode a turn actually runs in (D-4, G3–G3c):
 *  - `null` on v1 — v1 has no `--standalone` and no shared background
 *    service, so no flag is passed and the option is hidden;
 *  - `"standalone"` whenever the harness has a home — the shared service
 *    binds a fixed port that HOME/XDG isolation can't separate (spike A14),
 *    so an additional account must never reach the first account's daemon;
 *  - otherwise the task's own stored `mode`.
 */
export function effectiveOpencodeServer(a: {
  mode: OpencodeServerMode;
  harnessHome: string | null;
  major: 1 | 2;
}): OpencodeServerMode | null {
  if (a.major === 1) return null;
  if (a.harnessHome !== null && a.harnessHome.trim() !== "") return "standalone";
  return a.mode;
}

/**
 * The model/effort argv for one `opencode run` (D-3, D-6):
 *  - the sentinel ({@link OPENCODE_DEFAULT_MODEL}) or a null model → `[]`
 *    (no `-m`, and so no effort either — a variant needs a model);
 *  - an effort of `null` or `"auto"` ("Model default") → just `-m <model>`;
 *  - otherwise v2 carries the variant in the model id (`-m provider/model#v`)
 *    and v1 takes `--variant v`.
 * Every spawn passes the stored `task.effort` straight through, so the drop
 * for the sentinel and for `auto` must happen here, not only in the picker.
 */
export function opencodeModelArgs(a: {
  model: string | null;
  effort: string | null;
  major: 1 | 2;
}): string[] {
  const model = a.model?.trim() ?? "";
  if (model === "" || model === OPENCODE_DEFAULT_MODEL) return [];
  const effort = a.effort?.trim() ?? "";
  if (effort === "" || effort === "auto") return ["-m", model];
  return a.major === 2 ? ["-m", `${model}#${effort}`] : ["-m", model, "--variant", effort];
}

/** The 400 text every route uses for a bad `opencodeServer` value. */
export const OPENCODE_SERVER_INPUT_ERROR = "opencodeServer must be one of shared, standalone";

/**
 * Validates an `opencodeServer` request field: `undefined` (absent) passes
 * through as `undefined`, `"shared"`/`"standalone"` pass as themselves, and
 * anything else — `null`, another string, a non-string — is an error.
 */
export function parseOpencodeServerInput(v: unknown): OpencodeServerMode | { error: string } | undefined {
  if (v === undefined) return undefined;
  if (v === "shared" || v === "standalone") return v;
  return { error: OPENCODE_SERVER_INPUT_ERROR };
}
