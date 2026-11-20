# Spec — Create all PRs: right title/body, right base, base-aware PR link

Source: the "Overall goal" of the owner's pipeline run that produced this change (it lives in the pipeline prompt, not in the repo). Copied here unamended so reviewers can check the code against it. The owner's decisions that refine it are in `docs/plans/create-all-prs-title-and-base-grill.md`; the plan is `docs/plans/create-all-prs-title-and-base.md`.

> The Create All PRs button is wrongly getting the PR's title and body the commit & push output generates for multiple PRs.
>
> And, is not creating the PR for when the target is not the default branch in the repo.
>
> We must fix it.
>
> Also, include reviewing the commit and push button's prompt to ask the agent to formulate the link already targeting the destinated branch.
