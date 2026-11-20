import { defineOp } from "./define.ts";

/** One parsed transcript usage event, as `account-usage.ts` hands it over. */
export interface UsageEventInput {
  key: string;
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface UsageCursor {
  mtime_ms: number;
  size: number;
  offset: number;
}

export interface UsageTotalsRow {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  messages: number;
}

export interface UsageDayRowOut {
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
}

const PUT_CURSOR_SQL = `INSERT INTO usage_files (path, config_dir, mtime_ms, size, offset) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET config_dir = excluded.config_dir,
         mtime_ms = excluded.mtime_ms, size = excluded.size, offset = excluded.offset`;

/** Per-account token-usage rollups (`account-usage.ts`): the byte cursors, the
 *  seen-key dedupe and the daily sums. */
export const usageOps = {
  "usage.getCursor": defineOp({
    tx: false,
    run: ({ conn }, filePath: string): UsageCursor | null =>
      (conn.query("SELECT mtime_ms, size, offset FROM usage_files WHERE path = ?").get(filePath) as UsageCursor | null) ?? null,
  }),
  "usage.putCursor": defineOp({
    tx: false,
    run: ({ conn }, filePath: string, configDir: string, mtimeMs: number, size: number, offset: number): null => {
      conn.query(PUT_CURSOR_SQL).run(filePath, configDir, mtimeMs, size, offset);
      return null;
    },
  }),
  /** Count a slice's events and advance the file cursor as one unit: a throw
   *  rolls back every event and the cursor together. Returns the number of
   *  events counted for the first time (post-dedupe). */
  "usage.applyChunk": defineOp({
    tx: true,
    run: (
      { conn },
      configDir: string,
      filePath: string,
      mtimeMs: number,
      size: number,
      offset: number,
      events: UsageEventInput[],
    ): number => {
      const markSeen = conn.query("INSERT OR IGNORE INTO usage_seen (config_dir, key) VALUES (?, ?)");
      const addDaily = conn.query(
        `INSERT INTO usage_daily (config_dir, day, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(config_dir, day, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         message_count = message_count + 1`,
      );
      let counted = 0;
      for (const e of events) {
        if (markSeen.run(configDir, e.key).changes === 0) continue; // already counted
        addDaily.run(configDir, e.day, e.model, e.inputTokens, e.outputTokens, e.cacheWriteTokens, e.cacheReadTokens);
        counted++;
      }
      conn.query(PUT_CURSOR_SQL).run(filePath, configDir, mtimeMs, size, offset);
      return counted;
    },
  }),
  "usage.totalsSince": defineOp({
    tx: false,
    run: ({ conn }, configDir: string, day: string): UsageTotalsRow =>
      conn.query(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite, COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
              COALESCE(SUM(message_count), 0) AS messages
       FROM usage_daily WHERE config_dir = ? AND day >= ?`,
      ).get(configDir, day) as UsageTotalsRow,
  }),
  "usage.daysSince": defineOp({
    tx: false,
    run: ({ conn }, configDir: string, day: string): UsageDayRowOut[] =>
      conn.query(
        `SELECT day, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
              cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens,
              message_count AS messageCount
       FROM usage_daily WHERE config_dir = ? AND day >= ?
       ORDER BY day DESC, model ASC`,
      ).all(configDir, day) as UsageDayRowOut[],
  }),
};
