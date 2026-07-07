import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, type GitHubItemKind, type GitHubItemState, type GitHubListResult } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { GitHubListItem, Project } from "../../../shared/types.ts";

interface Props {
  open: boolean;
  projects: Project[];
  initialProjectPath?: string | null;
  onClose: () => void;
}

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

const fmtDate = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
};

function splitLabels(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function GitHubDialog({ open, projects, initialProjectPath, onClose }: Props) {
  const [projectPath, setProjectPath] = useState("");
  const [kind, setKind] = useState<GitHubItemKind>("pulls");
  const [state, setState] = useState<GitHubItemState>("open");
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState("");
  const [result, setResult] = useState<GitHubListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setProjectPath((cur) => {
      if (initialProjectPath) return initialProjectPath;
      if (cur) return cur;
      return projects[0]?.path ?? "";
    });
  }, [open, initialProjectPath, projects]);

  const load = async (requestId = ++requestSeq.current) => {
    if (!projectPath) return;
    if (requestId !== requestSeq.current) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.listGitHubItems({
        path: projectPath,
        kind,
        state,
        query,
        labels: splitLabels(labels),
      });
      if (requestId !== requestSeq.current) return;
      setResult(next);
    } catch (e) {
      if (requestId !== requestSeq.current) return;
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    const requestId = ++requestSeq.current;
    if (!open || !projectPath) {
      setLoading(false);
      return;
    }
    const t = setTimeout(() => { void load(requestId); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, kind, state, query, labels]);

  const availableLabels = useMemo(() => {
    const names = new Set<string>();
    for (const item of result?.items ?? []) {
      for (const label of item.labels) names.add(label.name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [result]);

  const projectOptions = useMemo(() => {
    const opts = projects.map((p) => ({ path: p.path, label: p.name || basename(p.path) || p.path }));
    if (projectPath && !opts.some((p) => p.path === projectPath)) {
      opts.unshift({ path: projectPath, label: basename(projectPath) || projectPath });
    }
    return opts;
  }, [projects, projectPath]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="github-dialog-title"
      className="flex max-h-[86vh] w-full max-w-5xl flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="github-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
            GitHub
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {result ? (
              <>
                {result.repo}
                {result.auth === "none" && " · unauthenticated"}
              </>
            ) : (
              "Pull requests and issues"
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {result && (
            <Button
              size="icon"
              variant="ghost"
              title="Open repository on GitHub"
              aria-label="Open repository on GitHub"
              onClick={() => { void api.openExternal(result.webUrl); }}
            >
              <ExternalLink className="size-4" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            title="Refresh"
            aria-label="Refresh GitHub items"
            disabled={!projectPath || loading}
            onClick={() => { void load(); }}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </header>

      <div className="grid gap-2 border-b border-border/60 p-3 md:grid-cols-[minmax(0,1.2fr)_auto_auto]">
        <Select
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          title="Project"
          aria-label="Project"
        >
          {projectOptions.length === 0 && <option value="">No projects</option>}
          {projectOptions.map((p) => (
            <option key={p.path} value={p.path}>
              {p.label}
            </option>
          ))}
        </Select>
        <div className="flex rounded-md border border-input p-0.5">
          <Button
            size="sm"
            variant={kind === "pulls" ? "secondary" : "ghost"}
            className="h-7"
            onClick={() => setKind("pulls")}
          >
            PRs
          </Button>
          <Button
            size="sm"
            variant={kind === "issues" ? "secondary" : "ghost"}
            className="h-7"
            onClick={() => setKind("issues")}
          >
            Issues
          </Button>
        </div>
        <Select
          value={state}
          onChange={(e) => setState(e.target.value as GitHubItemState)}
          title="State"
          aria-label="State"
          className="h-8 text-xs"
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </Select>
        <div className="relative md:col-span-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, body, number, author…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          placeholder="Labels, comma separated"
          className="h-8 text-xs"
          list="github-dialog-labels"
        />
        <datalist id="github-dialog-labels">
          {availableLabels.map((label) => <option key={label} value={label} />)}
        </datalist>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!loading && error && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-rose-400">
            <AlertCircle className="size-4" /> {error}
          </div>
        )}

        {loading && !result && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading GitHub…
          </div>
        )}

        {!loading && !error && result && result.items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <GitPullRequest className="size-6 opacity-40" />
            No {kind === "pulls" ? "pull requests" : "issues"} match these filters.
          </div>
        )}

        {result && result.items.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="px-1 text-xs text-muted-foreground">
              {result.items.length} {kind === "pulls" ? "pull requests" : "issues"}
            </div>
            {result.items.map((item) => (
              <GitHubItemRow key={`${item.kind}-${item.number}`} item={item} />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function GitHubItemRow({ item }: { item: GitHubListItem }) {
  const stateClass = item.state === "open" ? "text-emerald-400" : "text-violet-400";
  return (
    <div className="rounded-md border border-border/60 bg-card">
      <div className="flex items-start gap-3 p-3">
        <GitPullRequest className={cn("mt-0.5 size-4 shrink-0", stateClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="min-w-0 truncate text-left text-sm font-medium hover:underline"
              onClick={() => { void api.openExternal(item.htmlUrl); }}
              title="Open on GitHub"
            >
              #{item.number} {item.title}
            </button>
            {item.draft && (
              <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                Draft
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{item.state}</span>
            {item.author && <span>by {item.author.login}</span>}
            <span>updated {fmtDate(item.updatedAt)}</span>
            {item.comments > 0 && (
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="size-3" />
                {item.comments}
              </span>
            )}
          </div>
          {item.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.labels.map((label) => (
                <span
                  key={label.name}
                  className="rounded border px-1.5 py-0.5 text-[11px]"
                  style={{
                    borderColor: label.color ? `#${label.color}` : undefined,
                    backgroundColor: label.color ? `#${label.color}22` : undefined,
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
          {item.body && (
            <div className="markdown-body mt-2 max-h-28 overflow-hidden text-xs text-muted-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {item.body}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          title="Open on GitHub"
          aria-label={`Open #${item.number} on GitHub`}
          onClick={() => { void api.openExternal(item.htmlUrl); }}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
    </div>
  );
}
