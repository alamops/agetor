/**
 * Pure helpers for the `opencode` agent kind (OpenCode, `anomalyco/opencode`,
 * binary `opencode`) shared by the bun side (`buildCommand`, the driver, the
 * routes), the webview (the model picker and run panel; the Shared/Standalone
 * server picker is retired, `parseOpencodeServerInput` only keeps old requests
 * valid) and the CLI. Kept free of
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
 * The server a recorded turn ran against: the two stored {@link OpencodeServerMode}
 * values the legacy v2 tmux path used, plus `"agetor"` (plan D9) for a turn
 * that ran on the agetor-owned OpenCode server (the HTTP driver). Only the
 * turn breadcrumb carries `"agetor"`; the stored `tasks.opencode_server` /
 * `agent_profiles.opencode_server` field and every route that validates it
 * stay on {@link OpencodeServerMode} (`shared` | `standalone`).
 */
export type OpencodeTurnServer = OpencodeServerMode | "agetor";

/** How an OpenCode turn is carried: the agetor-owned HTTP server, or one-shot `opencode run` in tmux. */
export type OpencodeTransport = "server" | "run";

/**
 * Which transport a turn uses (plan D-transport): v1 has no server API, so it
 * always runs `opencode run`; `transportEnv` (the caller passes
 * `process.env.AGETOR_OPENCODE_TRANSPORT`) set to `run` (trimmed,
 * case-insensitive) is the kill switch back to `opencode run` on v2; anything
 * else, an unparseable version included, takes the server. Pure: this module
 * never reads `process.env`.
 */
export function opencodeTransportFor(a: {
  version: string | null | undefined;
  transportEnv?: string | null;
}): OpencodeTransport {
  if (opencodeMajor(a.version) === 1) return "run";
  if ((a.transportEnv ?? "").trim().toLowerCase() === "run") return "run";
  return "server";
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

/**
 * Display names for OpenCode's own hosted providers. Both serve many of the
 * same models under the same `name` (`opencode/deepseek-v4.1-flash` and
 * `opencode-go/deepseek-v4.1-flash` are both "DeepSeek V4.1 Flash"), but
 * they bill differently: `opencode` (Zen) draws on the account's
 * pay-as-you-go balance and answers 402 "Insufficient account funds" when it
 * is empty, while `opencode-go` runs on the Go subscription.
 */
const OPENCODE_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

/** The provider half of a `provider/model` id, or null when there is none. */
export function opencodeProviderOf(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : null;
}

/** A provider id's display name: the known OpenCode-hosted ones by name, any other as itself. */
export function opencodeProviderLabel(providerId: string): string {
  return OPENCODE_PROVIDER_LABELS[providerId] ?? providerId;
}

/**
 * Makes discovered OpenCode model labels unique. OpenCode reports a model's
 * `name` without its provider, so the same model offered by two providers
 * (Zen and Go above, or a BYOK provider) shows up as two identical rows in the
 * picker, and picking the wrong one can bill the wrong account. A label
 * shared by two or more ids gets ` (<provider>)` appended; one that still
 * collides after that (two ids of one provider) gets ` (<id>)` instead. Ids,
 * order, efforts and unshared labels are untouched; a model with no label
 * shows its id and needs nothing. Pure.
 */
export function disambiguateOpencodeLabels<T extends { id: string; label?: string }>(models: T[]): T[] {
  const count = (labels: Array<string | undefined>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of labels) if (l !== undefined) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const shared = count(models.map((m) => m.label));
  const withProvider = models.map((m) => {
    if (m.label === undefined || (shared.get(m.label) ?? 0) < 2) return m.label;
    const provider = opencodeProviderOf(m.id);
    return provider ? `${m.label} (${opencodeProviderLabel(provider)})` : `${m.label} (${m.id})`;
  });
  const still = count(withProvider);
  return models.map((m, i) => {
    const label = withProvider[i];
    if (label === m.label || label === undefined) return m;
    return { ...m, label: (still.get(label) ?? 0) > 1 ? `${m.label} (${m.id})` : label };
  });
}

/** Text that names Zen outright: the product, or an `opencode/…` (Zen) model id. `opencode-go/…` has no match. */
const ZEN_TEXT_RE = /\bzen\b|\bopencode\/[\w.-]/i;

/**
 * A hint for a turn that failed because the provider has no balance (v2
 * `{type: "provider.quota", status: 402}`, or the "Insufficient account
 * funds" text), else null. The hint only fits OpenCode Zen (`opencode/…`),
 * the pay-as-you-go provider: its usual cause is a Zen model picked by an
 * account that pays through a Go subscription, whose copy of the same model
 * is `opencode-go/…`. So it is given only when `model`'s provider is
 * `opencode`. A model of any other provider (a Go model, a BYOK one) gets no
 * hint: telling that user to switch to Go would be wrong. An unknown model
 * (null/absent, or an id with no provider such as the "OpenCode default"
 * sentinel) gets the hint only when the error text itself names Zen
 * (`Zen`, `opencode/…`); otherwise there is nothing to blame.
 */
export function opencodeQuotaHint(err: unknown, message: string, model?: string | null): string | null {
  const rec = err && typeof err === "object" ? (err as { type?: unknown; status?: unknown }) : null;
  const quota = rec?.type === "provider.quota" || rec?.status === 402 || /insufficient (account )?funds/i.test(message);
  if (!quota) return null;
  const provider = model ? opencodeProviderOf(model) : null;
  if (provider !== null) {
    if (provider !== "opencode") return null;
  } else if (!ZEN_TEXT_RE.test(message)) {
    return null;
  }
  return "the model's provider has no balance for this account. OpenCode Zen models (opencode/…) bill your Zen balance; " +
    "a Go subscription runs the opencode-go/… models, labelled (OpenCode Go) in the model picker — switch the task's model to one of those.";
}

/** The D-9 status line a failed resume posts before the fresh session (the one copy agents.ts, opencode-tmux.ts and opencode-driver.ts share). */
export function opencodeResumeFailedStatusLine(sessionId: string): string {
  return `couldn't resume OpenCode session ${sessionId.slice(0, 8)}… — starting a fresh session`;
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

/**
 * The fixed head of an OpenCode turn's opening status line (D-19) for a CLI
 * line: `opencode <major>.x · server=`. Also the persisted record of the
 * server mode a turn ran in — `task.opencodeServer` may change between turns,
 * so a later reader (teardown, boot, reattach) reads the run's own line.
 */
export function opencodeTurnBreadcrumbPrefix(major: 1 | 2): string {
  return `opencode ${major}.x · server=`;
}

/**
 * D-19: the opening status line of every OpenCode turn —
 * `opencode <major>.x · server=<shared|standalone|agetor|n/a> · model=<label> ·
 * effort=<id> · mode=<id>`. `server` is the EFFECTIVE mode (`null` → `n/a`,
 * v1; `agetor` = ran on the agetor-owned server, plan D9). {@link parseOpencodeTurnBreadcrumb} is its inverse for the head.
 */
export function formatOpencodeTurnBreadcrumb(a: {
  major: 1 | 2;
  server: OpencodeTurnServer | null;
  modelLabel: string;
  effort: string;
  mode: string;
}): string {
  return `${opencodeTurnBreadcrumbPrefix(a.major)}${a.server ?? "n/a"} · model=${a.modelLabel} · effort=${a.effort} · mode=${a.mode}`;
}

const TURN_BREADCRUMB_RE = /^opencode ([12])\.x · server=(shared|standalone|agetor|n\/a)(?: · |$)/;

/**
 * The CLI line and effective server mode a {@link formatOpencodeTurnBreadcrumb}
 * line records, or null when `text` isn't one. `server` is `null` for `n/a`.
 */
export function parseOpencodeTurnBreadcrumb(
  text: string | null | undefined,
): { major: 1 | 2; server: OpencodeTurnServer | null } | null {
  if (!text) return null;
  const m = TURN_BREADCRUMB_RE.exec(text);
  if (!m) return null;
  return { major: m[1] === "1" ? 1 : 2, server: m[2] === "n/a" ? null : (m[2] as OpencodeTurnServer) };
}

/**
 * True when a turn's subagent children cannot outlive it (A6a): every v1
 * child is foreground, and a Standalone v2 child dies with the turn's
 * private server. A v2 Shared child may keep running in the service, and so
 * may a child of an `agetor` turn: the agetor-owned server outlives the turn.
 */
export function opencodeChildrenDieWithTurn(t: { major: 1 | 2; server: OpencodeTurnServer | null }): boolean {
  return t.major === 1 || t.server === "standalone";
}
