import { useState } from "react";
import { Smartphone } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { usePhoneTerminal } from "@/lib/phone-terminal";
import { Button } from "@/components/ui/button";

export interface PhoneAttachedBannerViewProps {
  taskTitle: string;
  deviceName: string;
  busy: boolean;
  onDetach(): void;
}

/**
 * "Phone attached to <task>", the phone's name and a Detach button (docs/architecture/run-panel.md). A phone's terminal is a second tmux client
 * on the task's session: the Mac's owner can always see that someone is in there and end it. Detach kills only that client, never the session.
 * The phone's name is plain text (it is supplied by the phone, cleaned by the core).
 */
export function PhoneAttachedBannerView({ taskTitle, deviceName, busy, onDetach }: PhoneAttachedBannerViewProps) {
  return (
    <div
      className="mt-1 flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning"
      data-testid="phone-attached-banner"
      role="status"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Smartphone className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          Phone attached to <span className="font-medium">{taskTitle}</span> · <span data-testid="phone-attached-device">{deviceName}</span>
        </span>
      </span>
      <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" data-testid="phone-attached-detach" disabled={busy} onClick={onDetach}>
        Detach
      </Button>
    </div>
  );
}

/**
 * The banner for the open task: reads the module store (no per-task state of its own beyond a `busy` flag, and the caller keys it by task id so
 * that flag resets on a task switch), renders nothing when no phone is attached to THIS task.
 */
export function PhoneAttachedBanner({ taskId, taskTitle }: { taskId: string; taskTitle: string }) {
  const entry = usePhoneTerminal(taskId);
  const [busy, setBusy] = useState(false);
  if (!entry) return null;
  return (
    <PhoneAttachedBannerView
      taskTitle={taskTitle}
      deviceName={entry.deviceName}
      busy={busy}
      onDetach={() => {
        setBusy(true);
        api
          .detachPhoneTerminal(taskId)
          .catch((e: unknown) => toast.error("Couldn't detach the phone", { description: e instanceof Error ? e.message : String(e) }))
          .finally(() => setBusy(false));
      }}
    />
  );
}
