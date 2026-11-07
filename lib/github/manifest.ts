import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { secretsKey } from '@/lib/secrets/crypto'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { GitHubAppSetupError, validateGitHubAppCredentials, type GitHubAppCredentials, type GitHubAppQuery } from './app-config'

export const GITHUB_MANIFEST_COOKIE = 'mikka-github-app-manifest'
export const GITHUB_MANIFEST_TTL_MS = 60 * 60_000
export const GITHUB_MANIFEST_CALLBACK = withBasePath('/api/github/manifest/callback')
const githubSettings = `${workspaceLink({ section: 'plugins' })}&app=github`
export const GITHUB_MANIFEST_SETTINGS = withBasePath(githubSettings)
const STATE = /^ghm_[A-Za-z0-9_-]{43}$/
const ORG = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export type GitHubAppTemplate = { permissions: Readonly<Record<string, 'read' | 'write' | 'admin'>>; events: readonly string[] }
export function githubAppManifest({ origin, serverName, template, basePath = BASE_PATH }: { origin: string; serverName?: string; template: GitHubAppTemplate; basePath?: string }) {
  let site: URL
  try { site = new URL(origin) } catch (error) { throw new GitHubAppSetupError('origin', 400, error) }
  if (site.origin !== origin || !['http:', 'https:'].includes(site.protocol) || site.username || site.password) throw new GitHubAppSetupError('origin', 400)
  const name = (serverName?.trim() || site.hostname).slice(0, 26)
  const url = (path: string) => new URL(withBasePath(path, basePath), site.origin).toString()
  return {
    name: `Mikka (${name})`, url: url('/'),
    redirect_url: url('/api/github/manifest/callback'),
    hook_attributes: { url: url('/api/webhooks/github'), active: true },
    setup_url: url(githubSettings),
    callback_urls: [url('/api/auth/callback/github')],
    public: false, default_permissions: { ...template.permissions }, default_events: [...template.events],
    request_oauth_on_install: false, setup_on_update: true,
  }
}

export function githubManifestAction(state: string, organization?: string): string {
  if (!STATE.test(state)) throw new GitHubAppSetupError('request', 400)
  githubManifestOrganization(organization)
  const action = new URL(organization ? `https://github.com/organizations/${organization}/settings/apps/new` : 'https://github.com/settings/apps/new')
  action.searchParams.set('state', state)
  return action.toString()
}

export function githubManifestOrganization(organization: unknown): string | undefined {
  if (organization === undefined) return undefined
  if (typeof organization !== 'string' || !ORG.test(organization)) throw new GitHubAppSetupError('request', 400)
  return organization
}

export function githubManifestStateMatches(state: string | null, cookie: string | undefined): state is string {
  if (!state || !cookie || !STATE.test(state) || !STATE.test(cookie)) return false
  return timingSafeEqual(Buffer.from(state), Buffer.from(cookie))
}

export async function startGitHubAppManifest(query: GitHubAppQuery, { userId, sessionId, origin }: { userId: string; sessionId: string; origin: string },
  { now = Date.now(), env = process.env }: { now?: number; env?: Readonly<Record<string, string | undefined>> } = {}) {
  // Stop before taking the person to GitHub if this server cannot retain the returned credentials.
  try { secretsKey(env) } catch (error) { throw new GitHubAppSetupError('encryption', 503, error) }
  const state = `ghm_${randomBytes(32).toString('base64url')}`
  try {
    await query.query(`INSERT INTO github_app_manifest_intents ("stateHash","userId","sessionId",origin,"expiresAt") VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT ("userId") DO UPDATE SET "stateHash"=excluded."stateHash","sessionId"=excluded."sessionId",origin=excluded.origin,"expiresAt"=excluded."expiresAt","createdAt"=now()`,
      [hash(state), userId, sessionId, origin, new Date(now + GITHUB_MANIFEST_TTL_MS)])
  } catch (error) { throw new GitHubAppSetupError('storage', 503, error) }
  return state
}

/** Atomic consumption prevents concurrent callbacks and replays from exchanging another code. */
export async function consumeGitHubAppManifest(query: GitHubAppQuery, { state, userId, sessionId, origin }: { state: string; userId: string; sessionId: string; origin: string }, now = Date.now()): Promise<boolean> {
  if (!STATE.test(state)) return false
  try {
    const taken = await query.query(`DELETE FROM github_app_manifest_intents WHERE "stateHash"=$1 AND "userId"=$2 AND "sessionId"=$3 AND origin=$4 AND "expiresAt">$5 RETURNING "stateHash"`,
      [hash(state), userId, sessionId, origin, new Date(now)])
    return taken.rowCount === 1
  } catch (error) { throw new GitHubAppSetupError('storage', 503, error) }
}

export async function exchangeGitHubAppManifest(code: string, fetcher: typeof fetch = fetch): Promise<GitHubAppCredentials> {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(code)) throw new GitHubAppSetupError('request', 400)
  let response: Response
  try {
    response = await fetcher(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' },
    })
  } catch (error) { throw new GitHubAppSetupError('request', 502, error) }
  if (!response.ok) { await response.body?.cancel(); throw new GitHubAppSetupError('request', 502) }
  let raw: Record<string, unknown>
  try { raw = await response.json() }
  catch (error) { throw new GitHubAppSetupError('response', 502, error) }
  return validateGitHubAppCredentials({ id: Number.isSafeInteger(raw?.id) && Number(raw.id) > 0 ? String(raw.id) : null,
    slug: raw?.slug, pem: raw?.pem, webhookSecret: raw?.webhook_secret, clientId: raw?.client_id, clientSecret: raw?.client_secret })
}
