// An artificially SLOW, in-process smart-HTTP git server, for the two
// `e2e/clone-providers.spec.ts` tests that need to actually OBSERVE a clone
// in progress (docs/plans/clone-repository-all-providers.md Addendum A) —
// the progress-row-visible test and the Cancel test.
//
// `src/bun/clone-test-util.ts`'s own `startAuthGitServer` (used by
// `clone.test.ts`'s auth-retry/redirect integration tests) has a `delayMs`
// option too, but it delays the RESPONSE START, not the transfer: once
// `git-http-backend`'s CGI subprocess exits, its whole stdout is already
// fully computed, so a "wait, then send it all in one shot" response
// transfers over loopback in a handful of milliseconds no matter how long
// the wait was — nowhere near "long enough to click Cancel", and nowhere
// near long enough for the dialog's live phase text (`git clone --progress`'s
// `Receiving objects: NN%` sideband messages, forwarded through
// `src/bun/clone.ts`'s `readCloneStderrStream`/`parseCloneProgress`) to sit
// on screen for more than a single Playwright poll tick.
//
// This module PORTS the CGI-invocation plumbing (same env, same
// header/status parsing) from that file's `runGitHttpBackendCgi`, but then
// drips the already-computed response body for the ONE request that
// actually carries pack data (the `git-upload-pack` POST) back to the client
// in `chunkCount` pieces, `transferDelayMs / chunkCount` apart, via a
// `ReadableStream`. That's a real, paced HTTP transfer the git client on the
// other end (the agetor headless backend's own `git clone` subprocess) reads
// incrementally — so the sideband progress messages embedded in those bytes
// arrive spread out over real wall-clock time instead of in one
// instantaneous burst, which is what makes the phase text
// (`src/mainview/components/kanban/CloneProjectDialog.tsx`'s
// `CLONE_PHASE_LABEL`) actually visible mid-transition and gives a
// multi-second window to click Cancel before the clone finishes on its own.
//
// Hosted IN-PROCESS — an ordinary `Bun.serve` call, made directly from the
// spec file at plain module top level — rather than spawned as a separate
// subprocess. `e2e/github-stub.ts`'s own doc comment already establishes
// that Playwright specs in this repo run under Bun (`bun
// node_modules/@playwright/test/cli.js test`), so `Bun.serve` is available
// right here, and it binds its (ephemeral) port SYNCHRONOUSLY —
// `server.port` is populated the instant `Bun.serve` returns, no `await`
// needed. That sidesteps the exact problem a standalone subprocess would
// otherwise create: `e2e/clone-providers.spec.ts` needs a concrete
// clone-source URL to hand `test.use({ backendEnv: {
// AGETOR_CLONE_SOURCE_OVERRIDE } })` at module-evaluation time (synchronous —
// see that file's own module-scope setup, and `e2e/clone-project.spec.ts`'s
// identical rationale for its `SOURCE_REPO_DIR`), and a spawned child
// process's ephemeral port could only be learned back asynchronously
// (reading its stdout, polling a health check, …) for no benefit here:
// nothing about this fixture needs process-level isolation from the
// Playwright test runner the way the real headless `agetor` backend does
// (which is why `e2e/fixtures.ts` DOES spawn that one as a genuine
// subprocess — it's the production server under test).
import { spawnSync } from "node:child_process";
import path from "node:path";

/** How many pieces the paced response body is cut into, and how long
 *  between each — see `startSlowGitServer`'s doc comment. */
export interface SlowGitServerOptions {
  /** Total wall-clock time (ms) the `git-upload-pack` POST's (already fully
   *  computed) response body is deliberately spread over. Default 4000 —
   *  long enough to reliably click Cancel and to observe at least one
   *  non-"Starting…" phase transition, short enough not to make the spec
   *  file slow. The `info/refs` ref-discovery GET is deliberately never
   *  paced — its body is a handful of ref advertisements, not
   *  progress-worthy, and pacing it would only add dead time before the
   *  interesting phase starts. */
  transferDelayMs?: number;
  /** How many pieces the paced body is cut into. Default 20 — enough
   *  granularity that the sideband progress messages embedded in the body
   *  (computed once, up front, by the real `git-http-backend`/`git
   *  upload-pack` subprocess) land in more than one paced piece, instead of
   *  all arriving in the very first chunk. */
  chunkCount?: number;
}

export interface SlowGitServer {
  /** `http://127.0.0.1:<port>` — the caller appends `/repo.git` (or
   *  whatever `makeBareSourceRepo`, from `src/bun/clone-test-util.ts`, named
   *  the bare repo under `projectRoot`). */
  url: string;
  port: number;
  stop: () => void;
}

/** Ported from `src/bun/clone-test-util.ts`'s `runGitHttpBackendCgi` —
 *  spawns `git-http-backend` as CGI against `projectRoot` and returns its
 *  raw status/headers/body, WITHOUT building a `Response` yet: unlike that
 *  function, the caller below (`startSlowGitServer`'s `fetch` handler)
 *  decides whether this particular request's body gets paced. */
// Deliberately no explicit return-type annotation on `body` — writing the
// obvious `Promise<{ …; body: Buffer }>` widens it to the default
// `Buffer<ArrayBufferLike>`, which (structurally, via `Uint8Array`'s
// `buffer: ArrayBufferLike` field) is NOT assignable to DOM's
// `BodyInit`/`ArrayBufferView` — those default their own buffer type
// parameter to the narrower `ArrayBuffer`. Leaving this uninferred keeps
// `body`'s inferred type at the narrower `Buffer<ArrayBuffer>`
// `Buffer.from`/`.subarray()` actually produce, which DOES satisfy
// `BodyInit` — mirrors why `clone-test-util.ts`'s own (unannotated)
// `bodyBytes` local never hits this.
async function invokeGitHttpBackendCgi(req: Request, url: URL, projectRoot: string, port: number) {
  const execPathProc = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  const execPath = (execPathProc.stdout ?? "").trim();
  const backend = path.join(execPath, "git-http-backend");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    SERVER_PROTOCOL: "HTTP/1.1",
    SERVER_SOFTWARE: "agetor-e2e-slow-git",
    GATEWAY_INTERFACE: "CGI/1.1",
    REMOTE_ADDR: "127.0.0.1",
    SERVER_NAME: "127.0.0.1",
    SERVER_PORT: String(port),
  };
  const contentType = req.headers.get("content-type");
  if (contentType) env.CONTENT_TYPE = contentType;
  const contentLength = req.headers.get("content-length");
  if (contentLength) env.CONTENT_LENGTH = contentLength;
  for (const [key, value] of req.headers.entries()) {
    const cgiKey = "HTTP_" + key.toUpperCase().replace(/-/g, "_");
    if (cgiKey === "HTTP_CONTENT_TYPE" || cgiKey === "HTTP_CONTENT_LENGTH") continue;
    env[cgiKey] = value;
  }

  const bodyBuf = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
  const proc = Bun.spawn({ cmd: [backend], env, stdin: bodyBuf ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;

  const buf = Buffer.from(stdout);
  const sep = buf.indexOf("\r\n\r\n");
  const headerSepLf = buf.indexOf("\n\n");
  const headerLen = sep !== -1 ? sep + 4 : headerSepLf !== -1 ? headerSepLf + 2 : 0;
  const headerText = headerLen ? buf.subarray(0, headerLen).toString("utf8") : "";
  const bodyBytes = headerLen ? buf.subarray(headerLen) : buf;

  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    if (!line) continue;
    const statusMatch = line.match(/^Status:\s*(\d+)/i);
    if (statusMatch) {
      status = Number(statusMatch[1]);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) headers.append(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim());
  }
  return { status, headers, body: Buffer.from(bodyBytes) };
}

/** Splits `body` into up to `chunkCount` roughly-equal pieces (the last
 *  absorbs any remainder) and returns a `ReadableStream` that enqueues one
 *  piece every `perChunkMs`, closing after the last — a deterministic,
 *  artificially paced body transfer. Never enqueues a zero-length piece for
 *  a non-empty body; an empty body yields a stream that closes immediately. */
function pacedBodyStream(body: Buffer, chunkCount: number, perChunkMs: number): ReadableStream<Uint8Array> {
  const pieces: Buffer[] = [];
  if (body.length > 0) {
    const pieceSize = Math.max(1, Math.ceil(body.length / chunkCount));
    for (let offset = 0; offset < body.length; offset += pieceSize) {
      pieces.push(body.subarray(offset, offset + pieceSize));
    }
  }
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= pieces.length) {
        controller.close();
        return;
      }
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, perChunkMs));
      controller.enqueue(new Uint8Array(pieces[index]!));
      index++;
    },
  });
}

/** Whether `pathname` names the one request in the smart-HTTP clone
 *  handshake that actually carries pack data worth pacing — the
 *  `git-upload-pack` POST. The `info/refs` GET's body is just ref
 *  advertisements; pacing it would only add dead time before the
 *  interesting phase (a click on Cancel is equally possible during either
 *  request, since both are real, separate HTTP round-trips). */
function isPackTransferRequest(pathname: string): boolean {
  return pathname.endsWith("/git-upload-pack");
}

/**
 * Starts the paced smart-HTTP git server described in this module's doc
 * comment, on an ephemeral port bound SYNCHRONOUSLY by `Bun.serve` —
 * `.port`/`.url` are available the instant this function returns, no
 * `await` required, which is what lets a spec call this at plain
 * module-top-level and feed the result straight into `test.use({
 * backendEnv: { AGETOR_CLONE_SOURCE_OVERRIDE } })`.
 *
 * `projectRoot` must already contain a bare repo at `<projectRoot>/repo.git`
 * (e.g. via `makeBareSourceRepo` from `src/bun/clone-test-util.ts`) —
 * this module only hosts it, it doesn't create it.
 */
export function startSlowGitServer(projectRoot: string, opts: SlowGitServerOptions = {}): SlowGitServer {
  const transferDelayMs = opts.transferDelayMs ?? 4000;
  const chunkCount = opts.chunkCount ?? 20;
  const perChunkMs = Math.max(1, Math.round(transferDelayMs / chunkCount));
  // Mirrors clone-test-util.ts's `startAuthGitServer`'s `portBox` trick —
  // `fetch` only ever reads `portBox.port`, filled in right after
  // `Bun.serve` returns and before any request can possibly arrive, so this
  // sidesteps referencing `server` from inside its own `fetch` callback.
  const portBox = { port: 0 };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const { status, headers, body } = await invokeGitHttpBackendCgi(req, url, projectRoot, portBox.port);
      if (isPackTransferRequest(url.pathname) && body.length > 0) {
        return new Response(pacedBodyStream(body, chunkCount, perChunkMs), { status, headers });
      }
      return new Response(body, { status, headers });
    },
  });
  const port = server.port ?? 0;
  portBox.port = port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () => server.stop(true),
  };
}
