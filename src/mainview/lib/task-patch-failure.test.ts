import { describe, expect, test } from "bun:test";
import { switchAccountFailureToast, taskPatchFailureToast } from "./task-patch-failure.ts";
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

describe("switchAccountFailureToast", () => {
  test("a 409 with reasons lists each member", () => {
    const err = new ApiError("no usable member", 409, {
      error: "no usable member",
      code: "no-usable-member",
      reasons: [
        { harnessId: "a", label: "Work", reason: "cooling until 15:00" },
        { harnessId: "b", label: "Personal", reason: "logged out" },
      ],
    });
    expect(switchAccountFailureToast(err)).toEqual({
      title: "Couldn't switch account",
      description: "No other account can take this task: Work: cooling until 15:00; Personal: logged out",
    });
  });

  test("a refusal without reasons shows the server's error", () => {
    const err = new ApiError("x", 409, { error: "background agents are running", code: "background-agents" });
    expect(switchAccountFailureToast(err).description).toBe("background agents are running");
  });

  test("another refusal code that carries reasons reads as the server's sentence, not the member heading", () => {
    const err = new ApiError("x", 409, {
      error: "this task's account is not in a stack with a backup account",
      code: "not-in-stack",
      reasons: [{ harnessId: "a", label: "Work", reason: "cooling until 15:00" }],
    });
    expect(switchAccountFailureToast(err).description).toBe(
      "this task's account is not in a stack with a backup account",
    );
  });

  test("a transit failure says the switch may have landed", () => {
    expect(switchAccountFailureToast(new ApiTransitError("t")).title).toBe("Couldn't confirm the account switch");
  });
});
