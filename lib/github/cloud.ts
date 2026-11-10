import 'server-only'
import { pool } from '@/lib/db'
import { cloudRequest } from '@/lib/cloud-services/runtime'
import { CloudServiceError } from '@/lib/cloud-services/errors'
import { readCloudJson } from '@/lib/cloud-services/transport'
import { isCloudEdition } from '@/lib/edition'
import { readGitHubAppConfig } from './app-config'
import { githubRepository } from './run-pull-request'
import { GitHubAccessError } from './user-access-error'
import type { AuthorizedGitHubRepository } from './user-access'
import { remainingRequestBudget, type RequestBudget } from '../request-budget'

type Installation = { id: string; accountId: string; accountLogin: string; accountType: 'User' | 'Organization' }
type InstallationRow = { installation_id: string; account_id: string; account_login: string; account_type: Installation['accountType']; github_account_id: string | null }
const isId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
const protocol = () => new CloudServiceError('cloud_unavailable', 'protocol')

/** One local decision for this capability; a configured self-owned App always wins. */
export async function useCloudGitHub(userId: string): Promise<boolean> {
  if ((await readGitHubAppConfig()).source === 'database' || isCloudEdition()) return false
  const { rows: [binding] } = await pool.query<{ revoked: boolean; scopes: string[] }>(`SELECT b.revoked,b.scopes FROM cloud_service_bindings b JOIN cloud_service_registration r ON r.server_id=b.server_id
    WHERE b.owner=ANY($1::text[]) ORDER BY CASE WHEN b.owner='server' THEN 1 ELSE 0 END LIMIT 1`, [[`user:${userId}`, 'server']])
  if (!binding) return false
  if (binding.revoked) throw new CloudServiceError('cloud_server_revoked')
  if (!binding.scopes.includes('github')) throw new CloudServiceError('cloud_scope_missing')
  return true
}

async function cloudJson(userId: string, path: string, init?: RequestInit, budget?: RequestBudget): Promise<Record<string, unknown>> {
  if (budget) remainingRequestBudget(budget)
  return readCloudJson(await cloudRequest(userId, 'github', path, init, budget))
}

export async function beginCloudGitHubInstallation(userId: string): Promise<string | null> {
  if (!await useCloudGitHub(userId)) return null
  let value: Record<string, unknown>
  try { value = await cloudJson(userId, '/v1/github/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) }
  catch (error) { if (error instanceof CloudServiceError && error.code === 'cloud_not_connected') return null; throw error }
  if (typeof value.url !== 'string') throw protocol()
  const url = new URL(value.url)
  if (url.origin !== 'https://github.com' || !/^\/apps\/[a-z0-9-]{1,100}\/installations\/new$/.test(url.pathname) || url.username || url.password || url.hash || !/^mikka-gh\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') || url.searchParams.getAll('state').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'state')) throw protocol()
  return url.href
}

async function installations(userId: string, budget?: RequestBudget): Promise<{ installations: Installation[]; githubAccountId: string | null } | null> {
  let value: Record<string, unknown>
  try { value = await cloudJson(userId, '/v1/github/installations', undefined, budget) }
  catch (error) { if (error instanceof CloudServiceError && error.code === 'cloud_not_connected') return null; throw error }
  if (!Array.isArray(value.installations) || value.installations.length > 1000 || value.githubAccountId !== null && !isId(value.githubAccountId)
    || typeof value.subject !== 'string' || !/^(?:user|workspace):\S{1,256}$/.test(value.subject) || [...value.subject].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || typeof value.workspaceId !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value.workspaceId)) throw protocol()
  const list: Installation[] = value.installations.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw protocol()
    const row = item as Installation
    if (!isId(row.id) || !isId(row.accountId) || !['User', 'Organization'].includes(row.accountType) || typeof row.accountLogin !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(row.accountLogin)) throw protocol()
    return { id: row.id, accountId: row.accountId, accountLogin: row.accountLogin, accountType: row.accountType }
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (budget) {
      const timeout = String(Math.min(2000, remainingRequestBudget(budget)))
      await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [timeout])
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka_cloud_github_user:'||$1,0))", [userId])
    // Metadata is a local discovery cache, never authorization for minting a provider token.
    await client.query('DELETE FROM cloud_github_installations WHERE user_id=$1 AND NOT installation_id=ANY($2::text[])', [userId, list.map(item => item.id)])
    for (const item of list) await client.query(`INSERT INTO cloud_github_installations(user_id,installation_id,account_id,account_login,account_type,github_account_id,cloud_subject,cloud_workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(user_id,installation_id) DO UPDATE SET account_id=EXCLUDED.account_id,account_login=EXCLUDED.account_login,account_type=EXCLUDED.account_type,github_account_id=EXCLUDED.github_account_id,cloud_subject=EXCLUDED.cloud_subject,cloud_workspace_id=EXCLUDED.cloud_workspace_id,verified_at=now()`, [userId, item.id, item.accountId, item.accountLogin, item.accountType, value.githubAccountId, value.subject, value.workspaceId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
  return { installations: list, githubAccountId: value.githubAccountId as string | null }
}

async function mint(userId: string, installationId: string, repositories?: string[], budget?: RequestBudget) {
  const result = await cloudJson(userId, '/v1/github/installation-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId, ...(repositories ? { repositories } : {}) }) }, budget)
  const expires = typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN
  // Installation credentials are opaque (RFC 6750 b64token), not a fixed
  // ghs_ prefix/length. Preserve the header-safe alphabet and bounded size.
  if (typeof result.token !== 'string' || result.token.length < 20 || result.token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(result.token) || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 65 * 60_000) throw protocol()
  return { token: result.token, expiresAt: new Date(expires), installationId }
}

/** The selected native token goes straight into gh's normal credential file.
 * This is called during preparation and natural expiry renewal, never per git/gh operation. */
export async function cloudGitHubCredential(userId: string, remoteKey?: string, budget?: RequestBudget): Promise<{ token: string; expiresAt: Date; githubAccountId?: string; installationId: string } | null> {
  if (budget) remainingRequestBudget(budget)
  if (!await useCloudGitHub(userId)) return null
  if (!remoteKey) throw new GitHubAccessError('githubRepositoryForbidden', 403)
  const repo = githubRepository(remoteKey)
  let { rows } = await pool.query<InstallationRow>('SELECT * FROM cloud_github_installations WHERE user_id=$1 AND lower(account_login)=lower($2)', [userId, repo.owner])
  if (!rows.length) {
    if (!await installations(userId, budget)) return null
    rows = (await pool.query<InstallationRow>('SELECT * FROM cloud_github_installations WHERE user_id=$1 AND lower(account_login)=lower($2)', [userId, repo.owner])).rows
  }
  if (rows.length !== 1) throw new GitHubAccessError('githubRepositoryForbidden', 403)
  const row = rows[0]
  // The broker rechecks the exact server/credential/workspace binding here, even for stale local metadata.
  const credential = await mint(userId, row.installation_id, [repo.repo], budget)
  return { ...credential, ...(row.github_account_id ? { githubAccountId: row.github_account_id } : {}) }
}

/** Repository discovery uses an installation token directly against GitHub; the cloud is not a provider proxy. */
export async function cloudGitHubRepositories(userId: string): Promise<{ githubAccountId: string | null; login: string | null; installationAccounts: string[]; installations: string[]; repositories: AuthorizedGitHubRepository[]; token: null } | null> {
  if (!await useCloudGitHub(userId)) return null
  const linked = await installations(userId)
  if (!linked) return null
  const repositories: AuthorizedGitHubRepository[] = []
  for (const installation of linked.installations) {
    const credential = await mint(userId, installation.id)
    for (let page = 1; page <= 100; page++) {
      const response = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${credential.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' } })
      if (!response.ok) { await response.body?.cancel(); throw new GitHubAccessError('githubUnavailable', 502) }
      const value = await response.json() as { repositories?: unknown }
      if (!Array.isArray(value.repositories)) throw protocol()
      for (const item of value.repositories as Record<string, unknown>[]) {
        if (!isId(String(item.id)) || typeof item.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(item.full_name) || typeof item.private !== 'boolean' || item.full_name.split('/')[0].toLowerCase() !== installation.accountLogin.toLowerCase()) throw protocol()
        repositories.push({ id: String(item.id), installationId: installation.id, fullName: item.full_name, htmlUrl: `https://github.com/${item.full_name}`, private: item.private,
          description: typeof item.description === 'string' ? item.description.slice(0, 300) : null, homepage: typeof item.homepage === 'string' ? item.homepage.slice(0, 300) : null, pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null })
      }
      if (!/rel="next"/.test(response.headers.get('link') ?? '')) break
      if (page === 100) throw protocol()
    }
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka_cloud_github_user:'||$1,0))", [userId])
    await client.query('DELETE FROM cloud_github_repositories WHERE user_id=$1', [userId])
    for (const repo of repositories) await client.query('INSERT INTO cloud_github_repositories(user_id,remote_key,installation_id,repository_id) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM cloud_github_installations WHERE user_id=$1 AND installation_id=$3)', [userId, `v2/github.com/${repo.fullName.toLowerCase()}`, repo.installationId, repo.id])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
  return { githubAccountId: linked.githubAccountId, login: null, installationAccounts: linked.installations.map(i => i.accountLogin), installations: linked.installations.map(i => i.id), repositories, token: null }
}
