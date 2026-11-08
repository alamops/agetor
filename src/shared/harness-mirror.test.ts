import { describe, expect, test } from "bun:test";
import { MIRROR_PAYLOAD_LIMITS, MIRROR_SPECS, isHarnessAuthEnvKey, isNeverCopyPath } from "./harness-mirror.ts";

describe("mirror allowlist", () => {
  test("no credential or session path is ever in a copy/merge list", () => {
    for (const kind of ["claude-code", "codex"] as const) {
      const spec = MIRROR_SPECS[kind];
      for (const rel of [...spec.copy, ...spec.merge]) {
        expect(isNeverCopyPath(kind, rel), `${kind}:${rel}`).toBe(false);
      }
    }
  });

  test("the user-level instruction/config files are in the copy list (review M2)", () => {
    // Grill 18 says "mirror the whole user-level config": standing
    // instructions and output styles are part of how the account behaves.
    expect(MIRROR_SPECS["claude-code"].copy).toContain("CLAUDE.md");
    expect(MIRROR_SPECS["claude-code"].copy).toContain("output-styles");
    expect(MIRROR_SPECS.codex.copy).toContain("AGENTS.md");
  });

  test("plugin payload trees have their own bounded copy budget (review S3)", () => {
    for (const rel of ["plugins/cache", "plugins/marketplaces", "plugins"]) {
      const limits = MIRROR_PAYLOAD_LIMITS[rel];
      expect(limits, rel).toBeDefined();
      expect(limits!.maxBytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(limits!.maxEntries).toBeGreaterThan(5_000);
      // Still bounded: an unbounded copy is not an option.
      expect(Number.isFinite(limits!.maxBytes)).toBe(true);
      expect(Number.isFinite(limits!.maxEntries)).toBe(true);
    }
  });

  test("Claude credentials and transcripts are never copied", () => {
    for (const rel of [".credentials.json", "projects/p/x.jsonl", "history.jsonl", "plugins/store/x", ".claude"]) {
      expect(isNeverCopyPath("claude-code", rel)).toBe(true);
    }
    // The installed plugin payload is config, not a credential store: it is
    // copied so a backup can load its own plugins.
    expect(isNeverCopyPath("claude-code", "plugins/cache/m/p/1/SKILL.md")).toBe(false);
  });

  test("Codex auth/session DBs and OAuth locks are never copied", () => {
    for (const rel of ["auth.json", "sessions/2026/01/rollout-x.jsonl", "state_1.sqlite", "thread_history_1.sqlite", "mcp-oauth-locks/x"]) {
      expect(isNeverCopyPath("codex", rel)).toBe(true);
    }
    // Codex's allowlist copies `plugins/` whole, including the installed
    // payload cache; only transient/derived state is excluded.
    for (const rel of [
      "plugins/.remote-plugin-install-staging/x",
      "plugins/store/x",
      "plugins/plugin-catalog-cache.json",
    ]) {
      expect(isNeverCopyPath("codex", rel), rel).toBe(true);
    }
    expect(isNeverCopyPath("codex", "plugins/cache/m/p/1/SKILL.md")).toBe(false);
  });

  test(".git is never copyable at any depth (a clone's config can carry a token)", () => {
    for (const kind of ["claude-code", "codex"] as const) {
      expect(isNeverCopyPath(kind, "plugins/marketplaces/m/.git")).toBe(true);
      expect(isNeverCopyPath(kind, "plugins/marketplaces/m/.git/config")).toBe(true);
      expect(isNeverCopyPath(kind, "plugins/cache/m/p/1/.git")).toBe(true);
      // Ordinary dotfiles next to it are plugin content and stay copyable.
      expect(isNeverCopyPath(kind, "plugins/marketplaces/m/.gitignore")).toBe(false);
    }
  });

  test("provider login env keys are recognized (explicit + vendor prefix)", () => {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY"]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(true);
    }
    expect(isHarnessAuthEnvKey("FOO_BAR")).toBe(false);
    expect(isHarnessAuthEnvKey("ANTHROPIC_BASE_URL")).toBe(false);
  });

  test("credentials are recognized by shape, whatever the vendor (R15-S1)", () => {
    // The vendor-prefix rule missed these: an OpenRouter/GitHub/Hugging Face
    // key or a web-identity token file crossed into every backup even though
    // the security review's control is "credential-shaped env keys are
    // stripped", not "eight enumerated spellings".
    for (const key of [
      "OPENROUTER_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "HF_TOKEN",
      "NPM_TOKEN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "SOME_VENDOR_SECRET",
      "MY_SERVICE_PASSWORD",
      "DATABASE_CREDENTIAL",
      "AWS_ROLE_ARN",
      "AWS_PROFILE",
      "AWS_DEFAULT_PROFILE",
    ]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(true);
    }
    // Whole-segment matching, not substring: limits and look-alikes survive.
    // (`TOKEN_BUDGET` would match — a `TOKEN` segment is treated as a
    // credential by design; no harness setting uses that spelling.)
    for (const key of ["MAX_TOKENS", "TOKENIZER", "KEYCHAIN_PATH", "MONKEY_MODE"]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(false);
    }
  });

  test("cloud/vendor credential env keys are recognized too (review S1)", () => {
    // A backup inheriting any of these runs as the primary, exactly like an
    // inherited ANTHROPIC_API_KEY — the security review's control is "provider
    // env keys are stripped", not "only the eight enumerated spellings".
    for (const key of [
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_AD_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_OAUTH_ACCESS_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_AUTH_TOKEN",
      "VERTEX_AI_PRIVATE_KEY",
      "OPENAI_CLIENT_SECRET",
    ]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(true);
    }
  });

  test("non-credential provider settings survive the strip", () => {
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_MAX_TOKENS",
      "OPENAI_BASE_URL",
      "OPENAI_ORGANIZATION",
      "AWS_REGION",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_REGION",
      "CLAUDE_CODE_USE_BEDROCK",
      "GEMINI_MODEL",
    ]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(false);
    }
  });
});
