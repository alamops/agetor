// In-page card checker. Runs in Playwright (Chromium + WebKit) and again live
// in the viewer's browser. One result per `.card-under-test`.
(function () {
  const TOL = 0.5;
  function parseColor(s) {
    if (!s) return null;
    let m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
    }
    m = s.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return null;
  }
  const over = (top, bottom) => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const mix = (a, b, t) => [a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t), 1];
  const lum = (c) => {
    const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  // Composite every background from the theme scope down to `el`.
  function bgChain(el, stop) {
    const chain = [];
    for (let n = el; n && n !== stop.parentElement; n = n.parentElement) chain.push(n);
    let c = [1, 1, 1, 1];
    for (const n of chain.reverse()) {
      const bg = parseColor(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0) c = over(bg, c);
    }
    return c;
  }
  function describe(el) {
    const part = el.closest("[data-part]")?.getAttribute("data-part");
    const tid = el.getAttribute("data-testid");
    const txt = (el.textContent || "").trim().slice(0, 24);
    const tag = el.tagName.toLowerCase();
    return `${part ? part + " › " : ""}${tid || tag}${txt ? ` “${txt}”` : ""}`;
  }
  function inside(r, p) {
    return r.left >= p.left - TOL && r.right <= p.right + TOL && r.top >= p.top - TOL && r.bottom <= p.bottom + TOL;
  }
  function checkCard(card) {
    const fails = [];
    const cr = card.getBoundingClientRect();
    const scope = card.closest(".theme-scope");
    const col = card.parentElement;
    const els = [...card.querySelectorAll("*")].filter((e) => !e.closest("[data-bounds-exempt]"));
    // Visible part of an element: clipped by every ancestor (up to the card)
    // whose overflow is not visible, so text a `truncate` span hides by
    // design is not counted as spilling.
    function visibleRect(e) {
      let r = e.getBoundingClientRect();
      let l = r.left, t = r.top, rt = r.right, b = r.bottom;
      for (let n = e.parentElement; n && n !== card; n = n.parentElement) {
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
      if (r.width === 0 && r.height === 0) continue;
      if (!inside(r, cr)) {
        const dx = Math.max(cr.left - r.left, r.right - cr.right, 0);
        const dy = Math.max(cr.top - r.top, r.bottom - cr.bottom, 0);
        fails.push(`outside the card by ${Math.round(Math.max(dx, dy))}px: ${describe(e)}`);
      }
    }
    // 2. every block-level child inside its parent horizontally
    for (const e of els) {
      const p = e.parentElement;
      if (!p || p === card.parentElement) continue;
      const ps = getComputedStyle(p), es = getComputedStyle(e);
      if (es.position === "absolute" || es.position === "fixed") continue;
      if (ps.display.startsWith("inline") && !ps.display.includes("flex")) continue;
      if (ps.overflowX !== "visible") continue;
      const r = e.getBoundingClientRect(), pr = p.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < pr.left - TOL || r.right > pr.right + TOL) {
        fails.push(`spills out of its row by ${Math.round(Math.max(pr.left - r.left, r.right - pr.right))}px: ${describe(e)}`);
      }
    }
    // 3. no two flex/grid siblings overlap (the icon-under-the-pill bug)
    for (const p of [card, ...els]) {
      const ps = getComputedStyle(p);
      if (!/flex|grid/.test(ps.display)) continue;
      const kids = [...p.children].filter((k) => !k.hasAttribute("data-bounds-exempt") && !/absolute|fixed/.test(getComputedStyle(k).position));
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 1 && oy > 1) fails.push(`overlaps by ${Math.round(ox)}px: ${describe(kids[i])} / ${describe(kids[j])}`);
        }
      }
    }
    // 3b. no text squeezed to a sliver (the investigation's 10 px left
    //     cluster; text a flex row shrank away instead of wrapping)
    for (const e of els) {
      const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 24 && e.scrollWidth > r.width + 1) fails.push(`text squeezed to ${Math.round(r.width)}px: ${describe(e)}`);
    }
    // 4. the full pipeline name, the progress and the title are never cut
    for (const e of card.querySelectorAll("[data-must-not-truncate]")) {
      if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) fails.push(`text is cut off: ${describe(e)}`);
    }
    // 5. buttons: 24×24 minimum target, accessible name on icon-only ones
    for (const b of card.querySelectorAll("button")) {
      const r = b.getBoundingClientRect();
      if (r.width < 24 - TOL || r.height < 24 - TOL) fails.push(`target smaller than 24×24 (${Math.round(r.width)}×${Math.round(r.height)}): ${describe(b)}`);
      if (!(b.textContent || "").trim() && !b.getAttribute("aria-label")) fails.push(`icon button without aria-label: ${describe(b)}`);
    }
    // 6. no button nested in a role=button card (axe nested-interactive)
    if (card.getAttribute("role") === "button" && card.querySelector("button")) fails.push("buttons nested inside a role=button card");
    // 7. text contrast (WCAG AA 4.5:1; every text on the card is small)
    let minC = Infinity, minWhere = "";
    if (!card.hasAttribute("data-contrast-exempt")) {
      const behind = bgChain(col, scope);
      for (const e of [card, ...els]) {
        const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0) continue;
        let o = 1;
        for (let n = e; n && n !== col; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        const bgIn = bgChain(e, scope);
        let fg = parseColor(getComputedStyle(e).color);
        if (!fg) continue;
        fg = over(fg, bgIn);
        const c = ratio(mix(fg, behind, o), mix(bgIn, behind, o));
        if (c < minC) { minC = c; minWhere = describe(e); }
      }
      if (minC < 4.5) fails.push(`contrast ${minC.toFixed(2)}:1 is below 4.5:1: ${minWhere}`);
    }
    return {
      alt: card.dataset.alt, state: card.dataset.state,
      theme: scope.classList.contains("dark") ? "dark" : "light",
      height: Math.round(cr.height),
      minContrast: Number.isFinite(minC) ? Number(minC.toFixed(2)) : null,
      fails: [...new Set(fails)],
    };
  }
  window.checkCards = function () {
    document.documentElement.classList.add("measuring");
    try {
      return [...document.querySelectorAll(".card-under-test")].map(checkCard);
    } finally {
      document.documentElement.classList.remove("measuring");
    }
  };
})();
