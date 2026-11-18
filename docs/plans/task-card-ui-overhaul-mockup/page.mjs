import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { STATES } from "./states.mjs";
import { renderA, renderB, renderC, renderC1, renderC2, renderToday } from "./render.mjs";

const here = new URL(".", import.meta.url).pathname;
const css = existsSync(here + "out.css") ? readFileSync(here + "out.css", "utf8") : "";
const checker = readFileSync(here + "checker.js", "utf8");
const results = existsSync(here + "results.json") ? JSON.parse(readFileSync(here + "results.json", "utf8")) : null;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Today's card gets the raw markdown prompt and the old execution-count label,
// exactly as it renders on main.
const TODAY_OVERRIDES = {
  "pipe-done": { rawPrompt: "# Spec — Keep the inbox watched for the whole session | Field | Value | | --- | --- | | Date | 2026-11-10 |", pipelineToday: "13/10" },
  "pipe-running": { pipelineToday: "3/10 · Implementing" },
  "pipe-gate": { pipelineToday: "6/10 · Human Approval" },
  "pipe-blocked": { pipelineToday: "4/10 · Bug Fix" },
};

const ALTS = [
  { id: "C1", name: "C1 · Title, then two quiet lines", render: renderC1, blurb: "Under the title: one identity line in plain text (agent or profile · model · mode) and one status line. Activity counts are plain icon + number; only the account stack and an fx pause stay chips, because their colour means something." },
  { id: "C2", name: "C2 · Title, preview, then meta", render: renderC2, blurb: "Nothing between the title and the preview. Status, identity and repo · branch sit together in one meta block above the buttons, in that order. Reads like a document card: what it is, what it says, then the details." },
  { id: "A", name: "A · Meta footer", render: renderA, blurb: "Row 1 keeps the type icon and status counts, with the stack chip on the right. Who runs the task (agent or profile, model, mode) moves down into a two-line meta block above the buttons, next to repo · branch." },
  { id: "B", name: "B · Identity header", render: renderB, blurb: "Row 1 says who runs it: type icon, agent or profile chip, then model · mode, which truncates first. Row 2 is status: the account-stack chip and the counts, wrapping, shown only when there are any." },
  { id: "C", name: "C · Title first (as picked)", render: renderC, blurb: "The title leads, with the type icon inline before it. Everything else is one wrapping row of chips under the title, with no left/right split, so nothing has a fixed slot to collide with." },
  { id: "today", name: "Today (control)", render: (s) => renderToday({ ...s, ...(TODAY_OVERRIDES[s.id] ?? {}), pipeline: s.pipeline && { ...s.pipeline, today: TODAY_OVERRIDES[s.id]?.pipelineToday } }), blurb: "TaskCard.tsx as it is on main. It is here to prove the checker catches the screenshot's breakage." },
];

function cell(alt, s, theme) {
  return `<div class="cell" data-alt="${alt.id}" data-state="${s.id}" data-theme="${theme}">
    <div class="theme-scope ${theme === "dark" ? "dark" : "light"}">
      <div class="board-col w-72 rounded-lg border border-border/40 bg-muted/30 p-3">${alt.render(s)}</div>
    </div>
    <div class="verdict" data-verdict-for="${alt.id}|${s.id}|${theme}"></div>
  </div>`;
}

const stateSections = STATES.map((s) => `
  <section class="state" id="state-${s.id}" data-state="${s.id}">
    <h3 class="state-title">${esc(s.label)}</h3>
    <div class="state-scroll">
      <div class="grid-head">${ALTS.map((a) => `<div class="alt-head" data-alt="${a.id}">${esc(a.name)}</div>`).join("")}</div>
      ${["light", "dark"].map((t) => `<div class="grid-row" data-theme="${t}">${ALTS.map((a) => cell(a, s, t)).join("")}</div>`).join("")}
    </div>
  </section>`).join("");

function summaryTable() {
  const engines = results ? Object.keys(results.engines) : [];
  const heads = engines.flatMap((e) => ["light", "dark"].map((t) => `<th scope="col">${esc(e)}<br><span class="sub">${t}</span></th>`)).join("");
  const rows = ALTS.map((a) => {
    const cells = engines.flatMap((e) => ["light", "dark"].map((t) => {
      const rs = results.engines[e].filter((r) => r.alt === a.id && r.theme === t);
      const bad = rs.filter((r) => r.fails.length);
      return `<td class="${bad.length ? "fail" : "pass"}">${rs.length - bad.length}/${rs.length}${bad.length ? `<br><span class="sub">${bad.map((r) => r.state).join(", ")}</span>` : ""}</td>`;
    })).join("");
    const ch = results ? results.engines[engines[0]].filter((r) => r.alt === a.id && r.theme === "light") : [];
    const avg = ch.length ? Math.round(ch.reduce((n, r) => n + r.height, 0) / ch.length) : "–";
    const max = ch.length ? Math.max(...ch.map((r) => r.height)) : "–";
    return `<tr><th scope="row">${esc(a.name)}</th>${cells}<td class="live" data-live-for="${a.id}">…</td><td class="num">${avg} / ${max}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="summary"><thead><tr><th scope="col">Layout</th>${heads}<th scope="col">This browser<br><span class="sub">live</span></th><th scope="col">Card height<br><span class="sub">avg / max px</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const staticResults = results ? `<script>window.__ENGINE_RESULTS = ${JSON.stringify(results)};</script>` : "<script>window.__ENGINE_RESULTS = null;</script>";

const html = `<title>Task Card Alternatives</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: a measuring bench. Each state is a row of real 262 px cards, light over dark, with each card's checks under it. */
:root {
  --pg-bg: #f5f6f8; --pg-panel: #ffffff; --pg-fg: #16181d; --pg-muted: #5b6170; --pg-line: #d9dce3;
  --pg-accent: #2f5fb3; --pg-pass: #1e7a46; --pg-fail: #b4232c; --pg-pass-bg: #e6f4ec; --pg-fail-bg: #fbe9ea;
  --pg-font: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --pg-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --pg-bg: #101216; --pg-panel: #171a20; --pg-fg: #e8eaee; --pg-muted: #9aa1ae; --pg-line: #2a2f38;
  --pg-accent: #7aa7f5; --pg-pass: #5fcf8f; --pg-fail: #ff7a80; --pg-pass-bg: #12291c; --pg-fail-bg: #331417; color-scheme: dark; } }
:root[data-theme="dark"] {
  --pg-bg: #101216; --pg-panel: #171a20; --pg-fg: #e8eaee; --pg-muted: #9aa1ae; --pg-line: #2a2f38;
  --pg-accent: #7aa7f5; --pg-pass: #5fcf8f; --pg-fail: #ff7a80; --pg-pass-bg: #12291c; --pg-fail-bg: #331417; color-scheme: dark; }
body { background: var(--pg-bg); color: var(--pg-fg); font-family: var(--pg-font); font-size: 14px; line-height: 1.5; }
.page { max-width: 1320px; margin: 0 auto; padding-block: 28px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: flex; flex-direction: column; gap: 28px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0; font-weight: 600; text-wrap: balance; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0; font-weight: 600; text-wrap: balance; }
.lede { max-width: 68ch; color: var(--pg-muted); margin: 6px 0 0; }
.panel { background: var(--pg-panel); border: 1px solid var(--pg-line); border-radius: 10px; padding: 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.fixed-list { margin: 0; padding-left: 18px; color: var(--pg-muted); columns: 2 320px; column-gap: 32px; }
.fixed-list li { break-inside: avoid; margin-bottom: 4px; }
.alts { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.alt-card { border: 1px solid var(--pg-line); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.alt-card h3 { margin: 0; font-size: 15px; font-weight: 600; }
.alt-card p { margin: 0; color: var(--pg-muted); }
.table-wrap { overflow-x: auto; }
table.summary { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px; }
.summary th, .summary td { border-bottom: 1px solid var(--pg-line); padding: 8px 10px; text-align: left; vertical-align: top; }
.summary thead th { font-weight: 500; color: var(--pg-muted); font-size: 12px; }
.summary td.pass { color: var(--pg-pass); font-weight: 600; }
.summary td.fail { color: var(--pg-fail); font-weight: 600; }
.summary .sub { font-weight: 400; color: var(--pg-muted); font-size: 11px; }
.summary .num { font-family: var(--pg-mono); font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; gap: 16px 28px; align-items: center; }
.seg { display: inline-flex; border: 1px solid var(--pg-line); border-radius: 8px; overflow: hidden; }
.seg button { font: inherit; font-size: 13px; color: var(--pg-fg); background: transparent; border: 0; padding: 6px 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--pg-line); }
.seg button[aria-pressed="true"] { background: var(--pg-accent); color: var(--pg-panel); }
.seg button:focus-visible, .jump a:focus-visible { outline: 2px solid var(--pg-accent); outline-offset: 2px; }
.ctl-label { font-size: 12px; color: var(--pg-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-right: 8px; }
.jump { display: flex; flex-wrap: wrap; gap: 6px; }
.jump a { font-size: 12px; color: var(--pg-accent); text-decoration: none; border: 1px solid var(--pg-line); border-radius: 999px; padding: 2px 10px; }
.state { display: flex; flex-direction: column; gap: 10px; scroll-margin-top: 12px; }
.state-title { margin: 0; font-size: 15px; font-weight: 600; }
.state-scroll { overflow-x: auto; padding-bottom: 6px; display: flex; flex-direction: column; gap: 10px; }
.grid-head, .grid-row { display: flex; gap: 14px; width: max-content; }
.alt-head { width: 288px; font-size: 12px; font-weight: 600; color: var(--pg-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.cell { width: 288px; display: flex; flex-direction: column; gap: 6px; }
.theme-scope { font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; background: hsl(var(--background)); color: hsl(var(--foreground)); padding: 0; border-radius: 10px; font-size: 16px; line-height: 1.5; }
.verdict { font-size: 12px; min-height: 18px; }
.verdict .ok { color: var(--pg-pass); }
.verdict .bad { color: var(--pg-fail); }
.verdict details summary { cursor: pointer; color: var(--pg-fail); }
.verdict ul { margin: 4px 0 0; padding-left: 16px; color: var(--pg-muted); font-size: 11px; word-break: break-word; }
.verdict .eng { color: var(--pg-muted); font-family: var(--pg-mono); font-size: 11px; }
html.measuring .cell, html.measuring .alt-head, html.measuring .grid-row { display: flex !important; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
${css}
</style>
<div class="page">
  <header>
    <h1>Task card: refining layout C</h1>
    <p class="lede">You picked C, title first, and asked for a calmer chip area under the title. C1 and C2 are two ways to do that; C is shown as picked for comparison. A, B and today's card stay available under Show. Every card below is 262 px wide, the real width of a board card (column <code>w-72</code>, 233 px of content at <code>p-3</code>). Each state is filled with the longest content found in the database. A checker measures every card: each child must stay inside the card and inside its row, no two items may overlap, the pipeline name, progress and title are never cut, buttons are at least 24×24, and text contrast meets 4.5:1.</p>
  </header>

  <section class="panel" aria-labelledby="h-results">
    <h2 id="h-results">Measured results</h2>
    <p class="lede" style="margin:0">States passing, per browser engine and theme. WebKit is the engine behind the desktop app's WKWebView. "This browser" re-runs the same checks in the browser you are reading this in. Lower card height means more cards fit on screen.</p>
    ${summaryTable()}
  </section>

  <section class="panel" aria-labelledby="h-alts">
    <h2 id="h-alts">What differs</h2>
    <div class="alts">${ALTS.filter((a) => ["C1", "C2", "C"].includes(a.id)).map((a) => `<div class="alt-card"><h3>${esc(a.name)}</h3><p>${esc(a.blurb)}</p></div>`).join("")}</div>
    <h2 style="font-size:15px">Fixed in every layout (from the grill)</h2>
    <ul class="fixed-list">
      <li>Pipeline cards get the status-tinted hat: full pipeline name (wraps, never cut), progress on the right, active step or gate line below.</li>
      <li>Progress counts distinct finished steps; a finished run reads ✓ Done. Run counts live in the hat's tooltip.</li>
      <li>One visible primary action plus ⋯, which opens the right-click menu. Diff, Archive, Unarchive, the extra Stop and Delete live there.</li>
      <li>Titles wrap in full, no clamp.</li>
      <li>One chip style: 20 px tall, 10 px text, fully rounded. All buttons 28 px tall.</li>
      <li>Card padding 12 px. One meta line: repo folder · branch, full path in the tooltip.</li>
      <li>Prompt preview is the first prose paragraph as plain text.</li>
      <li>Answer uses the warning-solid token, Done is transparent in dark mode, the card has a focus outline and a group role.</li>
      <li>Stop uses the danger token on the card (4.7:1 in light mode); the shared destructive token is 3.61:1.</li>
    </ul>
  </section>

  <section class="panel" aria-label="View">
    <div class="controls">
      <div><span class="ctl-label">Show</span><span class="seg" role="group" aria-label="Layouts shown">
        ${ALTS.map((a) => `<button type="button" id="alt-${a.id}" data-toggle-alt="${a.id}" aria-pressed="${["C", "C1", "C2"].includes(a.id) ? "true" : "false"}">${esc(a.id === "today" ? "Today" : a.id)}</button>`).join("")}
      </span></div>
      <div><span class="ctl-label">Theme</span><span class="seg" role="group" aria-label="Themes shown">
        <button type="button" id="th-both" data-theme-view="both" aria-pressed="true">Both</button>
        <button type="button" id="th-light" data-theme-view="light" aria-pressed="false">Light</button>
        <button type="button" id="th-dark" data-theme-view="dark" aria-pressed="false">Dark</button>
      </span></div>
    </div>
    <nav class="jump" aria-label="Jump to a state">${STATES.map((s) => `<a href="#state-${s.id}">${esc(s.label.split(" · ")[0] === "Pipeline" ? s.label.replace("Pipeline · ", "Pipeline: ") : s.label.split(" · ")[0])}</a>`).join("")}</nav>
  </section>

  ${stateSections}
</div>
${staticResults}
<script>${checker}</script>
<script>
(function () {
  const shownAlts = new Set(["C", "C1", "C2"]);
  let themeView = "both";
  function apply() {
    document.querySelectorAll(".cell, .alt-head").forEach((el) => {
      const okAlt = shownAlts.has(el.dataset.alt);
      el.hidden = !okAlt;
    });
    document.querySelectorAll(".grid-row").forEach((r) => { r.hidden = themeView !== "both" && r.dataset.theme !== themeView; });
  }
  document.querySelectorAll("[data-toggle-alt]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.toggleAlt;
    if (shownAlts.has(id)) shownAlts.delete(id); else shownAlts.add(id);
    b.setAttribute("aria-pressed", String(shownAlts.has(id)));
    apply();
  }));
  document.querySelectorAll("[data-theme-view]").forEach((b) => b.addEventListener("click", () => {
    themeView = b.dataset.themeView;
    document.querySelectorAll("[data-theme-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    apply();
  }));
  function engineLine(alt, state, theme) {
    const er = window.__ENGINE_RESULTS;
    if (!er) return "";
    return Object.entries(er.engines).map(([eng, rs]) => {
      const r = rs.find((x) => x.alt === alt && x.state === state && x.theme === theme);
      return r ? eng + (r.fails.length ? " ✗" : " ✓") : "";
    }).filter(Boolean).join(" · ");
  }
  function render() {
    // Measure with every card laid out (hidden ones have no size).
    document.querySelectorAll("[hidden]").forEach((el) => el.setAttribute("data-was-hidden", ""));
    document.querySelectorAll("[data-was-hidden]").forEach((el) => { el.hidden = false; });
    const res = window.checkCards();
    document.querySelectorAll("[data-was-hidden]").forEach((el) => { el.hidden = true; el.removeAttribute("data-was-hidden"); });
    const byAlt = {};
    for (const r of res) {
      (byAlt[r.alt] ||= { pass: 0, total: 0 }).total++;
      if (!r.fails.length) byAlt[r.alt].pass++;
      const v = document.querySelector('[data-verdict-for="' + r.alt + "|" + r.state + "|" + r.theme + '"]');
      if (!v) continue;
      const eng = engineLine(r.alt, r.state, r.theme);
      v.innerHTML = r.fails.length
        ? '<details><summary>✗ ' + r.fails.length + " problem" + (r.fails.length > 1 ? "s" : "") + " here</summary><ul>" + r.fails.map((f) => "<li>" + f.replace(/</g, "&lt;") + "</li>").join("") + "</ul></details>" + (eng ? '<span class="eng">' + eng + "</span>" : "")
        : '<span class="ok">✓ passes here</span> <span class="eng">· ' + r.height + " px tall" + (eng ? " · " + eng : "") + "</span>";
    }
    for (const [alt, s] of Object.entries(byAlt)) {
      const td = document.querySelector('[data-live-for="' + alt + '"]');
      if (td) { td.textContent = s.pass + "/" + s.total; td.className = "live " + (s.pass === s.total ? "pass" : "fail"); }
    }
  }
  apply();
  const run = () => { try { render(); } catch (e) { console.error(e); } };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run); else run();
  window.addEventListener("resize", () => { clearTimeout(window.__rt); window.__rt = setTimeout(run, 200); });
})();
</script>
`;
writeFileSync(here + "page.html", html);
console.log("page.html", html.length, "bytes", results ? "(with engine results)" : "(no engine results yet)");
