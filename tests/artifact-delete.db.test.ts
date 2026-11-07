// DELETE /api/mobile/artifacts/<id> (资料库, R-51) against a real PostgreSQL:
// the owner deletes their own artifact with its versions, share links and stored
// files; someone else's, one outside a workspace token's workspace, and one
// already deleted are all 404 and nothing changes.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { dbUrl, seedAgent, seedBot, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { enterprisePrincipal } from '../lib/enterprise/principal'

type Caller = { id: string; [key: symbol]: string }
let caller: Caller | null = null
let selectedWorkspace: string | undefined
mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: (key: string) => key === 'mikka-workspace' && selectedWorkspace ? { value: selectedWorkspace } : undefined }) } })
const removed: string[] = []
let failRemoval = false
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
  mobileUser: async () => caller ? { ...caller, name: 'Artifact fixture', email: `${caller.id}@example.invalid`, image: null, [enterprisePrincipal]: { kind: 'session', sessionId: 'artifact-delete-fixture' } } : null,
  writeAllowed: () => true,
  unauthorized: () => Response.json({ error: 'authRequired' }, { status: 401 }),
  forbiddenOrigin: () => Response.json({ error: 'originNotAllowed' }, { status: 403 }),
} })
mock.module(new URL('../lib/artifacts/storage.ts', import.meta.url).href, { namedExports: {
  deleteArtifactObject: async (key: string) => { if (failRemoval) throw new Error('storage down'); removed.push(key) },
} })

mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })

test('only the owner deletes an artifact; anything else is 404', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { DELETE } = await import('../app/api/mobile/artifacts/[id]/route')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const users: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM artifacts WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM account_storage_retirements WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const person = async () => {
    const id = await seedUser(pool, 'artifact-delete')
    users.push(id)
    return id
  }
  /** An artifact a Bot's thread in this workspace handed over: one inline version, one in storage, one share link. */
  const artifact = async (userId: string, workspaceId: string) => {
    const run = await seedRun(pool, { userId, agentId: await seedAgent(pool, userId), botId: await seedBot(pool, workspaceId, userId) })
    const id = randomUUID()
    await pool.query('INSERT INTO artifacts (id,"userId",kind,title,"runId","latestVersion") VALUES ($1,$2,$3,$4,$5,2)', [id, userId, 'markdown', 'Notes', run])
    await pool.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES
      ($1,$3,1,$4,'# v1','a',4,'Bot'), ($2,$3,2,$5,NULL,'b',4,'Bot')`, [randomUUID(), randomUUID(), id, `${userId}/${id}/v1.md`, `${userId}/${id}/v2.md`])
    await pool.query('INSERT INTO artifact_shares (id,"artifactId","createdBy","tokenHash") VALUES ($1,$2,$3,$4)', [randomUUID(), id, userId, randomUUID()])
    return id
  }
  const send = (id: string) => DELETE(new Request(`http://localhost/api/mobile/artifacts/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })
  const rows = async (id: string) => (await pool.query(`SELECT (SELECT count(*)::int FROM artifacts WHERE id=$1) AS artifacts,
    (SELECT count(*)::int FROM artifact_versions WHERE "artifactId"=$1) AS versions, (SELECT count(*)::int FROM artifact_shares WHERE "artifactId"=$1) AS shares`, [id])).rows[0]

  const owner = await person()
  const home = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  selectedWorkspace = home.id

  await t.test('the owner deletes it with its versions, share links and stored file; again is 404', async () => {
    const id = await artifact(owner, home.id)
    caller = { id: owner }
    const response = await send(id)
    assert.equal(response.status, 204)
    assert.deepEqual(await rows(id), { artifacts: 0, versions: 0, shares: 0 })
    assert.deepEqual(removed, [`${owner}/${id}/v2.md`], 'only the version kept in storage has a file to remove')
    const { rows: left } = await pool.query('SELECT 1 FROM account_storage_retirements WHERE "userId"=$1', [owner])
    assert.equal(left.length, 0, 'a removed file is no longer recorded')
    assert.equal((await send(id)).status, 404, 'deleting it again is 404')
  })

  await t.test('a file storage could not remove stays recorded for account deletion', async () => {
    const id = await artifact(owner, home.id)
    caller = { id: owner }
    failRemoval = true
    try { assert.equal((await send(id)).status, 204) } finally { failRemoval = false }
    assert.equal((await rows(id)).artifacts, 0)
    const { rows: left } = await pool.query('SELECT "storageKey" FROM account_storage_retirements WHERE "userId"=$1', [owner])
    assert.deepEqual(left.map(row => row.storageKey), [`${owner}/${id}/v2.md`])
  })

  await t.test("someone else's artifact is 404 and stays", async () => {
    const id = await artifact(owner, home.id)
    caller = { id: await person() }
    assert.equal((await send(id)).status, 404)
    assert.deepEqual(await rows(id), { artifacts: 1, versions: 2, shares: 1 })
  })

  await t.test("a token for another workspace is 404, even for the owner's own artifact", async () => {
    const id = await artifact(owner, home.id)
    caller = { id: owner, [tokenWorkspace]: other.id }
    assert.equal((await send(id)).status, 404)
    assert.deepEqual(await rows(id), { artifacts: 1, versions: 2, shares: 1 })
    caller = { id: owner, [tokenWorkspace]: home.id }
    assert.equal((await send(id)).status, 204, 'a token for its own workspace deletes it')
    assert.equal((await rows(id)).artifacts, 0)
  })

  await t.test('an unknown or malformed id is 404', async () => {
    caller = { id: owner }
    assert.equal((await send(randomUUID())).status, 404)
    assert.equal((await send('not-an-id')).status, 404)
  })
})
