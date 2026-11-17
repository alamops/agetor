import { describe, expect, test } from "bun:test";
import { linkMatchesRepo, parsePrLink } from "./pr-link.ts";

describe("parsePrLink — GitHub", () => {
  test("compare/<base>...<head>?quick_pull=1 reads base and head", () => {
    expect(parsePrLink("https://github.com/acme/app/compare/main...feature/a?quick_pull=1")).toEqual({
      forge: "github", host: "github.com", owner: "acme", repo: "app", head: "feature/a", base: "main",
    });
  });
  test("percent-encoded names decode, including an encoded slash", () => {
    const l = parsePrLink("https://github.com/acme/app/compare/release%2F1.2...feature%2Fa%20b?quick_pull=1");
    expect(l?.base).toBe("release/1.2");
    expect(l?.head).toBe("feature/a b");
  });
  test("compare/<head> names the head only", () => {
    const l = parsePrLink("https://github.com/acme/app/compare/feature/a");
    expect(l?.head).toBe("feature/a");
    expect(l?.base).toBeNull();
  });
  test("legacy pull/new/<head> names the head only", () => {
    const l = parsePrLink("https://github.com/acme/app/pull/new/feature/a");
    expect(l).toMatchObject({ head: "feature/a", base: null, owner: "acme", repo: "app" });
  });
  test("a fork head (owner:branch) reads as head null", () => {
    const l = parsePrLink("https://github.com/acme/app/compare/main...someone:feature");
    expect(l?.head).toBeNull();
    expect(l?.base).toBe("main");
  });
  test("a PR page, a repo page and garbage are not PR links", () => {
    expect(parsePrLink("https://github.com/acme/app/pull/12")).toBeNull();
    expect(parsePrLink("https://github.com/acme/app")).toBeNull();
    expect(parsePrLink("not a url")).toBeNull();
    expect(parsePrLink("ftp://github.com/acme/app/compare/a...b")).toBeNull();
    expect(parsePrLink("https://github.com/acme/app/compare/%E0%A4%A...b")).toBeNull();
  });
});

describe("parsePrLink — GitLab", () => {
  test("raw brackets", () => {
    const l = parsePrLink(
      "https://gitlab.com/acme/app/-/merge_requests/new?merge_request[source_branch]=feature/a&merge_request[target_branch]=develop",
    );
    expect(l).toEqual({ forge: "gitlab", host: "gitlab.com", owner: "acme", repo: "app", head: "feature/a", base: "develop" });
  });
  test("percent-encoded brackets and names", () => {
    const l = parsePrLink(
      "https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fa&merge_request%5Btarget_branch%5D=release%2F1.2",
    );
    expect(l?.head).toBe("feature/a");
    expect(l?.base).toBe("release/1.2");
  });
  test("a nested group reads owner as the whole group path", () => {
    const l = parsePrLink("https://gitlab.com/group/sub/project/-/merge_requests/new?merge_request[source_branch]=x");
    expect(l).toMatchObject({ owner: "group/sub", repo: "project", head: "x", base: null });
  });
  test("an MR page is not a PR link", () => {
    expect(parsePrLink("https://gitlab.com/acme/app/-/merge_requests/12")).toBeNull();
  });
});

describe("parsePrLink — Bitbucket", () => {
  test("source and dest", () => {
    expect(parsePrLink("https://bitbucket.org/acme/app/pull-requests/new?source=feature%2Fa&dest=main")).toEqual({
      forge: "bitbucket", host: "bitbucket.org", owner: "acme", repo: "app", head: "feature/a", base: "main",
    });
  });
  test("a PR page is not a PR link", () => {
    expect(parsePrLink("https://bitbucket.org/acme/app/pull-requests/4")).toBeNull();
  });
});

describe("linkMatchesRepo", () => {
  const link = parsePrLink("https://github.com/Acme/App/compare/main...x")!;
  test("host and owner/name match case-insensitively, ignoring .git", () => {
    expect(linkMatchesRepo(link, { host: "github.com", owner: "acme", name: "app.git" })).toBe(true);
  });
  test("another repository or host does not match", () => {
    expect(linkMatchesRepo(link, { host: "github.com", owner: "acme", name: "other" })).toBe(false);
    expect(linkMatchesRepo(link, { host: "gitlab.com", owner: "acme", name: "app" })).toBe(false);
  });
  test("a GitLab nested project compares as one slash-joined path", () => {
    const nested = parsePrLink("https://gitlab.com/group/sub/project/-/merge_requests/new?merge_request[source_branch]=x")!;
    // The remote parser splits the same project as owner "group", name "sub/project".
    expect(linkMatchesRepo(nested, { host: "gitlab.com", owner: "group", name: "sub/project" })).toBe(true);
    expect(linkMatchesRepo(nested, { host: "gitlab.com", owner: "group/sub", name: "project" })).toBe(true);
    expect(linkMatchesRepo(nested, { host: "gitlab.com", owner: "group", name: "project" })).toBe(false);
  });
});
