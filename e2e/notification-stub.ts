#!/usr/bin/env bun
// A recording stand-in for AgetorNotifier (native/notifier/), for e2e/one-notification-per-task.spec.ts. The core's task notifier
// (src/bun/task-notifier.ts) spawns it exactly like the real helper: `--list` prints the list header, `--remove --id <id>` prints
// `removed <n>`, and a post prints `posted <id>`. Every call appends one JSON line to $AGETOR_E2E_NOTIFIER_LOG, which the spec reads:
// that is where the core's single notification decision (src/bun/notification-policy.ts) becomes observable from outside.

import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = process.env.AGETOR_E2E_NOTIFIER_LOG;
const record = (entry: Record<string, unknown>) => {
  if (log) appendFileSync(log, JSON.stringify({ ...entry, at: Date.now() }) + "\n");
};

if (argv.includes("--list")) {
  console.log("agetor-notifier list");
} else if (argv.includes("--remove")) {
  record({ op: "remove", id: flag("--id"), ifKinds: argv.flatMap((a, i) => (a === "--if-kind" ? [argv[i + 1]] : [])) });
  console.log("removed 1");
} else {
  const id = flag("--id") ?? "";
  record({ op: "post", id, kind: flag("--kind"), title: flag("--title"), message: flag("--message"), urgency: flag("--urgency") });
  console.log(`posted ${id}`);
}
