// The pattern half of log redaction, free of main-thread state so the core
// worker thread can apply it too (core-log.ts adds the registered-secret literals,
// which only the main thread knows). Imports only the import-free
// `opencode-http` redactor.

import { redactSecrets } from "./opencode-http.ts";

/** Bearer/Authorization and `token=` patterns, then `redactSecrets` (OpenCode password forms). */
export function redactLogPatterns(text: string): string {
  const out = text
    // "Bearer xyz" of any length (redactSecrets only catches 8+ chars).
    .replace(/\b(bearer)(\s+)[^\s"']+/gi, "$1$2[redacted]")
    // `token=…` / `access_token: …` in a URL, header dump or JSON.
    .replace(/(\b\w*token["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi, "$1[redacted]");
  return redactSecrets(out);
}
