import 'server-only'
// Every sandbox runs on its owner's own E2B key (orchestration § 2): never a teammate's, never the platform's.
import { AuthenticationError, NotFoundError, RateLimitError, SandboxNotFoundError } from 'e2b'
import { E2BKeyError, type E2BKeyErrorCode } from './flag'

type Env = Record<string, string | undefined>

/** The sandbox owner's own key; the unused argument keeps the existing caller signature. */
export async function e2bApiKey(ownerId: string, _platformMissing: string, env: Env = process.env): Promise<string> {
  return (await import('./e2b')).getUserE2BApiKey(ownerId, env)
}

/**
 * Who owns a sandbox, from its own record (a bot's cloud computer or a thread machine), so a
 * person opening it never lends their key to someone else's sandbox. Null when it is not ours.
 */
export async function sandboxKeyOwner(workspaceId: string, sandboxId: string): Promise<string | null> {
  const { pool } = await import('@/lib/db')
  const { rows } = await pool.query<{ ownerId: string }>(`SELECT "ownerId" FROM cloud_machines WHERE "sandboxId"=$1 AND "workspaceId"=$2
    UNION ALL SELECT "ownerId" FROM thread_machines WHERE "sandboxId"=$1 AND "workspaceId"=$2 LIMIT 1`, [sandboxId, workspaceId])
  return rows[0]?.ownerId ?? null
}

/** The bot's computer: Mikka's template on E2B's desktop, E2B_BYO_COMPUTER_TEMPLATE (must be public); unset → e2b_template_unavailable. */
export function computerTemplate(env: Env = process.env): string {
  if (!env.E2B_BYO_COMPUTER_TEMPLATE) throw new E2BKeyError('e2b_template_unavailable', 'BYO template not configured')
  return env.E2B_BYO_COMPUTER_TEMPLATE
}

/** Which variable names a task machine's template, by the run's harness (decision 2026-11-01-2335). */
const TASK_TEMPLATE_ENV = { claude_code: 'E2B_CLAUDE_TEMPLATE', codex: 'E2B_CODEX_TEMPLATE' } as const

/** A repository task's machine: Mikka's template on E2B's `claude` or `codex`, by harness; unset or another harness → e2b_template_unavailable. */
export function taskTemplate(harness: string, env: Env = process.env): string {
  const key = Object.hasOwn(TASK_TEMPLATE_ENV, harness) ? TASK_TEMPLATE_ENV[harness as keyof typeof TASK_TEMPLATE_ENV] : undefined
  const value = key ? env[key] : undefined
  if (!value) throw new E2BKeyError('e2b_template_unavailable', 'Task template not configured')
  return value
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
 * Maps key / quota / template failures to E2BKeyError{code} and records the
 * failure on the settings card (lastErrorCode). Never logs the key or the response body.
 * Unclassified failures are rethrown.
 */
export async function withE2BErrors<T>(ownerId: string, creating: boolean, run: () => Promise<T>, _env: Env = process.env): Promise<T> {
  try { return await run() } catch (error) {
    if (error instanceof E2BKeyError) throw error
    const code = classifyE2BError(error, creating)
    if (!code) throw error
    if (code in CARD_CODE) await (await import('./e2b')).recordE2BKeyError(ownerId, CARD_CODE[code as keyof typeof CARD_CODE]).catch(() => undefined)
    throw new E2BKeyError(code)
  }
}
