// Pulls lucide's real icon geometry from the main checkout's node_modules so
// the mockup's icons have the app's exact shapes and sizes.
import { readFileSync } from "node:fs";
// Run from the repo root after `bun install`.
const DIR = process.cwd() + "/node_modules/lucide-react/dist/esm/icons/";
const cache = new Map();
export function icon(name, cls = "size-3", attrs = "") {
  let body = cache.get(name);
  if (!body) {
    let src = readFileSync(DIR + name + ".mjs", "utf8");
    const alias = src.match(/export \{ default \} from '\.\/([\w-]+)\.mjs'/);
    if (alias) src = readFileSync(DIR + alias[1] + ".mjs", "utf8");
    const m = src.match(/const __iconNode = (\[[\s\S]*?\]);\n/);
    if (!m) throw new Error("no icon " + name);
    const node = Function(`return ${m[1]}`)();
    body = node.map(([tag, a]) => `<${tag} ${Object.entries(a).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")}></${tag}>`).join("");
    cache.set(name, body);
  }
  const hidden = attrs.includes("aria-label") ? "" : ' aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}"${hidden} ${attrs}>${body}</svg>`;
}
