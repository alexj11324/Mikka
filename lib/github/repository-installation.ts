import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { githubRepositoryInstallations } from '@/lib/db/schema'
import { githubRepository } from './run-pull-request'
import { readGitHubAppConfig } from './app-config'
import { githubAppEnvironmentConfig } from './app-env'

/** The Plugins → GitHub connection, else the GitHub sign-in account (Better Auth owns account). Durable provider subject only, never OAuth tokens. */
export async function linkedGitHubAccountId(userId: string): Promise<string | null> {
  const result = await db.execute<{ accountId: string }>(sql`select "accountId" from (
    select 0 as rank, "githubAccountId" as "accountId" from github_connections where "userId" = ${userId}
    union all (select 1, "accountId" from account where "userId" = ${userId} and "providerId" = 'github' order by "createdAt" limit 1)
  ) linked order by rank limit 1`)
  return result.rows[0]?.accountId ?? null
}

type Options = { fetcher?: typeof fetch; env?: Record<string, string | undefined> }
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

async function githubJson(fetcher: typeof fetch, token: string, path: string) {
  const response = await fetcher(`https://api.github.com${path}`, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' },
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`github_${response.status}`) }
  return { data: await response.json() as Record<string, unknown>, next: /rel="next"/.test(response.headers.get('link') ?? '') }
}

/**
 * Records which Mikka App installation and repository id this person's own
 * token reaches for `remoteKey` (github_repository_installations): the
 * repositories a workspace's Bots may use (lib/workspace-admin/bots.ts) and the
 * lock order of question continuations read it. Non-secret ids only; never a
 * token. Bookkeeping: a failure logs a code and is never thrown.
 */
export async function recordRepositoryInstallation(userId: string, remoteKey: string, credential: { token: string; githubAccountId: string; repositoryId?: number }, options: Options = {}): Promise<void> {
  try {
    const repo = githubRepository(remoteKey)
    const config = options.env ? githubAppEnvironmentConfig(options.env) : await readGitHubAppConfig()
    const appId = Number(config.id)
    if (!isId(appId)) throw new Error('app_not_configured')
    const fetcher = options.fetcher ?? fetch
    const repositoryId = credential.repositoryId ?? (await githubJson(fetcher, credential.token, repo.path)).data.id
    if (!isId(repositoryId)) throw new Error('repository_unreadable')
    let installationId: number | undefined
    for (let page = 1; page <= 10 && installationId === undefined; page++) {
      const { data, next } = await githubJson(fetcher, credential.token, `/user/installations?per_page=100&page=${page}`)
      const installations = Array.isArray(data.installations) ? data.installations as Record<string, unknown>[] : []
      installationId = installations.find(item => item.app_id === appId && item.suspended_at == null &&
        typeof (item.account as Record<string, unknown> | null)?.login === 'string' &&
        ((item.account as Record<string, unknown>).login as string).toLowerCase() === repo.owner.toLowerCase())?.id as number | undefined
      if (!next) break
    }
    if (!isId(installationId)) throw new Error('installation_not_found')
    const values = { userId, remoteKey, githubAccountId: credential.githubAccountId, installationId, repositoryId, verifiedAt: new Date() }
    // pushGrantedAt is left as it is: nothing reads it any more.
    await db.insert(githubRepositoryInstallations).values(values).onConflictDoUpdate({
      target: [githubRepositoryInstallations.userId, githubRepositoryInstallations.remoteKey],
      set: { githubAccountId: values.githubAccountId, installationId, repositoryId, verifiedAt: values.verifiedAt },
    })
  } catch (error) {
    const code = error instanceof Error && /^[a-z_0-9]+$/.test(error.message) ? error.message : 'unexpected'
    console.error(JSON.stringify({ event: 'github_installation_record_failed', code }))
  }
}

/** Whether this person's row was verified recently enough that a run's token fetch need not check again. */
export async function repositoryInstallationFresh(userId: string, remoteKey: string, maxAgeMs = 24 * 60 * 60_000): Promise<boolean> {
  const result = await db.execute<{ fresh: boolean }>(sql`select exists(select 1 from github_repository_installations
    where "userId" = ${userId} and "remoteKey" = ${remoteKey} and "verifiedAt" > now() - make_interval(secs => ${maxAgeMs / 1000})) as fresh`)
  return Boolean(result.rows[0]?.fresh)
}
