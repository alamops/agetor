/**
 * Writes `schemas/**`: the JSON Schemas the Swift and Kotlin apps generate their models from (spec "Repository layout").
 *   - `schemas/messages/<type>.json`: one per session message, derived from the specs in `src/messages.ts` (hand-written there, strict,
 *     `additionalProperties:false`), plus `schemas/qr.json`.
 *   - `schemas/routes/<Type>.json`: the bodies the v1 routes return, GENERATED from `src/shared` and `src/bun/interactions.ts` types with
 *     `ts-json-schema-generator` (spike W1). `src/remote-schemas.test.ts` regenerates them and fails on drift.
 *
 * `bun scripts/gen-schemas.ts` rewrites the files; `buildSchemas()` returns them for the drift test.
 */
import { createGenerator } from "ts-json-schema-generator";
import { resolve } from "node:path";
import { MESSAGES, schemaFor, type MessageType } from "../src/messages.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const TSCONFIG = resolve(ROOT, "tsconfig.json");

/** Route-body types, with the file that declares each. */
export const ROUTE_TYPES: ReadonlyArray<{ type: string; file: string }> = [
  { type: "Task", file: "src/shared/types.ts" },
  { type: "TaskDelta", file: "src/shared/types.ts" },
  { type: "RunEvent", file: "src/shared/types.ts" },
  { type: "TaskEventsReplayMeta", file: "src/shared/types.ts" },
  { type: "PipelineRunState", file: "src/shared/types.ts" },
  { type: "TaskGitStatus", file: "src/shared/types.ts" },
  { type: "Subagent", file: "src/shared/types.ts" },
  { type: "InboxGate", file: "src/shared/interactions-inbox.ts" },
  { type: "AskQuestionsRequest", file: "src/bun/interactions.ts" },
  { type: "TmuxPromptRequest", file: "src/bun/interactions.ts" },
  { type: "FxPermissionRequest", file: "src/bun/interactions.ts" },
];

function routeSchema(type: string, file: string): unknown {
  const generator = createGenerator({
    path: resolve(ROOT, file),
    tsconfig: TSCONFIG,
    type,
    skipTypeCheck: true,
    topRef: false,
    expose: "export",
    additionalProperties: false,
    jsDoc: "none",
    sortProps: true,
  });
  const schema = generator.createSchema(type) as Record<string, unknown>;
  return { ...schema, $id: `https://agetor.dev/schemas/remote/routes/${type}.json`, title: type };
}

const stable = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const type of Object.keys(MESSAGES) as MessageType[]) out[`messages/${type}.json`] = stable(schemaFor(type));
  out["qr.json"] = stable({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://agetor.dev/schemas/remote/qr.json",
    title: "qr",
    type: "object",
    properties: {
      fmt: { const: 1 },
      corePub: { type: "string", pattern: "^[0-9a-f]{64}$" },
      relayUrl: { type: "string", pattern: "^wss?://[^\\s]+$", maxLength: 512 },
      mailbox: { type: "string", pattern: "^[0-9a-f]{32}$" },
      pairingSecret: { type: "string", pattern: "^[0-9a-f]{64}$" },
      expiresAt: { type: "integer", minimum: 0 },
    },
    required: ["fmt", "corePub", "relayUrl", "mailbox", "pairingSecret", "expiresAt"],
    additionalProperties: false,
    description: "The QR code carries base64url (no padding) of the RFC 8785 canonical JSON of this object.",
  });
  for (const { type, file } of ROUTE_TYPES) out[`routes/${type}.json`] = stable(routeSchema(type, file));
  return out;
}

if (import.meta.main) {
  const dir = resolve(import.meta.dir, "../schemas");
  const files = buildSchemas();
  for (const [name, text] of Object.entries(files)) await Bun.write(resolve(dir, name), text);
  console.log(`wrote ${Object.keys(files).length} schemas`);
}
