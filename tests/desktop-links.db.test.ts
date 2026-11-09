import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('desktop links preserve real workspace membership and public share permissions', { skip: !url, timeout: 120_000 }, async t => {
  const database = new Pool({ connectionString: url, max: 2 })
  const client = await database.connect()
  const stream = (client as unknown as { connection: { stream: { bytesRead: number } } }).connection.stream
  const owner = `desktop-links-${randomUUID()}`, peer = `desktop-links-${randomUUID()}`
  const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID()
  const slug = `current-${randomUUID().slice(0, 8)}`, oldSlug = `old-${randomUUID().slice(0, 8)}`, foreignSlug = `foreign-${randomUUID().slice(0, 8)}`
  const artifactIds: string[] = [], mocks: { restore(): void }[] = []
  const queries: string[] = []
  let applicationPool: Pool | undefined
  const measuredClient = new Proxy(client, { get(target, property) {
    const value = Reflect.get(target, property, target)
    if (property === 'query') return (...args: unknown[]) => {
      const query = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text
      if (query) queries.push(query)
      return Reflect.apply(value, target, args)
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try {
    const [workspaceSchema, applicationDatabase] = await Promise.all([import('../lib/db/workspace-schema'), import('../lib/db')])
    applicationPool = applicationDatabase.pool
    const { withDatabaseClient } = applicationDatabase
    mocks.push(mock.module(new URL('../lib/workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: database, workspaceDb: drizzle(measuredClient, { schema: workspaceSchema }) } }))
    const { readWorkspaceLink, readWorkspaceSlug } = await import('../lib/workspace-admin/links')
    const { resolveSlugRedirect } = await import('../lib/workspace-admin/general')
    const { sharedArtifact } = await import('../lib/artifacts/store')
    const readShared = (token: string) => withDatabaseClient(measuredClient, () => sharedArtifact(token))
    const { GET } = await import('../app/api/artifacts/shared/[token]/route')
    for (const id of [owner, peer]) await database.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
    for (const [id, userId, name] of [[workspaceId, owner, slug], [foreignWorkspaceId, peer, foreignSlug]]) {
      await database.query('INSERT INTO mikka_workspaces(id,"userId",name,slug) VALUES($1,$2,$3,$3)', [id, userId, name])
      await database.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'admin\',\'active\')', [id, userId, `${userId}@example.invalid`])
    }
    await database.query('INSERT INTO mikka_workspace_slug_redirects(slug,"workspaceId") VALUES($1,$2)', [oldSlug, workspaceId])
    const artifact = async (kind: 'markdown' | 'html') => {
      const id = randomUUID(), token = `mks_${randomBytes(24).toString('base64url')}`
      const content = kind === 'markdown' ? '# Shared fixture\n\nThe existing document.' : '<h1>Shared fixture</h1>'
      artifactIds.push(id)
      await database.query('INSERT INTO artifacts(id,"userId","workspaceId",kind,title) VALUES($1,$2,$3,$4,\'Shared fixture\')', [id, owner, workspaceId, kind])
      await database.query('INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,1,$3,$4,$5,$6,\'Fixture author\')', [randomUUID(), id, `private/${id}`, content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)])
      await database.query('INSERT INTO artifact_shares(id,"artifactId","tokenHash","createdBy") VALUES($1,$2,$3,$4)', [randomUUID(), id, createHash('sha256').update(token).digest('hex'), owner])
      return { id, token, content }
    }
    const markdown = await artifact('markdown'), html = await artifact('html')
    const get = (token: string) => withDatabaseClient(measuredClient, () => GET(new Request(`http://127.0.0.1/mikka/api/artifacts/shared/${encodeURIComponent(token)}`), { params: Promise.resolve({ token }) }))

    await t.test('current and historical workspace links keep the original member reads and byte budget', async () => {
      const before = stream.bytesRead
      assert.equal(await readWorkspaceSlug(owner, oldSlug), null)
      assert.equal(await resolveSlugRedirect(oldSlug, owner), slug)
      assert.deepEqual(await readWorkspaceSlug(owner, slug), { id: workspaceId })
      const browserBytes = stream.bytesRead - before
      queries.length = 0
      const nativeStart = stream.bytesRead
      assert.deepEqual(await readWorkspaceLink(owner, oldSlug), { workspaceId, slug })
      const nativeBytes = stream.bytesRead - nativeStart
      assert.equal(queries.length, 3, 'the same reads as following the original browser redirect')
      assert.ok(nativeBytes <= browserBytes, 'native redirect resolution adds no database bytes')
      queries.length = 0
      assert.deepEqual(await readWorkspaceLink(owner, slug), { workspaceId, slug })
      assert.equal(queries.length, 1)
      t.diagnostic(JSON.stringify({ browserSlugBytes: browserBytes, nativeSlugBytes: nativeBytes }))
    })
    await t.test('foreign, suspended, deleted and malformed workspace links disclose no destination', async () => {
      assert.equal(await readWorkspaceLink(owner, foreignSlug), null)
      assert.equal(await readWorkspaceLink(peer, oldSlug), null)
      await database.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
      assert.equal(await readWorkspaceLink(owner, slug), null)
      assert.equal(await readWorkspaceLink(owner, oldSlug), null)
      assert.equal((await get(markdown.token)).status, 404, 'a suspended issuer cannot leave an anonymous tenant share')
      await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
      assert.equal(await readWorkspaceLink(owner, oldSlug), null)
      assert.equal((await get(html.token)).status, 404, 'a removed issuer cannot leave an anonymous tenant share')
      queries.length = 0
      for (const invalid of ['', '../private', 'UPPER', 'a'.repeat(65)]) assert.equal(await readWorkspaceLink(owner, invalid), null)
      assert.equal(queries.length, 0)
      await database.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'admin\',\'active\')', [workspaceId, owner, `${owner}@example.invalid`])
    })
    await t.test('a signed-out reader receives only the original shared props without additional database reads', async () => {
      await readShared(markdown.token)
      queries.length = 0
      const before = stream.bytesRead
      const original = (await readShared(markdown.token))!
      const browserBytes = stream.bytesRead - before, originalQueries = [...queries]
      queries.length = 0
      const nativeStart = stream.bytesRead
      const response = await get(markdown.token)
      const nativeBytes = stream.bytesRead - nativeStart
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
      assert.equal(response.headers.has('set-cookie'), false)
      const { content, ...detail } = original
      assert.deepEqual(await response.json(), { artifact: detail, markdown: content })
      assert.deepEqual(queries, originalQueries, 'the metadata route calls the existing share reader once')
      assert.ok(nativeBytes <= browserBytes, 'public metadata adds no database bytes')
      t.diagnostic(JSON.stringify({ browserShareBytes: browserBytes, nativeShareBytes: nativeBytes }))
    })
    await t.test('HTML bytes stay in the existing sandboxed frame endpoint', async () => {
      const response = await get(html.token)
      assert.equal(response.status, 200)
      const value = await response.json()
      assert.equal(value.artifact.kind, 'html')
      assert.equal(value.markdown, null)
      const serialized = JSON.stringify(value)
      for (const hidden of [owner, html.content, 'private/', 'tokenHash', 'storageKey', 'createdBy']) assert.equal(serialized.includes(hidden), false)
    })
    await t.test('revoked, unknown, deleted and malformed share tokens are indistinguishable', async () => {
      await database.query('UPDATE artifact_shares SET "revokedAt"=now() WHERE "artifactId"=$1', [markdown.id])
      await database.query('DELETE FROM artifacts WHERE id=$1', [html.id])
      for (const token of [markdown.token, html.token, `mks_${randomBytes(24).toString('base64url')}`, 'invalid', `mks_${'a'.repeat(125)}`]) {
        const response = await get(token)
        assert.equal(response.status, 404)
        assert.deepEqual(await response.json(), { error: 'not_found' })
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
      }
    })
  } finally {
    for (const handle of mocks.reverse()) handle.restore()
    await database.query('DELETE FROM artifacts WHERE id=ANY($1::uuid[])', [artifactIds])
    await database.query('DELETE FROM mikka_workspace_slug_redirects WHERE "workspaceId"=ANY($1::uuid[])', [[workspaceId, foreignWorkspaceId]])
    await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[workspaceId, foreignWorkspaceId]])
    await database.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspaceId, foreignWorkspaceId]])
    await database.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, peer]])
    client.release()
    await Promise.all([database.end(), applicationPool?.end()])
  }
})
