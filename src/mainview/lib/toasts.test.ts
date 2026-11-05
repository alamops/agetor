/**
 * The human-gate toast copy (R-S2 webview half). `App.tsx`'s
 * `raisePipelineReview` computes the pending-gate count and passes
 * `humanReviewSubtitle(count)` as the subtitle; this suite pins what the user
 * actually sees — the "Pipeline needs your review" heading, the title · copy
 * description, and the bare copy for a lone gate. A silent change to either
 * string would otherwise only show up in front of a user.
 *
 * `sonner` and `./api` are boundaries this repo doesn't own, so both are
 * mocked; `toasts.ts` itself (slot bookkeeping, description composition) runs
 * for real. Both mocked modules are snapshotted and restored in `afterAll` —
 * `mock.module` overwrites the module record in place, and other test files in
 * the same `bun test` process import them.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realSonner from "sonner";
import * as realApi from "./api.ts";
import { humanReviewSubtitle } from "../../shared/pipeline.ts";
import type { ToastArgs } from "./toasts.ts";

const realSonnerSnapshot = { ...realSonner };
const realApiSnapshot = { ...realApi };

interface SonnerCall {
  method: "warning" | "error";
  title: string;
  options: Record<string, unknown>;
}

const calls: SonnerCall[] = [];
const dismissed: Array<string | number> = [];
const cleared: string[] = [];
const posted: unknown[] = [];
// Ids are unique across the file so a slot carried between tests can't make a
// dismissal assertion pass by accident.
let nextToastId = 0;

mock.module("sonner", () => ({
  ...realSonnerSnapshot,
  toast: {
    ...realSonnerSnapshot.toast,
    warning: (title: string, options: Record<string, unknown>) => {
      calls.push({ method: "warning", title, options });
      return `toast-${++nextToastId}`;
    },
    error: (title: string, options: Record<string, unknown>) => {
      calls.push({ method: "error", title, options });
      return `toast-${++nextToastId}`;
    },
    dismiss: (id?: string | number) => {
      if (id !== undefined) dismissed.push(id);
    },
  },
}));

mock.module("./api", () => ({
  ...realApiSnapshot,
  api: {
    ...realApiSnapshot.api,
    notifyOS: async (payload: unknown) => {
      posted.push(payload);
    },
    clearTaskNotification: async (taskId: string) => {
      cleared.push(taskId);
    },
  },
}));

afterAll(() => {
  mock.module("sonner", () => realSonnerSnapshot);
  mock.module("./api", () => realApiSnapshot);
});

const { toastPipelineReview } = await import("./toasts.ts");

beforeEach(() => {
  calls.length = 0;
  dismissed.length = 0;
  cleared.length = 0;
  posted.length = 0;
});

function args(overrides: Partial<ToastArgs> = {}): ToastArgs {
  return {
    taskId: "pipeline-parent-1",
    title: "Fix the header",
    isSelected: false,
    isFocused: true,
    onOpen: () => {},
    ...overrides,
  };
}

function description(call: SonnerCall | undefined): string {
  return String(call?.options.description ?? "");
}

describe("toastPipelineReview", () => {
  test("a lone gate keeps the original blocking heading and copy", () => {
    toastPipelineReview(args({ subtitle: humanReviewSubtitle(1) }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("warning");
    expect(calls[0]!.title).toBe("Pipeline needs your review");
    expect(description(calls[0])).toBe("Fix the header · Pipeline needs your review");
    // A gate blocks indefinitely until decided/dismissed.
    expect(calls[0]!.options.duration).toBe(Infinity);
    expect((calls[0]!.options.action as { label: string }).label).toBe("Open");
  });

  test("several gates on one event name the count in the one alert's copy", () => {
    toastPipelineReview(args({ subtitle: humanReviewSubtitle(2) }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe("Pipeline needs your review");
    expect(description(calls[0])).toBe("Fix the header · Pipeline needs your review (2 gates)");
  });

  test("a newer announcement for the same task replaces its previous toast", () => {
    toastPipelineReview(args({ taskId: "pipeline-parent-2", subtitle: humanReviewSubtitle(1) }));
    toastPipelineReview(args({ taskId: "pipeline-parent-2", subtitle: humanReviewSubtitle(3) }));

    expect(dismissed).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(description(calls[1])).toBe("Fix the header · Pipeline needs your review (3 gates)");
  });

  test("a selected run view suppresses the toast but still alerts an unfocused window", () => {
    toastPipelineReview(args({ taskId: "pipeline-parent-3", isSelected: true, isFocused: false }));

    expect(calls).toHaveLength(0);
    expect(cleared).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      title: "Pipeline needs your review",
      taskId: "pipeline-parent-3",
      kind: "blocked",
    });
  });

  test("a selected run view in a focused window suppresses the toast and clears the OS entry", () => {
    toastPipelineReview(args({ taskId: "pipeline-parent-4", isSelected: true, isFocused: true }));

    expect(calls).toHaveLength(0);
    expect(posted).toEqual([]);
    expect(cleared).toEqual(["pipeline-parent-4"]);
  });
});
