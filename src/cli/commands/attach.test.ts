import { describe, expect, test } from "bun:test";
import { opencodeServerTurnAttachError } from "./attach.ts";

const TASK = "0123456789abcdef";

describe("opencodeServerTurnAttachError", () => {
  test("an OpenCode run with no tmux session is a server turn: names the server and the commands that exist", () => {
    const msg = opencodeServerTurnAttachError(TASK, "opencode", { tmuxSession: null });
    expect(msg).toContain("agetor-managed OpenCode server");
    expect(msg).toContain("agetor logs 01234567");
    expect(msg).toContain("agetor show 01234567");
    expect(msg).toContain("in the app");
    // the old advice would respawn a turn that is still running
    expect(msg).not.toContain("agetor send");
    expect(msg).not.toContain("respawn");
  });

  test("an OpenCode run that has a tmux session (1.x, or the run transport) falls through to the normal attach", () => {
    expect(opencodeServerTurnAttachError(TASK, "opencode", { tmuxSession: "agetor-01234567" })).toBeNull();
  });

  test("other harness kinds, an unknown kind and a task with no run are not server turns", () => {
    expect(opencodeServerTurnAttachError(TASK, "codex", { tmuxSession: null })).toBeNull();
    expect(opencodeServerTurnAttachError(TASK, null, { tmuxSession: null })).toBeNull();
    expect(opencodeServerTurnAttachError(TASK, "opencode", undefined)).toBeNull();
  });
});
