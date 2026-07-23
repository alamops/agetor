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
  type GuideStep,
} from "@/lib/github-setup-guide";

/**
 * "Connect Agetor to GitHub" instructions modal, opened from
 * `GitHubTokensSection` (the header button and the empty-state link). Purely
 * informational — it does not embed the token form itself, which lives
 * directly behind it in the same Settings section. All copy is sourced from
 * `lib/github-setup-guide.ts`; this component only supplies section
 * headings/intro sentences and layout.
 */
export function GitHubSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl" labelledBy="github-setup-dialog-title">
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <h2 id="github-setup-dialog-title" className="text-base font-semibold">
          Connect Agetor to GitHub
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      <div className="max-h-[70vh] space-y-5 overflow-y-auto pt-3 text-sm">
        <section className="space-y-1">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Agetor talks to GitHub using a personal access token (PAT) that you create and
            paste into this Settings section. The integration covers pull requests, issues,
            reviews, checks, Actions, releases, Projects, Discussions, and notifications —
            how much of that works depends on which permissions the token you save actually
            has.
          </p>
        </section>

        <GuideSection heading="How Agetor finds a token">
          <StepList steps={AUTH_RESOLUTION_STEPS} />
        </GuideSection>

        <GuideSection heading="Recommended: classic token (full access)">
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

        <GuideSection heading="Alternative: fine-grained token (least privilege)">
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
            <p className="text-[11px] font-medium uppercase tracking-wide text-amber-400">
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

        <GuideSection heading="Working with organizations">
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
            {ORG_CAVEATS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </GuideSection>

        <GuideSection heading="Multiple GitHub accounts">
          <p className="text-[11px] leading-snug text-muted-foreground">{MULTI_ACCOUNT_NOTE}</p>
        </GuideSection>

        <GuideSection heading="Save the token in Agetor">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Back in this Settings section, paste the host (github.com, or your ssh alias host),
            an optional label, and the token itself into the fields below, then click Save
            token.
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
