import { describe, expect, test } from "bun:test";
import {
  AUTH_RESOLUTION_STEPS,
  CLASSIC_CREATE_STEPS,
  CLASSIC_SCOPES,
  FINE_GRAINED_CREATE_STEPS,
  FINE_GRAINED_LIMITATIONS,
  FINE_GRAINED_PERMISSIONS,
  GITHUB_URLS,
  MULTI_ACCOUNT_NOTE,
  ORG_CAVEATS,
} from "./github-setup-guide.ts";

describe("GITHUB_URLS", () => {
  for (const [key, url] of Object.entries(GITHUB_URLS)) {
    test(`${key} starts with https:// and points at a github.com host`, () => {
      expect(url.startsWith("https://")).toBe(true);
      const parsed = new URL(url);
      expect(["github.com", "docs.github.com"]).toContain(parsed.host);
    });
  }
});

describe("AUTH_RESOLUTION_STEPS", () => {
  test("has exactly 3 steps", () => {
    expect(AUTH_RESOLUTION_STEPS).toHaveLength(3);
  });

  test("step 1 mentions stored tokens / Settings", () => {
    const step = AUTH_RESOLUTION_STEPS[0]!;
    const combined = `${step.title} ${step.detail}`.toLowerCase();
    expect(combined).toContain("token");
    expect(combined).toContain("settings");
  });

  test("step 2 mentions both GITHUB_TOKEN and GH_TOKEN verbatim", () => {
    const step = AUTH_RESOLUTION_STEPS[1]!;
    const combined = `${step.title} ${step.detail}`;
    expect(combined).toContain("GITHUB_TOKEN");
    expect(combined).toContain("GH_TOKEN");
  });

  test("step 3 mentions gh auth token verbatim", () => {
    const step = AUTH_RESOLUTION_STEPS[2]!;
    const combined = `${step.title} ${step.detail}`;
    expect(combined).toContain("gh auth token");
  });
});

describe("CLASSIC_SCOPES", () => {
  test("scope names are unique", () => {
    const names = CLASSIC_SCOPES.map((row) => row.scope);
    expect(new Set(names).size).toBe(names.length);
  });

  test("includes exactly the expected scope set", () => {
    const names = CLASSIC_SCOPES.map((row) => row.scope).sort();
    const expected = ["notifications", "project", "read:org", "repo", "workflow"].sort();
    expect(names).toEqual(expected);
  });

  test("every usedFor is non-empty", () => {
    for (const row of CLASSIC_SCOPES) {
      expect(row.usedFor.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("FINE_GRAINED_PERMISSIONS", () => {
  test("permission names are unique", () => {
    const names = FINE_GRAINED_PERMISSIONS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("levels are only Read-only or Read and write", () => {
    for (const row of FINE_GRAINED_PERMISSIONS) {
      expect(["Read-only", "Read and write"]).toContain(row.level);
    }
  });

  test("Contents, Pull requests, Issues, and Actions are Read and write", () => {
    const byName = new Map(FINE_GRAINED_PERMISSIONS.map((row) => [row.name, row.level]));
    for (const name of ["Contents", "Pull requests", "Issues", "Actions"]) {
      expect(byName.get(name)).toBe("Read and write");
    }
  });

  test("Commit statuses and Metadata are Read-only", () => {
    const byName = new Map(FINE_GRAINED_PERMISSIONS.map((row) => [row.name, row.level]));
    for (const name of ["Commit statuses", "Metadata"]) {
      expect(byName.get(name)).toBe("Read-only");
    }
  });

  test("every usedFor is non-empty", () => {
    for (const row of FINE_GRAINED_PERMISSIONS) {
      expect(row.usedFor.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("FINE_GRAINED_LIMITATIONS", () => {
  test("is non-empty", () => {
    expect(FINE_GRAINED_LIMITATIONS.length).toBeGreaterThan(0);
  });

  test("collectively mention notifications, discussions, checks, and projects", () => {
    const combined = FINE_GRAINED_LIMITATIONS.join(" ").toLowerCase();
    for (const term of ["notifications", "discussions", "checks", "projects"]) {
      expect(combined).toContain(term);
    }
  });
});

describe("ORG_CAVEATS", () => {
  test("is non-empty", () => {
    expect(ORG_CAVEATS.length).toBeGreaterThan(0);
  });

  test("mentions SSO somewhere", () => {
    const combined = ORG_CAVEATS.join(" ");
    expect(combined).toContain("SSO");
  });
});

describe("MULTI_ACCOUNT_NOTE", () => {
  test("mentions github.com", () => {
    expect(MULTI_ACCOUNT_NOTE).toContain("github.com");
  });
});

describe("FINE_GRAINED_CREATE_STEPS", () => {
  test("is non-empty with non-empty titles and details", () => {
    expect(FINE_GRAINED_CREATE_STEPS.length).toBeGreaterThan(0);
    for (const step of FINE_GRAINED_CREATE_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.detail.trim().length).toBeGreaterThan(0);
    }
  });

  test("mentions Fine-grained somewhere", () => {
    const combined = FINE_GRAINED_CREATE_STEPS.map((s) => `${s.title} ${s.detail}`).join(" ");
    expect(combined).toContain("Fine-grained");
  });
});

describe("CLASSIC_CREATE_STEPS", () => {
  test("is non-empty with non-empty titles and details", () => {
    expect(CLASSIC_CREATE_STEPS.length).toBeGreaterThan(0);
    for (const step of CLASSIC_CREATE_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.detail.trim().length).toBeGreaterThan(0);
    }
  });

  test('mentions "Tokens (classic)" somewhere', () => {
    const combined = CLASSIC_CREATE_STEPS.map((s) => `${s.title} ${s.detail}`).join(" ");
    expect(combined).toContain("Tokens (classic)");
  });
});
