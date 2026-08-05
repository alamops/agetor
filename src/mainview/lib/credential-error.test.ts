import { describe, expect, test } from "bun:test";
import { isCredentialError } from "./credential-error.ts";

describe("isCredentialError", () => {
  test("detects the marker phrase github.ts's privateRepoHint appends", () => {
    const err = "acme/app was not found on GitHub — if the repo is private, add a token for github.com in Settings → Git host tokens";
    expect(isCredentialError(err)).toBe(true);
  });

  test("detects the marker phrase gitlab.ts's authHint appends", () => {
    const err = "acme/app was not found on GitLab — if the project is private, add a token for gitlab.com in Settings → Git host tokens";
    expect(isCredentialError(err)).toBe(true);
  });

  test("detects the marker phrase bitbucket.ts's bitbucketAccessHint appends, including the authenticated-403 scope-check append", () => {
    const notFound = "acme/app was not found on Bitbucket (…) — if the repo is private, add a credential for bitbucket.org in Settings → Git host tokens (Bitbucket Basic auth: email:api_token)";
    expect(isCredentialError(notFound)).toBe(true);

    const scopeAppend = "Branch restrictions: at least 2 approvals are required to merge this pull request. — if the configured credential for bitbucket.org lacks the required Bitbucket scopes, update it in Settings → Git host tokens.";
    expect(isCredentialError(scopeAppend)).toBe(true);
  });

  test("returns false for a plain error with no Settings pointer", () => {
    expect(isCredentialError("500 Internal Server Error")).toBe(false);
    expect(isCredentialError("Branch restrictions: at least 2 approvals are required to merge this pull request.")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isCredentialError(null)).toBe(false);
  });
});
