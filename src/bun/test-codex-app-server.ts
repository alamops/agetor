/**
 * Test-only helper: plant a fake `codex` binary whose `app-server` subcommand
 * speaks just enough of the newline-delimited JSON-RPC protocol that
 * `discoverCodex` (`src/bun/agent-discovery.ts`) uses — `initialize`,
 * the `initialized` notification, and `model/list` (with `nextCursor`
 * pagination) — answering each request with the request's own `id`, the way
 * the real binary does. Everything else on stdin is ignored. The script stays
 * alive until stdin closes (the prober kills it), so it also models a server
 * that keeps running after answering.
 *
 * Shared by `agent-discovery.test.ts`, `model-discovery.test.ts` and the
 * orchestrator discovered-efforts test so they don't each hand-roll a stub.
 * Not imported by production code.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FakeCodexModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  /** Reported as `supportedReasoningEfforts[].reasoningEffort`, in this order. */
  efforts?: string[];
}

export interface FakeCodexAppServerOptions {
  /**
   * One entry per `model/list` page. The Nth `model/list` request receives
   * pages[N-1]; every page but the last carries a `nextCursor`. A request past
   * the last page repeats the last page with `nextCursor: null`.
   */
  pages: FakeCodexModel[][];
  /** Answer every `model/list` with a JSON-RPC error instead of a result. */
  error?: boolean;
  /** Directory to write into (a fresh mkdtemp dir by default). */
  dir?: string;
}

function toWire(m: FakeCodexModel): Record<string, unknown> {
  return {
    id: m.id,
    model: m.id,
    displayName: m.displayName ?? m.id,
    description: "",
    hidden: m.hidden ?? false,
    isDefault: false,
    defaultReasoningEffort: m.efforts?.[0] ?? null,
    supportedReasoningEfforts: (m.efforts ?? []).map((e) => ({ reasoningEffort: e, description: "" })),
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    inputModalities: ["text"],
  };
}

/**
 * Write the stub and return its absolute path — point `AGETOR_CODEX_BIN` at it.
 * The JSON payloads are baked into the script as single-quoted shell strings,
 * so a model id/label must not contain a single quote.
 */
export function plantFakeCodexAppServer(opts: FakeCodexAppServerOptions): string {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), "agetor-fake-codex-appserver-"));
  const pages = opts.pages.length > 0 ? opts.pages : [[]];
  const pageJson = pages.map((models, i) => {
    const last = i === pages.length - 1;
    const body = JSON.stringify({ data: models.map(toWire), nextCursor: last ? null : `cursor-${i + 1}` });
    if (body.includes("'")) throw new Error("plantFakeCodexAppServer: single quotes are not supported in model payloads");
    return body;
  });
  // The shell script answers requests as they arrive: extract the numeric id,
  // dispatch on the method, printf the response. `n` counts model/list calls
  // to select the page. `$'…'` is avoided for POSIX sh portability.
  const cases = pageJson
    .map((json, i) => `    if [ "$n" -eq ${i + 1} ]; then printf '{"id":%s,"result":%s}\\n' "$id" '${json}'; fi`)
    .join("\n");
  const lastJson = pageJson[pageJson.length - 1]!;
  const script = `#!/bin/sh
# fake codex app-server (test stub) — see src/bun/test-codex-app-server.ts
if [ "$1" != "app-server" ]; then echo "fake codex: unsupported args: $*" >&2; exit 2; fi
n=0
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\\n' "$id" ;;
    *'"method":"model/list"'*)
      n=$((n+1))
${opts.error ? `      printf '{"id":%s,"error":{"code":-32600,"message":"fake: model/list failed"}}\\n' "$id"` : `${cases}
      if [ "$n" -gt ${pageJson.length} ]; then printf '{"id":%s,"result":%s}\\n' "$id" '${lastJson}'; fi`}
      ;;
  esac
done
`;
  const bin = path.join(dir, "codex");
  writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}
