import 'server-only'
// 4e2: per-workspace E2B access for lib/computer/e2b-provider.ts and lib/cloud-computer/thread-machines.ts.
// Flag off (default): platform E2B_API_KEY and E2B_COMPUTER_TEMPLATE exactly as before.
// Flag on: the workspace's own key (getWorkspaceE2BApiKey, e2b_key_missing when absent, no fallback)
// and only the public template named by E2B_BYO_COMPUTER_TEMPLATE. We never modify or publish templates.
import { AuthenticationError, NotFoundError, RateLimitError, SandboxNotFoundError } from 'e2b'
import { byoE2BKeyEnabled, E2BKeyError, getWorkspaceE2BApiKey, recordE2BKeyError, type E2BKeyErrorCode } from './e2b'

type Env = Record<string, string | undefined>

/** Resolves the API key for a workspace. `platformMissing` keeps each caller's existing flag-off error message. */
export async function e2bApiKey(workspaceId: string, platformMissing: string, env: Env = process.env): Promise<string> {
  if (!byoE2BKeyEnabled(env)) {
    if (!env.E2B_API_KEY) throw new Error(platformMissing)
    return env.E2B_API_KEY
  }
  return getWorkspaceE2BApiKey(workspaceId, env)
}

/** Base desktop template. Flag on: E2B_BYO_COMPUTER_TEMPLATE (must be a public template); unset → e2b_template_unavailable. */
export function computerTemplate(env: Env = process.env): string {
  if (!byoE2BKeyEnabled(env)) {
    if (!env.E2B_COMPUTER_TEMPLATE) throw new Error('Cloud desktop template is not configured')
    return env.E2B_COMPUTER_TEMPLATE
  }
  if (!env.E2B_BYO_COMPUTER_TEMPLATE) throw new E2BKeyError('e2b_template_unavailable', 'BYO template not configured')
  return env.E2B_BYO_COMPUTER_TEMPLATE
}

const status = (error: unknown): number | undefined => {
  const value = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined
  return typeof value === 'number' ? value : undefined
}

/** Classifies an E2B SDK error. `creating` = Sandbox.create, where a 404 means the template is not usable by this key. */
export function classifyE2BError(error: unknown, creating: boolean): E2BKeyErrorCode | null {
  if (error instanceof E2BKeyError) return error.code
  const code = status(error)
  if (error instanceof AuthenticationError || code === 401 || code === 403) return 'e2b_key_invalid'
  if (error instanceof RateLimitError || code === 429) return 'e2b_limit_reached'
  if (creating && !(error instanceof SandboxNotFoundError) && (error instanceof NotFoundError || code === 404)) return 'e2b_template_unavailable'
  return null
}

const CARD_CODE = { e2b_key_invalid: 'invalid', e2b_limit_reached: 'rate_limited', e2b_template_unavailable: 'template_unavailable' } as const

/**
 * Flag on only: maps key / quota / template failures to E2BKeyError{code} and records the
 * failure on the settings card (lastErrorCode). Never logs the key or the response body.
 * Flag off: rethrows unchanged.
 */
export async function withE2BErrors<T>(workspaceId: string, creating: boolean, run: () => Promise<T>, env: Env = process.env): Promise<T> {
  try { return await run() } catch (error) {
    if (!byoE2BKeyEnabled(env) || error instanceof E2BKeyError) throw error
    const code = classifyE2BError(error, creating)
    if (!code) throw error
    if (code in CARD_CODE) await recordE2BKeyError(workspaceId, CARD_CODE[code as keyof typeof CARD_CODE]).catch(() => undefined)
    throw new E2BKeyError(code)
  }
}
