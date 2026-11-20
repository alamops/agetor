// Tailwind config for the mockup: the app's own config, scanning only the
// generated page, plus the new --warning-solid-foreground colour the plan adds.
import { fileURLToPath } from "node:url";
import base from "../../../tailwind.config.js";
const here = fileURLToPath(new URL(".", import.meta.url));
export default {
  ...base,
  content: [here + "page.html"],
  theme: { ...base.theme, extend: { ...base.theme.extend, colors: { ...base.theme.extend.colors, "warning-solid-foreground": "hsl(var(--warning-solid-foreground))" } } },
};
