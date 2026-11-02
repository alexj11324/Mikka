import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'

// Explicit isolated acceptance runner, not a provider/OAuth acceptance claim.
// Run with the three matching loopback _e2e database variables, REQUIRE_DB=1,
// and --import ./tests/support/server-only.mjs --import tsx.
const target = process.env.E2E_DATABASE_URL
const eligible = isE2eTarget(target) && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!eligible) throw new Error('GitHub run-token acceptance requires three matching isolated loopback _e2e targets')

test('real PostgreSQL run-token authority and exchange (#500)', async t => {
  const { db, pool, createRequestDatabaseScope } = await import('../../lib/db/index.ts')
  const schema = await import('../../lib/db/schema.ts')
  const { issueRunToken, revokeRunTokens } = await import('../../lib/mcp/worker.ts')
  const { authorizeRunGitHubToken } = await import('../../lib/github/run-token-authority.ts')
  const { createRunGitHubTokenExchange } = await import('../../lib/github/run-token-exchange.ts')
  const { eq } = await import('drizzle-orm')
  const scope = createRequestDatabaseScope(target!)
  const owner = `github-500-${randomUUID()}`, peer = `github-peer-${randomUUID()}`
  const retainedRuns: string[] = []
  t.after(async () => {
    await scope.run(async () => { for (const runId of retainedRuns) await revokeRunTokens(runId) })
    await scope.close()
    t.diagnostic(`Retained ${retainedRuns.length} isolated fixture runs; their run tokens were revoked`)
  })
  await scope.run(async () => {
    for (const id of [owner, peer]) {
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES($1,$2,\'github\',$3,now(),now())', [randomUUID(), id === owner ? '500123' : '500456', id])
    }
    let number = 0
    const fixture = async () => {
      const runId = randomUUID(), issueId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
      const remoteKey = `v2/github.com/synthetic-fixture/repo-${runId.slice(0, 8)}`
      const remoteUrl = `https://github.com/synthetic-fixture/repo-${runId.slice(0, 8)}.git`
      const branch = `mikka/mik-${++number}`
      await db.insert(schema.devices).values({ id: deviceId, ownerId: owner, name: `Fixture ${deviceId}`, enabled: true })
      await db.insert(schema.agents).values({ id: agentId, userId: owner, harness: 'codex', name: `Fixture ${agentId}`, deviceId })
      await db.insert(schema.deviceRepos).values({ id: repoId, userId: owner, deviceId, repoPath: remoteKey, remoteUrl })
      await db.insert(schema.issues).values({ id: issueId, userId: owner, title: 'Run-token acceptance fixture', content: { type: 'doc', attrs: { mikka: { number } } }, status: 'todo', priority: 'normal', scope: 'personal', scopeSetBy: 'user' })
      await db.insert(schema.agentRuns).values({ id: runId, userId: owner, issueId, agentId, deviceId, deviceRepoId: repoId, status: 'running', kind: 'implement', leaseExpiresAt: new Date(Date.now() + 600_000) })
      await db.insert(schema.runPublications).values({ runId, userId: owner, issueId, remoteKey, remoteUrl, identifier: `MIK-${number}`, branch, pushApproved: true, scopeVersion: 1, issueTitle: 'Run-token acceptance fixture' })
      const issued = await issueRunToken({ id: runId, userId: owner })
      retainedRuns.push(runId)
      const request = () => new Request('http://127.0.0.1/mikka/api/runs/github-token', { method: 'POST', headers: { authorization: `Bearer ${issued.token}` } })
      return { runId, issueId, deviceId, agentId, repoId, remoteKey, remoteUrl, branch, request }
    }

    await t.test('an actual issued run token gets only its owner\'s credential, for any run kind', async () => {
      const f = await fixture()
      assert.deepEqual(await authorizeRunGitHubToken(f.request()), { runId: f.runId, userId: owner })
      await db.update(schema.agentRuns).set({ kind: 'plan', agentDefinition: { readOnly: true } as never }).where(eq(schema.agentRuns.id, f.runId))
      assert.deepEqual(await authorizeRunGitHubToken(f.request()), { runId: f.runId, userId: owner }, 'read-only and plan runs keep the credential')
      const issued: string[] = []
      const exchange = createRunGitHubTokenExchange({ authorize: authorizeRunGitHubToken, issue: async userId => {
        issued.push(userId)
        return { token: 'synthetic-provider-token', expiresAt: null }
      } })
      const response = await exchange(new Request(f.request(), { method: 'POST', body: JSON.stringify({ repository: 'another/repository', userId: peer }) }))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal((await response.json()).token, 'synthetic-provider-token')
      assert.deepEqual(issued, [owner])
    })

    for (const state of ['succeeded', 'failed', 'cancelled', 'stopped'] as const) {
      await t.test(`terminal ${state} refuses the existing actual token`, async () => {
        const f = await fixture()
        await db.update(schema.agentRuns).set({ status: state }).where(eq(schema.agentRuns.id, f.runId))
        assert.equal(await authorizeRunGitHubToken(f.request()), null)
      })
    }
    await t.test('STOP, expired lease, token expiry and revocation reject real stored authority', async () => {
      const f = await fixture()
      await db.update(schema.agentRuns).set({ stopRequestedAt: new Date() }).where(eq(schema.agentRuns.id, f.runId))
      assert.equal(await authorizeRunGitHubToken(f.request()), null)
      await db.update(schema.agentRuns).set({ stopRequestedAt: null, leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(schema.agentRuns.id, f.runId))
      assert.equal(await authorizeRunGitHubToken(f.request()), null)
      await db.update(schema.agentRuns).set({ leaseExpiresAt: new Date(Date.now() + 600_000) }).where(eq(schema.agentRuns.id, f.runId))
      await db.update(schema.runTokens).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.runTokens.runId, f.runId))
      assert.equal(await authorizeRunGitHubToken(f.request()), null)
      const replacement = await issueRunToken({ id: f.runId, userId: owner })
      const request = new Request(f.request(), { headers: { authorization: `Bearer ${replacement.token}` } })
      assert.ok(await authorizeRunGitHubToken(request))
      await revokeRunTokens(f.runId)
      assert.equal(await authorizeRunGitHubToken(request), null)
    })
    await t.test('a cross-owner token or device never reaches another person\'s credential', async () => {
      const f = await fixture()
      const mismatched = await issueRunToken({ id: f.runId, userId: peer })
      assert.equal(await authorizeRunGitHubToken(new Request(f.request(), { headers: { authorization: `Bearer ${mismatched.token}` } })), null)
      await db.update(schema.devices).set({ ownerId: peer }).where(eq(schema.devices.id, f.deviceId))
      assert.equal(await authorizeRunGitHubToken(f.request()), null)
      await db.update(schema.devices).set({ ownerId: owner, enabled: false }).where(eq(schema.devices.id, f.deviceId))
      assert.equal(await authorizeRunGitHubToken(f.request()), null)
    })
    await t.test('STOP during the token read returns nothing', async () => {
      const f = await fixture()
      const exchange = createRunGitHubTokenExchange({ authorize: authorizeRunGitHubToken, issue: async () => {
        await db.update(schema.agentRuns).set({ stopRequestedAt: new Date() }).where(eq(schema.agentRuns.id, f.runId))
        return { token: 'synthetic-raced-provider-token', expiresAt: null }
      } })
      const result = await exchange(f.request())
      assert.equal(result.status, 403)
      assert.doesNotMatch(await result.text(), /synthetic-raced-provider-token/)
    })
  })
})
