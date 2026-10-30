// #438: the BYO flag and E2BKeyError, with no store/workspace-access imports, so runtime.ts and
// e2b-runtime.ts can be imported on the hot paths (routes, workers) without loading the settings store.
export type E2BKeyErrorCode = 'e2b_key_missing' | 'e2b_key_invalid' | 'e2b_limit_reached' | 'e2b_template_unavailable' | 'e2b_unavailable'
/** Thrown at dispatch / sandbox creation; the client shows a prompt per code. */
export class E2BKeyError extends Error {
  constructor(readonly code: E2BKeyErrorCode, readonly detail?: string) { super(code); this.name = 'E2BKeyError' }
}

/** Compatibility seam for existing settings callers. BYO is mandatory (#523); the old flag cannot enable platform spend. */
export const byoE2BKeyEnabled = (_env: Record<string, string | undefined> = process.env) => true

/** Storage cannot create secrets without this deployment encryption key. */
export const workspaceSecretsConfigured = (env: Record<string, string | undefined> = process.env) => Boolean(env.WORKSPACE_SECRETS_KEY?.trim())
