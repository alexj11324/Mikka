import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser } from './support/workspace-admin-db'

test('repository discovery replaces the owned cache with one insert and preserves the previous cache on failure', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl })
  const owner = await seedUser(database, 'cloud-catalog')
  const workspace = randomUUID(), installationId = '91'
  let inserts = 0, duplicate = false, removed = false
  const pool = {
    query: async () => ({ rows: [{ revoked: false, scopes: ['github'] }] }),
    connect: async () => {
      const client = await database.connect()
      return {
        query: (text: string, values?: unknown[]) => {
          if (text.includes('INSERT INTO cloud_github_repositories')) inserts++
          return client.query(text, values)
        },
        release: () => client.release(),
      }
    },
  }
  t.after(async () => {
    await database.query('DELETE FROM "user" WHERE id=$1', [owner])
    await database.end()
  })
  mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { pool } })
  mock.module(new URL('../lib/edition.ts', import.meta.url).href, { namedExports: { isCloudEdition: () => false } })
  mock.module(new URL('../lib/github/app-config.ts', import.meta.url).href, { namedExports: { readGitHubAppConfig: async () => ({ source: 'environment' }) } })
  mock.module(new URL('../lib/cloud-services/runtime.ts', import.meta.url).href, { namedExports: {
    cloudRequest: async (user: string, scope: string, path: string) => {
      assert.equal(user, owner)
      assert.equal(scope, 'github')
      if (path === '/v1/github/installations') return Response.json({ subject: 'user:fixture', workspaceId: workspace, githubAccountId: '42',
        installations: [{ id: installationId, accountId: '42', accountLogin: 'Example', accountType: 'Organization' }] })
      assert.equal(path, '/v1/github/installation-token')
      return Response.json({ token: 'synthetic-catalog-credential', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    },
  } })
  const repositories = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, full_name: 'Example/R' + index, private: true }))
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(String(url), 'https://api.github.com/installation/repositories?per_page=100&page=1')
    if (removed) await database.query('DELETE FROM cloud_github_installations WHERE user_id=$1 AND installation_id=$2', [owner, installationId])
    return Response.json({ repositories: duplicate ? [repositories[0], repositories[0]] : repositories })
  })
  const { cloudGitHubRepositories } = await import('../lib/github/cloud')
  const readCache = () => database.query('SELECT remote_key, repository_id FROM cloud_github_repositories WHERE user_id=$1 ORDER BY repository_id::int', [owner])
  assert.equal((await cloudGitHubRepositories(owner))?.repositories.length, 50)
  const expected = repositories.map(row => ({ remote_key: 'v2/github.com/' + row.full_name.toLowerCase(), repository_id: String(row.id) }))
  assert.deepEqual((await readCache()).rows, expected)
  assert.equal(inserts, 1)
  duplicate = true
  await assert.rejects(cloudGitHubRepositories(owner), { code: '23505' })
  assert.deepEqual((await readCache()).rows, expected)
  duplicate = false; removed = true
  await cloudGitHubRepositories(owner)
  assert.equal((await readCache()).rowCount, 0)
})
