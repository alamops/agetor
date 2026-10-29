/**
 * Pure model for the confirm-on-quit dialog (docs/plans/always-on-host.md
 * §3.6, grill D6/D7/C20). `App.tsx` receives a `quit_request` AppEvent when
 * Cmd+Q / window close lands while runs are active; this turns it into the
 * dialog's title, body and buttons so the wording is unit-testable.
 *
 * Three cases:
 *   plain     — the plain app: today's sentence, [Quit anyway] [Stay open].
 *   armed     — a parked login-item supervisor will boot a background core
 *               when the app quits, so the tasks keep running there; offers
 *               [Quit] [Quit completely] [Cancel].
 *   completely — "Quit Agetor Completely": the background core stops too and
 *               running tasks stop; [Quit completely] [Cancel].
 */
import type { AppEvent } from "../../shared/types.ts";

export type QuitRequestEvent = Extract<AppEvent, { type: "quit_request" }>;

export type QuitDialogAction = "quit" | "quit-completely" | "cancel";

export interface QuitDialogModel {
  title: string;
  /** Sentences shown above the task-name preview. */
  body: string;
  /** Up to three running task titles, comma-joined with a trailing ellipsis
   *  when more are running; `null` when the event carried none. */
  titlesPreview: string | null;
  actions: QuitDialogAction[];
  /** Button text per action (only the ones in `actions` are rendered). */
  labels: Record<QuitDialogAction, string>;
}

export function quitTitlesPreview(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  return titles.slice(0, 3).join(", ") + (titles.length > 3 ? ", …" : "");
}

export function quitDialogModel(ev: QuitRequestEvent): QuitDialogModel {
  const n = ev.runningRunCount;
  const noun = n === 1 ? "task is" : "tasks are";
  const titlesPreview = quitTitlesPreview(ev.runningTaskTitles);
  if (ev.completely) {
    return {
      title: "Quit Agetor completely?",
      body: `${n} ${noun} still running. Quitting completely also stops the background core, so they will stop.`,
      titlesPreview,
      actions: ["quit", "cancel"],
      labels: { quit: "Quit completely", "quit-completely": "Quit completely", cancel: "Cancel" },
    };
  }
  if (ev.backgroundArmed) {
    return {
      title: "Quit Agetor?",
      body: `${n} ${noun} still running. They'll keep running in the background; you can reconnect to them next time you open Agetor.`,
      titlesPreview,
      actions: ["quit", "quit-completely", "cancel"],
      labels: { quit: "Quit", "quit-completely": "Quit completely", cancel: "Cancel" },
    };
  }
  return {
    title: "Quit Agetor?",
    body: `${n} ${noun} still running. They will keep running in the background; you can reconnect to them next time you open Agetor.`,
    titlesPreview,
    actions: ["quit", "cancel"],
    labels: { quit: "Quit anyway", "quit-completely": "Quit completely", cancel: "Stay open" },
  };
}
