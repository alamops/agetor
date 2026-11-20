import { icon } from "./icons.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const TYPES = {
  task: { icon: "inbox", label: "Task", iconClass: "text-info", border: "border-l-info" },
  bug: { icon: "bug", label: "Bug", iconClass: "text-danger", border: "border-l-danger" },
  spike: { icon: "flask-conical", label: "Spike", iconClass: "text-spike", border: "border-l-spike" },
};

// ---------------------------------------------------------------------------
// Shared constraints (identical in every alternative)

// One chip system: h-5, text-[10px], rounded-full, same padding; colour
// carries the meaning. Variable-length text truncates inside the chip.
const CHIP_BASE = "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full border px-2 text-[10px] font-medium leading-none whitespace-nowrap";
const CHIP_TONE = {
  neutral: "border-border text-muted-foreground",
  info: "border-info/40 text-info",
  warning: "border-warning/40 text-warning",
  success: "border-success/40 text-success",
  identity: "border-transparent bg-secondary text-secondary-foreground",
};
export function chip(tone, inner, { title = "", extra = "", testid = "" } = {}) {
  return `<span class="${CHIP_BASE} ${CHIP_TONE[tone]} ${extra}"${title ? ` title="${esc(title)}"` : ""}${testid ? ` data-testid="${testid}"` : ""}>${inner}</span>`;
}
const countChips = (s) => (s.counts ?? []).map((c) => chip(c.tone, `${icon(c.icon, "size-3 shrink-0")}<span class="truncate">${esc(c.text)}</span>`, { title: c.title })).join("");
const stackChip = (s, extra = "") => s.stack ? chip(s.stack.tone, `<span class="truncate">${esc(s.stack.text)}</span>`, { title: "Account stack", extra, testid: "task-card-stack-badge" }) : "";
const agentChip = (s, extra = "") => s.agent ? chip("identity", `${icon(s.agent.kind, "size-3 shrink-0")}<span class="truncate">${esc(s.agent.name)}</span>`, { title: s.agent.profile ? "cursor (profile)" : s.agent.name, extra, testid: s.agent.profile ? "task-card-agent-profile" : "" }) : "";
const typeIcon = (s, cls) => { const t = TYPES[s.type]; return icon(t.icon, `${cls} ${t.iconClass}`, `role="img" aria-label="${t.label}"`); };

const BTN = "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card";
const BTN_V = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
  // Card-local: the shared `destructive` token is 3.61:1 with white text in
  // light mode (below AA); `--danger` is 4.7:1 light and passes dark too.
  destructive: "bg-danger text-danger-foreground hover:bg-danger/90",
  answer: "bg-warning-solid text-warning-solid-foreground hover:bg-warning-solid/90",
};
const btn = (v, label, ic) => `<button type="button" class="${BTN} ${BTN_V[v]}">${ic ? icon(ic, "size-3.5 shrink-0") : ""}${label}</button>`;
const ACTIONS = {
  run: () => btn("primary", "Run", "play"),
  stop: () => btn("destructive", "Stop", "square"),
  answer: () => btn("answer", `Answer (12)${icon("arrow-right", "size-3.5 shrink-0")}`, "message-circle-question"),
  "answer-review": () => btn("answer", `Review${icon("arrow-right", "size-3.5 shrink-0")}`, "message-circle-question"),
  open: () => btn("secondary", "Open", "folder-open"),
  done: () => btn("outline", "Done", "circle-check"),
  review: () => btn("primary", "Review", "user-check"),
};
const moreBtn = `<button type="button" aria-label="More actions" aria-haspopup="menu" title="More actions" class="${BTN} ml-auto w-7 border border-input px-0 text-foreground hover:bg-accent hover:text-accent-foreground">${icon("ellipsis", "size-4")}</button>`;
const actionRow = (s) => `<div class="flex items-center gap-1.5" data-part="actions">${s.actions.map((a) => ACTIONS[a]()).join("")}${moreBtn}</div>`;

const HAT_TONE = {
  running: "bg-info/10 text-info border-info/25",
  review: "bg-info/10 text-info border-info/25",
  blocked: "bg-warning/10 text-warning border-warning/30",
  done: "bg-success/10 text-success border-success/25",
  cancelled: "bg-muted text-muted-foreground border-border",
};
// The hat: full-width, status-tinted, full pipeline name that wraps (never
// truncated), progress on the right (never truncated), active step / gate
// line at the bottom. Its top corners follow the card's inner radius
// (8 px outer − 4 px left border / 1 px top border).
function hat(s) {
  const p = s.pipeline;
  const step = p.step
    ? `<div class="flex items-start gap-1.5 text-[11px] font-medium leading-4">${icon(p.step.icon, "mt-0.5 size-3 shrink-0")}<span class="min-w-0 [overflow-wrap:anywhere]">${esc(p.step.text)}</span></div>`
    : "";
  return `<div data-part="hat" data-testid="task-card-pipeline" class="flex flex-col gap-1 rounded-tl-[4px_7px] rounded-tr-[7px] border-b px-3 py-2 ${HAT_TONE[p.status]}" title="${esc(`${p.name} — ${p.progress} · ${p.runs}`)}">
    <div class="flex items-start gap-1.5">${icon("workflow", "mt-0.5 size-3.5 shrink-0")}<span data-must-not-truncate class="min-w-0 flex-1 text-xs font-semibold leading-[18px] [overflow-wrap:anywhere]">${esc(p.name)}</span><span data-must-not-truncate class="shrink-0 text-xs font-semibold leading-[18px] tabular-nums">${esc(p.progress)}</span></div>
    ${step}
  </div>`;
}
const title = (s, before = "") => `<h3 data-part="title" data-must-not-truncate class="text-sm font-semibold leading-snug text-card-foreground [overflow-wrap:anywhere]">${before}${esc(s.title)}</h3>`;
const preview = (s) => s.preview ? `<p data-part="preview" class="line-clamp-2 text-xs leading-normal text-muted-foreground">${esc(s.preview)}</p>` : "";
function metaLine(s) {
  if (s.multi) {
    return `<div data-part="meta" class="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground" title="${esc(s.multi.names)}">${icon("git-fork", "size-3 shrink-0")}<span class="shrink-0 font-medium">${s.multi.count} repositories</span><span class="min-w-0 truncate">· ${esc(s.multi.names)}</span></div>`;
  }
  const m = s.meta;
  const drift = m.drift ? chip(m.drift.tone, esc(m.drift.text), { extra: "shrink-0 font-sans", testid: "task-card-branch-drift" }) : "";
  return `<div data-part="meta" class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[10px] text-muted-foreground" title="${esc(`~/Projects/acme/${m.repo}\n${m.branch}\nbase a1b2c3d`)}"><span class="flex min-w-[10rem] flex-1 basis-0 items-center gap-1">${icon("git-branch", "size-3 shrink-0")}<span class="max-w-[45%] shrink-0 truncate">${esc(m.repo)}</span><span class="shrink-0" aria-hidden="true">·</span><span class="min-w-0 flex-1 truncate">${esc(m.branch)}</span></span>${drift}</div>`;
}
const AWAITING_RING = "ring-2 ring-warning/60 ring-offset-2 ring-offset-background";
function cardShell(s, alt, inner) {
  const t = TYPES[s.type];
  const cls = [
    "card-under-test relative cursor-grab select-none rounded-lg border border-border/60 border-l-4 bg-card text-card-foreground shadow-sm transition-colors hover:border-border",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    t.border, s.awaiting ? AWAITING_RING : "", s.archived ? "cursor-default opacity-60" : "",
  ].join(" ");
  const dot = s.unread ? `<span data-bounds-exempt="unread dot sits on the corner by design" class="absolute -right-1.5 -top-1.5 z-10 size-2.5 rounded-full bg-info ring-2 ring-background" role="img" aria-label="New messages" title="New messages"></span>` : "";
  const glow = s.awaiting ? `<span data-bounds-exempt="awaiting glow paints outside by design" aria-hidden="true" class="pointer-events-none absolute inset-0 rounded-[inherit] animate-awaiting-pulse motion-reduce:animate-none" style="box-shadow:0 0 14px hsl(var(--warning) / 0.85)"></span>` : "";
  return `<div class="${cls}" role="group" aria-roledescription="draggable task" aria-label="${esc(s.title)}" tabindex="0" data-alt="${alt}" data-state="${s.id}"${s.archived ? ' data-contrast-exempt="archived cards are dimmed by design"' : ""}>${dot}${inner}${glow}</div>`;
}

// ---------------------------------------------------------------------------
// Alternative A: "Meta footer". Row 1 = type + count chips, stack chip right.
// Identity (agent / profile · model · mode) moves into a footer meta block.
export function renderA(s) {
  const head = `<div data-part="row1" class="flex items-start gap-2"><div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">${typeIcon(s, "mr-0.5 size-3.5 shrink-0")}${countChips(s)}</div>${stackChip(s, "shrink-0")}</div>`;
  const ident = (s.agent || s.model)
    ? `<div data-part="identity" class="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title="${esc([s.agent?.name, s.model].filter(Boolean).join(" · "))}">${s.agent ? icon(s.agent.kind, "size-3 shrink-0") : ""}<span class="min-w-0 truncate">${s.agent ? `<span class="font-medium text-foreground">${esc(s.agent.name)}</span> · ` : ""}<span class="font-mono">${esc(s.model ?? "")}</span></span></div>`
    : "";
  const body = `<div class="flex flex-col gap-2 p-3">${head}${title(s)}${preview(s)}<div class="flex flex-col gap-1">${ident}${metaLine(s)}</div>${actionRow(s)}</div>`;
  return cardShell(s, "A", (s.pipeline ? hat(s) : "") + body);
}

// Alternative B: "Identity header". Row 1 = type + agent chip + model·mode
// (truncates first) + stack chip; row 2 = count chips, only when there are any.
export function renderB(s) {
  const model = s.model ? `<span class="min-w-[4.5rem] flex-1 shrink-[4] truncate font-mono text-[10px] text-muted-foreground" title="${esc(s.model)}">${esc(s.model)}</span>` : `<span class="flex-1"></span>`;
  const row1 = `<div data-part="row1" class="flex min-w-0 items-center gap-1.5">${typeIcon(s, "size-3.5 shrink-0")}${agentChip(s, "shrink min-w-[4.5rem]")}${model}</div>`;
  const row2 = (s.stack || s.counts?.length) ? `<div data-part="row2" class="flex flex-wrap items-center gap-1">${stackChip(s)}${countChips(s)}</div>` : "";
  const body = `<div class="flex flex-col gap-2 p-3">${row1}${row2}${title(s)}${preview(s)}${metaLine(s)}${actionRow(s)}</div>`;
  return cardShell(s, "B", (s.pipeline ? hat(s) : "") + body);
}

// Alternative C: "Title first". Type icon inline before the title; then one
// wrapping chip row (agent, model·mode, stack, counts) with no
// justify-between, so it has no fixed right side to collide with.
export function renderC(s) {
  const modelChip = s.model ? chip("neutral", `<span class="truncate font-mono">${esc(s.model)}</span>`, { title: s.model }) : "";
  const chipsRow = `<div data-part="chips" class="flex flex-wrap items-center gap-1">${agentChip(s)}${modelChip}${stackChip(s)}${countChips(s)}</div>`;
  const body = `<div class="flex flex-col gap-2 p-3">${title(s, typeIcon(s, "mr-1.5 inline-block size-3.5 align-[-2px]"))}${chipsRow}${preview(s)}${metaLine(s)}${actionRow(s)}</div>`;
  return cardShell(s, "C", (s.pipeline ? hat(s) : "") + body);
}

// ---------------------------------------------------------------------------
// Today's card (TaskCard.tsx at 4d7f8bfb), as the control: the checker must
// fail it on the screenshot's states, or the checker proves nothing.
export function renderToday(s) {
  const t = TYPES[s.type];
  const badgeOutline = "inline-flex items-center rounded-full border px-2.5 py-0.5 font-semibold transition-colors text-foreground gap-1 text-[10px] shrink-0";
  const counts = (s.counts ?? []).map((c) => `<div class="${badgeOutline} ${c.tone === "warning" ? "text-warning border-warning/40" : ""}">${icon(c.icon, "size-3")}${esc(c.text)}</div>`).join("");
  let right;
  if (s.pipeline) {
    const tone = { running: "bg-info/10 text-info", review: "bg-info/10 text-info", blocked: "bg-warning/10 text-warning", done: "bg-success/10 text-success", cancelled: "bg-muted text-muted-foreground" }[s.pipeline.status];
    const label = s.pipeline.today ?? s.pipeline.progress;
    right = `<div class="items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors bg-secondary text-secondary-foreground inline-flex min-w-0 max-w-full gap-1.5 border-transparent font-normal ${tone} shrink-0">${icon("workflow", "size-3 shrink-0")}<span class="min-w-0 truncate">${esc(s.pipeline.name)}</span><span class="shrink-0 opacity-80">${esc(label)}</span></div>`;
  } else {
    right = `<div class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors border-transparent bg-secondary text-secondary-foreground gap-1 shrink-0">${icon(s.agent.kind, "size-3")}${esc(s.agent.name)}</div>`;
  }
  const stack = s.stack ? `<span class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${s.stack.tone === "warning" ? "border-warning/40 text-warning" : "border-info/40 text-info"} shrink-0">${esc(s.stack.text)}</span>` : "";
  const sm = "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors h-8 rounded-md px-3 text-xs";
  const ic = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors hover:bg-accent h-9 w-9";
  const btns = {
    run: `<button class="${sm} bg-primary text-primary-foreground">${icon("play", "size-3")} Run</button>`,
    stop: `<button class="${sm} bg-destructive text-destructive-foreground">${icon("square", "size-3")} Stop</button>`,
    open: `<button class="${sm} bg-secondary text-secondary-foreground">${icon("folder-open", "size-3")} Open</button>`,
    done: `<button class="${sm} border border-input bg-background">${icon("circle-check", "mr-1 size-3")} Done</button>`,
    review: `<button class="${sm} bg-primary text-primary-foreground">${icon("user-check", "mr-1 size-3")} Review</button>`,
    answer: `<button class="${sm} gap-1 bg-amber-500 text-amber-950">${icon("message-circle-question", "size-3")}Answer (12)${icon("arrow-right", "size-3")}</button>`,
    "answer-review": `<button class="${sm} gap-1 bg-amber-500 text-amber-950">${icon("message-circle-question", "size-3")}Review${icon("arrow-right", "size-3")}</button>`,
    gate: `<button class="${sm} bg-secondary text-secondary-foreground">${icon("folder-open", "size-3")} Open</button><button class="${sm} bg-primary text-primary-foreground">${icon("user-check", "mr-1 size-3")} Review</button><button class="${sm} border bg-background border-destructive/40 text-destructive">${icon("square", "size-3")} Stop</button>`,
  };
  const row = s.id === "pipe-gate" ? btns.gate : s.actions.filter((a) => a !== "review").map((a) => btns[a]).join("");
  const icons = `${s.awaiting ? `<button class="${ic}" title="Stop">${icon("square", "size-3")}</button><button class="${ic}" title="Archive">${icon("archive", "size-3")}</button>` : ""}<button class="${ic}" title="View changes (git diff)">${icon("git-compare", "size-3")}</button><button class="${ic}" title="Delete task">${icon("trash-2", "size-3")}</button>`;
  const meta = s.multi ? "" : `<p class="text-[10px] text-muted-foreground/70 font-mono truncate">~/Projects/acme/${esc(s.meta.repo)}</p><div class="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">${icon("git-branch", "size-3 shrink-0")}<span class="truncate">${esc(s.meta.branch)}</span>${s.meta.drift ? `<span class="shrink-0 rounded px-1 font-sans font-medium bg-info/15 text-info">${esc(s.meta.drift.text)}</span>` : ""}</div>`;
  const dot = s.unread ? `<span data-bounds-exempt="unread dot" class="absolute -top-1.5 -right-1.5 size-2.5 rounded-full bg-info ring-2 ring-background"></span>` : "";
  const inner = `${dot}<div class="flex flex-col space-y-1.5 p-4 pb-2 space-y-1"><div class="flex items-center justify-between gap-2"><div class="flex min-w-0 flex-wrap items-center gap-1.5">${icon(t.icon, `size-3.5 shrink-0 ${t.iconClass}`)}${counts}</div>${right}${stack}</div><span class="self-end text-[10px] font-mono text-muted-foreground">${esc(s.model ?? "")}</span><div class="font-semibold leading-none tracking-tight text-sm break-words">${esc(s.title)}</div></div><div class="p-4 pt-0 space-y-2"><p class="text-xs text-muted-foreground line-clamp-2">${esc(s.rawPrompt ?? s.preview)}</p>${meta}<div class="flex gap-1">${row}${icons}</div></div>`;
  return `<div class="card-under-test relative cursor-grab select-none rounded-lg border bg-card text-card-foreground shadow-sm border-border/60 border-l-4 ${t.border} ${s.awaiting ? AWAITING_RING : ""}" role="button" tabindex="0" data-alt="today" data-state="${s.id}">${inner}</div>`;
}

// ---------------------------------------------------------------------------
// Refinements of C after the owner's pick ("the chips under the title get
// polluted"). Identity becomes one quiet text line, not two chips. Activity
// counts become plain icon + number stats, not bordered pills. Only states
// that carry a meaning a colour must signal keep a chip: the account stack
// and an fx pause (and the branch drift chip on the meta line).
function identityLine(s) {
  if (!s.agent && !s.model) return "";
  const t = [s.agent?.name, s.model].filter(Boolean).join(" · ");
  return `<div data-part="identity" class="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground" title="${esc(t)}">${s.agent ? icon(s.agent.kind, "size-3 shrink-0") : ""}<span class="min-w-0 truncate">${s.agent ? `<span class="font-medium text-foreground">${esc(s.agent.name)}</span><span aria-hidden="true"> · </span>` : ""}<span class="font-mono text-[10px]">${esc(s.model ?? "")}</span></span></div>`;
}
const stat = (c) => `<span class="inline-flex shrink-0 items-center gap-1 text-[11px] leading-4 tabular-nums text-muted-foreground" title="${esc(c.title)}">${icon(c.icon, "size-3 shrink-0")}${esc(c.text)}</span>`;
function statusRow(s) {
  const plain = (s.counts ?? []).filter((c) => c.tone !== "warning");
  const loud = (s.counts ?? []).filter((c) => c.tone === "warning");
  if (!plain.length && !loud.length && !s.stack) return "";
  const chips = stackChip(s) + loud.map((c) => chip(c.tone, `${icon(c.icon, "size-3 shrink-0")}<span class="truncate">${esc(c.text)}</span>`, { title: c.title })).join("");
  return `<div data-part="status" class="flex flex-wrap items-center gap-x-2.5 gap-y-1">${plain.map(stat).join("")}${chips}</div>`;
}
const titleWithIcon = (s) => title(s, typeIcon(s, "mr-1.5 inline-block size-3.5 align-[-2px]"));

// C1: under the title, one identity line and one status line.
export function renderC1(s) {
  const body = `<div class="flex flex-col gap-2 p-3">${titleWithIcon(s)}<div class="flex flex-col gap-1">${identityLine(s)}${statusRow(s)}</div>${preview(s)}${metaLine(s)}${actionRow(s)}</div>`;
  return cardShell(s, "C1", (s.pipeline ? hat(s) : "") + body);
}

// C2: nothing between title and preview; identity, status and repo · branch
// form one meta block above the buttons.
export function renderC2(s) {
  const body = `<div class="flex flex-col gap-2 p-3">${titleWithIcon(s)}${preview(s)}<div class="flex flex-col gap-1">${statusRow(s)}${identityLine(s)}${metaLine(s)}</div>${actionRow(s)}</div>`;
  return cardShell(s, "C2", (s.pipeline ? hat(s) : "") + body);
}
