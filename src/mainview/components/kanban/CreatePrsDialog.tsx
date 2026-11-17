import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, GitPullRequest, Loader2, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { RunEvent, Task } from "../../../shared/types.ts";
import type { TaskGitStatus } from "@/lib/commit-push";
import { loadProviderIdentity } from "@/lib/provider-info-cache";
import {
  buildPrPlan,
  editPrRow,
  planReposForTask,
  prRowSlug,
  runPrBatch,
  type PrBaseSource,
  type PrRow,
  type PrRowResult,
} from "@/lib/pr-plan";

const BASE_SOURCE_LABEL: Record<PrBaseSource, string> = {
  task: "from the task",
  agent: "from the agent",
  default: "remote default",
  user: "you picked it",
};

/** How many rows would be created right now. */
export function creatableRowCount(rows: readonly PrRow[]): number {
  return rows.filter((r) => r.checked && r.disabledReason === null).length;
}

/** Whether Create is blocked: nothing to create, or a checked row's base is invalid. */
export function createBlocked(rows: readonly PrRow[]): boolean {
  const n = creatableRowCount(rows);
  return n === 0 || rows.some((r) => r.checked && r.disabledReason === null && r.baseError !== null);
}

export interface CreatePrsDialogViewProps {
  open: boolean;
  onClose: () => void;
  phase: "planning" | "ready" | "error";
  error: string | null;
  rows: PrRow[];
  results: Record<string, PrRowResult>;
  running: boolean;
  /** The walk finished: the dialog now only offers Close. */
  finished: boolean;
  onEdit: (key: string, patch: { checked?: boolean; base?: string; title?: string }) => void;
  onSubmit: () => void;
}

/** A link target is only ever an http(s) URL (a forge's answer is shown as a link). */
function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function ResultLine({ result, slug }: { result: PrRowResult; slug: string }) {
  const testId = `create-prs-result-${slug}`;
  switch (result.status) {
    case "creating":
      return (
        <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={testId}>
          <Loader2 className="size-3 animate-spin" /> Creating…
        </p>
      );
    case "created":
      return (
        <p className="flex items-center gap-1 text-xs text-success" data-testid={testId}>
          Created ·{" "}
          {safeHref(result.url) ? (
            <a className="inline-flex items-center gap-1 underline" href={safeHref(result.url)!} target="_blank" rel="noreferrer">
              View <ExternalLink className="size-3" />
            </a>
          ) : (
            "done"
          )}
        </p>
      );
    case "already-open":
      return (
        <p className="text-xs text-info" data-testid={testId}>
          Already open
          {safeHref(result.url) ? (
            <>
              {" · "}
              <a className="underline" href={safeHref(result.url)!} target="_blank" rel="noreferrer">
                View
              </a>
            </>
          ) : null}
        </p>
      );
    case "failed":
      return (
        <p className="text-xs text-danger" data-testid={testId}>
          Failed: {result.error}
        </p>
      );
    case "skipped":
      return (
        <p className="text-xs text-warning" data-testid={testId}>
          Skipped: {result.reason}
        </p>
      );
  }
}

/**
 * The confirm list behind Create all PRs: one row per pull request it would
 * open (checkbox, head → base picker, title, description preview, hints), then
 * a per-row status while it runs. Static-renderable (the container owns every
 * effect), like `SelectProjectsDialog`. The base picker is a native `<select>`:
 * a popover inside a dialog would need the Escape / `data-popover-open` contract
 * (docs/architecture/prompt-composer.md) for no gain.
 */
export function CreatePrsDialogView(props: CreatePrsDialogViewProps) {
  const { open, onClose, phase, error, rows, results, running, finished, onEdit, onSubmit } = props;
  const n = creatableRowCount(rows);
  const locked = running || finished;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="create-prs-dialog-title"
      closeOnBackdrop={false}
      className="w-[44rem] max-w-[94vw]"
    >
      <div data-testid="create-prs-dialog" className="flex max-h-[80vh] flex-col gap-3">
        <div className="min-w-0">
          <h2 id="create-prs-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitPullRequest className="h-4 w-4" /> Create pull requests
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One pull request per row. The title, description and base come from the agent&apos;s proposals and the
            branch the task started from; change anything before you create.
          </p>
        </div>

        {phase === "planning" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="create-prs-loading">
            <Loader2 className="size-4 animate-spin" /> Checking the remotes…
          </p>
        )}
        {phase === "error" && (
          <p className="text-sm text-danger" data-testid="create-prs-error">
            {error ?? "Couldn't plan the pull requests."}
          </p>
        )}
        {phase === "ready" && rows.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="create-prs-empty">
            Every branch already has a pull request.
          </p>
        )}

        {phase === "ready" && rows.length > 0 && (
          <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
            {rows.map((row) => {
              const slug = prRowSlug(row.repoName, row.head);
              const result = results[row.key];
              return (
                <li
                  key={row.key}
                  data-testid={`create-prs-row-${slug}`}
                  className="rounded-md border border-border bg-card p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Create a pull request for ${row.repoName} ${row.head}`}
                      data-testid={`create-prs-check-${slug}`}
                      checked={row.checked}
                      disabled={row.disabledReason !== null || locked}
                      onChange={(e) => onEdit(row.key, { checked: e.target.checked })}
                    />
                    <span className="min-w-0 truncate text-xs font-medium" title={row.head}>
                      {row.repoName} · <span className="font-mono">{row.head || "(not pushed yet)"}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">→</span>
                    <div className="min-w-0 flex-1">
                      <Select
                        aria-label={`Base branch for ${row.repoName} ${row.head}`}
                        data-testid={`create-prs-base-${slug}`}
                        className="h-8 font-mono text-xs"
                        value={row.base}
                        disabled={row.disabledReason !== null || locked}
                        onChange={(e) => onEdit(row.key, { base: e.target.value })}
                      >
                        {row.base === "" && <option value="">Pick a base branch…</option>}
                        {row.baseOptions.map((o) => (
                          <option key={o.name} value={o.name}>
                            {o.name}
                            {o.onRemote === false ? ` (not on ${row.remote ?? "origin"})` : ""}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {row.base !== "" && (
                      <Badge variant="outline" className="shrink-0 text-[10px]" data-testid={`create-prs-base-source-${slug}`}>
                        {BASE_SOURCE_LABEL[row.baseSource]}
                      </Badge>
                    )}
                  </div>

                  <Input
                    className="mt-2 h-8 text-xs"
                    aria-label={`Title for ${row.repoName} ${row.head}`}
                    data-testid={`create-prs-title-${slug}`}
                    value={row.title}
                    disabled={row.disabledReason !== null || locked}
                    onChange={(e) => onEdit(row.key, { title: e.target.value })}
                  />
                  {row.body && (
                    <details className="mt-1.5" data-testid={`create-prs-body-${slug}`}>
                      <summary className="cursor-pointer text-xs text-muted-foreground">Description</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                        {row.body}
                      </pre>
                    </details>
                  )}

                  {row.disabledReason && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-warning" data-testid={`create-prs-disabled-${slug}`}>
                      <TriangleAlert className="size-3" /> {row.disabledReason}
                    </p>
                  )}
                  {row.baseError && !row.disabledReason && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-danger" data-testid={`create-prs-base-error-${slug}`}>
                      <TriangleAlert className="size-3" /> {row.baseError}
                    </p>
                  )}
                  {row.hints.map((hint) => (
                    <p key={hint} className="mt-1 text-xs text-muted-foreground" data-testid={`create-prs-hint-${slug}`}>
                      {hint}
                    </p>
                  ))}
                  {result && <ResultLine result={result} slug={slug} />}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose} data-testid="create-prs-close">
            {finished ? "Close" : "Cancel"}
          </Button>
          {!finished && (
            <Button
              size="sm"
              onClick={onSubmit}
              disabled={phase !== "ready" || running || createBlocked(rows)}
              data-testid="create-prs-submit"
            >
              {running ? (
                <>
                  <Loader2 className="mr-1 size-3 animate-spin" /> Creating…
                </>
              ) : (
                `Create ${n} pull request${n === 1 ? "" : "s"}`
              )}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export interface CreatePrsDialogProps {
  open: boolean;
  task: Task;
  events: RunEvent[];
  /** RunPanel's batched git status; a multi-repo task's per-repository entries are in `.repositories`. */
  gitStatus: TaskGitStatus | null;
  onClose: () => void;
  /** The walk finished: refetch the task so its `prs` (and the header link) update at once. */
  onPrsStamped: (taskId: string) => void;
}

/**
 * Plans the pull requests when it opens (`buildPrPlan`, reading each
 * repository's remote through `GET /github/pull-targets`), lets the user edit
 * the rows, then runs the batch. Closing mid-walk doesn't stop it: the walk is
 * module-owned (`runPrBatch`), and a result that lands after the dialog
 * unmounts is dropped.
 */
export function CreatePrsDialog({ open, task, events, gitStatus, onClose, onPrsStamped }: CreatePrsDialogProps) {
  const [phase, setPhase] = useState<"planning" | "ready" | "error">("planning");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PrRow[]>([]);
  const [results, setResults] = useState<Record<string, PrRowResult>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const aliveRef = useRef(true);
  // The inputs a plan was built from are read at open time only: re-planning
  // under the user's hands as the 5 s git poll ticks would discard their edits.
  const inputsRef = useRef({ task, events, gitStatus });
  inputsRef.current = { task, events, gitStatus };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("planning");
    setError(null);
    setResults({});
    setFinished(false);
    void (async () => {
      const { task: t, events: ev, gitStatus: gs } = inputsRef.current;
      try {
        // A step task's PRs carry the pipeline's root title, not the step's.
        let rootTitle = t.title;
        if (t.pipelineParentId) {
          try {
            rootTitle = (await api.getTask(t.pipelineParentId)).title;
          } catch {
            /* the step's own title is the fallback */
          }
        }
        const planned = await buildPrPlan(
          {
            taskId: t.id,
            repos: planReposForTask(t, gs),
            events: ev,
            rootTitle,
            issueUrl: t.issueUrl ?? null,
            multi: t.multiRepo ?? (t.repositories?.length ?? 0) > 1,
          },
          {
            providerInfo: loadProviderIdentity,
            pullTargets: async (q) => api.getPullTargets(q),
          },
        );
        if (cancelled) return;
        setRows(planned);
        setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onEdit = useCallback((key: string, patch: { checked?: boolean; base?: string; title?: string }) => {
    setRows((cur) => cur.map((r) => (r.key === key ? editPrRow(r, patch) : r)));
  }, []);

  const onSubmit = useCallback(async () => {
    setRunning(true);
    setResults({});
    const taskId = task.id;
    const summary = await runPrBatch(taskId, rows, {
      createPull: async (row) => {
        const res = await api.createGitHubPull({
          path: row.projectPath,
          title: row.title,
          head: row.head,
          base: row.base,
          body: row.body,
          taskId,
        });
        return { url: res.item.htmlUrl };
      },
      onResult: (key, result) => {
        if (aliveRef.current) setResults((cur) => ({ ...cur, [key]: result }));
      },
    });
    if (summary.busy) {
      toast("Pull requests are already being created for this task");
      if (aliveRef.current) setRunning(false);
      return;
    }
    const parts: string[] = [];
    if (summary.created > 0) parts.push(`${summary.created} created`);
    if (summary.alreadyOpen > 0) parts.push(`${summary.alreadyOpen} already open`);
    if (summary.failed.length > 0) parts.push(`${summary.failed.length} failed`);
    const text = parts.join(", ") || "Nothing to create";
    if (summary.failed.length > 0) toast.error(`Pull requests: ${text}`, { description: summary.failed.join("; ") });
    else toast.success(`Pull requests: ${text}`);
    if (aliveRef.current) {
      setRunning(false);
      setFinished(true);
    }
    // Pull the stamped PRs now rather than waiting for the board poll.
    onPrsStamped(taskId);
  }, [rows, task.id, onPrsStamped]);

  return (
    <CreatePrsDialogView
      open={open}
      onClose={onClose}
      phase={phase}
      error={error}
      rows={rows}
      results={results}
      running={running}
      finished={finished}
      onEdit={onEdit}
      onSubmit={() => void onSubmit()}
    />
  );
}
