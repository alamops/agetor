/** The device level vocabulary (grill D6, D7). A level is chosen in the native pairing window and signed into the registry entry. */
export const REMOTE_LEVELS = ["observe", "respond", "operate", "configure"] as const;
export type RemoteLevel = (typeof REMOTE_LEVELS)[number];

export function isRemoteLevel(v: unknown): v is RemoteLevel {
  return typeof v === "string" && (REMOTE_LEVELS as readonly string[]).includes(v);
}

export function levelRank(level: RemoteLevel): number {
  return REMOTE_LEVELS.indexOf(level);
}

/** True when `have` is at or above `need`. */
export function levelAtLeast(have: RemoteLevel, need: RemoteLevel): boolean {
  return levelRank(have) >= levelRank(need);
}
