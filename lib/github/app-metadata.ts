import 'server-only'
import { githubAppJwt } from '@/lib/suggestions/github-redelivery'
import { GitHubAppSetupError, type GitHubAppConfig } from './app-config'
import type { GitHubAppTemplate } from './manifest'

const IDENT = /^[a-z][a-z0-9_]{0,80}$/
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

/** Public metadata only; the provider response also contains credential-adjacent fields and is never returned wholesale. */
export function publicGitHubAppMetadata(value: unknown): GitHubAppTemplate & { slug: string } {
  const app = value as { slug?: unknown; permissions?: unknown; events?: unknown } | null
  if (!app || typeof app !== 'object' || typeof app.slug !== 'string' || !SLUG.test(app.slug)
    || !app.permissions || typeof app.permissions !== 'object' || Array.isArray(app.permissions)
    || !Array.isArray(app.events) || app.events.length > 128) throw new GitHubAppSetupError('response', 502)
  const entries = Object.entries(app.permissions)
  if (!entries.length || entries.length > 200 || entries.some(([name, access]) => !IDENT.test(name) || !['read', 'write', 'admin'].includes(access))
    || app.events.some(value => typeof value !== 'string' || !IDENT.test(value))) throw new GitHubAppSetupError('response', 502)
  return { slug: app.slug, permissions: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as GitHubAppTemplate['permissions'], events: [...new Set(app.events as string[])].sort() }
}

/** Explicit administrator readback of this server's configured App, never a runtime dependency for creating a self-hosted App. */
export async function readGitHubAppMetadata(config: GitHubAppConfig, fetcher: typeof fetch = fetch) {
  if (!config.id || !config.pem) throw new GitHubAppSetupError('configured', 503)
  let token: string
  try { token = githubAppJwt(config.id, config.pem) }
  catch (error) { throw new GitHubAppSetupError('encryption', 503, error) }
  let response: Response
  try {
    response = await fetcher('https://api.github.com/app', {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' },
    })
  } catch (error) { throw new GitHubAppSetupError('request', 502, error) }
  if (!response.ok) { await response.body?.cancel(); throw new GitHubAppSetupError('request', 502) }
  let body: unknown
  try { body = await response.json() } catch (error) { throw new GitHubAppSetupError('response', 502, error) }
  const metadata = publicGitHubAppMetadata(body)
  if (config.slug && metadata.slug !== config.slug) throw new GitHubAppSetupError('response', 502)
  return metadata
}
