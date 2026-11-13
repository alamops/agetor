/**
 * `Promise.all` with a bounded number of calls in flight, preserving input
 * order in the results. A `limit` below 1 (or not a number) is treated as 1.
 *
 * The webview shares a small per-host connection budget (WKWebView allows
 * about six HTTP/1.1 connections per host, and two are permanent SSE
 * channels), so any per-repository or per-row fan-out of requests must go
 * through this instead of a bare `Promise.all`. Callers: the Worktrees delete
 * confirm (one git status per checkout) and the multi-repository `@` listing,
 * search and agent discovery in `use-project-files.ts` / `PromptComposer.tsx`
 * (see docs/architecture/multi-repo-tasks.md).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  if (items.length === 0) return results;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
