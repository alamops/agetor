// Contract between the three places a Create-all-PRs link passes through
// (docs/plans/create-all-prs-title-and-base.md C2/C3, D8):
//
//   commitPushPrompt (src/shared/types.ts) asks the agent for a per-forge link
//   built from the remote URL  ──▶  parsePrLink / linkMatchesRepo
//   (src/mainview/lib/pr-link.ts) read it back  ──▶  matched against the identity
//   the core reports for the repository (parseGitRemote, src/bun/github.ts,
//   behind GET /github/provider-info).
//
// Each half has its own tests with hand-written fixtures; this file fills the
// prompt's OWN link templates with a real remote's parts and checks the parser
// recovers the head and base and attributes the link to that remote. A prompt
// that changes a link shape without the parser following it (or the reverse)
// fails here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitPushPrompt, type RunEvent } from "../shared/types.ts";
import { linkMatchesRepo, parsePrLink, type RepoIdentity } from "../mainview/lib/pr-link.ts";
import { collectRunProposals } from "../mainview/lib/pr-proposal.ts";
import { attributeProposals } from "../mainview/lib/pr-plan.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// github.ts may reach db.ts through its imports: set the data dir first and import dynamically.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pr-link-contract-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { parseGitRemote } = await import("./github.ts");
afterAll(() => rmTestDataDir(DATA_DIR));

type Forge = "github" | "gitlab" | "bitbucket";

/** The three link templates the prompt spells out, keyed by forge. */
function promptTemplates(prompt: string): Record<Forge, string> {
  const found = (prompt.match(/https:\/\/<host>\/[^\s;]+/g) ?? []).map((t) => t.replace(/[.;]$/, ""));
  expect(found).toHaveLength(3);
  const pick = (re: RegExp) => {
    const hits = found.filter((t) => re.test(t));
    expect(hits).toHaveLength(1);
    return hits[0]!;
  };
  return {
    github: pick(/\/compare\//),
    gitlab: pick(/merge_requests/),
    bitbucket: pick(/pull-requests/),
  };
}

/** Fill a template the way an agent following the prompt would, from a remote URL. */
function fill(template: string, remote: { rawHost: string; owner: string; name: string }, head: string, base: string, encode: boolean): string {
  const full = `${remote.owner}/${remote.name}`;
  const lastSlash = full.lastIndexOf("/");
  const namespace = full.slice(0, lastSlash);
  const project = full.slice(lastSlash + 1);
  const enc = (s: string) => (encode ? encodeURIComponent(s) : s);
  return template
    .replaceAll("<host>", remote.rawHost)
    .replaceAll("<owner>", remote.owner)
    .replaceAll("<workspace>", remote.owner)
    .replaceAll("<namespace>", namespace)
    .replaceAll("<project>", project)
    .replaceAll("<repo>", remote.name)
    .replaceAll("<head>", enc(head))
    .replaceAll("<base>", enc(base));
}

const REMOTES: Array<{ forge: Forge; url: string }> = [
  // An ssh host alias (per-identity keys in ~/.ssh/config).
  { forge: "github", url: "git@github-work.com:acme/app.git" },
  // A self-hosted GitLab with a nested group: the remote parser splits it
  // {owner:"grp", name:"sub/proj"}, the link parser {owner:"grp/sub", repo:"proj"}.
  { forge: "gitlab", url: "git@gitlab.corp.example:grp/sub/proj.git" },
  { forge: "bitbucket", url: "https://bitbucket.org/ws/repo.git" },
];

const identityOf = (url: string): RepoIdentity & { rawHost: string } => {
  const parsed = parseGitRemote(url);
  expect(parsed).not.toBeNull();
  // GET /github/provider-info reports the canonical host, owner and name.
  return { host: parsed!.host, owner: parsed!.owner, name: parsed!.name, rawHost: parsed!.rawHost };
};

const PROMPTS = {
  single: commitPushPrompt({ branch: "feature/login-x", taskType: "task", baseBranch: "release/1.2" }),
  multi: commitPushPrompt({
    branch: null,
    taskType: "task",
    multiRepo: true,
    repositories: [
      {
        path: "/src/app",
        name: "app",
        branch: "feature/login-x",
        branchSource: "created",
        worktreePath: null,
        baseRef: null,
        checkoutBranch: null,
        prUrl: null,
        baseBranch: "release/1.2",
        prs: [],
      },
      {
        path: "/src/infra",
        name: "infra",
        branch: "feature/login-x",
        branchSource: "created",
        worktreePath: null,
        baseRef: null,
        checkoutBranch: null,
        prUrl: null,
        baseBranch: null,
        prs: [],
      },
    ],
  }),
};

describe("the prompt's link templates read back through the parser", () => {
  for (const [variant, prompt] of Object.entries(PROMPTS)) {
    for (const { forge, url } of REMOTES) {
      for (const encode of [true, false]) {
        test(`${variant} prompt, ${forge}, ${encode ? "encoded" : "raw"} names: head and base survive and the link attributes to its remote`, () => {
          const id = identityOf(url);
          const link = fill(promptTemplates(prompt)[forge], id, "feature/login-x", "release/1.2", encode);
          const parsed = parsePrLink(link);
          expect(parsed).not.toBeNull();
          expect(parsed).toMatchObject({ forge, head: "feature/login-x", base: "release/1.2" });
          expect(linkMatchesRepo(parsed!, id)).toBe(true);
        });
      }
    }
  }

  test("an ssh-alias remote: the prompt asks for the web host, and a link built with it still attributes", () => {
    for (const prompt of Object.values(PROMPTS)) {
      expect(prompt).toContain("use the HostName that alias points to");
      // An SSH-over-443 HostName is a transport endpoint, never the link's host.
      expect(prompt).toContain("ssh.github.com means github.com");
      expect(prompt).toContain("altssh.gitlab.com means gitlab.com");
      expect(prompt).toContain("altssh.bitbucket.org means bitbucket.org");
    }
    // `ssh -G github-work.com` would report HostName github.com: the canonical host.
    const id = identityOf("git@github-work.com:acme/app.git");
    expect(id.rawHost).toBe("github-work.com");
    const link = fill(promptTemplates(PROMPTS.single).github, { ...id, rawHost: id.host }, "feature/login-x", "release/1.2", true);
    expect(link.startsWith("https://github.com/acme/app/compare/")).toBe(true);
    const parsed = parsePrLink(link);
    expect(parsed).toMatchObject({ forge: "github", head: "feature/login-x", base: "release/1.2" });
    expect(linkMatchesRepo(parsed!, id)).toBe(true);
  });

  test("a link to another repository on the same host never attributes", () => {
    for (const { forge, url } of REMOTES) {
      const id = identityOf(url);
      const other = { ...id, name: `${id.name}-other` };
      const parsed = parsePrLink(fill(promptTemplates(PROMPTS.single)[forge], other, "feature/a", "main", true));
      expect(parsed).not.toBeNull();
      expect(linkMatchesRepo(parsed!, id)).toBe(false);
    }
  });
});

describe("a reply in the prompt's requested shape attributes per repository", () => {
  test("unlabeled multi-repo proposals land on the repository each link names, with its own title and base", () => {
    const gh = identityOf("git@github-work.com:acme/app.git");
    const gl = identityOf("git@gitlab.corp.example:grp/sub/proj.git");
    const t = promptTemplates(PROMPTS.multi);
    const block = (base: string, link: string, title: string, body: string) =>
      [`Base: ${base}`, link, "PR title:", "```", title, "```", "PR description:", "````", body, "````", ""].join("\n");
    const reply = [
      "Pushed both repositories.",
      "",
      block("release/1.2", fill(t.github, gh, "feature/login-x", "release/1.2", true), "App login", "App body."),
      block("main", fill(t.gitlab, gl, "feature/login-x", "main", false), "Infra login", "Infra body."),
    ].join("\n");
    const events = [{ runId: "r1", taskId: "t1", stream: "assistant", data: reply, ts: 0 } as RunEvent];

    const attribution = attributeProposals(
      collectRunProposals(events),
      [
        { name: "app", liveHead: "feature/login-x", identity: gh },
        { name: "infra", liveHead: "feature/login-x", identity: gl },
      ],
      { multi: true },
    );
    expect(attribution.get("app")?.get("feature/login-x")).toMatchObject({
      title: "App login",
      description: "App body.",
      baseLine: "release/1.2",
      linkBase: "release/1.2",
    });
    expect(attribution.get("infra")?.get("feature/login-x")).toMatchObject({
      title: "Infra login",
      description: "Infra body.",
      baseLine: "main",
      linkBase: "main",
    });
  });
});
