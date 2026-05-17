// Wipe the dev data dir (~/.agetor-dev) — the one `bun run dev` /
// `bun run dev:hmr` write to. The packaged .app uses ~/.agetor and is
// untouched. Hard-coded path with a suffix check so this can never
// accidentally nuke the production dir even if $HOME is exotic.
//
// Refuses to run if a live agetor process is using the dev data dir.
// Two signals, checked in order:
//   1. `agetor.pid` in the data dir — written at boot by src/bun/index.ts.
//      Precise per-data-dir and survives custom AGETOR_API_PORT values.
//   2. As a fallback (any pid-file state other than "proven dead" —
//      missing, unreadable, or malformed), probe the default API port.
//      Catches older builds and missing/corrupt pid files. Can
//      false-positive when a prod instance is on the same port —
//      `--force` overrides.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEV_DIR = path.join(homedir(), ".agetor-dev");
const PID_FILE = path.join(DEV_DIR, "agetor.pid");
const force = process.argv.includes("--force");
// Mirrors `getApiPort()` in src/bun/api-config.ts — kept in sync by hand
// (single integer, rarely changes). If you change the port resolution
// there, mirror it here too.
const API_PORT = Number(process.env.AGETOR_API_PORT ?? 4317);

if (!DEV_DIR.endsWith(".agetor-dev")) {
  console.error(`[wipe-dev] refusing: resolved path doesn't end in .agetor-dev (${DEV_DIR})`);
  process.exit(1);
}

// `kind` discriminates the four possible outcomes so callers can tell
// the difference between "proved dead" (skip the fallback) and "couldn't
// determine" (run the fallback).
type PidStatus =
  | { kind: "alive"; pid: number }
  | { kind: "dead"; pid: number }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "malformed"; raw: string };

function pidFileStatus(): PidStatus {
  if (!existsSync(PID_FILE)) return { kind: "missing" };
  let raw: string;
  try {
    raw = readFileSync(PID_FILE, "utf8");
  } catch {
    return { kind: "unreadable" };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { kind: "malformed", raw: raw.trim() };
  }
  try {
    process.kill(pid, 0);
    return { kind: "alive", pid };
  } catch {
    // ESRCH = no such process; EPERM = exists but we can't signal. Either
    // way, treat as "not our concern" — the pid was recycled or belongs to
    // a different user.
    return { kind: "dead", pid };
  }
}

function portInUse(): boolean {
  try {
    const probe = Bun.serve({
      port: API_PORT,
      hostname: "127.0.0.1",
      fetch: () => new Response("probe"),
    });
    probe.stop();
    return false;
  } catch {
    return true;
  }
}

if (!force) {
  const status = pidFileStatus();
  if (status.kind === "alive") {
    console.error(
      `[wipe-dev] refusing: agetor is running with pid ${status.pid} on this data dir. `
      + `Stop it first, or pass --force to wipe anyway.`,
    );
    process.exit(1);
  }
  // Fall back to the port probe whenever we *don't* have positive proof
  // the agetor is dead. `kind: "dead"` is the only case where we know for
  // sure (kill(pid, 0) returned ESRCH). Missing/unreadable/malformed pid
  // files all mean "uncertain" and deserve the safety-net check.
  if (status.kind !== "dead" && portInUse()) {
    const why =
      status.kind === "missing" ? "no pid file" :
      status.kind === "unreadable" ? "pid file unreadable" :
      `pid file malformed (${status.raw})`;
    console.error(
      `[wipe-dev] refusing: ${why} but something is listening on 127.0.0.1:${API_PORT}. `
      + `If that's a different process (or a prod agetor sharing the port), pass --force.`,
    );
    process.exit(1);
  }
}

if (!existsSync(DEV_DIR)) {
  console.log(`[wipe-dev] nothing to do — ${DEV_DIR} doesn't exist`);
  process.exit(0);
}

const st = statSync(DEV_DIR);
if (!st.isDirectory()) {
  console.error(`[wipe-dev] refusing: ${DEV_DIR} is not a directory`);
  process.exit(1);
}

rmSync(DEV_DIR, { recursive: true, force: true });
console.log(`[wipe-dev] removed ${DEV_DIR}${force ? " (--force)" : ""}`);
