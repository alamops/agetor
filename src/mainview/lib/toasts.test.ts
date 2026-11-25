/**
 * The human-gate toast copy (R-S2 webview half). `App.tsx`'s
 * `raisePipelineReview` computes the pending-gate count and passes
 * `humanReviewSubtitle(count)` as the subtitle; this suite pins what the user
 * actually sees — the "Pipeline needs your review" heading, the title · copy
 * description, and the bare copy for a lone gate. A silent change to either
 * string would otherwise only show up in front of a user.
 *
 * The OS notification for these events is the core's decision now (src/bun/notification-policy.ts), so the suite also pins that no
 * toast helper calls the API at all.
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
  method: "warning" | "error" | "info";
  title: string;
  options: Record<string, unknown>;
}

const calls: SonnerCall[] = [];
const dismissed: Array<string | number> = [];
/** Every method name the toasts called on `api`. Empty means no OS notification route was touched. */
const apiCalls: string[] = [];
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
    info: (title: string, options: Record<string, unknown>) => {
      calls.push({ method: "info", title, options });
      return `toast-${++nextToastId}`;
    },
    dismiss: (id?: string | number) => {
      if (id !== undefined) dismissed.push(id);
    },
  },
}));

mock.module("./api", () => ({
  ...realApiSnapshot,
  api: new Proxy({}, {
    get: (_t, prop) => (...args: unknown[]) => {
      apiCalls.push(`${String(prop)}(${args.length})`);
      return Promise.resolve({ ok: true });
    },
  }),
}));

afterAll(() => {
  mock.module("sonner", () => realSonnerSnapshot);
  mock.module("./api", () => realApiSnapshot);
});

const toasts = await import("./toasts.ts");
const { toastHarnessSwap, toastPipelineReview } = toasts;

beforeEach(() => {
  calls.length = 0;
  dismissed.length = 0;
  apiCalls.length = 0;
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

  test("a selected run view suppresses the toast, and the webview posts no OS notification for it", () => {
    toastPipelineReview(args({ taskId: "pipeline-parent-3", isSelected: true, isFocused: false }));
    expect(calls).toHaveLength(0);
    expect(apiCalls).toEqual([]);
  });

  test("a selected run view in a focused window suppresses the toast and clears nothing", () => {
    toastPipelineReview(args({ taskId: "pipeline-parent-4", isSelected: true, isFocused: true }));
    expect(calls).toHaveLength(0);
    expect(apiCalls).toEqual([]);
  });
});

describe("the webview never calls the notification routes (the core decides, grill D5)", () => {
  const base = (taskId: string) => args({ taskId, isSelected: false, isFocused: false });

  test("every toast helper shows its in-app toast and touches no API method", () => {
    toasts.toastSuccess({ ...base("n1") });
    toasts.toastError({ ...base("n2"), reason: "boom" });
    toasts.toastPending(base("n3"));
    toasts.toastApiError(base("n4"));
    toasts.toastSessionEnded(base("n5"));
    toasts.toastUnknownCommand(base("n6"));
    toasts.toastHarnessExhausted(base("n7"));
    toasts.toastHarnessUnusable(base("n8"));
    toasts.notifyWaitingInput(base("n9"));
    toasts.notifyFilesSent({ ...base("n10"), count: 2, caption: "shots", proactive: true });
    toastHarnessSwap({ ...base("n11"), fromLabel: "A", toLabel: "B", position: 1, count: 2 });
    toastPipelineReview(base("n12"));
    expect(calls.length).toBeGreaterThanOrEqual(11);
    expect(apiCalls).toEqual([]);
  });

  test("a selected task and a focused window change no toast rule here either", () => {
    toasts.toastSuccess({ ...args({ taskId: "n20", isSelected: true, isFocused: true }) });
    toasts.notifyWaitingInput(args({ taskId: "n21", isSelected: true, isFocused: false }));
    toasts.notifyFilesSent({ ...args({ taskId: "n22", isSelected: true, isFocused: true }), count: 1, caption: null, proactive: true });
    expect(apiCalls).toEqual([]);
  });
});

describe("toastHarnessSwap position (22d)", () => {
  const swap = (count: number, taskId: string) =>
    toastHarnessSwap({ ...args({ taskId }), fromLabel: "Work", toLabel: "Personal", position: 2, count });

  test("a stack of two or more names the n/m position", () => {
    swap(3, "swap-multi");
    const call = calls.find((c) => c.method === "info");
    expect(call?.title).toBe("Account switched");
    expect(description(call)).toBe("Work → Personal (2/3)");
  });

  test("a one-member stack prints no position", () => {
    swap(1, "swap-single");
    const call = calls.find((c) => c.method === "info");
    expect(description(call)).toBe("Work → Personal");
    expect(description(call)).not.toContain("/");
  });
});
