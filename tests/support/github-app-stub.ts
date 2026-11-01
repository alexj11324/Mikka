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
