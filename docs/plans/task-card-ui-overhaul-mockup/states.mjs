// Worst-case card content, taken from the grill record (decision #3) and the
// investigation's prod string lengths. Every string here is synthetic.
const TITLE_128 = (() => {
  const t = "Refactor src/mainview/components/kanban/TaskCard.tsx so the pipeline hat, chips and action row never overflow the narrow card";
  if (t.length > 128) return t.slice(0, 128);
  return t.padEnd(128, "!");
})();
export const LONG_TITLE = TITLE_128;
const PROFILE_25 = "Exemplars Helper (Cursor)";
const MODEL_38 = "opencode-go/deepseek-v4.1-flash · auto";
const PIPE_26 = "My Implementation Pipeline";
const STEP_60 = "Code Review against the investigation brief and grill record";

const ALL_COUNTS = [
  { icon: "bot", text: "3", tone: "neutral", title: "3 background tasks running" },
  { icon: "terminal", text: "2", tone: "neutral", title: "2 open terminals" },
  { icon: "list-todo", text: "7/12", tone: "neutral", title: "7 of 12 tasks done" },
  { icon: "paperclip", text: "4", tone: "neutral", title: "4 files sent" },
  { icon: "pause-circle", text: "auto-resume 4:59", tone: "warning", title: "fx paused" },
];

export const STATES = [
  {
    id: "backlog", label: "Backlog · minimal", type: "task",
    agent: { kind: "sparkles", name: "claude-code" }, model: "opus-5.5 · auto",
    title: "Fix login redirect loop",
    preview: "The login page sends the user back to itself after a successful sign-in when the session cookie is set on a subdomain.",
    meta: { repo: "web-dashboard", branch: "(not yet created)", title: "~/Projects/acme/web-dashboard" },
    actions: ["run"],
  },
  {
    id: "ready-worst", label: "Ready · every badge, long profile, 128-char title", type: "bug",
    agent: { kind: "sparkles", name: PROFILE_25, profile: true }, model: MODEL_38,
    stack: { text: "1/2", tone: "info" }, counts: ALL_COUNTS,
    title: TITLE_128,
    preview: "Every child of the card must stay inside the card box in every state, with the longest names we have seen in a real database.",
    meta: { repo: "agetor-companion-mobile-app", branch: "agetor/1f2e3d4c-refactor-taskcard-so-the-pipeline-hat-chips", drift: { text: "not on PR head", tone: "warning" } },
    actions: ["run"],
  },
  {
    id: "running", label: "Running · switch scheduled", type: "spike",
    agent: { kind: "sparkles", name: "claude-backup" }, model: "opus-5.5 · auto",
    stack: { text: "⇄ switch scheduled", tone: "info" },
    counts: [ALL_COUNTS[0], ALL_COUNTS[2]],
    title: "Spike: can WKWebView lay out the card like Chromium?",
    preview: "Measure the same markup in Playwright WebKit and Chromium and compare every bounding box.",
    meta: { repo: "agetor", branch: "agetor/9a8b7c6d-spike-wkwebview-layout" },
    actions: ["stop"],
  },
  {
    id: "awaiting", label: "Awaiting · Answer (12), unread", type: "task",
    agent: { kind: "sparkles", name: PROFILE_25, profile: true }, model: MODEL_38,
    stack: { text: "⏳ 2/3", tone: "warning" }, counts: ALL_COUNTS,
    title: TITLE_128, unread: true, awaiting: true,
    preview: "The agent asked twelve questions about the layout contract and is waiting for your answers before it continues.",
    meta: { repo: "agetor", branch: "fix/agetor-card-ui-improvement" },
    actions: ["answer"],
  },
  {
    id: "review", label: "Review · drifted branch", type: "task",
    agent: { kind: "sparkles", name: "codex" }, model: "gpt-6-codex · auto",
    title: "Add keyboard dragging between board columns",
    preview: "Space picks the card up, the arrow keys move it to the next column, and Escape puts it back.",
    meta: { repo: "agetor", branch: "feature/keyboard-drag-between-columns", drift: { text: "drifted", tone: "info" } },
    actions: ["open", "done"],
  },
  {
    id: "done", label: "Done", type: "bug",
    agent: { kind: "sparkles", name: "claude-code" }, model: "sonnet-5.5 · plan",
    title: "Dark-mode Done button looks like a hole",
    preview: "The outline variant paints the page background, which is darker than the card in dark mode.",
    meta: { repo: "agetor", branch: "fix/done-button-dark" },
    actions: ["open"],
  },
  {
    id: "archived", label: "Archived", type: "task", archived: true,
    agent: { kind: "sparkles", name: "gemini" }, model: "gemini-3.5-pro · auto",
    title: "Old experiment with a wider board column",
    preview: "Columns at w-80 hid the overflow without fixing it.",
    meta: { repo: "agetor", branch: "spike/wider-columns" },
    actions: ["open"],
  },
  {
    id: "multi-repo", label: "Multi-repository", type: "task",
    agent: { kind: "sparkles", name: "claude-code" }, model: "opus-5.5 · auto",
    title: "Rename the shared task type across the API, web and mobile apps",
    preview: "One task, three worktrees, one branch name in each repository.",
    multi: { count: 3, names: "api-gateway, web-dashboard, mobile-companion" },
    actions: ["open"],
  },
  {
    id: "pipe-running", label: "Pipeline · running, every badge, unread", type: "task",
    pipeline: { name: PIPE_26, status: "running", progress: "3/10", step: { icon: "play", text: "Implementing" }, runs: "4 step runs" },
    model: MODEL_38, stack: { text: "1/2", tone: "info" }, counts: ALL_COUNTS, unread: true,
    title: TITLE_128,
    preview: "Improve the card UI following UI/UX best practice. Today the header badges overflow the card and progress reads 13/10.",
    meta: { repo: "agetor", branch: "fix/agetor-card-ui-improvement" },
    actions: ["stop"],
  },
  {
    id: "pipe-gate", label: "Pipeline · human gate pending", type: "task",
    pipeline: { name: PIPE_26, status: "review", progress: "6/10", step: { icon: "user-check", text: "Waiting for your review: " + STEP_60 }, runs: "8 step runs · 2 re-runs" },
    model: "opus-5.5 · auto", stack: { text: "1/2", tone: "info" },
    title: "Ship the inbox watcher behind a setting",
    preview: "Keep the agent's inbox watched for the whole session, and stop the watcher when the session ends.",
    meta: { repo: "acme-sync", branch: "feature/acme-sync-inbox-session-watch" },
    actions: ["review", "open"],
  },
  {
    id: "pipe-done", label: "Pipeline · done (the screenshot)", type: "task",
    pipeline: { name: "Zebra Pipeline (No Audio)", status: "done", progress: "✓ Done", runs: "13 step runs · 3 re-runs" },
    model: "opus-5.5 · auto", stack: { text: "1/2", tone: "info" },
    title: "Acme Sync - Keep the inbox watched for the whole session",
    preview: "Agents miss peer messages between turns because nothing watches the inbox while the agent is idle.",
    meta: { repo: "acme-sync", branch: "feature/acme-sync-inbox-session-watch", drift: { text: "drifted", tone: "info" } },
    actions: ["open", "done"],
  },
  {
    id: "pipe-blocked", label: "Pipeline · blocked (needs you)", type: "bug",
    pipeline: { name: PIPE_26, status: "blocked", progress: "4/10", step: { icon: "triangle-alert", text: "Blocked: Bug Fix ended without a handoff" }, runs: "5 step runs · 1 re-run" },
    model: "opus-5.5 · auto", awaiting: true,
    title: "Bug fix flow for the drag-and-drop regression",
    preview: "Dropping a card on the same column snapped it back and showed a 409 toast.",
    meta: { repo: "agetor", branch: "fix/drag-drop-same-column" },
    actions: ["answer-review"],
  },
];
