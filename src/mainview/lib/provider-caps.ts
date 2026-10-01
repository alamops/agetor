import { PROVIDER_CAPS, type GitProvider, type ProviderCaps } from "../../shared/types.ts";

/** The Git dialog's provider state: a resolved provider, `"mixed"` for an
 *  aggregate view spanning more than one provider, or `null` while the
 *  provider-info lookup is still in flight (or failed). */
export type DialogProvider = GitProvider | "mixed" | null;

/** The boolean feature flags of {@link ProviderCaps} (everything but the
 *  merge-method list and the terminology strings). */
export type ProviderCapFlag = {
  [K in keyof ProviderCaps]: ProviderCaps[K] extends boolean ? K : never;
}[keyof ProviderCaps];

/**
 * Capability set used for *rendering* (terminology + which affordances show).
 * Defaults to GitHub's while unresolved or mixed, so the overwhelmingly common
 * GitHub case never flickers during the brief provider lookup.
 */
export function displayCaps(provider: DialogProvider): ProviderCaps {
  return provider === "mixed" || provider === null ? PROVIDER_CAPS.github : PROVIDER_CAPS[provider];
}

/**
 * Gate for *issuing a request* to a provider-specific backend endpoint. Unlike
 * {@link displayCaps} this never assumes GitHub: it is true only once the
 * provider is confirmed and its caps carry `flag`, so a GitLab/Bitbucket repo
 * never hits a GitHub-only route (which answers 400 "project does not have a
 * GitHub remote") — not even during the unresolved window.
 */
export function providerSupports(provider: DialogProvider | undefined, flag: ProviderCapFlag): boolean {
  if (provider === undefined || provider === null || provider === "mixed") return false;
  return PROVIDER_CAPS[provider][flag];
}

/**
 * The provider owning one list item. In single-repo mode that is the dialog's
 * own provider; in aggregate mode items come from different repos, so it is
 * the per-path provider-info lookup for the item's `sourcePath` (`cached`,
 * `undefined`/`null` when not resolved).
 */
export function itemProvider(
  dialogProvider: DialogProvider,
  isAggregate: boolean,
  cached: GitProvider | null | undefined,
): DialogProvider {
  if (!isAggregate) return dialogProvider;
  return cached ?? null;
}

/** A provider-info result bound to the target it was resolved for, so it can
 *  never be read against a different one. */
export interface BoundProvider {
  /** {@link providerTargetKey} of the target this result belongs to. */
  targetKey: string;
  provider: DialogProvider;
  /** Whether the lookup landed (success OR failure) — `provider` alone can't
   *  say, since a failed lookup leaves it `null` exactly like an in-flight one. */
  settled: boolean;
}

/**
 * Identity of the dialog's provider-lookup target: the selected project path,
 * plus — in aggregate mode, where `projectPath` is the aggregate sentinel — the
 * joined candidate paths (`aggregatePathsKey`, `""` in single-repo mode), so a
 * change to the registered set also invalidates a resolved aggregate provider.
 */
export function providerTargetKey(projectPath: string, aggregatePathsKey: string): string {
  return `${projectPath}\0${aggregatePathsKey}`;
}

/**
 * The provider (and settled flag) that applies to `targetKey`. A result bound
 * to a different target — the dialog stays mounted across target changes, and
 * the lookup effect's state update lands only on a later render — reads as
 * unresolved, so request gates never fire against the previous repo's provider.
 */
export function providerForTarget(
  bound: BoundProvider | null,
  targetKey: string,
): { provider: DialogProvider; settled: boolean } {
  if (bound === null || bound.targetKey !== targetKey) return { provider: null, settled: false };
  return { provider: bound.provider, settled: bound.settled };
}
