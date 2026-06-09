import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CoreCreds,
  CORE_CREDS_FILENAME,
  coreCredsPath,
  writeCoreCreds,
  readCoreCreds,
  removeCoreCreds,
  isPidAlive,
} from "./core-creds.ts";

let dir: string;

const sample = (): CoreCreds => ({
  port: 4317,
  token: "deadbeef".repeat(8),
  pid: process.pid,
  kind: "cli-daemon",
  version: "0.0.16",
  startedAt: 1733740000000,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agetor-creds-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("core-creds", () => {
  it("round-trips every field through write → read", () => {
    const creds = sample();
    writeCoreCreds(creds, dir);
    expect(readCoreCreds(dir)).toEqual(creds);
  });

  it("writes the file at mode 0600", () => {
    writeCoreCreds(sample(), dir);
    const mode = statSync(coreCredsPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("places the file at <dataDir>/agetor-core.json", () => {
    expect(coreCredsPath(dir)).toBe(path.join(dir, CORE_CREDS_FILENAME));
  });

  it("returns null when the file is missing", () => {
    expect(readCoreCreds(dir)).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    writeFileSync(coreCredsPath(dir), "{ not json");
    expect(readCoreCreds(dir)).toBeNull();
  });

  it("returns null for a wrong-shaped object (missing token)", () => {
    writeFileSync(
      coreCredsPath(dir),
      JSON.stringify({ port: 4317, pid: 1, kind: "app", version: "x", startedAt: 1 }),
    );
    expect(readCoreCreds(dir)).toBeNull();
  });

  it("returns null for an unknown kind", () => {
    writeFileSync(
      coreCredsPath(dir),
      JSON.stringify({ ...sample(), kind: "rogue" }),
    );
    expect(readCoreCreds(dir)).toBeNull();
  });

  it("removeCoreCreds deletes the file and is idempotent", () => {
    writeCoreCreds(sample(), dir);
    expect(readCoreCreds(dir)).not.toBeNull();
    removeCoreCreds(dir);
    expect(readCoreCreds(dir)).toBeNull();
    expect(() => removeCoreCreds(dir)).not.toThrow();
  });

  it("isPidAlive is true for our own pid, false for a free high pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });
});
