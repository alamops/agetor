import {
  ARCHIVED_HISTORY_RETENTION_DEFAULT_DAYS,
  ARCHIVED_HISTORY_RETENTION_OFF,
  ARCHIVED_HISTORY_RETENTION_PREF,
  parseArchivedHistoryRetentionDays,
  type DbStats,
} from "../../shared/types.ts";

/**
 * Webview-facing home for the archived-history retention preference — see
 * `docs/plans/non-blocking-session-restore.md` (decision F, task T11) and the
 * doc comments on the originals in `src/shared/types.ts` for the contract.
 * Mirrors `fx-auto-resume-prefs.ts`: one small documented module that
 * `SettingsDialog.tsx` imports from rather than reaching into the shared file.
 */
export {
  ARCHIVED_HISTORY_RETENTION_DEFAULT_DAYS,
  ARCHIVED_HISTORY_RETENTION_OFF,
  ARCHIVED_HISTORY_RETENTION_PREF,
  parseArchivedHistoryRetentionDays,
};

/** The ages Settings → General offers (days). `Off` is offered in addition. */
export const RETENTION_DAY_OPTIONS = [7, 14, 30, 90, 180, 365] as const;

/** The stored preference value for a parsed age: `null` (trimming off) →
 *  `"off"`, a day count → its integer string. Inverse of
 *  `parseArchivedHistoryRetentionDays` for every value the picker can write. */
export function formatRetentionValue(days: number | null): string {
  return days === null ? ARCHIVED_HISTORY_RETENTION_OFF : String(days);
}

/** The picker's visible label for an age. */
export function retentionOptionLabel(days: number | null): string {
  if (days === null) return "Off";
  return days === 1 ? "1 day" : `${days} days`;
}

/** The ages the picker lists: `null` (off) first, then the curated days, plus
 *  `current` when it isn't one of them (e.g. `45` set through `agetor config`)
 *  so the control never lies about what is stored. Ascending. */
export function retentionSelectOptions(current: number | null): (number | null)[] {
  const days: number[] = [...RETENTION_DAY_OPTIONS];
  if (current !== null && !days.includes(current)) {
    days.push(current);
    days.sort((a, b) => a - b);
  }
  return [null, ...days];
}

/** Compact byte formatter for the DB size line: `B` below 1 KB, then KB/MB
 *  with one decimal and GB with two (binary multiples, like the rest of the
 *  retention copy). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === units.length - 1 ? 2 : 1)} ${units[unit]}`;
}

/** The "Database … on disk · … reclaimable · …" line under the retention
 *  picker. `locale` is injectable for tests. */
export function formatDbStatsLine(stats: DbStats, locale?: string): string {
  const onDisk = formatBytes(stats.fileBytes + stats.walBytes);
  const base = `Database ${onDisk} on disk · ${formatBytes(stats.reclaimableBytes)} reclaimable`;
  const { running, lastRunAt, lastFreedBytes } = stats.retention;
  if (running) return `${base} · trimming now…`;
  if (lastRunAt === null) return `${base} · not trimmed yet`;
  const when = new Date(lastRunAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const freed = lastFreedBytes === null ? "" : `, freed ${formatBytes(lastFreedBytes)}`;
  return `${base} · last trimmed ${when}${freed}`;
}
