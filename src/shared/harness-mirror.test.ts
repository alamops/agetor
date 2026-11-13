import { describe, expect, test } from "bun:test";
import {
  CODEX_LOGIN_BEARING_CONFIG_KEYS,
  COMMAND_RUNNING_SETTINGS_KEYS,
  LOGIN_BEARING_SETTINGS_KEYS,
  LOGIN_SELECTOR_ENV_KEYS,
  MACOS_TCC_PROTECTED_HOME_FOLDERS,
  MIRROR_PAYLOAD_LIMITS,
  MIRROR_SPECS,
  SAFE_MODE_EXCLUDED_CODEX_KEYS,
  SAFE_MODE_EXCLUDED_SETTINGS_KEYS,
  CLAUDE_CODE_LOGIN_ENV_KEYS,
  containsUrlUserinfo,
  isCodexLoginBearingKeyPath,
  isCodexSecretKeyPath,
  isCommandRunningEnvKey,
  isMirrorNeverImportedEnvEntry,
  urlHasUserinfo,
  isCredentialShapedEnvKey,
  isHandoffCopyShape,
  isHandoffPrunableDir,
  isHarnessAuthEnvKey,
  isLoginBearingSettingsKey,
  isLoginSelectorEnvKey,
  isMirrorNeverImportedEnvKey,
  isMirrorNeverImportedSettingsKey,
  isNeverCopyPath,
  tccProtectedFolderOf, handoffCopySessionIdFromPath } from "./harness-mirror.ts";

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

  test("provider/login selectors are never imported by the mirror (review S3)", () => {
    // Not secrets (so not credential-shaped), but each one makes the account
    // authenticate somewhere else: the primary's must never become the
    // backup's.
    for (const key of [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "OPENAI_BASE_URL",
      "CODEX_BASE_URL",
      "OPENAI_API_BASE",
    ]) {
      expect(isLoginSelectorEnvKey(key), key).toBe(true);
      expect(isMirrorNeverImportedEnvKey(key), key).toBe(true);
      // The credential predicate (used for login evidence) is unchanged.
      expect(isHarnessAuthEnvKey(key), key).toBe(false);
    }
    // Credentials are never imported either.
    expect(isMirrorNeverImportedEnvKey("ANTHROPIC_API_KEY")).toBe(true);
  });

  test("the mirror's selector list covers every login selector harness-stacks treats as uninspectable", () => {
    // `UNINSPECTABLE_LOGIN_ENV_KEYS` in src/bun/harness-stacks.ts (not
    // importable here: shared stays free of process imports) — pinned by value.
    const uninspectable = {
      "claude-code": [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_VERTEX_BASE_URL",
      ],
      codex: ["OPENAI_BASE_URL", "CODEX_BASE_URL", "OPENAI_API_BASE"],
    } as const;
    for (const kind of ["claude-code", "codex"] as const) {
      for (const key of uninspectable[kind]) expect(LOGIN_SELECTOR_ENV_KEYS[kind], key).toContain(key);
    }
  });

  test("non-credential provider settings survive the strip", () => {
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_MAX_TOKENS",
      "OPENAI_ORGANIZATION",
      "AWS_REGION",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_REGION",
      "GEMINI_MODEL",
    ]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(false);
      expect(isMirrorNeverImportedEnvKey(key), key).toBe(false);
    }
  });
});

describe("Claude Code's own session variables are not a login", () => {
  test("credential-shaped CLAUDE_CODE_* runtime vars are not harness auth; the real login vars are", () => {
    // Set in every process a Claude Code session spawns (Agetor started from
    // a session inherits them), or non-login integration secrets/tuning knobs.
    for (const key of [
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN",
      "CLAUDE_CODE_MEMORY_API_TOKEN",
      "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
      "CLAUDE_CODE_SLACK_TAG_TOKEN",
      "CLAUDE_CODE_HFI_BEARER_TOKEN",
      "CLAUDE_CODE_CLIENT_KEY",
      "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
      "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
      "CLAUDE_CODE_ARG_KEY_SHAPE",
      "CLAUDE_CODE_IDLE_TOKEN_THRESHOLD",
      "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD",
      "CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT",
      "CLAUDE_CODE_SOME_FUTURE_TOKEN",
    ]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(false);
    }
    for (const key of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_GATEWAY_TOKEN",
    ]) {
      expect(CLAUDE_CODE_LOGIN_ENV_KEYS, key).toContain(key);
      expect(isHarnessAuthEnvKey(key), key).toBe(true);
    }
    // The shape rule still holds outside the CLAUDE_CODE_ namespace.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN", "CLAUDE_API_KEY"]) {
      expect(isHarnessAuthEnvKey(key), key).toBe(true);
    }
  });

  test("the mirror still strips every secret-shaped key, login or not", () => {
    for (const key of ["CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_MEMORY_API_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(isCredentialShapedEnvKey(key), key).toBe(true);
      expect(isMirrorNeverImportedEnvKey(key), key).toBe(true);
    }
  });
});

describe("safe mode and login-bearing config keys", () => {
  test("safe mode skips hooks, permissions and every command setting; Codex notify", () => {
    // Claude Code 2.1.319's own list of settings whose value is a command
    // (review R-S4): every one is skipped in safe mode.
    const claudeCommandSettings = [
      "apiKeyHelper",
      "awsAuthRefresh",
      "awsCredentialExport",
      "fileSuggestion",
      "gcpAuthRefresh",
      "otelHeadersHelper",
      "policyHelpers",
      "processWrapper",
      "proxyAuthHelper",
      "statusLine",
      "subagentStatusLine",
    ];
    expect([...COMMAND_RUNNING_SETTINGS_KEYS].sort()).toEqual(claudeCommandSettings);
    expect([...SAFE_MODE_EXCLUDED_SETTINGS_KEYS].sort()).toEqual(
      ["hooks", "permissions", ...claudeCommandSettings].sort(),
    );
    expect(SAFE_MODE_EXCLUDED_CODEX_KEYS).toContain("notify");
    // Plugins and MCP servers are the feature's promise, never safe-skipped.
    for (const key of ["enabledPlugins", "mcpServers", "mcp_servers", "plugins"]) {
      expect(SAFE_MODE_EXCLUDED_SETTINGS_KEYS).not.toContain(key);
      expect(SAFE_MODE_EXCLUDED_CODEX_KEYS).not.toContain(key);
    }
  });

  test("login-bearing and login-selecting settings are never imported; only the bearing ones are login evidence (review R-S3)", () => {
    for (const key of ["apiKeyHelper", "forceLoginOrgUUID", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh"]) {
      expect(isLoginBearingSettingsKey(key), key).toBe(true);
      expect(isMirrorNeverImportedSettingsKey(key), key).toBe(true);
    }
    // `forceLoginMethod` selects which login the CLI accepts and
    // `proxyAuthHelper` produces the proxy's credential: never imported, but
    // neither is a login of the account, so login evidence ignores them.
    for (const key of ["forceLoginMethod", "proxyAuthHelper"]) {
      expect(isMirrorNeverImportedSettingsKey(key), key).toBe(true);
      expect(isLoginBearingSettingsKey(key), key).toBe(false);
      expect(LOGIN_BEARING_SETTINGS_KEYS).not.toContain(key);
    }
    for (const key of ["model", "statusLine", "hooks", "env", "enabledPlugins"]) {
      expect(isMirrorNeverImportedSettingsKey(key), key).toBe(false);
    }
  });

  test("Codex login-bearing key paths", () => {
    for (const key of CODEX_LOGIN_BEARING_CONFIG_KEYS) {
      expect(isCodexLoginBearingKeyPath([key]), key).toBe(true);
    }
    expect(isCodexLoginBearingKeyPath(["model_providers", "corp"])).toBe(true);
    expect(isCodexLoginBearingKeyPath(["model_providers", "corp", "http_headers"])).toBe(true);
    expect(isCodexLoginBearingKeyPath(["profiles", "work", "model_provider"])).toBe(true);
    expect(isCodexLoginBearingKeyPath(["profiles", "work", "model"])).toBe(false);
    expect(isCodexLoginBearingKeyPath(["profiles", "work"])).toBe(false);
    for (const key of ["model", "notify", "mcp_servers", "model_reasoning_effort", "profile"]) {
      expect(isCodexLoginBearingKeyPath([key]), key).toBe(false);
    }
  });
});

describe("handoff copy shapes (review S4)", () => {
  test("Claude: a transcript or a file in a session sidecar folder", () => {
    for (const rel of [
      "projects/-tmp-x/SID.jsonl",
      "file-history/SID/abcd1234@v2",
      "projects/enc/SID/subagents/agent-1.jsonl",
      "projects/enc/SID/tool-results/a/b.txt",
      "projects/enc/SID/mcp-tasks/t.json",
    ]) {
      expect(isHandoffCopyShape("claude-code", rel, "SID"), rel).toBe(true);
    }
    for (const rel of [
      "settings.json",
      ".credentials.json",
      "projects/enc",
      "projects/enc/.jsonl",
      "projects/enc/other-sid.jsonl",
      "projects/enc/other-sid/subagents/a.jsonl",
      "file-history/other-sid/abcd@v1",
      "file-history/SID",
      "file-history",
      "projects/enc/SID.json",
      "projects/enc/SID/notes.txt",
      "projects/enc/SID/other/x",
      "projects/enc/SID/subagents",
      "projects/../x/s.jsonl",
      "projects/enc/../s.jsonl",
      "skills/s/SKILL.md",
      "sessions/2026/11/08/rollout-x.jsonl",
    ]) {
      expect(isHandoffCopyShape("claude-code", rel, "SID"), rel).toBe(false);
    }
  });

  test("Codex: only sessions/YYYY/MM/DD/rollout-*.jsonl", () => {
    expect(isHandoffCopyShape("codex", "sessions/2026/11/08/rollout-2026-11-08T00-00-00-SID.jsonl", "SID")).toBe(true);
    expect(isHandoffCopyShape("codex", "sessions/2026/11/08/rollout-2026-11-08T00-00-00-other.jsonl", "SID")).toBe(false);
    for (const rel of [
      "auth.json",
      "config.toml",
      "sessions/rollout-x.jsonl",
      "sessions/2026/11/rollout-x.jsonl",
      "sessions/2026/11/08/x.jsonl",
      "sessions/26/11/08/rollout-x.jsonl",
      "sessions/2026/11/08/sub/rollout-x.jsonl",
      "projects/enc/s.jsonl",
    ]) {
      expect(isHandoffCopyShape("codex", rel, "SID"), rel).toBe(false);
    }
  });

  test("prunable folders stay inside the shape", () => {
    expect(isHandoffPrunableDir("claude-code", "projects/enc/SID", "SID")).toBe(true);
    expect(isHandoffPrunableDir("claude-code", "projects/enc/SID/subagents/nested", "SID")).toBe(true);
    expect(isHandoffPrunableDir("claude-code", "projects/enc", "SID")).toBe(false);
    expect(isHandoffPrunableDir("claude-code", "projects", "SID")).toBe(false);
    expect(isHandoffPrunableDir("claude-code", "projects/enc/SID/other", "SID")).toBe(false);
    expect(isHandoffPrunableDir("codex", "sessions/2026/11/08", "SID")).toBe(true);
    expect(isHandoffPrunableDir("codex", "sessions/2026", "SID")).toBe(true);
    expect(isHandoffPrunableDir("codex", "sessions", "SID")).toBe(false);
    expect(isHandoffPrunableDir("codex", "sessions/archive", "SID")).toBe(false);
  });
});

describe("macOS TCC-protected home folders (contract CR4, review R-S5)", () => {
  const home = "/Users/someone";

  test("a path equal to or inside a protected folder names its entry", () => {
    expect(tccProtectedFolderOf("/Users/someone/Documents", [home])).toBe("Documents");
    expect(tccProtectedFolderOf("/Users/someone/Documents/notes/x", [home])).toBe("Documents");
    expect(tccProtectedFolderOf("/Users/someone/Library/Mobile Documents/com~apple~CloudDocs", [home]))
      .toBe("Library/Mobile Documents");
    expect(tccProtectedFolderOf("/Users/someone/Library/Group Containers/g/x", [home])).toBe("Library/Group Containers");
    // The default macOS volume is case-insensitive.
    expect(tccProtectedFolderOf("/Users/someone/documents/x", [home])).toBe("Documents");
    // Trailing and doubled slashes do not matter.
    expect(tccProtectedFolderOf("/Users/someone//Desktop/", [home + "/"])).toBe("Desktop");
  });

  test("ordinary home paths, prefixes and other homes are not protected", () => {
    for (const p of [
      "/Users/someone",
      "/Users/someone/.claude",
      "/Users/someone/DocumentsArchive",
      "/Users/someone/Library",
      "/Users/someone/Library/Caches",
      "/Users/other/Documents",
      "/private/tmp/x",
      "/private/var/folders/x",
    ]) {
      expect(tccProtectedFolderOf(p, [home]), p).toBeNull();
    }
  });

  test("every candidate home is tried", () => {
    expect(tccProtectedFolderOf("/private/h/Downloads/x", ["/h", "/private/h"])).toBe("Downloads");
  });

  test("the list is the documented conservative set", () => {
    expect([...MACOS_TCC_PROTECTED_HOME_FOLDERS].sort()).toEqual([
      "Desktop",
      "Documents",
      "Downloads",
      "Library/Containers",
      "Library/Group Containers",
      "Library/Mail",
      "Library/Messages",
      "Library/Mobile Documents",
      "Library/Safari",
      "Movies",
      "Music",
      "Pictures",
    ]);
  });
});

describe("TT-C: finding 14 predicates", () => {
  test("every credential segment is stripped, in any case, as a whole segment only", () => {
    for (const seg of ["APIKEY", "PASS", "PASSWD", "PAT", "AUTH", "HEADERS", "COOKIE", "COOKIES", "SESSION", "DSN", "WEBHOOK", "CONNECTION", "PASSPHRASE"]) {
      for (const key of [`SVC_${seg}`, `${seg}_X`, `a_${seg}_b`, `svc_${seg.toLowerCase()}`, `Svc_${seg[0]}${seg.slice(1).toLowerCase()}`]) {
        expect(isCredentialShapedEnvKey(key), key).toBe(true);
        expect(isMirrorNeverImportedEnvKey(key), key).toBe(true);
      }
    }
    // Whole-segment: look-alikes keep mirroring.
    for (const key of ["PATH", "AWS_REGION", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_THINKING_TOKENS", "PATHEXT", "AUTHOR", "COMPASS", "PASSENGER", "SESSIONS_DIR_X", "HOME"]) {
      expect(isMirrorNeverImportedEnvKey(key), key).toBe(false);
    }
  });

  test("session-ish credential shapes are mirror-stripped without becoming login evidence", () => {
    for (const key of ["TERM_SESSION_ID", "SITE_COOKIE", "OTEL_EXPORTER_OTLP_HEADERS", "SENTRY_DSN"]) {
      expect(isMirrorNeverImportedEnvKey(key), key).toBe(true);
      expect(isHarnessAuthEnvKey(key), key).toBe(false);
    }
  });

  test("a URL with userinfo is a credential whatever the name; a plain URL is not", () => {
    expect(isMirrorNeverImportedEnvEntry("HTTPS_PROXY", "http://u:p@proxy:8080")).toBe(true);
    expect(isMirrorNeverImportedEnvEntry("ANY", "  postgres://user@db/x  ")).toBe(true);
    expect(isMirrorNeverImportedEnvEntry("ANY", "https://host/path?a=b@c")).toBe(false);
    expect(isMirrorNeverImportedEnvEntry("ANY", "user@example.com")).toBe(false);
    expect(isMirrorNeverImportedEnvEntry("ANY", 5)).toBe(false);
    expect(urlHasUserinfo("https://tok@host/x")).toBe(true);
    expect(urlHasUserinfo("https://host/x")).toBe(false);
    expect(containsUrlUserinfo({ a: [{ b: "git+https://t:x@h/r.git" }] })).toBe(true);
    expect(containsUrlUserinfo({ a: [{ b: "https://h/r.git" }], n: 1, z: null })).toBe(false);
  });

  test("command-running env names, any case, including DYLD_*, *_HELPER and *_COMMAND", () => {
    for (const key of ["CLAUDE_CODE_SHELL_PREFIX", "NODE_OPTIONS", "node_options", "BASH_ENV", "PROMPT_COMMAND", "LD_PRELOAD", "GIT_PAGER", "GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "EDITOR", "PAGER", "DYLD_INSERT_LIBRARIES", "dyld_library_path", "MY_HELPER", "x_helper", "RUN_COMMAND", "run_command"]) {
      expect(isCommandRunningEnvKey(key), key).toBe(true);
    }
    for (const key of ["PATH", "AWS_REGION", "ANTHROPIC_MODEL", "HELPERS_DIR", "COMMANDS", "LANG"]) {
      expect(isCommandRunningEnvKey(key), key).toBe(false);
    }
  });

  test("Codex secret key paths: shell_environment_policy.set credentials and otel headers", () => {
    expect(isCodexSecretKeyPath(["shell_environment_policy", "set", "GH_TOKEN"])).toBe(true);
    expect(isCodexSecretKeyPath(["shell_environment_policy", "set", "db_pass"])).toBe(true);
    expect(isCodexSecretKeyPath(["shell_environment_policy", "set", "LANG"])).toBe(false);
    expect(isCodexSecretKeyPath(["otel", "exporter", "otlp-http", "headers"])).toBe(true);
    expect(isCodexSecretKeyPath(["otel", "exporter", "otlp-http", "headers", "authorization"])).toBe(true);
    expect(isCodexSecretKeyPath(["otel", "environment"])).toBe(false);
  });
});

describe("handoffCopySessionIdFromPath", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  test("reads the session from every handoff shape", () => {
    expect(handoffCopySessionIdFromPath("claude-code", `/r/projects/enc/${a}.jsonl`)).toBe(a);
    expect(handoffCopySessionIdFromPath("claude-code", `/r/projects/enc/${a}/subagents/x.jsonl`)).toBe(a);
    expect(handoffCopySessionIdFromPath("claude-code", `/r/file-history/${a}/abc@v1`)).toBe(a);
    expect(handoffCopySessionIdFromPath("codex", `/r/.codex/sessions/2026/11/10/rollout-2026-11-10T00-00-00-${a}.jsonl`)).toBe(a);
  });
  test("a root folder named like an anchor does not confuse it", () => {
    expect(handoffCopySessionIdFromPath("claude-code", `/home/projects/acct/projects/enc/${a}.jsonl`)).toBe(a);
    expect(handoffCopySessionIdFromPath("codex", `/sessions/x/.codex/sessions/2026/11/10/rollout-t-${a}.jsonl`)).toBe(a);
  });
  test("the preferred session wins over a nested anchor-named folder", () => {
    const nested = `/r/projects/enc/${a}/tool-results/projects/x/${b}.jsonl`;
    expect(handoffCopySessionIdFromPath("claude-code", nested, a)).toBe(a);
  });
  test("anything else is null", () => {
    expect(handoffCopySessionIdFromPath("claude-code", "/r/settings.json")).toBeNull();
    expect(handoffCopySessionIdFromPath("claude-code", `/r/projects/enc/${a}/other/x.jsonl`)).toBeNull();
    expect(handoffCopySessionIdFromPath("codex", `/r/.codex/sessions/2026/11/rollout-${a}.jsonl`)).toBeNull();
    expect(handoffCopySessionIdFromPath("codex", "/r/.codex/sessions/2026/11/10/rollout-not-a-uuid.jsonl")).toBeNull();
  });
});
