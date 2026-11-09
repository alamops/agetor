import { describe, expect, test } from "bun:test";
import { taskPatchFailureToast } from "./task-patch-failure.ts";
import { ApiError } from "./api.ts";
import { ApiTransitError } from "./net-retry.ts";

describe("taskPatchFailureToast (N8)", () => {
  test("a refused account switch shows the server's message", () => {
    const err = new ApiError("task is running — stop it before switching accounts", 409, { error: "x" });
    expect(taskPatchFailureToast({ agent: "backup" }, err)).toEqual({
      title: "Couldn't switch account",
      description: "task is running — stop it before switching accounts",
    });
  });

  test("a cross-kind switch patch (agent + kind defaults) toasts too", () => {
    const patch = { agent: "codex", mode: "auto", model: "m" };
    expect(taskPatchFailureToast(patch, new Error("boom"))?.description).toBe("boom");
  });

  test("a transit failure says the switch may have landed", () => {
    const toast = taskPatchFailureToast({ agent: "backup" }, new ApiTransitError("request failed in transit"));
    expect(toast?.title).toBe("Couldn't confirm the account switch");
    expect(toast?.description).toContain("may have gone through");
  });

  test("an empty message still explains itself", () => {
    expect(taskPatchFailureToast({ agent: "backup" }, new Error(""))?.description).toBe("agetor refused the switch.");
  });

  test("dropdown patches without an agent stay quiet", () => {
    expect(taskPatchFailureToast({ model: "m" } as { agent?: unknown }, new Error("boom"))).toBeNull();
    expect(taskPatchFailureToast({}, new Error("boom"))).toBeNull();
  });
});
