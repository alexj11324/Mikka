// 4e3: which environment's secrets a run receives. Pure: no DB, shared by the claim route and tests.

/** 4e3: the environment a run's secrets come from. 'development' is for local runs only. */
export type RunSecretsEnvironment = 'production' | 'preview' | 'development'

/** A branch name only counts when it is a non-empty string after trimming; anything else is unreadable. */
function readable(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 4e3 environment rule (approved design, QA #452 blockers 1-2):
 * - local device -> development (local runs never receive injected values);
 * - production ONLY when `trustedDefaultBranch` comes from a trusted source (GitHub's own
 *   `default_branch`) AND the run's explicit base branch equals it exactly (case-sensitive, after trim).
 *   The run's own baseBranch, device_repos.baseBranch (written from the run on the cloud path) and the
 *   schema default 'main' are NOT trusted sources and must never be passed here.
 * - everything else -> preview: another branch, a null/empty/whitespace/non-string run branch or
 *   default branch, or no trusted source at all. Unreadable never means production.
 * Override: not supported in this PR (it needs an audited admin path that lands with #432). Any override
 * request (production or preview, from anyone) is rejected; the caller fails the run with 403
 * secretEnvironmentOverrideUnsupported. The override column stays reserved with no writer.
 */
export function resolveRunSecretsEnvironment(input: {
  deviceKind: 'cloud' | 'local'
  runBaseBranch: string | null | undefined
  trustedDefaultBranch: string | null | undefined
  override?: unknown
}): { environment: RunSecretsEnvironment; rejected: boolean } {
  if (input.override !== null && input.override !== undefined) return { environment: input.deviceKind === 'local' ? 'development' : 'preview', rejected: true }
  if (input.deviceKind === 'local') return { environment: 'development', rejected: false }
  const run = readable(input.runBaseBranch)
  const trusted = readable(input.trustedDefaultBranch)
  const base: RunSecretsEnvironment = run !== null && trusted !== null && run === trusted ? 'production' : 'preview'
  return { environment: base, rejected: false }
}
