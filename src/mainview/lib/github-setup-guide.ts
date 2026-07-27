/**
 * Content for the "Connect Agetor to GitHub" setup guide (`GitHubSetupDialog.tsx`).
 *
 * This module is the **single source of truth** for that guide's copy — the
 * component only maps over these exports; no permission/scope/step text is
 * hardcoded in JSX. Keeping it as plain data (rather than markdown, which the
 * webview has no renderer for) means the dialog stays typed end-to-end and a
 * future test file can assert coverage (no duplicate scope names, https-only
 * URLs, every load-bearing permission present) without touching React.
 *
 * Permission facts (scope names, fine-grained permission names, what each
 * token type can and can't do) were verified against docs.github.com as of
 * July 2026. **Classic tokens are recommended for full Agetor access**
 * because three of the ~70 `/github/*` integration surfaces
 * (`src/bun/server.ts`) are classic-token-only or otherwise unreachable with
 * a fine-grained PAT: the Notifications API only accepts classic tokens, the
 * Checks API has no grantable fine-grained permission (commit statuses still
 * work), and repository Discussions has no fine-grained permission at all.
 * Fine-grained tokens are documented as the least-privilege alternative with
 * an explicit list of what won't work.
 */

/** One row in a fine-grained-token permission table. */
export type GuidePermissionRow = {
  name: string;
  level: "Read-only" | "Read and write";
  usedFor: string;
};

/** One row in a classic-token scope table. */
export type GuideScopeRow = {
  scope: string;
  usedFor: string;
};

/** One numbered step in a click-path (token creation, auth resolution, …). */
export type GuideStep = {
  title: string;
  detail: string;
};

/** GitHub URLs the guide links out to via `api.openExternal` (the webview is
 *  sandboxed — no `<a target="_blank">`, see `src/mainview/lib/api.ts`). */
export const GITHUB_URLS = {
  fineGrainedTokens: "https://github.com/settings/personal-access-tokens",
  classicTokens: "https://github.com/settings/tokens",
  tokenDocs:
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
} as const;

/**
 * How Agetor resolves the token used to authenticate a GitHub request, in
 * order — mirrors `githubToken()` in `src/bun/github.ts:856-863` exactly.
 * Keep this in lockstep with that function; it's documentation of real
 * runtime behavior, not aspirational copy.
 */
export const AUTH_RESOLUTION_STEPS: GuideStep[] = [
  {
    title: "A token saved in this Settings section",
    detail:
      "Agetor looks up the token stored for the repo's remote host (the raw ssh host — " +
      "e.g. github-work.com for an ssh alias remote). If none is stored for that exact " +
      "host, it falls back to whatever token is stored under the github.com entry.",
  },
  {
    title: "Environment variables",
    detail:
      "If no token is stored for the host, Agetor reads the GITHUB_TOKEN or GH_TOKEN " +
      "environment variable from the process it was launched with.",
  },
  {
    title: "GitHub CLI login",
    detail:
      "If neither of the above resolves a token, Agetor shells out to `gh auth token` " +
      "and uses whatever the GitHub CLI has you logged in as, if anything.",
  },
];

/** Recommended classic-token scopes for FULL Agetor access. */
export const CLASSIC_SCOPES: GuideScopeRow[] = [
  {
    scope: "repo",
    usedFor:
      "Pull requests, issues, comments, reviews, labels, milestones, releases, commit " +
      "statuses, check runs, diffs, and repository Discussions.",
  },
  {
    scope: "workflow",
    usedFor:
      "GitHub Actions — re-running, cancelling, and dispatching workflows, and pushing " +
      "any changes to workflow files.",
  },
  {
    scope: "notifications",
    usedFor:
      "The repo's notifications inbox and thread subscribe/unsubscribe. This API only " +
      "accepts classic tokens — a fine-grained token cannot reach it.",
  },
  {
    scope: "project",
    usedFor: "The Projects panel (classic and Projects v2 boards).",
  },
  {
    scope: "read:org",
    usedFor: "Org-owned Projects and other org context needed to resolve them.",
  },
];

/** Fine-grained-token permissions for least-privilege access. All are
 *  Repository permissions unless the row's `usedFor` says otherwise. */
export const FINE_GRAINED_PERMISSIONS: GuidePermissionRow[] = [
  {
    name: "Contents",
    level: "Read and write",
    usedFor: "Merging pull requests, applying review suggestions, releases and tags.",
  },
  {
    name: "Pull requests",
    level: "Read and write",
    usedFor:
      "Listing, creating, merging, closing, drafting, and auto-merging PRs; reviews, " +
      "line comments, suggestions, and review threads.",
  },
  {
    name: "Issues",
    level: "Read and write",
    usedFor:
      "Issues, comments, labels, milestones, locking/pinning/transferring, and sub-issues.",
  },
  {
    name: "Actions",
    level: "Read and write",
    usedFor: "Listing, re-running, cancelling, and dispatching workflow runs.",
  },
  {
    name: "Commit statuses",
    level: "Read-only",
    usedFor: "The commit status panel.",
  },
  {
    name: "Metadata",
    level: "Read-only",
    usedFor: "Added automatically by GitHub — collaborators and repository info.",
  },
  {
    name: "Projects (Organization permission)",
    level: "Read and write",
    usedFor: "Org-owned Projects v2.",
  },
];

/** What a fine-grained PAT cannot reach in Agetor, even with every
 *  permission above granted — phrased for the dialog's warning list. */
export const FINE_GRAINED_LIMITATIONS: string[] = [
  "The notifications inbox — GitHub's Notifications API only supports classic tokens.",
  "Repository Discussions — there is no fine-grained permission for repo discussions.",
  "Check-run details — the Checks API can't be granted to fine-grained tokens (commit statuses still work).",
  "User-owned (non-organization) Projects.",
];

/** Caveats specific to organization-owned repositories. */
export const ORG_CAVEATS: string[] = [
  "A fine-grained token used against an organization's repos may need the organization to allow fine-grained tokens at all, and can sit in a \"Pending\" state until an org admin approves it.",
  "Classic tokens for organizations with SAML SSO enabled must be authorized per-organization via the token's \"Configure SSO\" menu before they'll work against that org's repos.",
  "Organization policies may cap how long any token — classic or fine-grained — is allowed to live.",
];

/** Why the same GitHub identity resolves differently across repos, and how
 *  to run multiple GitHub accounts side by side. */
export const MULTI_ACCOUNT_NOTE: string =
  "Tokens are stored per remote host, not globally. A repo reached through an ssh host " +
  "alias (e.g. git@github-work.com:org/repo.git) authenticates with whatever token is " +
  "stored for that alias host; the github.com entry is the default used for ordinary " +
  "github.com remotes. This is how multiple GitHub identities — a personal account and " +
  "a work account, say — can coexist in the same Agetor install.";

/** Click-path to create a fine-grained personal access token. */
export const FINE_GRAINED_CREATE_STEPS: GuideStep[] = [
  {
    title: "Open GitHub → Settings → Developer settings",
    detail: "From your GitHub profile picture, go to Settings, then Developer settings in the left sidebar.",
  },
  {
    title: "Personal access tokens → Fine-grained tokens",
    detail: "Choose \"Fine-grained tokens\", then click \"Generate new token\".",
  },
  {
    title: "Name, expiration, and resource owner",
    detail:
      "Pick a name and expiration. Set \"Resource owner\" to your personal account, or " +
      "the organization that owns the repositories you want Agetor to work with.",
  },
  {
    title: "Repository access",
    detail:
      "Choose \"Only select repositories\" and pick the repos Agetor should touch (or " +
      "\"All repositories\" if you want it to cover everything under that owner).",
  },
  {
    title: "Set permissions",
    detail: "Grant the permissions listed below, then click \"Generate token\" and copy it — it's shown only once.",
  },
];

/** Click-path to create a classic personal access token. */
export const CLASSIC_CREATE_STEPS: GuideStep[] = [
  {
    title: "Open GitHub → Settings → Developer settings",
    detail: "From your GitHub profile picture, go to Settings, then Developer settings in the left sidebar.",
  },
  {
    title: "Personal access tokens → Tokens (classic)",
    detail: "Choose \"Tokens (classic)\", then \"Generate new token\" → \"Generate new token (classic)\".",
  },
  {
    title: "Note and expiration",
    detail: "Give the token a note describing what it's for, and pick an expiration.",
  },
  {
    title: "Select scopes",
    detail: "Tick the scopes listed below, then click \"Generate token\" and copy it — it's shown only once.",
  },
  {
    title: "SAML SSO organizations",
    detail:
      "If the token needs to reach an org with SAML SSO enabled, open the token's " +
      "\"Configure SSO\" menu afterward and authorize it for that organization.",
  },
];
