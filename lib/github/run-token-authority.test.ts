import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { RepositoryAdmission } from '@/lib/repository-admission'
import { createRunGitHubTokenExchange } from './run-token-exchange'

// These tests execute the actual authorizer. Only identity/database/policy IO
// are substitutes; they are not real PostgreSQL or live GitHub acceptance.
const ids = {
  run: '10000000-0000-4000-8000-000000000001',
  task: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  agent: '10000000-0000-4000-8000-000000000004',
}
const owner = 'test-owner'
const key = 'v2/github.com/owner/repo'
const remote = 'https://github.com/owner/repo.git'
const branch = 'mikka/mik-1'
/** The receipt admission wrote from the GitHub App grant (lib/github/push-grant.ts). */
const granted = (): RepositoryAdmission => ({
  userId: owner, issueId: ids.task, deviceId: ids.device, agentId: ids.agent, remoteKey: key, remoteUrl: remote,
  targetBranch: branch, permission: 'push_to_origin', authority: 'github_app', approvedAt: '2026-10-30T00:00:00Z', acceptedAt: '2026-10-30T00:00:00Z',
})

function fixture() {
  return {
    run: { id: ids.run, userId: owner, issueId: ids.task, deviceId: ids.device, agentId: ids.agent, botId: null,
      status: 'running', kind: 'implement', stopRequestedAt: null as Date | null,
      leaseExpiresAt: new Date(Date.now() + 60_000) as Date | null,
      agentDefinition: { repositoryAdmission: granted() } as { repositoryAdmission: RepositoryAdmission } | null },
    repo: { userId: owner, deviceId: ids.device, repoPath: key, remoteUrl: remote },
    device: { id: ids.device, ownerId: owner, enabled: true },
    task: { id: ids.task, userId: owner, scope: 'personal', scopeVersion: 1,
      content: { type: 'doc', attrs: { mikka: {} as Record<string, unknown> } } },
    publication: { userId: owner, issueId: ids.task, pushApproved: true, branch, remoteUrl: remote, remoteKey: key, scopeVersion: 1 },
  }
}

let row: ReturnType<typeof fixture> | null = fixture()
let policy = { readOnly: false, permissions: { git_push: 'allow' } }
let push: { approved: boolean; approvedByUserId?: string; approvedAt?: string } | null
let teamAllowed = false
let eventMatches = true
let frozenReadOnly = false
let runTokenValid = true
let githubAccountId: string | null = '123'
const queries: { sql: string; params: unknown[] }[] = []
const dialect = new PgDialect()
const select = mock.fn((columns: Record<string, unknown>) => {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: (query: Parameters<typeof dialect.sqlToQuery>[0]) => { queries.push(dialect.sqlToQuery(query)); return builder },
    limit: async () => !row ? [] : Object.hasOwn(columns, 'run') ? [row] : [{
      status: row.run.status, stopRequestedAt: row.run.stopRequestedAt, leaseExpiresAt: row.run.leaseExpiresAt,
    }],
  }
  return builder
})
const verify = mock.fn(async (_request: Request, token?: string) => runTokenValid && token === 'mkw_synthetic' ? { token, extra: { runId: ids.run, userId: owner } } : undefined)
const readPolicy = mock.fn(async () => ({ policy }))
const settings = mock.fn(async () => ({ push }))
const linkedAccount = mock.fn(async () => githubAccountId)
const query = mock.fn(async (_sql: string, _values: unknown[]) => ({ rows: [{ restricted: frozenReadOnly }] }))

function stub(relative: string, namedExports: Record<string, unknown>) {
  mock.module(new URL(relative, import.meta.url).href, { namedExports })
}
stub('../db/index.ts', { db: { select }, pool: { query } })
stub('../mcp/worker.ts', { verifyRunToken: verify, workerRun: () => ({ id: ids.run, userId: owner, botId: null, issueId: ids.task }) })
stub('../issue-team-access.ts', { issueTeamAccess: async () => ({ allowed: teamAllowed }) })
stub('../agent-tool-approval/policy-store.ts', { readCliRunPolicy: readPolicy })
stub('../device-repositories.ts', { readRepositorySettings: settings })
stub('../run-admission-store.ts', { acceptedEventStillMatches: async () => eventMatches })
stub('./repository-installation.ts', { linkedGitHubAccountId: linkedAccount })

let authorize: typeof import('./run-token-authority')['authorizeRunGitHubToken']
before(async () => { ({ authorizeRunGitHubToken: authorize } = await import('./run-token-authority')) })
beforeEach(() => {
  row = fixture()
  policy = { readOnly: false, permissions: { git_push: 'allow' } }
  push = { approved: true, approvedByUserId: owner, approvedAt: '2026-10-30T00:00:00Z' }
  teamAllowed = false; eventMatches = true; frozenReadOnly = false; runTokenValid = true; githubAccountId = '123'; queries.length = 0
  for (const fn of [select, verify, readPolicy, settings, linkedAccount, query]) fn.mock.resetCalls()
  readPolicy.mock.mockImplementation(async () => ({ policy }))
})

const request = (bearer: string | null = 'Bearer mkw_synthetic', body?: unknown) => new Request('https://mikka.example/api/runs/github-token', {
  method: 'POST', headers: bearer ? { authorization: bearer } : {}, ...(body ? { body: JSON.stringify(body) } : {}),
})

test('only a valid run bearer is accepted before any database or provider lookup', async () => {
  for (const bearer of [null, 'Bearer user-oauth-token', 'Bearer mkw_invalid', 'Bearer mkw_synthetic\nextra']) {
    if (bearer?.includes('\n')) continue // Request headers themselves reject this input.
    assert.equal(await authorize(request(bearer)), null)
  }
  assert.equal(select.mock.callCount(), 0)
  assert.equal(linkedAccount.mock.callCount(), 0)
})

test('the run and owner are bound in SQL and caller-supplied repositories are ignored', async () => {
  const result = await authorize(request(undefined, { repository: 'other/private', runId: 'other-run' }))
  assert.deepEqual(result, { runId: ids.run, userId: owner, remoteKey: key, branch, githubAccountId: '123' })
  assert.deepEqual(queries[0].params, [ids.run, owner])
  assert.match(queries[0].sql, /agent_runs.*id.*agent_runs.*userId/)
})

test('a missing persisted assignment cannot obtain repository authority', async () => {
  row = null
  assert.equal(await authorize(request()), null)
})

test('terminal, queued and waiting runs cannot exchange credentials', async () => {
  for (const status of ['queued', 'waiting_input', 'finishing', 'succeeded', 'failed', 'cancelled', 'stopped']) {
    row = fixture(); row.run.status = status
    assert.equal(await authorize(request()), null, status)
  }
  assert.equal(readPolicy.mock.callCount(), 0)
})

test('plan and acceptance assignments cannot obtain implementation credentials', async () => {
  for (const kind of ['plan', 'acceptance']) {
    row = fixture(); row.run.kind = kind
    assert.equal(await authorize(request()), null, kind)
  }
  assert.equal(readPolicy.mock.callCount(), 0)
})

test('frozen benchmark and independent Factory check constraints override live write permission', async () => {
  frozenReadOnly = true
  assert.equal(await authorize(request()), null)
  assert.equal(readPolicy.mock.callCount(), 0)
  const [statement, parameters] = query.mock.calls[0].arguments
  assert.match(statement, /improvement_benchmark_runs/)
  assert.match(statement, /factory_attempts/)
  assert.match(statement, /stage<>'execute'/)
  assert.deepEqual(parameters, [ids.run])
})

test('STOP, expired lease and missing lease reject the actual authorizer', async () => {
  row!.run.stopRequestedAt = new Date()
  assert.equal(await authorize(request()), null)
  row = fixture(); row.run.leaseExpiresAt = new Date(Date.now() - 1)
  assert.equal(await authorize(request()), null)
  row = fixture(); row.run.leaseExpiresAt = null
  assert.equal(await authorize(request()), null)
})

test('STOP, terminal transition and lease loss during asynchronous policy lookup are rechecked', async () => {
  for (const transition of [
    () => { row!.run.stopRequestedAt = new Date() },
    () => { row!.run.status = 'succeeded' },
    () => { row!.run.leaseExpiresAt = new Date(Date.now() - 1) },
  ]) {
    row = fixture()
    readPolicy.mock.mockImplementation(async () => { transition(); return { policy } })
    assert.equal(await authorize(request()), null)
  }
})

test('a run token revoked during asynchronous policy lookup is checked again', async () => {
  readPolicy.mock.mockImplementation(async () => { runTokenValid = false; return { policy } })
  assert.equal(await authorize(request()), null)
  assert.equal(verify.mock.callCount(), 2)
})

test('a foreign or disabled device and foreign repository owner are rejected', async () => {
  for (const mutate of [
    () => { row!.device.ownerId = 'other' },
    () => { row!.device.enabled = false },
    () => { row!.repo.userId = 'other' },
    () => { row!.repo.deviceId = 'other-device' },
  ]) {
    row = fixture(); mutate()
    assert.equal(await authorize(request()), null)
  }
})

test('the publication cannot grant another owner, task, repository or branchless assignment', async () => {
  for (const mutate of [
    () => { row!.publication.userId = 'other' },
    () => { row!.publication.issueId = 'other-task' },
    () => { row!.publication.pushApproved = false },
    () => { row!.publication.branch = '' },
    () => { row!.publication.remoteKey = 'v2/github.com/other/repo' },
    () => { row!.publication.remoteUrl = 'https://github.com/other/repo.git' },
  ]) {
    row = fixture(); mutate()
    assert.equal(await authorize(request()), null)
  }
})

test('deleted tasks and revoked or stale team scope are rejected', async () => {
  row!.task.content.attrs.mikka.deletedAt = '2026-10-30T00:00:00Z'
  assert.equal(await authorize(request()), null)
  row = fixture(); row.task.userId = 'teammate'; row.task.scope = 'workspace'
  assert.equal(await authorize(request()), null)
  teamAllowed = true
  assert.ok(await authorize(request()))
  row.task.scopeVersion++
  assert.equal(await authorize(request()), null)
  row = fixture(); row.task.userId = 'teammate'
  assert.equal(await authorize(request()), null)
})

test('read-only and git-push deny remain authoritative despite the GitHub App grant', async () => {
  policy.readOnly = true
  assert.equal(await authorize(request()), null)
  policy.readOnly = false; policy.permissions.git_push = 'deny'
  assert.equal(await authorize(request()), null)
  assert.equal(linkedAccount.mock.callCount(), 0)
})

test('a Mikka-side repository approval neither grants nor withholds the token: the GitHub App receipt does', async () => {
  for (const value of [null, { approved: false }, { approved: true, approvedByUserId: 'other', approvedAt: '2026-10-30T00:00:00Z' }]) {
    push = value
    assert.ok(await authorize(request()), 'the accepted grant receipt issues the token')
  }
  row!.run.agentDefinition = null
  push = { approved: true, approvedByUserId: owner, approvedAt: '2026-10-30T00:00:00Z' }
  assert.equal(await authorize(request()), null, 'without the receipt no Mikka setting lends authority')
  assert.equal(settings.mock.callCount(), 0, 'the issuer no longer reads Mikka repository settings')
})

test('a saved admission is checked against the actual device, repository and accepted source event', async () => {
  const admission = granted()
  row!.run.agentDefinition = { repositoryAdmission: admission }
  assert.ok(await authorize(request()))
  eventMatches = false
  assert.equal(await authorize(request()), null)
  eventMatches = true; admission.deviceId = '10000000-0000-4000-8000-000000000009'
  assert.equal(await authorize(request()), null)
})

test('a receipt from the earlier per-repository approval still issues; an old configured_allow receipt never does', async () => {
  row!.run.agentDefinition = { repositoryAdmission: { ...granted(), authority: 'repository_approval' } }
  assert.ok(await authorize(request()))
  row!.run.agentDefinition = { repositoryAdmission: { ...granted(), authority: 'configured_allow', approvedAt: undefined } }
  assert.equal(await authorize(request()), null)
})

test('allow and ask both issue a token with the grant; deny or read-only does not', async () => {
  for (const decision of ['allow', 'ask'] as const) {
    policy.permissions.git_push = decision
    assert.ok(await authorize(request()), decision)
  }
  policy.permissions.git_push = 'deny'
  assert.equal(await authorize(request()), null)
  assert.equal(linkedAccount.mock.callCount(), 2)
})

test('a missing linked GitHub identity cannot use App installation credentials', async () => {
  githubAccountId = null
  assert.equal(await authorize(request()), null)
})

test('the exchange never calls GitHub for an actually ended run', async () => {
  row!.run.status = 'succeeded'
  const handle = createRunGitHubTokenExchange({ authorize, issue: async () => assert.fail('ended run reached GitHub'), revoke: async () => {} })
  assert.equal((await handle(request())).status, 403)
})

test('STOP while GitHub is issuing a token revokes the newly minted token and withholds it', async () => {
  const revoked: string[] = []
  const handle = createRunGitHubTokenExchange({
    authorize,
    issue: async () => {
      row!.run.stopRequestedAt = new Date()
      return { token: 'synthetic-minted-token', expiresAt: '2099-01-01T00:00:00Z' }
    },
    revoke: async token => { revoked.push(token) },
  })
  const result = await handle(request())
  assert.equal(result.status, 403)
  assert.deepEqual(revoked, ['synthetic-minted-token'])
  assert.doesNotMatch(await result.text(), /synthetic-minted-token/)
})
