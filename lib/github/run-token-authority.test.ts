import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { createRunGitHubTokenExchange } from './run-token-exchange'

// These tests execute the actual authorizer and exchange. Only the run token
// check and the database read are substitutes; no live GitHub is reached.
const ids = { run: '10000000-0000-4000-8000-000000000001', device: '10000000-0000-4000-8000-000000000003' }
const owner = 'test-owner'

function fixture() {
  return {
    run: { id: ids.run, userId: owner, deviceId: ids.device, status: 'running', kind: 'implement', stopRequestedAt: null as Date | null,
      leaseExpiresAt: new Date(Date.now() + 60_000) as Date | null, agentDefinition: null as Record<string, unknown> | null },
    device: { id: ids.device, ownerId: owner, enabled: true },
  }
}

let row: ReturnType<typeof fixture> | null = fixture()
let runTokenValid = true
let personalAllowed = true
/** Whose run the run token names. */
let tokenUser = owner
const select = mock.fn(() => {
  const builder = { from: () => builder, innerJoin: () => builder, leftJoin: () => builder, where: () => builder,
    // The real query filters on the run token's user; a row of another person never matches.
    limit: async () => row && row.run.userId === tokenUser ? [row] : [] }
  return builder
})
const verify = mock.fn(async (_request: Request, token?: string) => runTokenValid && token === 'mkw_synthetic' ? { token, extra: { runId: ids.run, userId: tokenUser } } : undefined)

function stub(relative: string, namedExports: Record<string, unknown>) {
  mock.module(new URL(relative, import.meta.url).href, { namedExports })
}
stub('../db/index.ts', { db: { select }, pool: { query: async (text: string, args: unknown[]) => {
  assert.match(text, /mikka_run_personal_resources_allowed/)
  assert.deepEqual(args, [ids.run, tokenUser])
  return { rows: [{ allowed: personalAllowed }] }
} } })
stub('../mcp/worker.ts', { verifyRunToken: verify, workerRun: () => ({ id: ids.run, userId: tokenUser, botId: null, issueId: null }) })

let authorize: typeof import('./run-token-authority')['authorizeRunGitHubToken']
before(async () => { ({ authorizeRunGitHubToken: authorize } = await import('./run-token-authority')) })
beforeEach(() => { row = fixture(); runTokenValid = true; tokenUser = owner; personalAllowed = true })

const request = (authorization = 'Bearer mkw_synthetic') => new Request('https://mikka.test/api/runs/github-token', { method: 'POST', headers: { authorization } })

test('every live run of the owner is authorized, read-only and plan included, with no repository or branch scope', async () => {
  for (const patch of [{ kind: 'implement' }, { kind: 'fix' }, { kind: 'plan' }, { kind: 'implement', agentDefinition: { readOnly: true } }, { status: 'preparing' }]) {
    row = fixture(); Object.assign(row.run, patch)
    assert.deepEqual(await authorize(request()), { runId: ids.run, userId: owner }, JSON.stringify(patch))
  }
})

test('the run\'s own github.com repository rides along for bookkeeping; another person\'s repository row does not', async () => {
  Object.assign(row!, { repoPath: 'v2/github.com/owner/repo', repoUserId: owner })
  assert.deepEqual(await authorize(request()), { runId: ids.run, userId: owner, remoteKey: 'v2/github.com/owner/repo' })
  Object.assign(row!, { repoPath: 'v2/github.com/owner/repo', repoUserId: 'peer' })
  assert.deepEqual(await authorize(request()), { runId: ids.run, userId: owner })
  Object.assign(row!, { repoPath: 'v2/file/localhost/tmp/origin', repoUserId: owner })
  assert.deepEqual(await authorize(request()), { runId: ids.run, userId: owner })
})

test('an ended, stopped or lease-expired run, another person\'s device, or a bad run token is refused', async () => {
  const refusals: (() => void)[] = [
    () => { row!.run.status = 'succeeded' },
    () => { row!.run.stopRequestedAt = new Date() },
    () => { row!.run.leaseExpiresAt = null },
    () => { row!.run.leaseExpiresAt = new Date(Date.now() - 1) },
    () => { row!.device.enabled = false },
    () => { row!.device.ownerId = 'someone-else' },
    () => { runTokenValid = false },
    () => { row = null },
  ]
  for (const refuse of refusals) {
    row = fixture(); runTokenValid = true
    refuse()
    assert.equal(await authorize(request()), null)
  }
  assert.equal(await authorize(request('Bearer not-a-run-token')), null)
})

test('a run token of one person never reaches another person\'s run or credential', async () => {
  tokenUser = 'peer'
  const issued: string[] = []
  const exchange = createRunGitHubTokenExchange({ authorize, issue: async userId => { issued.push(userId); return { token: 'synthetic-peer-token', expiresAt: null } } })
  const response = await exchange(request())
  assert.equal(response.status, 403)
  assert.deepEqual(issued, [])
})

test('an Owner-executed Shared run cannot fetch the Owner private GitHub token', async () => {
  personalAllowed = false
  const issued: string[] = []
  const exchange = createRunGitHubTokenExchange({ authorize, issue: async userId => { issued.push(userId); return { token: 'synthetic-never-issued', expiresAt: null } } })
  assert.equal((await exchange(request())).status, 403)
  assert.deepEqual(issued, [])
})

test('the exchange gives the owner\'s own token to a read-only run, and only the owner\'s', async () => {
  row!.run.agentDefinition = { readOnly: true }
  const issued: string[] = []
  const exchange = createRunGitHubTokenExchange({ authorize, issue: async userId => { issued.push(userId); return { token: `synthetic-token-of-${userId}`, expiresAt: null } }, now: () => Date.parse('2026-11-02T00:00:00Z') })
  const response = await exchange(request())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { token: `synthetic-token-of-${owner}`, expiresAt: '2026-11-02T01:00:00.000Z' })
  assert.deepEqual(issued, [owner])
})
