import type { ReactNode } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
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
  type GuideScopeRow,
  type GuideStep,
} from "@/lib/github-setup-guide";

/** Click-path to create a Bitbucket Atlassian API token, used in place of
 *  the retired (2026-06-09) app-password flow. Stored as a single
 *  `email:api_token` string — Bitbucket's Basic auth format. A *scopeless*
 *  Atlassian API token (the default the Atlassian account UI offers, aimed at
 *  Jira/Confluence) is rejected by api.bitbucket.org — the token must be
 *  created "with scopes" and have the Bitbucket scopes below selected. */
const BITBUCKET_CREATE_STEPS: GuideStep[] = [
  {
    title: "Open id.atlassian.com → Security",
    detail: "Sign in at id.atlassian.com, then choose \"Security\" in the left sidebar.",
  },
  {
    title: "Create an API token with scopes",
    detail:
      "Under \"API tokens\", click \"Create API token with scopes\" (NOT the plain, scopeless " +
      "\"Create API token\" — a scopeless token works for Jira/Confluence but api.bitbucket.org " +
      "rejects it). Give it a name, then select \"Bitbucket\" and tick the scopes listed below.",
  },
  {
    title: "Copy the token",
    detail: "Click \"Create\" and copy the generated token — it's shown only once.",
  },
  {
    title: "Save it as email:api_token",
    detail:
      "Back in the Git host tokens section, enter the host (bitbucket.org, or your ssh " +
      "alias host) and put your Atlassian account email, a colon, then the API token in " +
      "the token field — e.g. \"jane@example.com:ATATT3x…\". Bitbucket app passwords were " +
      "retired on 2026-06-09; replace any saved app password with a token in this format.",
  },
];

/** Bitbucket scopes to select when creating the scoped API token above — the
 *  minimum set covering everything this adapter's ~18 call sites touch
 *  (src/bun/bitbucket.ts): repository read/write for PR diffs, statuses, and
 *  merges; pull request and issue read/write; account read to resolve the
 *  viewer (`getBitbucketViewer`, used for the "me"-scoped BBQL filters). */
const BITBUCKET_SCOPES: GuideScopeRow[] = [
  {
    scope: "Repositories: Read, Write",
    usedFor: "Listing repos, reading diffs/commit statuses, and merging pull requests.",
  },
  {
    scope: "Pull requests: Read, Write",
    usedFor:
      "Listing, creating, merging, declining, and reviewing PRs; PR and line comments; " +
      "merge-conflict detection.",
  },
  {
    scope: "Issues: Read, Write",
    usedFor: "The repository issue tracker — listing, creating, updating, and commenting.",
  },
  {
    scope: "Account: Read",
    usedFor: "Resolving the signed-in account, used for \"assigned to me\"/\"created by me\" filters.",
  },
];

/** Click-path to create a GitLab personal access token. */
const GITLAB_CREATE_STEPS: GuideStep[] = [
  {
    title: "Open GitLab → Edit profile → Access tokens",
    detail:
      "From your GitLab avatar, go to \"Edit profile\", then \"Access tokens\" in the left " +
      "sidebar.",
  },
  {
    title: "Name, expiration, and scope",
    detail: "Give the token a name and expiration, then select the \"api\" scope.",
  },
  {
    title: "Create and save it in Agetor",
    detail:
      "Click \"Create personal access token\" and copy it — it's shown only once. Back in " +
      "the Git host tokens section, enter the host (gitlab.com, or your ssh alias host) and " +
      "the token itself.",
  },
];

const BITBUCKET_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const GITLAB_TOKENS_URL = "https://gitlab.com/-/user_settings/personal_access_tokens";

/**
 * "Connect Agetor to a git host" instructions modal, opened from
 * `GitHubTokensSection` (the header button and the empty-state link). Purely
 * informational — it does not embed the token form itself, which lives
 * directly behind it in the same Settings section. GitHub copy is sourced
 * from `lib/github-setup-guide.ts`; Bitbucket and GitLab copy is local to
 * this component (smaller, single-consumer guides that don't warrant a
 * shared data module yet). This component supplies section
 * headings/intro sentences and layout.
 */
export function GitHubSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-2xl"
      labelledBy="github-setup-dialog-title"
      describedBy="github-setup-dialog-desc"
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <h2 id="github-setup-dialog-title" className="text-base font-semibold">
          Connect Agetor to a git host
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      <div className="max-h-[70vh] space-y-5 overflow-y-auto pt-3 text-sm">
        <section className="space-y-1">
          <p id="github-setup-dialog-desc" className="text-[11px] leading-snug text-muted-foreground">
            Agetor talks to GitHub, GitLab, and Bitbucket using a token or credential that you
            create and paste into the Git host tokens Settings section. For GitHub, the
            integration covers pull requests, issues, reviews, checks, Actions, releases,
            Projects, Discussions, and notifications — how much of that works depends on which
            permissions the token you save actually has. Set up whichever host(s) apply to you
            below.
          </p>
        </section>

        <GuideSection heading="GitHub: how Agetor finds a token">
          <StepList steps={AUTH_RESOLUTION_STEPS} />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Bitbucket and GitLab resolve the same way minus the CLI-login step: Bitbucket tries a
            stored host entry, then the bitbucket.org entry, then the{" "}
            <code className="font-mono">BITBUCKET_TOKEN</code>/
            <code className="font-mono">BITBUCKET_EMAIL</code> environment variables; GitLab tries a
            stored entry, then <code className="font-mono">GITLAB_TOKEN</code>, then a stored{" "}
            <code className="font-mono">glab</code> CLI login.
          </p>
        </GuideSection>

        <GuideSection heading="GitHub — recommended: classic token (full access)">
          <StepList steps={CLASSIC_CREATE_STEPS} />
          <div className="space-y-1.5">
            {CLASSIC_SCOPES.map((row) => (
              <div key={row.scope} className="rounded-md border border-border/60 px-3 py-2">
                <div className="font-mono text-xs">{row.scope}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">{row.usedFor}</div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void api.openExternal(GITHUB_URLS.classicTokens)}>
              Open GitHub → Tokens (classic)
            </Button>
          </div>
        </GuideSection>

        <GuideSection heading="GitHub — alternative: fine-grained token (least privilege)">
          <StepList steps={FINE_GRAINED_CREATE_STEPS} />
          <div className="space-y-1.5">
            {FINE_GRAINED_PERMISSIONS.map((row) => (
              <div key={row.name} className="rounded-md border border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{row.level}</span>
                </div>
                <div className="text-[11px] leading-snug text-muted-foreground">{row.usedFor}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1 rounded-md border border-border/60 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-warning">
              Not available with fine-grained tokens
            </p>
            <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
              {FINE_GRAINED_LIMITATIONS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openExternal(GITHUB_URLS.fineGrainedTokens)}
            >
              Open GitHub → Fine-grained tokens
            </Button>
          </div>
        </GuideSection>

        <GuideSection heading="GitHub — working with organizations">
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
            {ORG_CAVEATS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </GuideSection>

        <GuideSection heading="GitHub — multiple accounts">
          <p className="text-[11px] leading-snug text-muted-foreground">{MULTI_ACCOUNT_NOTE}</p>
        </GuideSection>

        <GuideSection heading="Bitbucket: Atlassian API token">
          <StepList steps={BITBUCKET_CREATE_STEPS} />
          <div className="space-y-1.5">
            {BITBUCKET_SCOPES.map((row) => (
              <div key={row.scope} className="rounded-md border border-border/60 px-3 py-2">
                <div className="font-mono text-xs">{row.scope}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">{row.usedFor}</div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openExternal(BITBUCKET_TOKENS_URL)}
            >
              Open Atlassian → API tokens
            </Button>
          </div>
        </GuideSection>

        <GuideSection heading="GitLab: personal access token">
          <StepList steps={GITLAB_CREATE_STEPS} />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openExternal(GITLAB_TOKENS_URL)}
            >
              Open GitLab → Access tokens
            </Button>
          </div>
        </GuideSection>

        <GuideSection heading="Save the credential in Agetor">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Back in this Settings section, paste the host (github.com, gitlab.com,
            bitbucket.org, or your ssh alias host), an optional label, and the token — or, for
            Bitbucket, the <code className="font-mono">email:api_token</code> string — into the
            fields below, then click Save token.
          </p>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="link"
              className="h-auto p-0"
              onClick={() => void api.openExternal(GITHUB_URLS.tokenDocs)}
            >
              GitHub's token documentation
            </Button>
          </div>
        </GuideSection>
      </div>
    </Dialog>
  );
}

function GuideSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium">{heading}</h3>
      {children}
    </section>
  );
}

function StepList({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => (
        <li key={step.title} className="rounded-md border border-border/60 px-3 py-2">
          <div className="text-xs font-medium">
            {i + 1}. {step.title}
          </div>
          <div className="text-[11px] leading-snug text-muted-foreground">{step.detail}</div>
        </li>
      ))}
    </ol>
  );
}
