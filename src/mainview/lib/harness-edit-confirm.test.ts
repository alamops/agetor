/**
 * The Settings account editor's save when the core refuses an edit that would
 * drop the account's config-mirror records (409 `mirror-records`): ask with
 * the core's sentence, re-send with `confirmMirrorDrop` only on a yes, and
 * write nothing on a cancel.
 */
import { expect, test } from "bun:test";
import { ApiError } from "./api.ts";
import { mirrorDropRefusal, saveConfirmingMirrorDrop } from "./harness-edit-confirm.ts";

const REFUSAL = {
  error: "This edit moves Backup's config folder from /a to /b (the config mirror keeps 2 records for /a).",
  code: "mirror-records",
  folders: [{ what: "config folder", was: "/a", now: "/b", records: 2, savedOriginals: 0 }],
};

function refusedOnce() {
  const calls: boolean[] = [];
  const save = async (confirmMirrorDrop: boolean) => {
    calls.push(confirmMirrorDrop);
    if (!confirmMirrorDrop) throw new ApiError(REFUSAL.error, 409, REFUSAL);
  };
  return { calls, save };
}

test("a mirror-records refusal asks with the core's sentence and re-sends with the confirmation on a yes", async () => {
  const { calls, save } = refusedOnce();
  const asked: string[] = [];
  const outcome = await saveConfirmingMirrorDrop(save, async (refusal) => {
    asked.push(refusal.error);
    return true;
  });
  expect(outcome).toBe("saved");
  expect(asked).toEqual([REFUSAL.error]);
  expect(calls).toEqual([false, true]);
});

test("a cancel sends nothing more and reports cancelled", async () => {
  const { calls, save } = refusedOnce();
  const outcome = await saveConfirmingMirrorDrop(save, async () => false);
  expect(outcome).toBe("cancelled");
  expect(calls).toEqual([false]);
});

test("a save that is not refused never asks; any other failure is thrown as is", async () => {
  let asked = false;
  const ask = async () => {
    asked = true;
    return true;
  };
  expect(await saveConfirmingMirrorDrop(async () => {}, ask)).toBe("saved");
  const other = new ApiError("home must be absolute or null", 400, { error: "home must be absolute or null" });
  await expect(saveConfirmingMirrorDrop(async () => { throw other; }, ask)).rejects.toBe(other);
  const otherConflict = new ApiError("busy", 409, { error: "busy", code: "busy" });
  await expect(saveConfirmingMirrorDrop(async () => { throw otherConflict; }, ask)).rejects.toBe(otherConflict);
  expect(asked).toBe(false);
});

test("mirrorDropRefusal reads only a 409 mirror-records body", () => {
  expect(mirrorDropRefusal(new ApiError(REFUSAL.error, 409, REFUSAL))?.folders).toHaveLength(1);
  expect(mirrorDropRefusal(new ApiError("x", 400, REFUSAL))).toBeNull();
  expect(mirrorDropRefusal(new ApiError("x", 409, { error: "x", code: "stack-changed" }))).toBeNull();
  expect(mirrorDropRefusal(new Error("x"))).toBeNull();
});
