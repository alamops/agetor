import { ensureCore, type EnsureOptions } from "./daemon/supervisor.ts";
import { AgetorClient, discoverCore } from "./api-client.ts";

/** Global flags parsed from argv, threaded to every command. */
export interface Flags {
  json: boolean;
  plain: boolean;
  noDaemon: boolean;
  dataDir?: string;
  port?: number;
}

export function ensureOpts(flags: Flags): EnsureOptions {
  return { dataDir: flags.dataDir, port: flags.port, noDaemon: flags.noDaemon };
}

/** Get a client, auto-spawning a daemon if no core is running. */
export async function getClient(flags: Flags): Promise<AgetorClient> {
  const core = await ensureCore(ensureOpts(flags));
  return new AgetorClient(core);
}

/** Get a client only if a core is already running (never spawns). */
export async function getClientIfRunning(flags: Flags): Promise<AgetorClient | null> {
  const core = await discoverCore(flags.dataDir);
  return core ? new AgetorClient(core) : null;
}
