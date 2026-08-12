// Test-only helpers for exercising the network functions in `gitlab.ts` (TT2,
// docs/plans/multi-provider-git-modal.md).
//
// Unlike github.ts's exported functions (which resolve `{owner,name}` from a
// real git remote via `repoForDir`), every gitlab.ts function already takes a
// resolved `ProviderRepoInfo` — the adapter is a leaf module that never shells
// out to git itself (see gitlab.ts's module doc comment). So there is no
// git-repo-on-disk fixture to build here, only a plain object factory.
//
// `mockGitHubFetch` (github-test-util.ts) is host-agnostic — it just matches
// on the request URL/method against a route table over `globalThis.fetch` —
// so it is reused directly here rather than re-implemented.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderRepoInfo } from "../shared/types.ts";

export { mockGitHubFetch as mockGitLabFetch } from "./github-test-util.ts";
export type { MockRoute, FetchCall, FetchMock } from "./github-test-util.ts";

/** A resolved GitLab repo identity, as `providerRepoForDir` (git-provider.ts)
 *  would produce for a project whose remote points at gitlab.com (or an
 *  ssh-alias host that canonicalizes to it). */
export function sampleRepo(overrides: Partial<ProviderRepoInfo> = {}): ProviderRepoInfo {
  return {
    provider: "gitlab",
    host: "gitlab.com",
    remoteHost: "gitlab.com",
    owner: "acme",
    name: "app",
    ...overrides,
  };
}

/** Same as `sampleRepo`, but with `remoteHost` set to a raw ssh-alias host
 *  (e.g. `git@gitlab-work.io:acme/app.git`) — exercises the multi-identity
 *  token-routing path the same way `makeAliasGitHubRepo` does for GitHub. */
export function sampleAliasRepo(aliasHost = "gitlab-work.io", overrides: Partial<ProviderRepoInfo> = {}): ProviderRepoInfo {
  return sampleRepo({ remoteHost: aliasHost, ...overrides });
}

/** Same as `sampleRepo`, but pointed at a genuine self-hosted GitLab domain
 *  (docs/plans/per-host-git-api-bases.md) — both `host` and `remoteHost` are
 *  the self-hosted domain itself (no ssh alias involved), exercising
 *  `gitlabApiBase`'s per-host routing in gitlab-network.test.ts. */
export function sampleSelfHostedRepo(selfHostedHost = "gitlab.mycompany.com", overrides: Partial<ProviderRepoInfo> = {}): ProviderRepoInfo {
  return sampleRepo({ host: selfHostedHost, remoteHost: selfHostedHost, ...overrides });
}

/** Writes an executable stub standing in for `ssh`, for pointing
 *  `AGETOR_SSH_BIN` (git-provider.ts's `apiHostForRemote` override) at
 *  deterministic, network-free hostname resolution — mirrors
 *  git-provider.test.ts's own `writeSshStub`. `apiHostForRemote` invokes it
 *  as `<stub> -G -- <host>`, so `$3` is the (lowercased, trimmed) host
 *  argument when a stub cares to inspect it. Each call gets its own
 *  throwaway mkdtemp dir under the OS tmp root, which the OS reclaims —
 *  callers don't need to track it for cleanup. */
export function writeSshStub(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-gitlab-ssh-stub-"));
  const binPath = path.join(dir, "ssh");
  writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

/** A minimal-but-valid GitLab merge-request JSON object (REST v4 shape), as
 *  returned by the merge_requests list/detail/create/update endpoints.
 *  Overridable per-field for individual tests. */
export function gitlabMergeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 1,
    title: "Add feature",
    state: "opened",
    draft: false,
    web_url: "https://gitlab.com/acme/app/-/merge_requests/1",
    author: { username: "alice", avatar_url: null, web_url: null },
    assignees: [],
    milestone: null,
    description: "body text",
    labels: ["bug"],
    user_notes_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    discussion_locked: false,
    sha: "deadbeef",
    ...overrides,
  };
}

/** A minimal-but-valid GitLab issue JSON object (REST v4 shape). */
export function gitlabIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 5,
    title: "Bug report",
    state: "opened",
    web_url: "https://gitlab.com/acme/app/-/issues/5",
    author: { username: "alice", avatar_url: null, web_url: null },
    assignees: [],
    milestone: null,
    description: "steps to reproduce",
    labels: [],
    user_notes_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    discussion_locked: false,
    ...overrides,
  };
}

/** A minimal-but-valid GitLab note (`/notes`) JSON object. `system: false`
 *  by default — set `system: true` to exercise the system-note exclusion in
 *  `listGitLabComments`. */
export function gitlabNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    body: "a comment",
    author: { username: "bob", avatar_url: null, web_url: null },
    created_at: "2026-01-01T01:00:00Z",
    updated_at: "2026-01-01T01:00:00Z",
    system: false,
    ...overrides,
  };
}

/** A minimal-but-valid GitLab discussion (`/discussions`) JSON object,
 *  wrapping one or more notes. Pass `notes` overrides to shape the inline
 *  `DiffNote` payload used for line-comment tests. */
export function gitlabDiscussion(notes: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "disc-1",
    individual_note: false,
    notes,
    ...overrides,
  };
}

/** A minimal-but-valid `DiffNote` — a note carrying an inline `position`. */
export function gitlabDiffNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...gitlabNote(),
    type: "DiffNote",
    position: {
      position_type: "text",
      new_path: "src/foo.ts",
      old_path: "src/foo.ts",
      new_line: 10,
      old_line: null,
    },
    ...overrides,
  };
}
