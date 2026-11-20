// What a worker thread forwards of one console call to the main thread's
// core.log. Kept apart from core-worker.ts (which patches the console and takes
// over `self.onmessage` the moment it is imported) so a test can call it.

import { redactLogPatterns } from "../log-redact.ts";

/** Longest `text` a forwarded log message carries; longer output is cut with a marker. */
export const LOG_TEXT_MAX_CHARS = 8192;
/** Text longer than this is cut before redaction purely to bound its cost. */
const MAX_PRE_REDACT_CHARS = 256 * 1024;

/** Redact, then cut. The order matters: a secret that straddles the cut must be
 *  `[redacted]` before it, as in core-log.ts, or its prefix leaks. The main
 *  thread additionally redacts its registered literal secrets, which this
 *  thread does not know. */
export function prepareWorkerLogText(text: string): string {
  let out = text;
  if (out.length > MAX_PRE_REDACT_CHARS) out = `${out.slice(0, MAX_PRE_REDACT_CHARS)}... [truncated]`;
  out = redactLogPatterns(out);
  if (out.length > LOG_TEXT_MAX_CHARS) out = `${out.slice(0, LOG_TEXT_MAX_CHARS)}... [truncated]`;
  return out;
}
