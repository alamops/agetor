import { describe, expect, test } from "bun:test";
import { quitDialogModel, quitTitlesPreview, type QuitRequestEvent } from "./quit-dialog.ts";

const ev = (over: Partial<QuitRequestEvent> = {}): QuitRequestEvent => ({
  type: "quit_request",
  runningRunCount: 2,
  runningTaskTitles: ["Alpha", "Beta"],
  backgroundArmed: false,
  completely: false,
  ts: 1,
  ...over,
});

describe("quitTitlesPreview", () => {
  test("null when there are no titles", () => {
    expect(quitTitlesPreview([])).toBeNull();
  });
  test("up to three titles are comma-joined without an ellipsis", () => {
    expect(quitTitlesPreview(["a"])).toBe("a");
    expect(quitTitlesPreview(["a", "b", "c"])).toBe("a, b, c");
  });
  test("more than three are truncated to three plus an ellipsis", () => {
    expect(quitTitlesPreview(["a", "b", "c", "d"])).toBe("a, b, c, …");
    expect(quitTitlesPreview(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, …");
  });
});

describe("quitDialogModel — plain (no background core)", () => {
  test("keeps the sentence and buttons the app has always shown", () => {
    // Recovered from the pre-change App.tsx confirm({...}) call.
    const m = quitDialogModel(ev());
    expect(m.title).toBe("Quit Agetor?");
    expect(m.body).toBe(
      "2 tasks are still running. They will keep running in the background; you can reconnect to them next time you open Agetor.",
    );
    expect(m.actions).toEqual(["quit", "cancel"]);
    expect(m.labels.quit).toBe("Quit anyway");
    expect(m.labels.cancel).toBe("Stay open");
  });

  test("singular count uses 'task is'", () => {
    const m = quitDialogModel(ev({ runningRunCount: 1, runningTaskTitles: ["Only"] }));
    expect(m.body).toStartWith("1 task is still running.");
    expect(m.titlesPreview).toBe("Only");
  });

  test("title preview is truncated to three plus an ellipsis, or null with none", () => {
    expect(quitDialogModel(ev({ runningTaskTitles: ["a", "b", "c", "d"] })).titlesPreview).toBe("a, b, c, …");
    expect(quitDialogModel(ev({ runningTaskTitles: [] })).titlesPreview).toBeNull();
  });
});

describe("quitDialogModel — armed (parked supervisor will take over)", () => {
  test("offers Quit / Quit completely / Cancel and promises the tasks keep running", () => {
    const m = quitDialogModel(ev({ backgroundArmed: true }));
    expect(m.title).toBe("Quit Agetor?");
    expect(m.actions).toEqual(["quit", "quit-completely", "cancel"]);
    expect(m.labels).toEqual({ quit: "Quit", "quit-completely": "Quit completely", cancel: "Cancel" });
    expect(m.body).toContain("keep running in the background");
    expect(m.body).not.toContain("will stop");
    expect(m.titlesPreview).toBe("Alpha, Beta");
  });

  test("singular and plural", () => {
    expect(quitDialogModel(ev({ backgroundArmed: true, runningRunCount: 1 })).body).toStartWith("1 task is");
    expect(quitDialogModel(ev({ backgroundArmed: true, runningRunCount: 3 })).body).toStartWith("3 tasks are");
  });
});

describe("quitDialogModel — completely", () => {
  test("warns that the tasks will stop and offers only Quit completely / Cancel", () => {
    const m = quitDialogModel(ev({ completely: true }));
    expect(m.title).toBe("Quit Agetor completely?");
    expect(m.body).toContain("stops the background core");
    expect(m.body).toContain("will stop");
    expect(m.actions).toEqual(["quit", "cancel"]);
    expect(m.labels.quit).toBe("Quit completely");
    expect(m.labels.cancel).toBe("Cancel");
  });

  test("wins over backgroundArmed", () => {
    const m = quitDialogModel(ev({ completely: true, backgroundArmed: true }));
    expect(m.title).toBe("Quit Agetor completely?");
    expect(m.actions).toEqual(["quit", "cancel"]);
  });

  test("singular count and title preview", () => {
    const m = quitDialogModel(ev({ completely: true, runningRunCount: 1, runningTaskTitles: ["x", "y", "z", "w"] }));
    expect(m.body).toStartWith("1 task is still running.");
    expect(m.titlesPreview).toBe("x, y, z, …");
  });
});
