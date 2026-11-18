// Loads page.html (wrapped in a standards-mode skeleton like the publish
// wrapper) in Playwright Chromium and WebKit and records every card's checks.
import { readFileSync, writeFileSync } from "node:fs";
const PW = process.cwd() + "/node_modules/playwright-core/index.mjs"; // run from the repo root
const { chromium, webkit } = await import(PW);
const here = new URL(".", import.meta.url).pathname;
const page = readFileSync(here + "page.html", "utf8");
const wrapped = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${page}</body></html>`;
writeFileSync(here + "page.local.html", wrapped);

const out = { generatedAt: new Date().toISOString(), engines: {} };
for (const [name, type] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await type.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto("file://" + here + "page.local.html");
  await p.waitForTimeout(400);
  const res = await p.evaluate(() => window.checkCards());
  out.engines[name] = res;
  if (process.argv.includes("--shots")) {
    for (const id of process.argv.slice(process.argv.indexOf("--shots") + 1)) {
      const el = await p.$(`#state-${id}`);
      if (el) await el.screenshot({ path: `${here}shot-${name}-${id}.png` });
    }
  }
  await browser.close();
  const bad = res.filter((r) => r.fails.length);
  console.log(`${name}: ${res.length - bad.length}/${res.length} pass`);
  for (const r of bad) console.log(`  ✗ ${r.alt} ${r.state} ${r.theme}: ${r.fails.join(" | ")}`);
}
writeFileSync(here + "results.json", JSON.stringify(out, null, 1));
