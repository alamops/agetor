// Client for the Swift login-item helper (docs/plans/always-on-host.md §3.3).
//
// "Run Agetor in the background" is a macOS login item registered through
// SMAppService, and SMAppService can only be driven from inside the signed app
// bundle. The bundle therefore ships a tiny Swift binary,
// `Contents/MacOS/agetor-login-item` (native/login-item/main.swift), that wraps
// it: `info`, `status`, `register`, `unregister`, `reregister`, `open-settings`
// (plus `run`, which the LaunchAgent uses and this client never calls). Each
// command prints ONE JSON line on stdout and exits 0 whenever it handled the
// command — a failed `register` is still exit 0 with `ok:false` and an `error`
// — so a non-zero exit, a timeout or output that is not the pinned shape is a
// broken helper, not a refused request, and surfaces as a thrown `HelperError`.
//
// This module deliberately imports nothing from `db.ts` (which opens SQLite on
// import) so the `agetor` CLI can query and drive the helper offline, the same
// reason `core-creds.ts` stays db-free. The data dir is resolved lazily through
// `core-creds.ts`'s `resolveDataDir`, never captured at import time.
//
// Test seam: `AGETOR_FAKE_LOGIN_ITEM=1` (checked at call time of
// `loginItemHelper`) swaps the real binary for a file-backed fake at
// `<dataDir>/fake-login-item.json`, shaped
// `{ registration, info?, calls: string[], failNext? }`. Every method appends its
// name to `calls` and persists the new state, so a spec in another process can
// observe what the app asked for and seed a starting registration or `info`
// override. `failNext` injects one failure for the next call of `command`.

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { coreSpawn } from "./core-spawn.ts";
import { resolveDataDir } from "./core-creds.ts";
import type { BackgroundRegistration } from "../shared/types.ts";

export interface HelperInfo {
  bundlePath: string;
  bundleId: string;
  channel: string;
  /** LaunchAgent label for this channel. The Swift helper prints `null` for
   *  `label` and `plist` when it runs from a dev build with no channel mapping;
   *  the client normalizes both to `""` so callers never branch on null. */
  label: string;
  plist: string;
  signed: boolean;
  teamId: string | null;
  location: "applications" | "user-applications" | "translocated" | "volume" | "other";
}

export interface HelperResult {
  ok: boolean;
  registration: BackgroundRegistration;
  error?: { domain: string; code: number; message: string };
}

export interface LoginItemHelper {
  info(): Promise<HelperInfo>;
  status(): Promise<BackgroundRegistration>;
  register(): Promise<HelperResult>;
  unregister(): Promise<HelperResult>;
  reregister(): Promise<HelperResult>;
  openSettings(): Promise<void>;
}

/** A helper that could not produce a usable answer: it failed to start, timed
 *  out, exited non-zero, or printed something other than the pinned JSON. */
export class HelperError extends Error {
  readonly command: string;
  /** Process exit code, or `null` when it never exited normally (timeout,
   *  spawn failure). */
  readonly exitCode: number | null;
  /** Trimmed, capped stderr. */
  readonly stderr: string;
  constructor(command: string, exitCode: number | null, stderr: string, message: string) {
    super(message);
    this.name = "HelperError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const HELPER_BINARY = "agetor-login-item";
const HELPER_TIMEOUT_MS = 15_000;
const STDERR_CAP = 2000;
const FAKE_FILENAME = "fake-login-item.json";

const REGISTRATIONS: readonly BackgroundRegistration[] = [
  "enabled",
  "requiresApproval",
  "notRegistered",
  "notFound",
];
const LOCATIONS: readonly HelperInfo["location"][] = [
  "applications",
  "user-applications",
  "translocated",
  "volume",
  "other",
];

/** Mutable only through `__testing`, so a unit test can shorten the timeout. */
let timeoutMs = HELPER_TIMEOUT_MS;

/**
 * Where the helper binary is, or `null` when there is none to run.
 *
 * Order: `AGETOR_LOGIN_ITEM_HELPER` (a dev/test override — when it is set but
 * the file is missing the answer is `null`, NOT a fall-through, so a typo in an
 * override never quietly runs a different binary), then the sibling of the
 * running executable (the packaged app's bun lives in `Contents/MacOS` next to
 * the helper), then — only for the CLI, whose own binary lives elsewhere — the
 * two installed-app locations.
 */
export function resolveLoginItemHelperPath(opts: { forCli?: boolean } = {}): string | null {
  const override = process.env.AGETOR_LOGIN_ITEM_HELPER;
  if (override) return existsSync(override) ? override : null;
  const sibling = path.join(path.dirname(process.execPath), HELPER_BINARY);
  if (existsSync(sibling)) return sibling;
  if (opts.forCli) {
    const rel = path.join("Applications", "Agetor.app", "Contents", "MacOS", HELPER_BINARY);
    const candidates = [path.join("/", rel), path.join(homedir(), rel)];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The helper client for this process, or `null` when no helper is available
 * (source runs, non-darwin, an unbundled install). With `AGETOR_FAKE_LOGIN_ITEM=1`
 * it is always the file-backed fake. `dataDir` only matters to the fake.
 */
export function loginItemHelper(
  dataDir?: string,
  opts: { forCli?: boolean } = {},
): LoginItemHelper | null {
  if (process.env.AGETOR_FAKE_LOGIN_ITEM === "1") return fakeHelper(dataDir);
  // `forCli`: the CLI is not inside the app bundle, so it also looks for the
  // installed app's helper (resolveLoginItemHelperPath).
  const bin = resolveLoginItemHelperPath({ forCli: opts.forCli });
  return bin ? realHelper(bin) : null;
}

// ---------------------------------------------------------------------------
// Real helper

function capStderr(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_CAP ? `${trimmed.slice(0, STDERR_CAP)}…` : trimmed;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRegistration(v: unknown): BackgroundRegistration | null {
  return typeof v === "string" && (REGISTRATIONS as readonly string[]).includes(v)
    ? (v as BackgroundRegistration)
    : null;
}

function parseInfo(v: unknown): HelperInfo | null {
  if (!isObject(v)) return null;
  const { bundlePath, bundleId, channel, label, plist, signed, teamId, location } = v;
  if (typeof bundlePath !== "string" || typeof bundleId !== "string") return null;
  if (typeof channel !== "string") return null;
  if (label !== null && typeof label !== "string") return null;
  if (plist !== null && typeof plist !== "string") return null;
  if (typeof signed !== "boolean") return null;
  if (teamId !== null && typeof teamId !== "string") return null;
  if (typeof location !== "string" || !(LOCATIONS as readonly string[]).includes(location)) return null;
  return {
    bundlePath,
    bundleId,
    channel,
    label: label ?? "",
    plist: plist ?? "",
    signed,
    teamId,
    location: location as HelperInfo["location"],
  };
}

function parseResult(v: unknown): HelperResult | null {
  if (!isObject(v) || typeof v.ok !== "boolean") return null;
  const registration = parseRegistration(v.registration);
  if (!registration) return null;
  const result: HelperResult = { ok: v.ok, registration };
  if (v.error !== undefined && v.error !== null) {
    const e = v.error;
    if (!isObject(e)) return null;
    if (typeof e.domain !== "string" || typeof e.code !== "number" || typeof e.message !== "string") {
      return null;
    }
    result.error = { domain: e.domain, code: e.code, message: e.message };
  }
  return result;
}

/** Run one helper command and return its parsed stdout JSON. */
async function runHelper(bin: string, command: string): Promise<unknown> {
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn([bin, command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new HelperError(command, null, "", `login-item helper failed to start: ${(e as Error).message}`);
  }
  // The timeout settles the call itself instead of waiting for the pipes to
  // close: killing the helper does not close them if it left a child holding
  // the write end, and a hung helper must not hang its caller.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      resolve("timeout");
    }, timeoutMs);
  });
  const finished = Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  finished.catch(() => {}); // a read that loses the race to the timeout must not surface later
  try {
    const outcome = await Promise.race([finished, timeout]);
    if (outcome === "timeout") {
      throw new HelperError(command, null, "", `login-item helper \`${command}\` timed out after ${timeoutMs} ms`);
    }
    const [stdout, stderr, exitCode] = outcome;
    const err = capStderr(stderr);
    if (exitCode !== 0) {
      throw new HelperError(
        command,
        exitCode,
        err,
        `login-item helper \`${command}\` exited ${exitCode}${err ? `: ${err}` : ""}`,
      );
    }
    try {
      return JSON.parse(stdout.trim());
    } catch {
      throw new HelperError(command, exitCode, err, `login-item helper \`${command}\` printed non-JSON output`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function badShape(command: string): HelperError {
  return new HelperError(command, 0, "", `login-item helper \`${command}\` printed an unexpected JSON shape`);
}

function realHelper(bin: string): LoginItemHelper {
  const result = async (command: string): Promise<HelperResult> => {
    const parsed = parseResult(await runHelper(bin, command));
    if (!parsed) throw badShape(command);
    return parsed;
  };
  return {
    async info() {
      const parsed = parseInfo(await runHelper(bin, "info"));
      if (!parsed) throw badShape("info");
      return parsed;
    },
    async status() {
      const raw = await runHelper(bin, "status");
      const registration = isObject(raw) ? parseRegistration(raw.registration) : null;
      if (!registration) throw badShape("status");
      return registration;
    },
    register: () => result("register"),
    unregister: () => result("unregister"),
    reregister: () => result("reregister"),
    async openSettings() {
      const raw = await runHelper(bin, "open-settings");
      if (!isObject(raw) || raw.ok !== true) throw badShape("open-settings");
    },
  };
}

// ---------------------------------------------------------------------------
// File-backed fake (AGETOR_FAKE_LOGIN_ITEM=1)

type FakeCommand = "info" | "status" | "register" | "unregister" | "reregister" | "openSettings";

interface FakeState {
  registration: BackgroundRegistration;
  info?: Partial<HelperInfo>;
  calls: string[];
  /** One-shot failure for the next call of `command`. For register/unregister/
   *  reregister it becomes `{ok:false, registration, error}`; for `info`,
   *  `status` and `openSettings`, which have no result envelope, it throws a
   *  `HelperError` carrying the error message. */
  failNext?: {
    command: FakeCommand;
    error: { domain: string; code: number; message: string };
    registration?: BackgroundRegistration;
  };
}

const DEFAULT_FAKE_INFO: HelperInfo = {
  bundlePath: "/Applications/Agetor.app",
  bundleId: "sh.alamops.agetor",
  channel: "stable",
  label: "sh.alamops.agetor.daemon",
  plist: "sh.alamops.agetor.daemon.plist",
  signed: true,
  teamId: "TEAMID0000",
  location: "applications",
};

function fakeHelper(dataDir?: string): LoginItemHelper {
  // Resolved per call, not once: tests repoint AGETOR_DATA_DIR between cases.
  const file = () => path.join(dataDir ?? resolveDataDir(), FAKE_FILENAME);

  const load = (): FakeState => {
    try {
      const raw = JSON.parse(readFileSync(file(), "utf8")) as Partial<FakeState>;
      return {
        registration: parseRegistration(raw.registration) ?? "notRegistered",
        info: isObject(raw.info) ? (raw.info as Partial<HelperInfo>) : undefined,
        calls: Array.isArray(raw.calls) ? raw.calls.filter((c): c is string => typeof c === "string") : [],
        failNext: isObject(raw.failNext) ? (raw.failNext as FakeState["failNext"]) : undefined,
      };
    } catch {
      return { registration: "notRegistered", calls: [] };
    }
  };

  const save = (state: FakeState): void => {
    const target = file();
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, target);
  };

  /** Log the call, consume a matching `failNext`, persist, and hand back the
   *  state plus the injected failure (if any). */
  const begin = (command: FakeCommand) => {
    const state = load();
    state.calls.push(command);
    let failure: NonNullable<FakeState["failNext"]> | null = null;
    if (state.failNext && state.failNext.command === command) {
      failure = state.failNext;
      delete state.failNext;
    }
    return { state, failure };
  };

  const throwInjected = (command: string, failure: NonNullable<FakeState["failNext"]>): never => {
    throw new HelperError(command, null, "", failure.error.message);
  };

  const transition = (command: "register" | "unregister" | "reregister", to: BackgroundRegistration) => {
    const { state, failure } = begin(command);
    if (failure) {
      const res: HelperResult = {
        ok: false,
        registration: failure.registration ?? state.registration,
        error: failure.error,
      };
      state.registration = res.registration;
      save(state);
      return Promise.resolve(res);
    }
    state.registration = to;
    save(state);
    return Promise.resolve<HelperResult>({ ok: true, registration: to });
  };

  return {
    async info() {
      const { state, failure } = begin("info");
      save(state);
      if (failure) return throwInjected("info", failure);
      return { ...DEFAULT_FAKE_INFO, ...state.info };
    },
    async status() {
      const { state, failure } = begin("status");
      save(state);
      if (failure) return throwInjected("status", failure);
      return state.registration;
    },
    register: () => transition("register", "enabled"),
    unregister: () => transition("unregister", "notRegistered"),
    reregister: () => transition("reregister", "enabled"),
    async openSettings() {
      const { state, failure } = begin("openSettings");
      save(state);
      if (failure) throwInjected("open-settings", failure);
    },
  };
}

/** Test hooks; not for production callers. */
export const __testing = {
  /** Override the 15 s per-command timeout; `undefined` restores the default. */
  setTimeoutMs(ms?: number): void {
    timeoutMs = ms ?? HELPER_TIMEOUT_MS;
  },
  DEFAULT_TIMEOUT_MS: HELPER_TIMEOUT_MS,
  FAKE_FILENAME,
};
