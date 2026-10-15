import { describe, expect, test } from "bun:test";
import {
  ARCHIVED_HISTORY_RETENTION_DEFAULT_DAYS,
  RETENTION_DAY_OPTIONS,
  formatBytes,
  formatDbStatsLine,
  formatRetentionValue,
  parseArchivedHistoryRetentionDays,
  retentionOptionLabel,
  retentionSelectOptions,
} from "./retention-prefs.ts";
import type { DbStats } from "../../shared/types.ts";

// Docs: docs/plans/non-blocking-session-restore.md row TT6 (retention prefs
// parser / formatter round-trips used by Settings → General).

describe("parseArchivedHistoryRetentionDays", () => {
  test("off, in any case or padding, disables trimming", () => {
    expect(parseArchivedHistoryRetentionDays("off")).toBeNull();
    expect(parseArchivedHistoryRetentionDays(" OFF ")).toBeNull();
    expect(parseArchivedHistoryRetentionDays("Off")).toBeNull();
  });

  test("absent and unparsable values fall back to the default", () => {
    expect(ARCHIVED_HISTORY_RETENTION_DEFAULT_DAYS).toBe(30);
    for (const v of [undefined, null, "", "  ", "garbage", "0", "-3", "3651", "1.5", "1e2", "0x10", "30 days"]) {
      expect(parseArchivedHistoryRetentionDays(v)).toBe(30);
    }
  });

  test("a valid integer in range is returned as-is, bounds inclusive", () => {
    expect(parseArchivedHistoryRetentionDays("45")).toBe(45);
    expect(parseArchivedHistoryRetentionDays(" 7 ")).toBe(7);
    expect(parseArchivedHistoryRetentionDays("1")).toBe(1);
    expect(parseArchivedHistoryRetentionDays("3650")).toBe(3650);
  });
});

describe("formatRetentionValue", () => {
  test("null (off) → \"off\", a day count → its string", () => {
    expect(formatRetentionValue(null)).toBe("off");
    expect(formatRetentionValue(45)).toBe("45");
  });

  test("round-trips with the parser for every value the picker can write", () => {
    expect(parseArchivedHistoryRetentionDays(formatRetentionValue(null))).toBeNull();
    for (const days of [...RETENTION_DAY_OPTIONS, 45, 1, 3650]) {
      expect(parseArchivedHistoryRetentionDays(formatRetentionValue(days))).toBe(days);
    }
    // " OFF " → null → "off" → null
    const parsed = parseArchivedHistoryRetentionDays(" OFF ");
    expect(formatRetentionValue(parsed)).toBe("off");
  });
});

describe("retentionOptionLabel", () => {
  test("off, singular and plural", () => {
    expect(retentionOptionLabel(null)).toBe("Off");
    expect(retentionOptionLabel(1)).toBe("1 day");
    expect(retentionOptionLabel(30)).toBe("30 days");
  });
});

describe("retentionSelectOptions", () => {
  test("lists off first, then the curated ages", () => {
    expect(retentionSelectOptions(30)).toEqual([null, ...RETENTION_DAY_OPTIONS]);
    expect(retentionSelectOptions(null)).toEqual([null, ...RETENTION_DAY_OPTIONS]);
  });

  test("an uncurated current value gets an extra option, kept ascending", () => {
    const options = retentionSelectOptions(45);
    expect(options).toContain(45);
    expect(options).toHaveLength(RETENTION_DAY_OPTIONS.length + 2);
    const days = options.filter((o): o is number => o !== null);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(options[0]).toBeNull();
  });

  test("a curated current value adds nothing", () => {
    expect(retentionSelectOptions(30)).not.toContain(45);
    expect(retentionSelectOptions(30)).toHaveLength(RETENTION_DAY_OPTIONS.length + 1);
  });
});

describe("formatBytes", () => {
  test("zero, negative and non-finite are 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  test("bytes below 1 KB", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("KB and MB take one decimal, GB takes two", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.00 GB");
    expect(formatBytes(4.2 * 1024 ** 3)).toBe("4.20 GB");
  });

  test("anything past GB stays in GB", () => {
    expect(formatBytes(2048 * 1024 ** 3)).toBe("2048.00 GB");
  });
});

function stats(retention: Partial<DbStats["retention"]> = {}): DbStats {
  return {
    fileBytes: 1024 * 1024 * 10,
    walBytes: 1024 * 1024 * 2,
    pageSize: 4096,
    pageCount: 3072,
    freelistCount: 256,
    reclaimableBytes: 1024 * 1024,
    compactEstimateSec: 1,
    activeRunCount: 0,
    retention: {
      days: 30,
      lastRunAt: null,
      lastFreedBytes: null,
      lastTrimmedRows: null,
      running: false,
      ...retention,
    },
  };
}

describe("formatDbStatsLine", () => {
  const base = "Database 12.0 MB on disk · 1.0 MB reclaimable";

  test("running wins over everything else", () => {
    expect(formatDbStatsLine(stats({ running: true, lastRunAt: 1_700_000_000_000 }))).toBe(`${base} · trimming now…`);
  });

  test("never trimmed", () => {
    expect(formatDbStatsLine(stats())).toBe(`${base} · not trimmed yet`);
  });

  test("last trimmed, with and without a freed-bytes figure", () => {
    const lastRunAt = Date.UTC(2026, 5, 15, 12, 30);
    const when = new Date(lastRunAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    expect(formatDbStatsLine(stats({ lastRunAt, lastFreedBytes: 3 * 1024 * 1024 }), "en-US")).toBe(
      `${base} · last trimmed ${when}, freed 3.0 MB`,
    );
    expect(formatDbStatsLine(stats({ lastRunAt, lastFreedBytes: null }), "en-US")).toBe(
      `${base} · last trimmed ${when}`,
    );
  });
});
