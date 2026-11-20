/**
 * The in-page board-card checker, ported from the design-gate mockup
 * (`docs/plans/task-card-ui-overhaul-mockup/checker.js`). `e2e/task-card-bounds.spec.ts`
 * runs it against the real board, so a card that breaks fails the suite.
 *
 * `checkBoardCards` is serialised into the page by `page.evaluate`, so it must
 * stay self-contained: no imports, no module-scope values, no closures over
 * anything outside the function body.
 *
 * What it checks, per card (`.cursor-grab[data-task-id]`):
 *   1. every descendant stays inside the card box (clip-aware, so text a
 *      `truncate` span hides by design is not counted as spilling);
 *   2. every child stays inside its parent's row horizontally;
 *   2b. every text run stays inside the card and its row: an element's box can
 *      fit while unbroken text spills past it (`overflow: visible`), so the
 *      text's own line boxes (`Range.getClientRects`) are measured, clipped by
 *      every clipping ancestor so a `truncate` span still passes;
 *   3. no two flex/grid siblings overlap;
 *   3b. no text is squeezed below 24 px wide;
 *   4. `[data-must-not-truncate]` text (pipeline name, progress, title) is not cut;
 *   5. every button is at least 24x24 and icon-only buttons are labelled;
 *   6. no button nests inside a `role="button"` card;
 *   7. text contrast is at least 4.5:1 (WCAG AA; all card text is small),
 *      except on an archived card, which is dimmed by design.
 *
 * Exempt: the unread dot (`[data-card-overlay]`) sits on the corner, and the
 * awaiting glow (`.animate-awaiting-pulse`) paints outside its box, both by
 * design.
 */
export interface CardCheckResult {
  taskId: string;
  theme: "light" | "dark";
  height: number;
  minContrast: number | null;
  fails: string[];
}

export function checkBoardCards(): CardCheckResult[] {
  const TOL = 0.5;
  const EXEMPT = "[data-card-overlay],.animate-awaiting-pulse,[data-bounds-exempt]";
  type RGBA = [number, number, number, number];

  function parseColor(s: string): RGBA | null {
    if (!s) return null;
    let m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0]! / 255, p[1]! / 255, p[2]! / 255, p.length > 3 ? p[3]! : 1];
    }
    m = s.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
    }
    return null;
  }
  const over = (top: RGBA, bottom: RGBA): RGBA => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const mix = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t), 1];
  const lum = (c: RGBA) => {
    const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  // Composite every background from the page root down to `el`.
  function bgChain(el: Element): RGBA {
    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
    let c: RGBA = [1, 1, 1, 1];
    for (const n of chain.reverse()) {
      const bg = parseColor(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0) c = over(bg, c);
    }
    return c;
  }
  function describe(el: Element): string {
    const part = el.closest("[data-part]")?.getAttribute("data-part");
    const tid = el.getAttribute("data-testid");
    const txt = (el.textContent || "").trim().slice(0, 24);
    return `${part ? part + " › " : ""}${tid || el.tagName.toLowerCase()}${txt ? ` “${txt}”` : ""}`;
  }
  const inside = (r: { left: number; right: number; top: number; bottom: number }, p: DOMRect) =>
    r.left >= p.left - TOL && r.right <= p.right + TOL && r.top >= p.top - TOL && r.bottom <= p.bottom + TOL;

  const theme: "light" | "dark" = document.documentElement.classList.contains("dark") ? "dark" : "light";

  function checkCard(card: HTMLElement): CardCheckResult {
    const fails: string[] = [];
    const cr = card.getBoundingClientRect();
    const col = card.parentElement!;
    const els = [...card.querySelectorAll("*")].filter((e) => !e.closest(EXEMPT)) as HTMLElement[];

    // The part of an element (or a text run's line box) that is visible:
    // clipped by every ancestor, from `from` up to the card, whose overflow is
    // not visible.
    function visibleRect(e: Element, r: { left: number; top: number; right: number; bottom: number } = e.getBoundingClientRect(), from: Element | null = e.parentElement) {
      let l = r.left;
      let t = r.top;
      let rt = r.right;
      let b = r.bottom;
      for (let n = from; n && n !== card; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const nr = n.getBoundingClientRect();
        if (cs.overflowX !== "visible") { l = Math.max(l, nr.left); rt = Math.min(rt, nr.right); }
        if (cs.overflowY !== "visible") { t = Math.max(t, nr.top); b = Math.min(b, nr.bottom); }
      }
      return { left: l, top: t, right: Math.max(l, rt), bottom: Math.max(t, b), width: Math.max(0, rt - l), height: Math.max(0, b - t) };
    }

    // 1. every child inside the card box
    for (const e of els) {
      const r = visibleRect(e);
      // Clipped to nothing in either axis (a span a `truncate` parent hides
      // whole) is not visible, so it cannot spill.
      if (r.width === 0 || r.height === 0) continue;
      if (!inside(r, cr)) {
        const dx = Math.max(cr.left - r.left, r.right - cr.right, 0);
        const dy = Math.max(cr.top - r.top, r.bottom - cr.bottom, 0);
        fails.push(`outside the card by ${Math.round(Math.max(dx, dy))}px: ${describe(e)}`);
      }
    }
    // 2. every child inside its parent horizontally
    for (const e of els) {
      const p = e.parentElement;
      if (!p || p === col) continue;
      const ps = getComputedStyle(p);
      const es = getComputedStyle(e);
      if (es.position === "absolute" || es.position === "fixed") continue;
      if (ps.display.startsWith("inline") && !ps.display.includes("flex")) continue;
      if (ps.overflowX !== "visible") continue;
      const r = e.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < pr.left - TOL || r.right > pr.right + TOL) {
        fails.push(`spills out of its row by ${Math.round(Math.max(pr.left - r.left, r.right - pr.right))}px: ${describe(e)}`);
      }
    }
    // 2b. every text run inside the card and inside its row. The row is the
    // nearest ancestor that is not a plain inline box; the run is clipped from
    // its own parent up, since an element clips its own text.
    for (const e of [card, ...els]) {
      for (const n of e.childNodes) {
        if (n.nodeType !== 3 || !(n.textContent ?? "").trim()) continue;
        let row: Element = e;
        while (row !== card && row.parentElement) {
          const d = getComputedStyle(row).display;
          if (!(d.startsWith("inline") && !d.includes("flex") && !d.includes("grid") && !d.includes("block"))) break;
          row = row.parentElement;
        }
        const rowR = row.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const box of range.getClientRects()) {
          const v = visibleRect(e, box, e);
          if (v.width === 0 || v.height === 0) continue;
          if (!inside(v, cr)) {
            fails.push(`text outside the card by ${Math.round(Math.max(cr.left - v.left, v.right - cr.right, cr.top - v.top, v.bottom - cr.bottom, 0))}px: ${describe(e)}`);
          }
          if (row !== card && (v.left < rowR.left - TOL || v.right > rowR.right + TOL)) {
            fails.push(`text spills out of its row by ${Math.round(Math.max(rowR.left - v.left, v.right - rowR.right))}px: ${describe(e)}`);
          }
        }
        range.detach();
      }
    }
    // 3. no two flex/grid siblings overlap (the icon-under-the-pill bug)
    for (const p of [card, ...els]) {
      if (!/flex|grid/.test(getComputedStyle(p).display)) continue;
      const kids = [...p.children].filter((k) => !k.matches(EXEMPT) && !/absolute|fixed/.test(getComputedStyle(k).position));
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i]!.getBoundingClientRect();
          const b = kids[j]!.getBoundingClientRect();
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 1 && oy > 1) fails.push(`overlaps by ${Math.round(ox)}px: ${describe(kids[i]!)} / ${describe(kids[j]!)}`);
        }
      }
    }
    // 3b. no text squeezed to a sliver (text a flex row shrank away instead of wrapping)
    for (const e of els) {
      if (!([...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()))) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 24 && e.scrollWidth > r.width + 1) fails.push(`text squeezed to ${Math.round(r.width)}px: ${describe(e)}`);
    }
    // 4. the full pipeline name, the progress and the title are never cut
    for (const e of card.querySelectorAll<HTMLElement>("[data-must-not-truncate]")) {
      if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) fails.push(`text is cut off: ${describe(e)}`);
    }
    // 5. buttons: 24x24 minimum target, an accessible name on icon-only ones
    for (const b of card.querySelectorAll("button")) {
      const r = b.getBoundingClientRect();
      if (r.width < 24 - TOL || r.height < 24 - TOL) fails.push(`target smaller than 24×24 (${Math.round(r.width)}×${Math.round(r.height)}): ${describe(b)}`);
      if (!(b.textContent || "").trim() && !b.getAttribute("aria-label")) fails.push(`icon button without aria-label: ${describe(b)}`);
    }
    // 6. no button nested in a role=button card (axe nested-interactive)
    if (card.getAttribute("role") === "button" && card.querySelector("button")) fails.push("buttons nested inside a role=button card");
    // 7. text contrast (WCAG AA 4.5:1; every text on the card is small)
    let minC = Infinity;
    let minWhere = "";
    // An archived card is dimmed on purpose (`opacity-60`).
    if (!card.classList.contains("opacity-60")) {
      const behind = bgChain(col);
      for (const e of [card, ...els]) {
        if (!([...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()))) continue;
        if (e.getBoundingClientRect().width === 0) continue;
        let o = 1;
        for (let n: Element | null = e; n && n !== col; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        const bgIn = bgChain(e);
        let fg = parseColor(getComputedStyle(e).color);
        if (!fg) continue;
        fg = over(fg, bgIn);
        const c = ratio(mix(fg, behind, o), mix(bgIn, behind, o));
        if (c < minC) { minC = c; minWhere = describe(e); }
      }
      if (minC < 4.5) fails.push(`contrast ${minC.toFixed(2)}:1 is below 4.5:1: ${minWhere}`);
    }
    return {
      taskId: card.dataset.taskId ?? "",
      theme,
      height: Math.round(cr.height),
      minContrast: Number.isFinite(minC) ? Number(minC.toFixed(2)) : null,
      fails: [...new Set(fails)],
    };
  }

  return [...document.querySelectorAll<HTMLElement>(".cursor-grab[data-task-id], .cursor-default[data-task-id]")].map(checkCard);
}
