// A synthetic Mikka GitHub App for tests: answers exactly the api.github.com
// calls the push check makes (lib/github/run-pull-request.ts repositoryAccess)
// and passes every other request through. No real GitHub is reached.
import { generateKeyPairSync } from 'node:crypto'

type Installation = { contents?: string; pull_requests?: string; suspended?: boolean } | 'missing'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

export function githubAppStub() {
  const installations = new Map<string, Installation>()
  const writers = new Map<string, Set<string>>()
  const calls: string[] = []
  /** Each person's own GitHub user token: their GitHub id and the repositories they authorized the App on. */
  const people = new Map<string, { id: string; repositories: string[]; failure?: number; failures?: number }>()
  const previous = { fetch: globalThis.fetch, id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY }
  process.env.GITHUB_APP_ID = '1'
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== 'https://api.github.com') return previous.fetch(input, init)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    const full = repo ? `${decodeURIComponent(repo[1])}/${decodeURIComponent(repo[2])}`.toLowerCase() : null
    if (repo && repo[3] === '/installation') {
      const found = installations.get(full!) ?? 'missing'
      if (found === 'missing') return json({ message: 'Not Found' }, 404)
      return json({ id: 77, suspended_at: found.suspended ? '2026-11-01T00:00:00Z' : null, permissions: { contents: found.contents, pull_requests: found.pull_requests } })
    }
    if (url.pathname === '/app/installations/77/access_tokens' && method === 'POST') return json({ token: 'synthetic-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    // A person's own token (lib/github/user-access.ts repositoriesForUser): who they are and what the App reaches for them.
    const person = people.get(String(new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, ''))
    // A token GitHub refuses (401: expired or revoked) or cannot answer for (502/503, or a 403 rate limit), `failures` times.
    if (person?.failure && (person.failures ?? Infinity) > 0 && url.pathname.startsWith('/user')) {
      person.failures = (person.failures ?? Infinity) - 1
      return new Response(JSON.stringify({ message: 'synthetic failure' }), { status: person.failure, headers: { 'content-type': 'application/json', ...(person.failure === 403 ? { 'x-ratelimit-remaining': '0' } : {}) } })
    }
    if (person && url.pathname === '/user') return json({ id: Number(person.id), login: `user-${person.id}` })
    if (person && url.pathname === '/user/installations') return json({ installations: [{ id: 77, app_id: Number(process.env.GITHUB_APP_ID), account: { login: 'octo' }, suspended_at: null }] })
    if (person && url.pathname === '/user/installations/77/repositories') return json({ repositories: person.repositories.map((fullName, index) => ({ id: 5000 + index, full_name: fullName, private: true, description: null, homepage: null, pushed_at: null })) })
    const user = /^\/user\/(\d+)$/.exec(url.pathname)
    if (user) return json({ id: Number(user[1]), login: `user-${user[1]}` })
    if (repo && repo[3]?.startsWith('/collaborators/')) {
      const login = decodeURIComponent(repo[3].split('/')[2])
      const id = login.slice('user-'.length)
      return json({ permission: writers.get(full!)?.has(id) ? 'write' : 'read', user: { id: Number(id), login } })
    }
    if (repo && !repo[3]) return json({ id: 4242, full_name: full, default_branch: 'main' })
    return json({ message: 'Not Found' }, 404)
  }) as typeof fetch
  return {
    calls,
    /** The App's installation on `owner/repo` and its permissions; 'missing' when it is not installed. */
    install(fullName: string, installation: Installation) { installations.set(fullName.toLowerCase(), installation) },
    /** The GitHub account (numeric id) may write to `owner/repo`. */
    allowWriter(fullName: string, githubAccountId: string) {
      const key = fullName.toLowerCase()
      writers.set(key, new Set([...(writers.get(key) ?? []), githubAccountId]))
    },
    /** The person signed in with this user token is GitHub account `githubAccountId` and authorized the App on `repositories`. */
    authorize(token: string, githubAccountId: string, repositories: string[]) { people.set(token, { id: githubAccountId, repositories }) },
    /** GitHub answers this person's token with `status`, `times` times (all of them when omitted). */
    fail(token: string, status: number, times?: number) { const person = people.get(token); if (person) Object.assign(person, { failure: status, failures: times }) },
    restore() {
      globalThis.fetch = previous.fetch
      if (previous.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = previous.id
      if (previous.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = previous.key
    },
  }
}

/** A grant as a live check would have recorded it, for fixtures that dispatch inside a host transaction (Factory). Returns the GitHub account it rests on. */
export async function recordPushGrant(pool: { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, userId: string, remoteKey: string, githubAccountId = '9100001'): Promise<string> {
  // The grant is the person's own linked GitHub account; link one if the fixture has none.
  const linked = (await pool.query(`SELECT "accountId" FROM (SELECT 0 AS rank, "githubAccountId" AS "accountId" FROM github_connections WHERE "userId"=$1
    UNION ALL (SELECT 1, "accountId" FROM account WHERE "userId"=$1 AND "providerId"='github' ORDER BY "createdAt" LIMIT 1)) l ORDER BY rank LIMIT 1`, [userId])).rows[0]?.accountId as string | undefined
  if (!linked) await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES (gen_random_uuid()::text,$2,'github',$1,now(),now())`, [userId, githubAccountId])
  const account = linked ?? githubAccountId
  await pool.query(`INSERT INTO github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId","verifiedAt","pushGrantedAt")
    VALUES ($1,$2,$3,77,4242,now(),now()) ON CONFLICT ("userId","remoteKey") DO UPDATE SET "githubAccountId"=excluded."githubAccountId","pushGrantedAt"=now(),"verifiedAt"=now()`, [userId, remoteKey, account])
  return account
}

/**
 * Connects GitHub for a fixture person the way 插件 › GitHub does (a sealed user token in github_connections) and
 * authorizes the App on `repositories`, so dispatch finds them in the person's live authorized list.
 */
export async function connectGitHub(stub: ReturnType<typeof githubAppStub>, userId: string, githubAccountId: string, repositories: string[]) {
  const { saveGitHubConnection } = await import('../../lib/github/connection')
  const token = `synthetic-user-token-${userId}`
  await saveGitHubConnection(userId, { githubAccountId, githubLogin: `user-${githubAccountId}` }, { access_token: token })
  stub.authorize(token, githubAccountId, repositories)
  return token
}
