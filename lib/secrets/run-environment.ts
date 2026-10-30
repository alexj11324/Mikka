// 4e3: which environment's secrets a run receives. Pure: no DB, shared by the claim route and tests.

/** 4e3: the environment a run's secrets come from. 'development' is for local runs only. */
export type RunSecretsEnvironment = 'production' | 'preview' | 'development'
export type RunSecretsOverride = 'production' | 'preview'

/**
 * 4e3 environment rule (approved design):
 * - local device -> development (local runs never receive injected values);
 * - run on the repo's default branch -> production: a null run baseBranch means "the remote default",
 *   otherwise it must equal the repository's recorded default branch;
 * - any other branch -> preview; an unknown/unreadable default branch -> preview.
 * Override: only a run started by a workspace admin may raise the environment to production.
 * A member asking for production is rejected (`rejected: true`, caller audits and refuses the claim).
 * Lowering to preview is allowed for anyone.
 */
export function resolveRunSecretsEnvironment(input: {
  deviceKind: 'cloud' | 'local'
  runBaseBranch: string | null | undefined
  repoDefaultBranch: string | null | undefined
  override?: RunSecretsOverride | null
  starterRole?: 'admin' | 'member' | null
}): { environment: RunSecretsEnvironment; rejected: boolean } {
  if (input.deviceKind === 'local') return { environment: 'development', rejected: false }
  const run = input.runBaseBranch?.trim() || null
  const repoDefault = input.repoDefaultBranch?.trim() || null
  const base: RunSecretsEnvironment = run === null || (repoDefault !== null && run === repoDefault) ? 'production' : 'preview'
  if (input.override === 'preview') return { environment: 'preview', rejected: false }
  if (input.override === 'production') {
    if (input.starterRole !== 'admin') return { environment: base, rejected: true }
    return { environment: 'production', rejected: false }
  }
  return { environment: base, rejected: false }
}
