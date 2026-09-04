import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Subprocess } from "bun";
import pkg from "../../package.json" with { type: "json" };
import type { AgentKind } from "../shared/types.ts";

/**
 * A model id (and optional human label) surfaced by the agent CLI itself.
 * Discovery is best-effort — a missing or unparseable CLI just returns an
 * empty list and the UI falls back to the hardcoded AGENT_OPTIONS.
 *
 * `efforts`, when present, is the deduped list of bare reasoning-effort ids
 * (e.g. `"high"`, `"ultra"`) the CLI itself reported as supported for this
 * model — codex only today, sourced from `codex app-server`'s `model/list`
 * response (`supportedReasoningEfforts[].reasoningEffort`; see
 * `parseCodexModelList`). Omitted entirely when the CLI reported no efforts
 * (never an empty array), so a model with no discovered effort data is
 * byte-identical to the pre-`efforts` shape. Consumed via `supportedEfforts`'
 * third argument (`src/shared/types.ts`), where a non-empty discovered set
 * wins over the curated `MODEL_EFFORT_SUPPORT` table.
 */
export interface DiscoveredModel {
  id: string;
  label?: string;
  efforts?: string[];
}

/**
 * Run an external command with a 3-second timeout. Designed for cheap CLI
 * probes where blocking the API boot is unacceptable — if the CLI hangs (e.g.
 * waiting for an auth flow) we give up rather than freezing app startup.
 *
 * `env`, when given, is merged over `process.env` for this one spawn — it
 * exists solely so `discoverFx` can probe an additional-account fx harness
 * (one with a `HOME` override) under *that* harness's own env instead of
 * agetor's process env, since fx's catalog is account-scoped (see
 * `discoverFx`'s comment below). Cursor is the only other user of this
 * helper today — it probes a built-in CLI's model-listing subcommand and
 * never passes `env`, since its catalog doesn't vary by account. Codex used
 * to as well (`codex prompt --models`), but that flag never actually existed
 * (binary-verified 0.147.0/0.153.0, 2026-09-03 — `error: unexpected
 * argument '--models'`; `discoverCodex` had always returned `[]`), so it's
 * moved off this helper entirely onto `codex app-server`'s own JSON-RPC
 * protocol (see `discoverCodex` below) rather than a `runProbe` call.
 * Keeping the override optional and purely additive is what lets this
 * module stay free of the database and process-spawning helper modules
 * (which would otherwise drag DB-open and process-signal-handler side
 * effects into a plain best-effort prober) — see the module-level note on
 * `discoverFx` below for the full "stay a leaf" constraint.
 */
async function runProbe(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, 3_000);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    return { ok: proc.exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Parse a `codex app-server` `model/list` JSON-RPC result (the `result`
 * object shape, i.e. `{ data: [...], nextCursor }` — see `discoverCodex`
 * below for how the pages are collected and concatenated before this is
 * called). Pure, never throws: any malformed input (non-object, a missing or
 * non-array `data`, a non-object entry) degrades to `[]` rather than
 * throwing — discovery is best-effort, never a hard dependency.
 *
 * Per entry: `id` must be a non-empty string (else skipped); `hidden ===
 * true` entries are skipped defensively (the server already filters these,
 * per the spike, but a future account/build regression shouldn't leak a
 * hidden row into the picker); ids are deduped (same `seen`-Set convention
 * as `parseCursorModels`/`parseFxModels` below — first occurrence wins).
 * `label` is `displayName` when it's a non-empty string, else omitted.
 * `efforts` is the deduped list of `supportedReasoningEfforts[].reasoningEffort`
 * strings, in the order the CLI reported them, with the key omitted entirely
 * when that list is empty — so an entry with no reported efforts stays
 * `{ id }`-only, byte-identical to the pre-`efforts` shape.
 */
function parseCodexModelList(result: unknown): DiscoveredModel[] {
  if (!result || typeof result !== "object") return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (e.hidden === true) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const model: DiscoveredModel = { id };
    if (typeof e.displayName === "string" && e.displayName.length > 0) {
      model.label = e.displayName;
    }
    if (Array.isArray(e.supportedReasoningEfforts)) {
      const efforts: string[] = [];
      const effortsSeen = new Set<string>();
      for (const s of e.supportedReasoningEfforts) {
        if (!s || typeof s !== "object") continue;
        const reasoningEffort = (s as Record<string, unknown>).reasoningEffort;
        if (typeof reasoningEffort !== "string" || reasoningEffort.length === 0) continue;
        if (effortsSeen.has(reasoningEffort)) continue;
        effortsSeen.add(reasoningEffort);
        efforts.push(reasoningEffort);
      }
      if (efforts.length > 0) model.efforts = efforts;
    }
    out.push(model);
  }
  return out;
}

/**
 * Parse `cursor-agent --list-models` output. Like codex, the exact format
 * isn't formally specified (and the binary isn't installed on this
 * machine to verify against), so we lean on the same loose heuristic:
 * any line whose first whitespace-separated token looks like a model id
 * (`<word>-<word>...`, lowercase, alphanumeric + dashes/dots, at least one
 * dash) is taken as a model. Header rows / banner chatter are dropped.
 */
function parseCursorModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(available|models|model\s+id|---|=+)/i.test(line)) continue;
    const first = line.split(/\s+/)[0]!;
    if (!/^[a-z0-9][a-z0-9.\-_]*[a-z0-9]$/i.test(first)) continue;
    if (!first.includes("-")) continue;
    if (seen.has(first)) continue;
    seen.add(first);
    out.push({ id: first });
  }
  return out;
}

async function discoverCursor(): Promise<DiscoveredModel[]> {
  // Resolve against the rehydrated PATH explicitly — see discoverCodex's
  // comment above (and agent-status.ts) for why Bun.spawn's implicit lookup
  // can't be trusted on a packaged .app.
  const fallback = process.env.AGETOR_CURSOR_BIN ?? "cursor-agent";
  const bin = Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
  // Best-effort only: cursor-agent may not support --list-models at all, or
  // may not be installed. Either way we fall back to the hardcoded
  // AGENT_OPTIONS list — never throw, never block app boot.
  const probe = await runProbe([bin, "--list-models"]);
  if (!probe.ok || !probe.stdout) return [];
  return parseCursorModels(probe.stdout);
}

/**
 * Default `codex app-server` probe budget, in ms — overridable only via the
 * test seam `__testing.setCodexProbeTimeoutMs` below (re-read at the start
 * of every `discoverCodex` call, so a test can drive the timeout path in
 * well under a second instead of eating the full 5s). Never exposed as a
 * real env var — discovery timing isn't something a shipped user needs to
 * tune.
 */
const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 5_000;
let codexProbeTimeoutMs = DEFAULT_CODEX_PROBE_TIMEOUT_MS;

/**
 * Discover codex's model catalog by speaking to `codex app-server` directly
 * over JSON-RPC 2.0 (newline-delimited, one object per line each direction)
 * on its stdio pipes — NOT via a model-listing subcommand like
 * `parseCursorModels`/`parseFxModels`'s CLIs offer. `codex prompt --models`
 * was assumed to exist by a previous version of this function but never
 * did: binary-verified against codex-cli 0.147.0 and 0.153.0 (2026-09-03),
 * it fails with `error: unexpected argument '--models'` on both, so
 * `discoverCodex` had always silently returned `[]`.
 *
 * Protocol (spike-verified, both versions, 2026-09-03):
 *   1. `{jsonrpc:"2.0", id, method:"initialize", params:{clientInfo}}` →
 *      response in ~160ms. Unsolicited notifications with no `id` (e.g.
 *      `remoteControl/status/changed`) may arrive interleaved — ignored.
 *   2. `{jsonrpc:"2.0", method:"initialized", params:{}}` — a notification,
 *      no `id`, no response expected.
 *   3. `{jsonrpc:"2.0", id, method:"model/list", params:{}}` → response in
 *      0.8–1.8s: `{id, result:{data:[...], nextCursor}}`. An unknown method
 *      would answer `{id, error:{code:-32600, message}}`.
 *
 * The catalog is account-scoped and server-fetched (codex caches it at
 * `~/.codex/models_cache.json`), which is exactly why this can't be a
 * one-shot `runProbe` subcommand call the way cursor/fx's discoverers are —
 * it's a stateful handshake over a long-lived pipe, not a single argv probe.
 *
 * `env`, when given, is merged over `process.env` for this one spawn — same
 * convention (and same reason) as `runProbe`/`discoverFx`'s `env` parameter:
 * codex's catalog is account-scoped, so a second codex harness (its own
 * `home` → `HOME`+`CODEX_HOME` override via `harnessEnv`, see
 * `src/bun/agents.ts`) must be probed under *its own* env to see *its own*
 * account's catalog rather than the built-in harness's. `bin`, when given,
 * is used verbatim in place of the `AGETOR_CODEX_BIN ?? "codex"` /
 * `Bun.which` resolution below — mirrors `discoverFx`'s `bin` parameter and
 * `resolveBin`'s harness.bin-first resolution in `agents.ts`. Both are
 * optional and additive: every pre-existing no-args caller keeps probing the
 * built-in harness under agetor's own process env, exactly as before these
 * parameters existed.
 *
 * Contract, matching every other discoverer in this module: never throws,
 * never hangs. Resolves `[]` when: the child exits before the `model/list`
 * result arrives (the `/bin/echo app-server` unit-test stub case — this
 * resolves promptly on exit, it does not wait out the timeout budget below);
 * a response carries a JSON-RPC `error`; the timeout budget elapses; or
 * anything throws (including a `stdin.write`/`flush` against an
 * already-closed pipe, guarded individually since that stub case closes its
 * pipe immediately). The child is always killed and the timer always
 * cleared in a `finally`. Pagination follows a non-empty string
 * `nextCursor` with a fresh `model/list` call (`{cursor}`), bounded to 5
 * pages total, concatenating each page's `data` before handing the whole
 * batch to `parseCodexModelList` — UNLESS the timeout fired at any point
 * during that pagination (`timedOut`, set only by the timer callback): in
 * that case this resolves `[]` outright, discarding whatever pages had
 * already landed, rather than returning (and letting the caller cache +
 * publish) a partial catalog that would just flip back to the full one on
 * the next sweep. This is distinct from a genuine JSON-RPC `error` on
 * `model/list`, which is unaffected by the timeout flag: an error on the
 * FIRST page still resolves `[]` (nothing was collected yet to keep), but an
 * error on a LATER page keeps whatever earlier pages already landed — both
 * halves of that behavior are unchanged from before this fix, just spelled
 * out precisely here.
 *
 * Leak-safety: the background stdout reader is hoisted to this function's
 * scope (`reader`, assigned inside the read loop's own try) so the outer
 * `finally` can `reader.cancel()` it after `kill()`ing the direct child —
 * without this, a grandchild that inherited the same stdout pipe (a real
 * `codex app-server` may spawn MCP/helper children) keeps that pipe's write
 * end open from its side, the reader's `read()` never resolves `done`, and
 * this process never releases its own reference to the pipe — which is
 * exactly what keeps a `Bun.spawn`'d child's stdout stream, and therefore
 * agetor's own event loop, from ever going idle. Cancelling the reader (not
 * just killing the direct child) releases *this process's* end of the pipe
 * regardless of what a grandchild still holds open on its side. The read
 * loop's `getReader()` call itself is inside its own try (previously it sat
 * outside — a throw there was an unhandled rejection); every `await` in that
 * loop is covered by the same try/catch, which degrades to a silent no-op
 * on any stream error rather than rejecting into the void (the `exited`
 * handler already settles any pending calls independently). On a clean
 * `done` (the child closed stdout normally), a non-empty residual `buf` —
 * the tail of a reply that never got its own trailing newline — is run
 * through the same dispatch path before the loop exits, instead of being
 * silently discarded.
 *
 * Stays a leaf like every other discoverer here: no import of db.ts,
 * agents.ts, or any other process-spawning helper module — see the
 * module-level "stay a leaf" note on `discoverFx` below.
 */
async function discoverCodex(env?: Record<string, string>, bin?: string): Promise<DiscoveredModel[]> {
  const timeoutMs = codexProbeTimeoutMs;

  // Resolve against the rehydrated PATH explicitly — Bun.spawn (and the
  // implicit lookup inside it) uses Bun's startup PATH cache, which on a
  // packaged .app is launchd's minimal set. See agent-status.ts for the
  // full story. An explicit `bin` (a harness's own resolved binary path)
  // wins outright, same as `discoverFx`.
  let resolvedBin: string;
  if (bin !== undefined) {
    resolvedBin = bin;
  } else {
    const fallback = process.env.AGETOR_CODEX_BIN ?? "codex";
    resolvedBin = Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
  }

  let proc: Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn([resolvedBin, "app-server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  } catch {
    return [];
  }

  // `settled` flips true the moment we know no further response is coming
  // (child exited, or our own timeout fired) — every pending/future `call()`
  // resolves to `undefined` from that point on instead of hanging.
  let settled = false;
  let killed = false;
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    try { proc.kill(); } catch { /* already exited */ }
  };

  let nextId = 1;
  const pending = new Map<number, (msg: unknown) => void>();
  const settleAllPending = (): void => {
    settled = true;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  };

  // The child dying before it answered a pending request must unblock that
  // request's promise rather than hang until the timeout fires — this is
  // what makes a stub like `/bin/echo app-server` (which prints "app-server"
  // and exits at once) resolve `[]` promptly.
  proc.exited.then(settleAllPending).catch(settleAllPending);

  const timer = setTimeout(() => {
    timedOut = true;
    settleAllPending();
    kill();
  }, timeoutMs);

  // Parse one already-newline-stripped line as a JSON-RPC message and
  // resolve whichever pending call's numeric `id` it matches. A message with
  // no numeric `id` — an unsolicited notification — or one whose `id`
  // doesn't match any pending call is silently ignored. An unparsable line
  // is skipped, not fatal. Shared by the read loop's newline-split path and
  // its end-of-stream residual-buffer flush (finding: a reply lacking a
  // trailing newline used to be discarded outright).
  const dispatchLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const id = (msg as { id?: unknown }).id;
    if (typeof id !== "number") return;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(msg);
    }
  };

  // Background read loop: buffer stdout, split on newlines, dispatch each
  // complete line via `dispatchLine`. `reader` is assigned here (not
  // declared here) — see the enclosing function's leak-safety doc above for
  // why it's hoisted to that outer scope.
  void (async () => {
    try {
      reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (buf.trim().length > 0) dispatchLine(buf);
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          dispatchLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      /* stream error — the `exited` handler above still settles any pending calls */
    }
  })();

  const send = (obj: unknown): void => {
    try {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
      proc.stdin.flush();
    } catch {
      // Child's stdin already closed (e.g. the `/bin/echo app-server` stub,
      // which exits immediately) — the caller learns "no response coming"
      // via the `exited`/timeout settlement above, not via this throwing.
    }
  };

  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve) => {
      if (settled) {
        resolve(undefined);
        return;
      }
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params });
  };

  try {
    const initMsg = (await call("initialize", {
      clientInfo: { name: "agetor", title: "Agetor", version: pkg.version },
    })) as { result?: unknown; error?: unknown } | undefined;
    if (!initMsg || initMsg.error) return [];

    notify("initialized", {});

    let allData: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {};
      const listMsg = (await call("model/list", params)) as { result?: unknown; error?: unknown } | undefined;
      if (!listMsg || listMsg.error) break;
      const result = listMsg.result;
      if (!result || typeof result !== "object") break;
      const data = (result as { data?: unknown }).data;
      if (Array.isArray(data)) allData = allData.concat(data);
      const nextCursor = (result as { nextCursor?: unknown }).nextCursor;
      if (typeof nextCursor === "string" && nextCursor.length > 0) {
        cursor = nextCursor;
      } else {
        break;
      }
    }
    // Timeout trumps partial data — see the doc comment above.
    if (timedOut) return [];
    return parseCodexModelList({ data: allData });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    kill();
    try { void reader?.cancel(); } catch { /* already released/cancelled */ }
  }
}

/**
 * claude-code intentionally has no programmatic model-list command (open
 * feature request at the time of writing). Returning an empty list keeps the
 * UI on the hardcoded AGENT_OPTIONS, which is the only source of truth that
 * works today.
 */
async function discoverClaude(): Promise<DiscoveredModel[]> {
  return [];
}

/**
 * Gemini CLI has no documented programmatic model-list command either
 * (checked `gemini --help` on CLI 0.54.0 — no such flag/subcommand exists).
 * Same treatment as claude: empty list, UI stays on the hardcoded
 * AGENT_OPTIONS.gemini.
 */
async function discoverGemini(): Promise<DiscoveredModel[]> {
  return [];
}

/**
 * Parse `fx models --json` output. Unlike codex/cursor (whose CLI output
 * format isn't formally specified, hence the loose line-heuristic parsers
 * above), fx's shape here IS known precisely — spike-verified against the
 * real 0.0.6 binary: exactly one JSON object on stdout,
 * `{kind:"models", count, shown_count, more_count, private_models_hidden,
 * ids: string[]}`. `ids` is the complete catalog *for whatever account the
 * probe's env resolves to* (`shown_count === count`; no pagination flag
 * exists, `--all` is rejected) — the count itself is account-scoped, not a
 * fixed Gateway-wide number: an empty `HOME` sees 230 ids
 * (`private_models_hidden: true`, every flagship present); a reference
 * `fx login` account sees 158 ids (`private_models_hidden: false`), a strict
 * subset missing exactly the premium tiers — measured against fx 0.0.6,
 * 2026-08-27. We only trust `ids`; any other shape (non-JSON,
 * missing/malformed `ids`, non-string entries) yields an empty list rather
 * than throwing — discovery is best-effort, never a hard dependency for the
 * picker. Ids are deduped (same `seen`-Set convention as
 * `parseCodexModelList`/`parseCursorModels` above) — a repeated id in the
 * catalog would otherwise surface as a duplicate React key in the model
 * picker.
 *
 * Re-measured against fx 0.0.7 (build cef08aa0f178, full 0.0.6→0.0.7 source
 * diff, 2026-08-31): the `models --json` shape is unchanged. The
 * unauthenticated (empty-`HOME`) catalog grew from 230 to 234 ids, still
 * `private_models_hidden: true`; the reference signed-in (158-id) account's
 * view could not be re-measured this pass — the local `fx login` token had
 * expired, so there was no live authenticated account to probe.
 */
function parseFxModels(stdout: string): DiscoveredModel[] {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { ids?: unknown }).ids)) {
      return [];
    }
    const out: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const id of (parsed as { ids: unknown[] }).ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `fx models --json` is spike-verified (binary v0.0.6, measured 2026-08-27)
 * to run with zero filesystem writes regardless of auth state — an empty
 * `HOME` stays empty after the probe, so discovery itself never needs
 * `fx login` and never writes anything, unauth or auth. But it DOES *read*
 * `$HOME`'s credentials, and the catalog it returns back is account-scoped,
 * not Gateway-wide: an empty `HOME` sees 230 ids (every flagship, including
 * the premium tiers); a reference logged-in account sees 158 — a strict
 * subset missing exactly the premium tiers. Latency is 0.3–0.9 s either way,
 * well inside `runProbe`'s 3 s timeout.
 *
 * Re-measured against fx 0.0.7 (build cef08aa0f178, 2026-08-31): still zero
 * filesystem writes either way, and the unauth catalog grew to 234 ids
 * (still every flagship present); the 158-id signed-in reference could not
 * be re-checked this pass (expired local login token). New in 0.0.7 and
 * load-bearing for this account-scoping story: on an account whose login has
 * expired (`auth_expired: true`), a passive probe like this one does NOT
 * refresh the token — it silently falls back to the UNAUTHENTICATED catalog
 * rather than erroring or blocking, so a discovered list can quietly
 * over-show premium `catalogOnly` ids for a user whose session lapsed, until
 * they re-run `fx login`. There is no probe-side way to distinguish that
 * from a genuinely unauthenticated account; both read identically. The
 * pickers compensate for this at the merge layer: `mergeModelOptions`
 * (src/shared/model-options.ts) treats a harness whose `HarnessStatus.loggedIn
 * === false` as having no trustworthy discovered catalog, so `catalogOnly`
 * rows can't over-show from that degraded view.
 *
 * That account-scoping is exactly why `env` exists as a parameter here (and
 * threads through to `runProbe`): a harness with its own `HOME` override —
 * an additional-account fx harness — must be probed under *its own* env to
 * get *its own* account's catalog, not agetor's process env / the built-in
 * harness's account. Callers that omit `env` (the built-in fx harness, and
 * any caller that predates per-harness discovery) get exactly the prior
 * behavior: probed under agetor's own process env.
 *
 * The hardcoded `AGENT_OPTIONS.fx.models` stays the labeled/hinted curated
 * subset shown first in the picker; this discovered list merges with it the
 * same way the codex/cursor discovered lists merge with their own curated
 * arrays (nothing fx-specific to change on the UI side). No labels come back
 * from fx's CLI, so every discovered entry is `{id}` only — the picker falls
 * back to rendering the bare id, same as codex.
 */
/**
 * The default fx binary resolution — `AGETOR_FX_BIN ?? "fx"`, rehydrated
 * against `process.env.PATH` — used whenever a caller doesn't hand in an
 * explicit `bin` (see `discoverFx` below). Factored out so the "is this
 * target indistinguishable from the built-in/kind-level probe" checks in
 * `runRefresh`/`runRefreshHarnessTarget` can compare a target's `bin`
 * against this same computation instead of re-deriving it inline.
 */
function defaultFxBin(): string {
  const fallback = process.env.AGETOR_FX_BIN ?? "fx";
  return Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
}

/**
 * The default codex binary resolution — `AGETOR_CODEX_BIN ?? "codex"`,
 * rehydrated against `process.env.PATH` — the codex sibling of `defaultFxBin`
 * above, used by the same "is this target indistinguishable from the
 * built-in/kind-level probe" checks now that codex has joined the
 * per-harness discovery path (code-review finding #4).
 */
function defaultCodexBin(): string {
  const fallback = process.env.AGETOR_CODEX_BIN ?? "codex";
  return Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
}

async function discoverFx(env?: Record<string, string>, bin?: string): Promise<DiscoveredModel[]> {
  // Resolve exactly the way discoverCodex/discoverCursor do above:
  // rehydrated-PATH lookup only — no import of the sqlite-backed database
  // module (which opens+migrates the DB as an import-time side effect) and
  // no import of the process-spawning agents/harness-env module (whose
  // module chain registers fx's process signal handlers) — neither belongs
  // in a module whose whole contract is "best-effort, never a hard
  // dependency, never throws". The optional `env`/`bin` parameters are not
  // an exception to that: they're plain values the *caller* builds one
  // layer up (`env` from `harnessEnv(harness)`, `bin` from
  // `resolveBin(harness)` — both in `agents.ts`) and hands in, never a
  // harness object or a DB read performed here — this module stays a leaf,
  // callers pass resolved values in.
  //
  // `bin`, when given, is preferred outright over the `AGETOR_FX_BIN ?? "fx"`
  // fallback below — a harness's own configured `bin` (set by the user when
  // adding an alias, e.g. a second fx install) must win over agetor's
  // process-wide default, the same way every other harness kind's spawn
  // already resolves `harness.bin` first (see `resolveBin` in `agents.ts`).
  // Before this parameter existed, discovery silently ignored a harness's
  // `bin` and always probed the process-wide default binary regardless of
  // which harness was actually being refreshed.
  //
  // The whole body is wrapped below (try/catch → []) as a backstop: even a
  // future change here that starts throwing synchronously must still
  // degrade to an empty list, since `refreshDiscoveredModels` fans this out
  // alongside the other four discoverers and one throw must never strand
  // them all.
  try {
    const resolved = bin ?? defaultFxBin();
    // Confirm the binary actually resolves before spending a probe on it —
    // an unresolvable name (fx not installed) would otherwise just make
    // Bun.spawn throw inside runProbe, which is caught there too, but
    // bailing here skips the spawn attempt entirely and reads clearer as
    // "skipped". Same absolute-path/bare-name split for an explicit `bin` as
    // for the fallback: an absolute path (the only shape `harness.bin` can
    // ever hold — server.ts validates it) is checked with `existsSync`; a
    // bare name is resolved against PATH.
    const resolvable = isAbsolute(resolved)
      ? existsSync(resolved)
      : Bun.which(resolved, { PATH: process.env.PATH }) !== null;
    if (!resolvable) return [];
    const probe = await runProbe([resolved, "models", "--json"], env);
    if (!probe.ok || !probe.stdout) return [];
    return parseFxModels(probe.stdout);
  } catch {
    return [];
  }
}

/**
 * True when `target` is indistinguishable from the kind-level built-in probe
 * (`discoverFx()`/`discoverCodex()` with no args, per `target.kind`) — no env
 * override AND either no `bin` at all or a `bin` that resolves to exactly the
 * same binary the no-args call for that kind would pick. Used to decide
 * whether a per-harness probe can (a) reuse the kind-level result instead of
 * spawning the CLI a second time for an identical probe, and (b)
 * drift-correct the kind-level cache. A target with a *different* `bin` —
 * even with an empty `env` — is a different binary (and possibly a different
 * account), so it must never share either shortcut.
 *
 * Generalized from the fx-only `isBuiltinLikeFxTarget` when codex joined the
 * per-harness discovery path (code-review finding #4 on the GPT-6 Astra /
 * codex app-server discovery landing). It was never exported, so there's no
 * external caller/test to keep an alias for (grep confirms nothing else in
 * the repo references the old name) — renamed outright rather than aliased.
 */
function isBuiltinLikeTarget(target: HarnessTarget): boolean {
  if (Object.keys(target.env).length !== 0) return false;
  const kind = target.kind ?? "fx";
  const defaultBin = kind === "codex" ? defaultCodexBin() : defaultFxBin();
  return target.bin === undefined || target.bin === defaultBin;
}

/**
 * One harness to probe for its own account-scoped catalog — fx and codex are
 * the two kinds whose catalog varies per harness (`kind` defaults to `"fx"`
 * when omitted, so every caller/test written before codex joined this path —
 * `{ harnessId, env, bin }` with no `kind` field — keeps compiling and
 * behaving unchanged). `env` is the harness's spawn-env overrides (typically
 * a `HOME` override for an additional-account fx/cursor-style harness, or
 * `HOME`+`CODEX_HOME` for codex — mirroring `harnessEnv(harness)` one layer
 * up in `agents.ts`) — an empty object means "the built-in harness of this
 * kind, probe under agetor's own process env, same account as the kind-level
 * cache". `bin`, when given, is the harness's own resolved binary path
 * (mirroring `resolveBin(harness)` in `agents.ts` — the same resolver every
 * real spawn of that kind uses) — omitted, discovery falls back to that
 * kind's own `AGETOR_*_BIN ?? "<kind>"` default, same as before this field
 * existed.
 */
export interface HarnessTarget {
  harnessId: string;
  /** Defaults to `"fx"` when omitted — see the interface doc above. */
  kind?: "fx" | "codex";
  env: Record<string, string>;
  bin?: string;
}

/**
 * Pre-codex name for `HarnessTarget`, kept as a type alias (not renamed
 * outright) because it IS exported and imported by name elsewhere — e.g.
 * `agent-discovery.test.ts`'s `import { type FxHarnessTarget }` — so
 * dropping it would be a breaking rename for no behavior gain. Prefer
 * `HarnessTarget` in new code; both names describe the exact same shape.
 */
export type FxHarnessTarget = HarnessTarget;

const cache = new Map<AgentKind, DiscoveredModel[]>();
const harnessCache = new Map<string, DiscoveredModel[]>();
let ready = false;

/**
 * Serializes every `refreshDiscoveredModels` / `refreshFxHarnessModels` call
 * into a single FIFO queue. This replaces a previous `inflight` short-circuit
 * that handed a second concurrent caller the *first* call's already-in-flight
 * promise — silently dropping that second call's (possibly different)
 * `fxHarnesses` target list on the floor instead of ever probing it.
 *
 * `chain.then(run, run)` passes the same `run` function as both the
 * fulfilled- and rejected-path handler: a rejected prior run doesn't poison
 * the chain (the next enqueued run still fires — `run` ignores whatever
 * value/reason it's invoked with, since it takes no arguments), and each
 * caller's own returned promise is exactly `chain` at the moment of that
 * call, so it still resolves/rejects with *its own* run's outcome.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/**
 * Snapshot of discovered models per agent *kind*. Cached in-memory so
 * repeated API calls don't re-probe the CLI on every request. For fx
 * specifically this is the built-in harness's catalog only — an
 * additional-account fx harness (its own `HOME` override) has its own entry
 * in the harness-keyed cache instead, see `getHarnessDiscoveredModels`.
 */
export function getDiscoveredModels(agent: AgentKind): DiscoveredModel[] {
  return cache.get(agent) ?? [];
}

/**
 * Discovered models for one harness, keyed by harness id rather than kind.
 * `[]` for a harness that hasn't been probed yet — this includes every
 * non-fx/non-codex harness, since this cache only ever gets entries for the
 * two kinds whose catalog varies per-harness (fx always did; codex joined
 * via code-review finding #4).
 */
export function getHarnessDiscoveredModels(harnessId: string): DiscoveredModel[] {
  return harnessCache.get(harnessId) ?? [];
}

/**
 * A fresh snapshot object of every known harness's discovered models.
 * Callers get their own plain object each call, *and* their own copy of
 * each harness's array — `Object.fromEntries(harnessCache)` alone would
 * still hand out the same array *references* stored in the Map, so a caller
 * mutating a returned array would silently corrupt the live cache. Test-only
 * in practice (production reads go through `getHarnessDiscoveredModels`/
 * `getHarnessModelMap`), but the "never a live view" contract should hold
 * regardless of caller.
 */
export function getAllHarnessDiscoveredModels(): Record<string, DiscoveredModel[]> {
  const out: Record<string, DiscoveredModel[]> = {};
  for (const [harnessId, models] of harnessCache) {
    out[harnessId] = [...models];
  }
  return out;
}

/**
 * The bun-side twin of `discoveredEffortsFor` in `src/shared/model-options.ts`
 * (which serves the webview/CLI from the model lists those callers already
 * fetched over the API) — this one reads straight from this module's own
 * in-memory caches instead, for callers that live on this side of the
 * process (the orchestrator, `server.ts`'s PATCH guard). Looks in
 * `harnessCache.get(harnessId)` first when `harnessId` is given (fx and
 * codex are the only kinds whose catalog varies per harness — a `harnessId`
 * for any other kind simply won't have an entry there, so this is a
 * harmless miss), then falls back to `cache.get(kind)`. Returns the
 * matching model's `efforts` when that list is non-empty, else `null` (no
 * model arg, no matching
 * entry, or an entry with no discovered efforts all read the same way).
 * Callers pass this straight through as `supportedEfforts`'s third argument.
 */
export function getDiscoveredEfforts(
  kind: AgentKind,
  model: string | null,
  harnessId?: string | null,
): string[] | null {
  if (!model) return null;
  const fromHarness = harnessId ? harnessCache.get(harnessId)?.find((m) => m.id === model) : undefined;
  const entry = fromHarness ?? cache.get(kind)?.find((m) => m.id === model);
  if (entry?.efforts && entry.efforts.length > 0) return entry.efforts;
  return null;
}

/**
 * False until the first `refreshDiscoveredModels` call has fully settled
 * (success or failure), true forever after. Callers — e.g. a webview
 * boot-race retry — use this to tell "discovery hasn't run yet" apart from
 * "discovery ran and genuinely found nothing".
 */
export function isDiscoveryReady(): boolean {
  return ready;
}

/**
 * `opts.fxHarnesses` may be given as a plain array, or as a thunk returning
 * one — see `refreshDiscoveredModels`'s doc comment for why the thunk form
 * exists. The option key and type name both predate codex joining the
 * per-harness discovery path (code-review finding #4) and are kept as-is —
 * renaming them would churn every caller/test for no behavior gain — but the
 * targets they carry are `HarnessTarget`s now, so a target list built from
 * this option may include codex harnesses alongside fx ones.
 */
export type FxHarnessTargetsOption = HarnessTarget[] | (() => HarnessTarget[]);

async function runRefresh(opts?: { fxHarnesses?: FxHarnessTargetsOption }): Promise<void> {
  try {
    // Promise.allSettled, not Promise.all: every discoverer above is already
    // internally best-effort (probe failures resolve to []), but this is the
    // backstop against one of them throwing anyway (a stray import-time or
    // synchronous bug) — index.ts/headless.ts call `refreshAllModels()`
    // (model-discovery.ts, which wraps this function) as a bare
    // `void refreshAllModels()` at boot, so an unhandled rejection here
    // surfaces as an unhandled-rejection crash risk, and with Promise.all a
    // single rejection would strand every OTHER kind's cache (they'd never
    // get set, staying whatever they were before — empty on first boot)
    // even though only one kind actually failed.
    const results = await Promise.allSettled([
      discoverCodex(),
      discoverClaude(),
      discoverCursor(),
      discoverGemini(),
      discoverFx(),
    ]);
    const kinds: AgentKind[] = ["codex", "claude-code", "cursor", "gemini", "fx"];
    results.forEach((result, i) => {
      cache.set(kinds[i]!, result.status === "fulfilled" ? result.value : []);
    });

    // Resolve a thunk *here*, inside the enqueued run, not back at the
    // `refreshDiscoveredModels` call site — a caller (e.g. `refreshAllModels`,
    // which passes its `discoveryTargets` function directly) may enumerate a
    // harness list that changes between "this call was enqueued" and "this
    // call actually runs" (a concurrent create/delete while a sweep is
    // queued behind another in-flight run). Resolving late is what keeps a
    // queued sweep from pruning a harness that was created after the sweep
    // was enqueued but before it started running.
    const targetsOpt = opts?.fxHarnesses;
    const targets = typeof targetsOpt === "function" ? targetsOpt() : targetsOpt;
    if (targets) {
      // Reuse the kind-level result computed just above for any target
      // that's indistinguishable from that probe (no env override, and
      // either no `bin` or a `bin` matching that kind's default resolution)
      // instead of spawning the CLI a second time for what would be an
      // identical probe. Both fx and codex apply now (code-review finding
      // #4) — dispatched by `target.kind` (defaults to `"fx"`).
      const builtInFx = cache.get("fx") ?? [];
      const builtInCodex = cache.get("codex") ?? [];
      const targetResults = await Promise.allSettled(
        targets.map((target) => {
          const kind = target.kind ?? "fx";
          if (isBuiltinLikeTarget(target)) {
            return Promise.resolve(kind === "codex" ? builtInCodex : builtInFx);
          }
          return kind === "codex" ? discoverCodex(target.env, target.bin) : discoverFx(target.env, target.bin);
        }),
      );
      const seen = new Set<string>();
      targets.forEach((target, i) => {
        const result = targetResults[i]!;
        harnessCache.set(target.harnessId, result.status === "fulfilled" ? result.value : []);
        seen.add(target.harnessId);
      });
      // Prune any harness that isn't in this call's target list — a deleted
      // harness must not linger forever. A call made with no `opts.fxHarnesses`
      // at all never reaches this branch, so it never touches — let alone
      // prunes — harnessCache.
      for (const harnessId of [...harnessCache.keys()]) {
        if (!seen.has(harnessId)) harnessCache.delete(harnessId);
      }
    }
  } finally {
    ready = true;
  }
}

/**
 * Refreshes the kind-level cache (all five agent kinds, as before) and, when
 * `opts.fxHarnesses` is given, the harness-level fx/codex cache too. Calls
 * are serialized through `enqueue` (see its comment) so two overlapping
 * calls with different `fxHarnesses` target lists can't drop either one's
 * targets.
 *
 * `opts.fxHarnesses` accepts a thunk (`() => HarnessTarget[]`) as well as
 * a plain array — `runRefresh` resolves it only once its turn in the queue
 * actually starts, so a target list built from a live DB read (as
 * `refreshAllModels`'s `discoveryTargets` is) reflects the harness set at
 * *run* time, not at the moment this function was called and possibly left
 * waiting behind another in-flight refresh.
 */
export function refreshDiscoveredModels(opts?: { fxHarnesses?: FxHarnessTargetsOption }): Promise<void> {
  return enqueue(() => runRefresh(opts));
}

/**
 * Probes one harness target (fx or codex, per `target.kind`) and updates
 * both the per-harness cache and — when the target is indistinguishable
 * from the kind-level built-in probe — the kind-level cache too. Kind-neutral
 * successor to the fx-only `runRefreshFxHarnessModels` (code-review finding
 * #4); the fx-named `refreshFxHarnessModels` export below simply forwards to
 * this.
 */
async function runRefreshHarnessTarget(target: HarnessTarget): Promise<DiscoveredModel[]> {
  const kind = target.kind ?? "fx";
  const builtinLike = isBuiltinLikeTarget(target);
  let models: DiscoveredModel[];
  try {
    if (kind === "codex") {
      models = builtinLike ? await discoverCodex() : await discoverCodex(target.env, target.bin);
    } else {
      models = builtinLike ? await discoverFx() : await discoverFx(target.env, target.bin);
    }
  } catch {
    models = [];
  }
  harnessCache.set(target.harnessId, models);
  // A target indistinguishable from the built-in kind-level probe (empty
  // env, no distinguishing bin — see `isBuiltinLikeTarget`) drift-corrects
  // the kind-level cache too — otherwise a manual refresh of just the
  // built-in harness would update harnessCache but leave
  // `getDiscoveredModels(kind)` (still read by every non-harness-aware
  // caller) stale until the next full sweep. A target with its own `bin`
  // (a distinct binary/account even with an empty env) must NOT drift-
  // correct the shared kind-level cache — that would blend a harness
  // alias's catalog into the built-in's.
  if (builtinLike) {
    cache.set(kind, models);
  }
  return models;
}

/**
 * Probes exactly one harness (fx or codex, per `target.kind`) — through the
 * same serialized queue as `refreshDiscoveredModels` — and returns its
 * discovered models. Never throws: a probe failure resolves to `[]`, the
 * same contract every other discoverer in this module already follows.
 * Kind-neutral name introduced alongside `HarnessTarget` (code-review
 * finding #4); `refreshFxHarnessModels` below is the pre-codex fx-only name,
 * kept as a thin forwarding export.
 */
export function refreshHarnessTarget(target: HarnessTarget): Promise<DiscoveredModel[]> {
  return enqueue(() => runRefreshHarnessTarget(target));
}

/**
 * Pre-codex name for `refreshHarnessTarget`, kept exported (per code-review
 * finding #4) because it's imported by name elsewhere — e.g.
 * `agent-discovery.test.ts`. Forwards verbatim; `target.kind` still defaults
 * to `"fx"` when omitted, so every existing call site behaves identically.
 * Prefer `refreshHarnessTarget` in new code — it works for both kinds.
 */
export function refreshFxHarnessModels(target: FxHarnessTarget): Promise<DiscoveredModel[]> {
  return refreshHarnessTarget(target);
}

async function runRefreshKind(kind: AgentKind): Promise<void> {
  let models: DiscoveredModel[];
  try {
    switch (kind) {
      case "codex":
        models = await discoverCodex();
        break;
      case "claude-code":
        models = await discoverClaude();
        break;
      case "cursor":
        models = await discoverCursor();
        break;
      case "gemini":
        models = await discoverGemini();
        break;
      case "fx":
        models = await discoverFx();
        break;
    }
  } catch {
    models = [];
  }
  cache.set(kind, models);
}

/**
 * Refreshes exactly one agent kind's kind-level cache — cheaper than the
 * five-kind `refreshDiscoveredModels` sweep when only one harness's
 * availability/config changed (see model-discovery.ts's
 * `refreshHarnessModels`, which routes every non-fx/non-codex harness edit
 * here instead of a full sweep). Runs through the same serialized queue as
 * `refreshDiscoveredModels`/`refreshHarnessTarget` so it can't race a
 * concurrent full sweep or per-harness probe.
 *
 * `kind: "fx"` / `kind: "codex"` only refresh the kind-level entry for that
 * kind (the built-in account's catalog, as exposed by
 * `getDiscoveredModels(kind)` and the byte-compatible `GET /agent-models`
 * endpoint) — neither ever touches a per-harness cache entry. fx's and
 * codex's own harness-scoped catalogs are always refreshed through
 * `refreshHarnessTarget` instead (model-discovery.ts's
 * `refreshHarnessModels` routes every fx or codex harness, built-in or
 * alias, there rather than here), since those two kinds' catalogs vary per
 * harness while every other kind's is shared.
 */
export function refreshKindModels(kind: AgentKind): Promise<void> {
  return enqueue(() => runRefreshKind(kind));
}

/**
 * Drops one harness's entry from the per-harness discovered-models cache.
 * No probe, no queue hop — cheap and synchronous. Used when a harness is
 * deleted: there's nothing left to refresh, only stale cache state to clear
 * so it doesn't linger in `getAllHarnessDiscoveredModels()`/
 * `getHarnessDiscoveredModels()` forever (the alternative, a full
 * `refreshDiscoveredModels` sweep just to exercise its own pruning-by-
 * absence logic, would re-probe every other kind and every other fx harness
 * for no reason).
 */
export function pruneHarnessDiscovery(harnessId: string): void {
  harnessCache.delete(harnessId);
}

/**
 * Test seam for `discoverCodex`'s probe budget — `null` restores the 5s
 * default, any other value overrides it. Read fresh at the start of every
 * `discoverCodex` call (`codexProbeTimeoutMs`), so a test can drive the
 * timeout path (code-review finding #2) in well under a second instead of
 * eating the real 5s budget.
 */
function setCodexProbeTimeoutMs(ms: number | null): void {
  codexProbeTimeoutMs = ms ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS;
}

/**
 * Clears both caches, the serialization chain, the `ready` flag, and the
 * codex probe-timeout override. Tests that assert on cache contents or
 * `isDiscoveryReady()` call this first so module-level state from an earlier
 * test in the same file can't leak in — including a `setCodexProbeTimeoutMs`
 * override a prior test forgot to restore.
 */
function resetForTests(): void {
  cache.clear();
  harnessCache.clear();
  chain = Promise.resolve();
  ready = false;
  codexProbeTimeoutMs = DEFAULT_CODEX_PROBE_TIMEOUT_MS;
}

// Exposed for tests that want to feed in synthetic CLI output, drive the
// codex probe-timeout path, and reset module-level state between tests.
export const __testing = {
  parseCodexModelList,
  parseCursorModels,
  parseFxModels,
  resetForTests,
  setCodexProbeTimeoutMs,
};
