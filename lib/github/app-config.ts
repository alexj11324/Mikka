import 'server-only'
import { createPrivateKey } from 'node:crypto'
import type { Pool } from 'pg'
import { CodedError } from '@mikka/protocol/coded-error'
import { isCloudEdition } from '@/lib/edition'
import { openSecret, sealSecret, type Sealed } from '@/lib/secrets/crypto'
import { githubAppEnvironmentConfig, type GitHubAppConfig, type GitHubAppCredentials } from './app-env'
export type { GitHubAppConfig, GitHubAppCredentials } from './app-env'

export type GitHubAppSetupDetail = 'admin' | 'origin' | 'state' | 'encryption' | 'storage' | 'configured' | 'request' | 'response' | 'template'
export class GitHubAppSetupError extends CodedError<'github_app_setup_failed', GitHubAppSetupDetail> {
  constructor(detail: GitHubAppSetupDetail, readonly status: number, cause?: unknown) {
    super('github_app_setup_failed', { detail, cause })
  }
}

export type GitHubAppQuery = Pick<Pool, 'query'>
type Options = { query?: GitHubAppQuery; env?: Readonly<Record<string, string | undefined>> }
const AAD = 'mikka_server_github_app\u00001\u0000credentials_v1'
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max

/** The six fields are validated before any credential is stored or used. */
export function validateGitHubAppCredentials(value: unknown): GitHubAppCredentials {
  const row = value as Partial<GitHubAppCredentials> | null
  if (!row || typeof row !== 'object' || !/^[1-9]\d*$/.test(row.id ?? '') || !SLUG.test(row.slug ?? '')
    || !text(row.pem, 32_768) || !text(row.webhookSecret, 4_096) || !text(row.clientId, 256) || !text(row.clientSecret, 4_096)) throw new GitHubAppSetupError('response', 502)
  try {
    if (createPrivateKey(row.pem!).asymmetricKeyType !== 'rsa') throw new GitHubAppSetupError('response', 502)
  } catch (error) { throw new GitHubAppSetupError('response', 502, error) }
  return { id: row.id!, slug: row.slug!, pem: row.pem!, webhookSecret: row.webhookSecret!, clientId: row.clientId!, clientSecret: row.clientSecret! }
}

export function resolveGitHubAppConfig(stored: Sealed | null, env: Readonly<Record<string, string | undefined>> = process.env): GitHubAppConfig {
  if (!stored) return githubAppEnvironmentConfig(env)
  let credentials: unknown
  try { credentials = JSON.parse(openSecret(stored, AAD, env)) }
  catch (error) { throw new GitHubAppSetupError('encryption', 503, error) }
  return { source: 'database', ...validateGitHubAppCredentials(credentials) }
}

export function sealGitHubAppConfig(credentials: GitHubAppCredentials, env: Readonly<Record<string, string | undefined>> = process.env): Sealed {
  const validated = validateGitHubAppCredentials(credentials)
  try { return sealSecret(JSON.stringify(validated), AAD, env) }
  catch (error) { throw new GitHubAppSetupError('encryption', 503, error) }
}

export async function readGitHubAppConfig({ query, env = process.env }: Options = {}): Promise<GitHubAppConfig> {
  // The official App keeps its deployment-owned credentials and zero-read
  // webhook path. Community installations resolve their own stored App below.
  if (isCloudEdition(env)) return githubAppEnvironmentConfig(env)
  const connection = query ?? (await import('@/lib/db')).pool
  let stored: Sealed | null
  try {
    const result = await connection.query<Sealed>('SELECT ciphertext,iv,"keyVersion" FROM server_github_app WHERE id=1')
    stored = result.rows[0] ?? null
  } catch (error) { throw new GitHubAppSetupError('storage', 503, error) }
  // A bad stored key or an unavailable database never silently selects a different App.
  return resolveGitHubAppConfig(stored, env)
}

/** Only the first successful registration wins. A second callback cannot replace server-wide authority. */
export async function saveGitHubAppConfig(credentials: GitHubAppCredentials, userId: string, { query, env = process.env }: Options = {}): Promise<void> {
  const sealed = sealGitHubAppConfig(credentials, env)
  const connection = query ?? (await import('@/lib/db')).pool
  let inserted: number | null
  try {
    const result = await connection.query('INSERT INTO server_github_app (id,ciphertext,iv,"keyVersion","createdBy") VALUES (1,$1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      [sealed.ciphertext, sealed.iv, sealed.keyVersion, userId])
    inserted = result.rowCount
  } catch (error) { throw new GitHubAppSetupError('storage', 503, error) }
  if (!inserted) throw new GitHubAppSetupError('configured', 409)
}

/** Explicit opt-in: Better Auth resolves provider options at startup; changing this choice requires a restart. */
export async function githubSignInClient(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ clientId: string; clientSecret: string; enabled: boolean }> {
  const config = env.GITHUB_SIGN_IN_USE_APP === 'true' ? await readGitHubAppConfig({ env }) : githubAppEnvironmentConfig(env)
  return { clientId: config.clientId ?? '', clientSecret: config.clientSecret ?? '', enabled: Boolean(config.clientId && config.clientSecret) }
}
