/**
 * Saving an account edit that moves the account away from a config folder the
 * config mirror keeps records and saved originals for: the core refuses the
 * PATCH with 409 `mirror-records` (the sentence names the account, the folder
 * and what is dropped), and the Settings editor asks before re-sending it with
 * `confirmMirrorDrop: true`. Kept out of the component so the
 * refuse → ask → retry / cancel flow is testable without a DOM.
 */
import type { HarnessEditMirrorRefusal } from "../../shared/types.ts";
import { ApiError } from "./api.ts";

/** The core's `mirror-records` refusal carried by a failed save, or null. */
export function mirrorDropRefusal(e: unknown): HarnessEditMirrorRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body;
  if (!body || typeof body !== "object") return null;
  const o = body as Partial<HarnessEditMirrorRefusal>;
  if (o.code !== "mirror-records" || typeof o.error !== "string") return null;
  return { error: o.error, code: "mirror-records", folders: Array.isArray(o.folders) ? o.folders : [] };
}

/**
 * Run `save` once without the confirmation; on a `mirror-records` refusal ask
 * `confirm` with the core's sentence and, only on a yes, run it again with
 * `confirmMirrorDrop`. Resolves "saved" or "cancelled" (nothing was written:
 * the refused PATCH changes nothing). Any other failure is thrown as is.
 */
export async function saveConfirmingMirrorDrop(
  save: (confirmMirrorDrop: boolean) => Promise<unknown>,
  confirm: (refusal: HarnessEditMirrorRefusal) => Promise<boolean>,
): Promise<"saved" | "cancelled"> {
  try {
    await save(false);
    return "saved";
  } catch (e) {
    const refusal = mirrorDropRefusal(e);
    if (!refusal) throw e;
    if (!(await confirm(refusal))) return "cancelled";
  }
  await save(true);
  return "saved";
}
