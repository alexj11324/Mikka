import './fixtures/scope-request-runtime.mjs'
import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import pg from 'pg'
import { validateTarget } from '../scripts/run-db-tests.mjs'
import { readIssueMetadata } from '../lib/issue-metadata'

/** Real tracked SQL, server actions and GraphQL HTTP transport. Callers and
 * provider resources are isolated fixtures, not a live Linear/OAuth acceptance. */
test('personal scope archives the frozen old Linear issue while ordinary sync remains off', { timeout: 60_000 }, async t => {
  validateTarget(process.env)
  assert.equal(process.env.REQUIRE_DB, '1')
  const database = 'scope184_archive_' + randomUUID().replaceAll('-', '') + '_e2e'
  const admin = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
  try { await admin.query(`create database "${database}"`) } finally { await admin.end() }
  const url = new URL(process.env.E2E_DATABASE_URL!)
  url.pathname = '/' + database
  for (const key of ['E2E_DATABASE_URL', 'DATABASE_URL', 'MIKKA_DATABASE_URL']) process.env[key] = url.href
  process.env.BETTER_AUTH_SECRET = 'isolated-scope184-archive-auth-fixture'
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:31844'
  process.env.LINEAR_TOKEN_ENCRYPTION_KEY = '1'.repeat(64)
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY
  const migrated = await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, MIGRATE: '1', VERCEL_ENV: '' }, maxBuffer: 4 << 20 })
  assert.match(migrated.stdout, /applied 20261031021420_archive_linear_on_personal_scope.sql/)
  const pool = new pg.Pool({ connectionString: url.href, max: 6 })
  t.after(async () => { await pool.end() })
  console.log(`Retained Linear archive database ${database}`)

  const external = new Map<string, { id: string; archivedAt: string | null; team: { id: string } }>()
  let archiveRequests = 0, stateReads = 0, dropResponse = false
  const receiver = createServer(async (request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer synthetic-linear-archive-token')
    let body = ''
    for await (const part of request) body += part
    const { query, variables } = JSON.parse(body)
    response.setHeader('content-type', 'application/json')
    if (query.includes('query MikkaLinearArchiveState')) {
      stateReads++
      return response.end(JSON.stringify({ data: { issue: external.get(variables.id) ?? null } }))
    }
    assert.ok(query.includes('mutation MikkaLinearArchiveIssue'), 'ordinary create/update/inbox API must not run while sync is off')
    archiveRequests++
    const issue = external.get(variables.id)
    assert.ok(issue)
    issue.archivedAt = new Date().toISOString()
    if (dropResponse) { dropResponse = false; return response.destroy() }
    response.end(JSON.stringify({ data: { issueArchive: { success: true } } }))
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const address = receiver.address() as { port: number }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, options) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (target.origin === 'https://api.linear.app' && target.pathname === '/graphql') return originalFetch(`http://127.0.0.1:${address.port}/graphql`, options)
    throw Error('Only the owned Linear protocol receiver is allowed')
  }) as typeof fetch
  t.after(async () => {
    globalThis.fetch = originalFetch
    receiver.closeAllConnections()
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()))
    await (await import('../lib/db')).pool.end()
    await (await import('../lib/workspace-db')).workspacePool.end()
  })

  const [{ createAppIssueFromLinear }, { seal }, { actAs }, actions, { collectIssueEffects }, { processLinearIssueOutbox }, { issueForUser }, { readRun }, { db }, { linearTeamSyncs }, { eq }] = await Promise.all([
    import('../lib/linear-sync/issue-sync'), import('../lib/linear-sync/crypto'), import('../lib/acting-user'), import('../app/actions/issues'), import('../lib/issue-effects'), import('../lib/linear-sync/worker'), import('../lib/issue-access'), import('../lib/agent-runs'), import('../lib/db'), import('../lib/db/schema'), import('drizzle-orm'),
  ])
  const owner = 'archive-owner-' + randomUUID(), member = 'archive-member-' + randomUUID()
  const workspace = randomUUID(), teamId = randomUUID(), syncId = randomUUID(), agentId = randomUUID()
  for (const id of [owner, member]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,\'Fixture\',$2,true,now(),now())', [id, id + '@example.invalid'])
  await pool.query('insert into issue_prefixes("userId",prefix) values($1,\'ALEX\')', [owner])
  await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,\'Archive fixture\')', [workspace, owner])
  for (const id of [owner, member]) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,\'Fixture\',$3,\'member\',\'active\')', [workspace, id, id + '@example.invalid'])
  await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,\'Archive fixture\',\'MIK\')', [teamId, workspace, owner])
  await pool.query('insert into linear_team_syncs(id,"ownerId","linearTeamId","linearTeamKey","linearTeamName") values($1,$2,$3,\'MIK\',\'Archive fixture\')', [syncId, owner, teamId])
  await pool.query('insert into linear_connections("userId","linearUserId","organizationId","organizationName","accessToken","refreshToken","expiresAt") values($1,\'fixture-user\',\'fixture-org\',\'Fixture\',$2,$3,now()+interval \'1 day\')', [owner, seal('synthetic-linear-archive-token'), seal('synthetic-unused-refresh')])
  await pool.query('insert into agents(id,"userId",harness,name) values($1,$2,\'codex\',\'Archive fixture\')', [agentId, member])
  const [team] = await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.id, syncId))
  async function seed() {
    const id = randomUUID()
    const remote = { id, identifier: 'MIK-184', title: 'Archive fixture', description: '', dueDate: null, priority: 0, url: 'https://example.invalid/fixture', updatedAt: new Date().toISOString(), state: null, team: { id: teamId, key: 'MIK', name: 'Fixture' }, assignee: null, labels: [] }
    assert.ok(await createAppIssueFromLinear(team, remote))
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [id, teamId, workspace, owner])
    await pool.query('insert into linear_sync_outbox(id,"issueId","scopeVersion") values($1,$2,1) on conflict do nothing', [randomUUID(), id])
    external.set(id, { id, archivedAt: null, team: { id: teamId } })
    return id
  }
  async function retire(id: string, confirmed = false) {
    const effects: import('../lib/issue-effects').IssueEffect[] = []
    const before = (await pool.query('select content,revision from issues where id=$1', [id])).rows[0]
    const preview = confirmed ? await actAs(owner, () => actions.previewIssuePersonalScope(id)) : null
    if (confirmed) assert.ok(preview && 'preview' in preview && preview.preview)
    const result = await collectIssueEffects(effects, () => actAs(owner, () => confirmed && preview && 'preview' in preview && preview.preview
      ? actions.confirmIssuePersonalScope({ id, revision: before.revision, confirmation: preview.preview.confirmation })
      : actions.setIssueScope({ id, revision: before.revision, scope: 'personal' })))
    assert.ok('issue' in result && result.issue)
    assert.equal(result.issue.scope, 'personal')
    assert.equal(result.issue.scopeSetBy, 'user')
    assert.equal(result.issue.identifier, `ALEX-${readIssueMetadata(before.content).number}`)
    assert.deepEqual(effects, [{ kind: 'sync', issueId: id }])
    return result.issue
  }

  const issue = await seed(), runId = randomUUID()
  await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status) values($1,$2,$3,$4,\'queued\')', [runId, member, issue, agentId])
  assert.ok(await issueForUser(member, issue))
  assert.ok(await readRun(member, runId))
  assert.deepEqual(await actAs(member, () => actions.setIssueScope({ id: issue, revision: 1, scope: 'personal' })), { error: 'issueScopeOwnerOnly' })
  assert.deepEqual(await actAs(owner, () => actions.setIssueScope({ id: issue, revision: 99, scope: 'personal' })), { error: 'issueStale' })
  await retire(issue)
  assert.equal(await issueForUser(member, issue), null)
  assert.equal(await readRun(member, runId), null)
  assert.equal((await pool.query('select status from agent_runs where id=$1', [runId])).rows[0].status, 'cancelled')
  assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1', [issue])).rows[0].n, 0)
  const job = (await pool.query('select * from linear_sync_outbox where "issueId"=$1 and operation=\'archive\'', [issue])).rows[0]
  assert.equal(job.archiveTarget.targetVerified, true)
  assert.equal(job.archiveTarget.linearIssueId, issue)
  await assert.rejects(pool.query('update linear_sync_outbox set "archiveTarget"=$2 where id=$1', [job.id, { ...job.archiveTarget, linearIssueId: randomUUID() }]), { code: '23514' })
  const oldClaim = await pool.query('update linear_sync_outbox set status=\'processing\',"claimToken"=$2,attempts=attempts+1 where id=$1', [job.id, randomUUID()])
  assert.equal(oldClaim.rowCount, 0, 'old sync workers cannot claim or consume the new archive request')
  dropResponse = true
  await Promise.all(Array.from({ length: 10 }, () => processLinearIssueOutbox(issue)))
  assert.equal(archiveRequests, 1)
  const unknown = (await pool.query('select * from linear_sync_outbox where id=$1', [job.id])).rows[0]
  assert.equal(unknown.status, 'queued')
  assert.ok(unknown.lastError)
  assert.equal((await pool.query('select "archivedAt" from linear_issue_detachments where "linearIssueId"=$1', [issue])).rows[0].archivedAt, null)
  await pool.query('update linear_sync_outbox set "availableAt"=now() where id=$1', [job.id])
  await processLinearIssueOutbox(issue)
  assert.equal(archiveRequests, 1, 'retry reads the applied archive instead of mutating again')
  assert.equal((await pool.query('select status from linear_sync_outbox where id=$1', [job.id])).rows[0].status, 'done')
  assert.ok((await pool.query('select "archivedAt" from linear_issue_detachments where "linearIssueId"=$1', [issue])).rows[0].archivedAt)
  assert.equal(await createAppIssueFromLinear(team, { id: issue, identifier: 'MIK-184', title: 'Delayed webhook', description: '', dueDate: null, priority: 0, url: 'https://example.invalid/fixture', updatedAt: new Date().toISOString(), state: null, team: { id: teamId, key: 'MIK', name: 'Fixture' }, assignee: null, labels: [] }), null)

  const denied = await seed()
  await retire(denied, true)
  await pool.query('update linear_connections set "revokedAt"=now() where "userId"=$1', [owner])
  const calls = stateReads
  await processLinearIssueOutbox(denied)
  assert.equal(stateReads, calls)
  assert.equal(archiveRequests, 1)
  assert.equal((await pool.query('select status from linear_sync_outbox where "issueId"=$1 and operation=\'archive\'', [denied])).rows[0].status, 'failed')
  // Same unresolved state as the browser acceptance: no verified link, an
  // inactive sync and a committed reservation whose response was lost.
  await pool.query('update linear_connections set "revokedAt"=null where "userId"=$1', [owner])
  const created = await collectIssueEffects([], () => actAs(owner, () => actions.saveIssue({ title: 'Unknown Linear publication', content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })))
  assert.ok('issue' in created && created.issue)
  const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
  const promoted = await promoteExistingIssueForUser(owner, { requestId: randomUUID(), issueId: created.issue.id, revision: created.issue.revision, teamId, expectedTeamId: null })
  assert.ok('issue' in promoted && promoted.issue)
  const pendingIssue = created.issue.id, pendingSync = randomUUID(), pendingPublication = randomUUID(), pendingRemote = randomUUID()
  await pool.query('insert into linear_team_syncs(id,"ownerId","linearTeamId","linearTeamKey","linearTeamName",active) values($1,$2,$3,\'OLD\',\'Unresolved fixture\',false)', [pendingSync, owner, randomUUID()])
  await pool.query('insert into linear_issue_publications(id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId","writePending") values($1,$2,$3,$4,$5,$6,true)', [pendingPublication, pendingIssue, owner, pendingSync, promoted.issue.scopeVersion, pendingRemote])
  await retire(pendingIssue)
  const beforeUnknownReads = stateReads, beforeUnknownWrites = archiveRequests
  await processLinearIssueOutbox(pendingIssue)
  assert.equal(stateReads, beforeUnknownReads)
  assert.equal(archiveRequests, beforeUnknownWrites, 'an unknown target never receives another external write')
  const pending = (await pool.query('select * from linear_sync_outbox where "issueId"=$1 and operation=\'archive\'', [pendingIssue])).rows[0]
  assert.equal(pending.archiveTarget.targetVerified, false)
  assert.equal(pending.status, 'failed')
  assert.ok(pending.lastError)
  const retained = (await pool.query('select * from linear_issue_publications where id=$1', [pendingPublication])).rows[0]
  assert.equal(retained.linearIssueId, pendingRemote)
  assert.equal(retained.writePending, true)
  assert.ok(retained.retiredAt)
  const detached = (await pool.query('select * from linear_issue_detachments where "linearIssueId"=$1', [pendingRemote])).rows[0]
  assert.equal(detached.publicationId, pendingPublication)
  assert.equal(detached.externalTargetVerified, false)
  assert.equal(detached.archivedAt, null)
  assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where operation=\'sync\' and status<>\'done\'')).rows[0].n, 0)
})
