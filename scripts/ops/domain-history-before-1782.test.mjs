import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createSessionClient } from '../acceptance/cloud-startup.mjs'
import { candidateInventory, EPIC_MIGRATIONS, guardContext, guardMain, MAIN, projectRows, publicFailure, searchCandidates, selectScope, snapshot, SQL, verifyScope } from './domain-history-before-1782.mjs'
import * as beforeDriver from './domain-history-before-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const owners = ids => Object.fromEntries(ids.map(value => [value, 'smoke-owner']))
const scope = { ownerId: 'smoke-owner', workspaceId: id(90), workspaceKind: 'team', adminId: 'policy-admin',
  taskIds: [id(1), id(2)], candidateTaskIds: [id(1), id(2)], taskOwners: owners([id(1), id(2)]) }
const sharedView = () => ({ currentUserId: scope.ownerId, workspace: { id: scope.workspaceId, kind: 'team' }, role: 'admin',
  choices: [{ id: scope.workspaceId, kind: 'team' }], members: [{ userId: scope.ownerId, role: 'admin', status: 'active' },
    { userId: scope.adminId, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] })
const fixture = () => ({ task: scope.taskIds.map(value => ({ id: value, owner: scope.ownerId,
  workspace: scope.workspaceId, scope: 'workspace', state: 'bound', identifier: 'MIK-' + value.slice(-1) })),
publication: scope.taskIds.map((value, index) => ({ id: id(index + 3), issueId: value, identifier: 'MIK-' + (index + 1), branch: 'private-branch', baseBranch: 'main', remoteKey: 'private-repo' })),
run: scope.taskIds.map((value, index) => ({ id: id(index + 3), issueId: value, hasProjectSnapshot: false, frozenDigest: 'a'.repeat(32) })) })
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
  GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108', GITHUB_EVENT_NAME: 'push',
  GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_JOB: 'domain_history_before',
  GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'b'.repeat(40),
  GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-domain-history-before.yml@refs/heads/ops/self-hosted-vault-closeout-20261108' }
const windowNow = Date.parse('2026-11-09T19:00:00.000Z')
const windowFixture = () => {
  const window = { workspaceId: scope.workspaceId, readerSha256: createHash('sha256').update(scope.ownerId).digest('hex'),
    opsParentSha: 'd'.repeat(40), commentId: 4567, commentBodySha256: null,
    startsAt: '2026-11-09T18:59:00.000Z', expiresAt: '2026-11-09T19:15:00.000Z' }
  const record = { state: 'active', batch: 1782, mode: 'domain_history_before', mainSha: MAIN,
    workspaceSha256: createHash('sha256').update(window.workspaceId).digest('hex'), readerSha256: window.readerSha256,
    opsParentSha: window.opsParentSha, startsAt: window.startsAt, expiresAt: window.expiresAt }
  const comment = { id: window.commentId, issue_url: 'https://api.github.com/repos/alexj11324/Mikka/issues/1752',
    user: { login: 'alexj11324', id: 183887963 }, body: '<!-- mikka-1782-domain-history-before:v1\n' + JSON.stringify(record) + '\n-->' }
  window.commentBodySha256 = createHash('sha256').update(comment.body).digest('hex')
  return { window, comment, record }
}
const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
  after: env.GITHUB_SHA, deleted: false, forced: false }

test('ordinary owner-deleted proof reauthorizes a fixed Task after exact issueNotFound without treating that error as permission', async () => {
  const deletedAt = new Date(Date.now() - 60000).toISOString(), actions = []
  const client = createSessionClient('https://synthetic.invalid', async (url, init) => {
    if (url.pathname.endsWith('/api/auth/get-session')) return Response.json({ user: { id: scope.ownerId } })
    if (url.pathname.endsWith('/api/workspace')) return Response.json(sharedView())
    assert.equal(url.pathname, '/mikka/api/rpc')
    assert.equal(init.headers['x-mikka-workspace-id'], scope.workspaceId)
    const { action, args } = JSON.parse(init.body); actions.push(action)
    let result
    if (action === 'issues.getIssue') result = args[0] === id(1) ? { error: 'issueNotFound' }
      : { issue: { id: args[0], userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } }
    else {
      assert.equal(action, 'issue-operations.getDeletedIssue'); assert.deepEqual(args, [id(1)])
      result = { id: id(1), title: 'never-output-this-title', deletedAt }
    }
    return Response.json({ ok: true, result })
  })
  const taskAccess = { [id(1)]: { mode: 'owned_deleted', deletedAt }, [id(2)]: { mode: 'live', deletedAt: null } }
  const observed = await verifyScope(client, { ...scope, taskAccess })
  assert.deepEqual(observed, { live: 1, ownedDeleted: 1 })
  assert.equal(actions.filter(action => action === 'issue-operations.getDeletedIssue').length, 1)
  assert.ok(!JSON.stringify(observed).includes('never-output-this-title'))
})

test('existing real Ops subject accepts only a clean first-attempt owned snapshot job', () => {
  guardContext(env, event, env.GITHUB_SHA, false)
  for (const change of [{ GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_JOB: 'private_candidates' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/self-hosted-vault-closeout.yml@refs/heads/ops/self-hosted-vault-closeout-20261108' }]) {
    assert.throws(() => guardContext({ ...env, ...change }, event, env.GITHUB_SHA, false))
  }
  assert.throws(() => guardContext(env, { ...event, forced: true }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, deleted: true }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, ref: 'refs/heads/main' }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, after: 'c'.repeat(40) }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, repository: { ...event.repository, id: 1 } }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, { ...event, repository: { ...event.repository, owner: { id: 1 } } }, env.GITHUB_SHA, false))
  assert.throws(() => guardContext(env, event, 'c'.repeat(40), false))
  assert.throws(() => guardContext(env, event, env.GITHUB_SHA, true))
})

test('public served build and current main must both equal the exact before pin', async () => {
  for (const changed of [null, 'main', 'served']) {
    const calls = [], { window, comment } = windowFixture()
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/comments?')) return Response.json([comment])
      if (url.endsWith('/issues/1752')) return Response.json({ number: 1752, comments: 7 })
      return new Response(JSON.stringify(url.includes('api.github.com') ? {
        ref: 'refs/heads/main', object: { sha: changed === 'main' ? 'a'.repeat(40) : MAIN, type: 'commit' },
      } : { build: changed === 'served' ? 'a'.repeat(40) : MAIN }))
    }
    if (changed) await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, fetchImpl, window, () => windowNow))
    else assert.equal((await guardMain({ GITHUB_TOKEN: 'synthetic' }, fetchImpl, window, () => windowNow)).mainSha, MAIN)
    assert.equal(calls[0].init.redirect, 'error')
    if (calls.length >= 2) assert.equal(calls[1].init.headers.authorization, undefined)
  }
})

test('snapshot contains only closed projections and sorted finite UUIDs; no raw identifiers, branches or definitions', () => {
  const rows = fixture(); rows.task.reverse(); rows.run[0].agentDefinition = 'sensitive-prompt'
  rows.publication[0].remoteUrl = 'https://credential:private@example.invalid'
  const result = projectRows(scope, rows), json = JSON.stringify(result)
  assert.deepEqual(result.task.map(row => row.id), scope.taskIds)
  assert.equal(result.run[0].frozenDigest, 'a'.repeat(32))
  for (const raw of ['sensitive-prompt', 'private-branch', 'private-repo', 'credential:', 'MIK-1', 'smoke-owner']) assert.ok(!json.includes(raw))
  assert.equal(result.task[0].issuedIdentifierPresent, true)
  assert.match(result.publication[0].branchSha256, /^[a-f0-9]{64}$/)
})

for (const [name, change] of [
  ['changed frozen creator', rows => { rows.task[0].owner = 'other' }],
  ['ownership no longer bound', rows => { rows.task[0].state = 'pending' }],
  ['different workspace', rows => { rows.task[0].workspace = id(99) }],
  ['unknown legacy scope', rows => { rows.task[0].scope = 'private' }],
  ['missing task', rows => { rows.task.pop() }],
  ['duplicate task', rows => { rows.task[1] = rows.task[0] }],
  ['unrelated run', rows => { rows.run[0].issueId = id(99) }],
  ['no publication', rows => { rows.publication = [] }],
  ['no ended run', rows => { rows.run = [] }],
  ['truncated run set', rows => { rows.run = Array(1001).fill(rows.run[0]) }],
  ['invalid digest', rows => { rows.run[0].frozenDigest = 'raw-content' }],
]) test('refuses ' + name, () => { const rows = fixture(); change(rows); assert.throws(() => projectRows(scope, rows)) })

test('a same-owner same-workspace personal compatibility label is a legal historical Task', () => {
  const rows = fixture(); rows.task[0].scope = 'personal'
  const result = projectRows(scope, rows)
  assert.deepEqual(result.task.map(row => row.id), scope.taskIds)
  rows.task[0].workspace = id(99)
  assert.throws(() => projectRows(scope, rows))
  rows.task[0].workspace = scope.workspaceId; rows.task[0].owner = 'other'
  assert.throws(() => projectRows(scope, rows))
})

test('at most ten explicit Task UUIDs, not an arbitrary SQL or all-tenant scan', () => {
  assert.throws(() => projectRows({ ...scope, taskIds: Array.from({ length: 11 }, (_, i) => id(i + 1)) }, fixture()))
  assert.throws(() => projectRows({ ...scope, taskIds: ['injection'] }, fixture()))
  assert.throws(() => projectRows({ ...scope, taskIds: [] }, fixture()))
})

function database({ readonly = 'on', isolation = 'repeatable read', epic = 0, legacy = 0, failRun = false, bindingOverride, publicationOverride,
  accessOverride,
  selected = scope.taskIds.map(value => ({ id: value })) } = {}) {
  const calls = [], rows = fixture()
  return { calls, query: async (sql, args) => {
    calls.push({ sql, args })
    if (sql === SQL.settings) return { rows: [{ readonly, isolation }] }
    if (sql === SQL.ledger) return { rows: [{ epic, legacy, digest: 'c'.repeat(32) }] }
    if (sql === SQL.taskAccess) return { rows: [accessOverride ?? { present: args[0].length, authorized: args[0].length }] }
    if (sql === SQL.binding) {
      assert.deepEqual(args[1], args[0].map(value => scope.taskOwners[value] ?? scope.ownerId)); assert.equal(args[2], scope.workspaceId)
      return { rows: [bindingOverride ?? { present: args[0].length, bound: args[0].length, published: 2, ended: 2, historical: 2 }] }
    }
    if (sql === SQL.publicationEvidence) {
      assert.deepEqual(args[1], args[0].map(value => scope.taskOwners[value] ?? scope.ownerId)); assert.equal(args[2], scope.workspaceId)
      return { rows: [publicationOverride ?? { receipts: 2, published: bindingOverride?.published ?? 2,
        runMissing: 0, issueMismatch: 0, executorMismatch: 0, workspaceNull: 0, workspaceDifferent: 0, verified: bindingOverride?.published ?? 2 }] }
    }
    if (sql === SQL.select) {
      assert.deepEqual(args[1], args[0].map(value => scope.taskOwners[value] ?? scope.ownerId)); assert.equal(args[2], scope.workspaceId)
      return { rows: selected }
    }
    for (const kind of ['task', 'publication', 'run']) if (sql === SQL[kind]) {
      if (kind === 'run' && failRun) throw Error('synthetic-private-provider-error')
      assert.deepEqual(args, [scope.taskIds, scope.taskIds.map(value => scope.taskOwners[value]), scope.workspaceId]); return { rows: rows[kind] }
    }
    return { rows: [] }
  } }
}

test('one repeatable read, read-only transaction uses fixed SQL and always rolls back', async () => {
  const db = database(), result = await snapshot(db, scope)
  assert.equal(result.readOnly, true)
  assert.equal(db.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(db.calls.every(({ sql }) => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/i.test(sql)))
  assert.equal(db.calls.filter(({ args }) => args).length, 6)
})
for (const options of [{ readonly: 'off' }, { isolation: 'read committed' }, { epic: 1 }, { legacy: 1 }, { failRun: true }]) {
  test('fails closed and rolls back for ' + JSON.stringify(options), async () => {
    const db = database(options)
    await assert.rejects(snapshot(db, scope))
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  })
}

test('one hundred authorized candidate UUIDs produce only the fixed historical subset for all three snapshots', async () => {
  const db = database(), candidateTaskIds = Array.from({ length: 100 }, (_, i) => id(i + 1))
  const result = await snapshot(db, { ...scope, candidateTaskIds, taskOwners: owners(candidateTaskIds) })
  assert.equal(result.candidateCount, 100)
  assert.deepEqual(result.taskIds, scope.taskIds)
  assert.deepEqual(db.calls.find(row => row.sql === SQL.select).args, [candidateTaskIds, candidateTaskIds.map(() => scope.ownerId), scope.workspaceId])
  for (const kind of ['task', 'publication', 'run']) assert.deepEqual(db.calls.find(row => row.sql === SQL[kind]).args, [scope.taskIds, scope.taskIds.map(value => scope.taskOwners[value]), scope.workspaceId])
  assert.match(SQL.select, /p.status='published'/)
  assert.match(SQL.select, /r.status IN \('succeeded','stopped','failed','cancelled'\)/)
  assert.match(SQL.select, /unnest\(\$1::uuid\[\], \$2::text\[\]\)/)
  assert.match(SQL.select, /a.creator=i\."userId"/)
  assert.match(SQL.select, /i\."workspaceId"=\$3::uuid/)
  assert.match(SQL.select, /i.scope IN \('workspace','personal'\)/)
  assert.match(SQL.select, /LIMIT 10$/)
})

for (const [name, selected] of [['empty', []], ['foreign', [{ id: id(99) }]],
  ['duplicate', [{ id: id(1) }, { id: id(1) }]], ['eleven', Array.from({ length: 11 }, (_, i) => ({ id: id(i + 1) }))]]) {
  test('refuses ' + name + ' history selection before any three-table snapshot', async () => {
    const db = database({ selected })
    await assert.rejects(snapshot(db, scope))
    assert.ok(!db.calls.some(row => [SQL.task, SQL.publication, SQL.run].includes(row.sql)))
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  })
}

test('refuses more than one hundred API candidates before opening any transaction', async () => {
  const db = database()
  await assert.rejects(snapshot(db, { ...scope, candidateTaskIds: Array.from({ length: 101 }, (_, i) => id(i + 1)) }))
  assert.equal(db.calls.length, 0)
})

test('normal API candidates admit both legal labels and other creators and emit counts without raw identity or content', () => {
  const rows = [
    { id: id(1), ownerId: scope.ownerId, scope: 'workspace', status: 'completed', title: 'sensitive-title' },
    { id: id(2), ownerId: scope.ownerId, scope: 'personal', status: 'stopped', content: 'sensitive-body' },
    { id: id(3), ownerId: 'other-owner', scope: 'personal', status: 'active' },
    { id: id(4), ownerId: scope.ownerId, scope: 'unknown' },
    { id: id(5), userId: scope.ownerId, scope: 'personal' },
  ]
  const result = candidateInventory(rows, scope.ownerId)
  assert.deepEqual(result.candidateTaskIds, [id(1), id(2), id(3)])
  assert.equal(result.taskOwners[id(3)], 'other-owner')
  assert.deepEqual(result.counts, { returned: 5, ownerIdFieldPresent: 4, own: 3, ownWorkspace: 1, ownPersonal: 1,
    ownUnknownScope: 1, ownScopeOmitted: 0, workspaceLabel: 1, personalLabel: 3, unknownScope: 1, scopeOmitted: 0, listCapacityReached: false })
  const output = JSON.stringify(result.counts)
  for (const privateValue of [scope.ownerId, 'other-owner', 'sensitive-title', 'sensitive-body', id(1)]) assert.ok(!output.includes(privateValue))
  assert.equal(candidateInventory([], scope.ownerId).counts.returned, 0)
  assert.deepEqual(candidateInventory(rows.filter(row => row.ownerId !== scope.ownerId), scope.ownerId).candidateTaskIds, [id(3)])
})

test('each candidate collection has a hard one-hundred UUID bound', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: id(i + 1), ownerId: scope.ownerId, scope: 'personal' }))
  assert.equal(candidateInventory(rows, scope.ownerId).counts.listCapacityReached, true)
  assert.equal(candidateInventory(rows, scope.ownerId).candidateTaskIds.length, 100)
  assert.throws(() => candidateInventory([...rows, { id: id(101), ownerId: scope.ownerId, scope: 'personal' }], scope.ownerId))
  assert.throws(() => candidateInventory([rows[0], rows[0]], scope.ownerId))
})

test('post-query API authorization loss invalidates evidence', async () => {
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : sharedView(), rpc: async (action, [value]) => {
    assert.equal(action, 'issues.getIssue')
    return { issue: { id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'workspace' } }
  } }
  await verifyScope(client, scope)
  client.rpc = async () => ({})
  await assert.rejects(verifyScope(client, scope))
})

test('post-query API verifies the same owner and Workspace for a personal-label Task', async () => {
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : sharedView(), rpc: async (action, [value]) => {
    assert.equal(action, 'issues.getIssue')
    return { issue: { id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } }
  } }
  await verifyScope(client, scope)
  client.rpc = async (_action, [value]) => ({ issue: { id: value, userId: 'other', workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } })
  await assert.rejects(verifyScope(client, scope))
  client.rpc = async (_action, [value]) => ({ issue: { id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'unknown' } })
  await assert.rejects(verifyScope(client, scope))
})

test('ordinary API workspace mismatch refuses before any APP query', async () => {
  await assert.rejects(selectScope({ json: async () => ({ user: { id: 'owner', email: 'different@example.invalid' } }) }, 'synthetic@example.invalid'))
})

test('failure output never copies provider messages, SQL, URLs or credentials', () => {
  assert.deepEqual(publicFailure(Object.assign(Error('postgres://user:password@private/db'), { code: '42P01' })), { code: 'before_failed' })
})

test('workflow isolates snapshot permissions and exact single-key credential reads', async () => {
  const root = new URL('../../', import.meta.url)
  const source = await readFile(new URL('.github/workflows/issue1782-domain-history-before.yml', root), 'utf8')
  const beforeJob = source.slice(source.indexOf('  domain_history_before:'))
  assert.match(beforeJob, /group: production-smoke-owner-acceptance/)
  assert.match(beforeJob, /contents: read\n      issues: read\n      id-token: write/)
  assert.ok(!/actions: write|contents: write|E2B_API_KEY|VERCEL_TEAM_TOKEN/.test(beforeJob))
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'MIKKA_DATABASE_URL']) assert.equal((beforeJob.match(new RegExp('secret-name: ' + key, 'g')) ?? []).length, 1)
  assert.ok(beforeJob.indexOf('node --test') < beforeJob.indexOf('uses: Infisical'))
  assert.match(beforeJob, /recursive: false/g)
})

test('runner context is resolved only inside install and capture steps, never job env', async () => {
  const source = await readFile(new URL('../../.github/workflows/issue1782-domain-history-before.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(source.slice(0, source.indexOf('    steps:')), /\$\{\{\s*runner\./)
  for (const name of ['Install only the bounded PostgreSQL driver outside checkout', 'Capture only authorized historical UUIDs and immutable digests']) {
    const start = source.indexOf('      - name: ' + name)
    assert.ok(start >= 0)
    const next = source.indexOf('\n      - ', start + 1)
    const block = source.slice(start, next < 0 ? source.length : next)
    assert.match(block, /        env:\n          DOMAIN_HISTORY_DEPENDENCIES: \$\{\{ runner.temp \}\}\/domain-history-dependencies/)
  }
})

test('real opaque search pagination retains API-visible Tasks from both creators with server cursors', async () => {
  const paths = [], inventories = []
  const client = { json: async path => {
    paths.push(path); const page = paths.length
    const rows = Array.from({ length: 2 }, (_, index) => ({
      id: id((page - 1) * 2 + index + 1), ownerId: page < 3 ? 'other-owner' : scope.ownerId,
      title: 'private-title', content: 'private-content',
    }))
    return { items: rows, nextCursor: page < 3 ? 'opaque' + page : null, truncated: false }
  } }
  const result = await searchCandidates(client, scope, counts => inventories.push(counts))
  assert.deepEqual(result.candidateTaskIds, [id(1), id(2), id(3), id(4), id(5), id(6)])
  assert.equal(result.counts.pages, 3); assert.equal(result.counts.returned, 6)
  assert.equal(result.counts.ownScopeOmitted, 2); assert.equal(result.counts.hasMore, false)
  for (const [index, path] of paths.entries()) {
    const url = new URL(path, 'https://synthetic.invalid')
    assert.equal(url.pathname, '/api/issues/search'); assert.equal(url.searchParams.get('workspaceId'), scope.workspaceId)
    assert.equal(url.searchParams.get('q'), ''); assert.equal(url.searchParams.get('limit'), '50')
    assert.equal(url.searchParams.get('cursor'), index ? 'opaque' + index : null)
  }
  const evidence = JSON.stringify(inventories)
  for (const text of ['other-owner', scope.ownerId, 'private-title', 'private-content', 'opaque1', id(101)]) assert.ok(!evidence.includes(text))
})

test('search stops at five pages while retaining at most one hundred candidates and declares both bounds', async () => {
  for (const own of [false, true]) {
    let calls = 0
    const result = await searchCandidates({ json: async () => {
      const page = calls++
      return { items: Array.from({ length: 50 }, (_, i) => ({ id: id(page * 50 + i + 1), ownerId: own ? scope.ownerId : 'other', ...(own ? {} : { scope: 'unknown' }) })),
        nextCursor: 'cursor' + calls, truncated: false }
    } }, scope)
    assert.equal(calls, 5)
    assert.equal(result.candidateTaskIds.length, own ? 100 : 0)
    assert.equal(result.counts.hasMore, true)
    assert.equal(result.counts.pageLimitReached, true)
    assert.equal(result.counts.candidateLimitReached, own)
    assert.equal(result.counts.eligibleCount, own ? 250 : 0)
    assert.equal(result.counts.discardedEarlierRows, own ? 150 : 0)
    if (own) assert.deepEqual(result.candidateTaskIds, Array.from({ length: 100 }, (_, i) => id(i + 151)))
  }
})

test('search refuses repeated cursors, duplicate IDs, overlarge pages and malformed cursor responses', async () => {
  for (const scenario of ['cursor', 'duplicate', 'large', 'foreign_cursor', 'truncated']) {
    let calls = 0
    await assert.rejects(searchCandidates({ json: async () => {
      calls++
      return { items: Array.from({ length: scenario === 'large' ? 51 : 1 }, (_, index) => ({
        id: id(scenario === 'duplicate' ? 1 : calls * 100 + index), ownerId: scope.ownerId,
      })), nextCursor: scenario === 'foreign_cursor' ? 'https://foreign.invalid' : 'same', truncated: scenario === 'truncated' }
    } }, scope))
    assert.ok(calls <= 2)
  }
})

test('APP diagnostic counts distinguish missing binding from a valid candidate with no history', async () => {
  for (const binding of [
    { present: 0, bound: 0, published: 0, ended: 0, historical: 0 },
    { present: 2, bound: 1, published: 1, ended: 1, historical: 1 },
    { present: 2, bound: 2, published: 0, ended: 2, historical: 0 },
  ]) {
    const db = database({ bindingOverride: { ...binding, raw: 'must-not-escape' }, selected: [] }), observations = []
    await assert.rejects(snapshot(db, scope, value => observations.push(value)), error => error.code === (binding.bound === 2 ? 'history_missing' : 'database_binding'))
    assert.deepEqual(observations.find(value => value.candidateCounts)?.candidateCounts, binding)
    assert.equal(observations.at(-1).transactionRolledBack, true)
    assert.ok(!JSON.stringify(observations).includes('must-not-escape'))
    assert.ok(observations.some(value => value.readOnly === true && value.isolation === 'repeatable read'))
  }
})

test('rollback evidence follows the actual ACK on success or failure, never a failed rollback', async () => {
  for (const failRollback of [false, true]) {
    const db = database({ failRun: true }), original = db.query, observations = []
    db.query = async (...args) => { if (args[0] === 'ROLLBACK' && failRollback) throw Error('rollback-failed'); return original(...args) }
    await assert.rejects(snapshot(db, scope, value => observations.push(value)))
    assert.equal(observations.some(value => value.transactionRolledBack === true), !failRollback)
  }
})

test('exact older Task revalidation never depends on the newest list or includes another tenant', async () => {
  const seen = [], client = {
    json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : sharedView(),
    rpc: async (action, [value], options) => { seen.push({ action, value });
      assert.deepEqual(options, { headers: { 'x-mikka-workspace-id': scope.workspaceId } }); return { issue: {
      id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal', content: 'never-recorded',
    } } },
  }
  await verifyScope(client, { ...scope, taskIds: [id(501)], taskOwners: owners([id(501)]) })
  assert.deepEqual(seen, [{ action: 'issues.getIssue', value: id(501) }])
  client.rpc = async (_action, [value]) => ({ issue: { id: value, userId: scope.ownerId, workspaceId: id(999), ownershipState: 'bound', scope: 'personal' } })
  await assert.rejects(verifyScope(client, { ...scope, taskIds: [id(501)], taskOwners: owners([id(501)]) }))
})

test('the existing session transport reads fixed Tasks in an authorized request Workspace without changing the selected cookie', async () => {
  const selectedWorkspace = id(999), paths = []
  const client = createSessionClient('https://synthetic.invalid', async (url, init) => {
    paths.push(url.pathname)
    if (url.pathname.endsWith('/api/auth/get-session')) return new Response(JSON.stringify({ user: { id: scope.ownerId } }), {
      headers: { 'set-cookie': 'mikka-workspace=' + selectedWorkspace + '; Path=/mikka' },
    })
    assert.equal(init.headers.cookie, 'mikka-workspace=' + selectedWorkspace)
    if (url.pathname.endsWith('/api/workspace')) {
      assert.equal(url.searchParams.get('workspace'), scope.workspaceId)
      return new Response(JSON.stringify(sharedView()))
    }
    assert.equal(url.pathname, '/mikka/api/rpc')
    const body = JSON.parse(init.body)
    assert.equal(body.action, 'issues.getIssue')
    // The account's saved choice is deliberately different. The existing API
    // requires the membership-checked transport preference for this target.
    if (init.headers['x-mikka-workspace-id'] !== scope.workspaceId) return new Response('{}', { status: 403 })
    return new Response(JSON.stringify({ ok: true, result: { issue: { id: body.args[0], userId: body.args[0] === id(502) ? 'another-owner' : scope.ownerId,
      workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } } }))
  })
  await verifyScope(client, scope)
  assert.deepEqual(paths, ['/mikka/api/auth/get-session', '/mikka/api/workspace', '/mikka/api/rpc', '/mikka/api/rpc', '/mikka/api/workspace'])
})

test('normal session transport authorizes other creators in the policy Shared Workspace without switching the saved Personal cookie', async () => {
  const savedId = id(999), email = 'synthetic@example.invalid', calls = []
  const client = createSessionClient('https://synthetic.invalid', async (url, init) => {
    calls.push({ path: url.pathname, search: url.search, body: init.body })
    if (url.pathname.endsWith('/api/auth/get-session')) return new Response(JSON.stringify({ user: { id: scope.ownerId, email } }), {
      headers: { 'set-cookie': 'mikka-workspace=' + savedId + '; Path=/mikka' },
    })
    assert.equal(init.headers.cookie, 'mikka-workspace=' + savedId)
    if (url.pathname.endsWith('/api/workspace')) {
      const value = sharedView(); value.choices.push({ id: savedId, kind: 'personal' })
      if (url.searchParams.has('workspace')) assert.equal(url.searchParams.get('workspace'), scope.workspaceId)
      else value.workspace = { id: savedId, kind: 'personal' }
      return new Response(JSON.stringify(value))
    }
    if (url.pathname.endsWith('/api/issues/search')) {
      assert.equal(url.searchParams.get('workspaceId'), scope.workspaceId)
      return new Response(JSON.stringify({ items: [{ id: id(501), ownerId: scope.ownerId }, { id: id(502), ownerId: 'another-owner' }],
        nextCursor: null, truncated: false }))
    }
    assert.equal(url.pathname, '/mikka/api/rpc')
    const body = JSON.parse(init.body)
    assert.equal(body.action, 'issues.getIssue')
    assert.equal(init.headers['x-mikka-workspace-id'], scope.workspaceId)
    return new Response(JSON.stringify({ ok: true, result: { issue: { id: body.args[0], userId: body.args[0] === id(502) ? 'another-owner' : scope.ownerId,
      workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } } }))
  })
  const selected = await selectScope(client, email)
  assert.equal(selected.workspaceId, scope.workspaceId)
  assert.equal(selected.workspaceKind, 'team')
  assert.deepEqual(selected.candidateTaskIds, [id(501), id(502)])
  assert.equal(selected.taskOwners[id(502)], 'another-owner')
  await verifyScope(client, { ...selected, taskIds: selected.candidateTaskIds })
  assert.equal(calls.filter(row => row.path.endsWith('/api/issues/search')).length, 1)
  assert.deepEqual(calls.filter(row => row.body).map(row => JSON.parse(row.body).action), ['issues.getIssue', 'issues.getIssue', 'issues.getIssue', 'issues.getIssue'])
})

for (const [name, change] of [
  ['missing Shared choice', value => { value.choices = [] }],
  ['duplicate Shared choices', value => { value.choices.push({ id: scope.workspaceId, kind: 'team' }) }],
  ['another session owner', value => { value.currentUserId = 'other' }],
  ['another explicit Workspace', value => { value.workspace.id = id(998) }],
  ['a Personal returned for the Shared target', value => { value.workspace.kind = 'personal' }],
  ['no own membership', value => { value.members = [{ userId: 'other', role: 'admin', status: 'active' }] }],
  ['suspended own membership', value => { value.members[0].status = 'suspended' }],
  ['duplicate own membership', value => { value.members.push({ ...value.members[0] }) }],
  ['membership role mismatch', value => { value.members[0].role = 'member' }],
]) test('Shared selection rejects ' + name + ' before searching Task IDs', async () => {
  const email = 'synthetic@example.invalid'
  const client = { json: async path => {
    if (path.includes('get-session')) return { user: { id: scope.ownerId, email } }
    assert.ok(path.startsWith('/api/workspace'), 'refused scope never reaches Task search')
    const value = sharedView()
    if (path.includes('?workspace=') || name.startsWith('missing') || name.startsWith('duplicate Shared')) change(value)
    return value
  } }
  await assert.rejects(selectScope(client, email))
})

test('a revoked Shared membership fails fixed-UUID revalidation before any Task read', async () => {
  const client = { json: async path => {
    if (path.includes('get-session')) return { user: { id: scope.ownerId } }
    const value = sharedView(); value.members[0].status = 'suspended'; return value
  }, rpc: async () => { assert.fail('revoked membership cannot read a Task') } }
  await assert.rejects(verifyScope(client, scope))
})

test('a separately authorized creator is accepted only under its frozen per-Task identity and emits its hash', () => {
  const rows = fixture(), taskOwners = { ...scope.taskOwners, [id(2)]: 'authorized-other-creator' }
  rows.task[1].owner = taskOwners[id(2)]
  const projected = projectRows({ ...scope, taskOwners }, rows)
  assert.equal(projected.task[1].creatorSha256, createHash('sha256').update(taskOwners[id(2)]).digest('hex'))
  assert.notEqual(projected.task[0].creatorSha256, projected.task[1].creatorSha256)
  assert.ok(!JSON.stringify(projected).includes(taskOwners[id(2)]))
  rows.task[1].owner = 'changed-after-api'
  assert.throws(() => projectRows({ ...scope, taskOwners }, rows), error => error.code === 'database_binding')
})

test('the fixed Task collection may carry published and ended history on different authorized Tasks', () => {
  const rows = fixture()
  rows.publication = rows.publication.slice(0, 1)
  rows.run = rows.run.slice(1)
  const result = projectRows(scope, rows)
  assert.deepEqual(result.task.map(row => row.id), scope.taskIds)
  assert.deepEqual(result.publication.map(row => row.issueId), [id(1)])
  assert.deepEqual(result.run.map(row => row.issueId), [id(2)])
})

test('collection coverage still rejects zero publication, zero ended Run and padding Tasks with neither', () => {
  for (const kind of ['publication', 'run']) {
    const rows = fixture(); rows[kind] = []
    assert.throws(() => projectRows(scope, rows), error => error.code === 'history_missing')
  }
  const rows = fixture(); rows.publication.pop(); rows.run.pop()
  assert.throws(() => projectRows(scope, rows), error => error.code === 'history_missing')
})

test('a missing creator mapping fails before opening APP rather than substituting the reader', async () => {
  const db = database()
  await assert.rejects(snapshot(db, { ...scope, taskOwners: { [id(1)]: scope.ownerId } }), error => error.code === 'sample_invalid')
  assert.equal(db.calls.length, 0)
})

const authorizedClient = (readIssue, observe = () => {}) => ({
  json: async path => {
    observe(path)
    if (path.includes('get-session')) return { user: { id: scope.ownerId, email: 'synthetic@example.invalid' } }
    if (path.startsWith('/api/workspace')) return sharedView()
    assert.ok(path.startsWith('/api/issues/search?'))
    return { items: [{ id: id(1), ownerId: 'authorized-other-creator' }], nextCursor: null, truncated: false }
  },
  rpc: async (action, [value], options) => {
    assert.equal(action, 'issues.getIssue'); assert.equal(value, id(1))
    assert.deepEqual(options, { headers: { 'x-mikka-workspace-id': scope.workspaceId } })
    return readIssue({ id: value, userId: 'authorized-other-creator', workspaceId: scope.workspaceId,
      ownershipState: 'bound', scope: 'personal' })
  },
})

test('ordinary per-Task detail authorization precedes any database work for a different creator', async () => {
  let detailReads = 0, databaseStarted = false
  const client = authorizedClient(issue => { assert.equal(databaseStarted, false); detailReads++; return { issue } })
  const selected = await selectScope(client, 'synthetic@example.invalid')
  databaseStarted = true
  assert.equal(detailReads, 1); assert.equal(selected.taskOwners[id(1)], 'authorized-other-creator')
  assert.equal(selected.ownerId, scope.ownerId); assert.equal(selected.workspaceKind, 'team')
})

for (const [name, response] of [
  ['API refusal', () => { throw Object.assign(Error('private-api-message'), { code: 'forbidden' }) }],
  ['unknown response', () => ({})],
  ['creator changed after search', issue => ({ issue: { ...issue, userId: 'another-creator' } })],
  ['different tenant', issue => ({ issue: { ...issue, workspaceId: id(999) } })],
  ['pending Task', issue => ({ issue: { ...issue, ownershipState: 'pending' } })],
  ['unknown label', issue => ({ issue: { ...issue, scope: 'private' } })],
]) test(name + ' refuses the candidate before any database work', async () => {
  let databaseStarted = false
  await assert.rejects((async () => {
    await selectScope(authorizedClient(response), 'synthetic@example.invalid')
    databaseStarted = true
  })())
  assert.equal(databaseStarted, false)
})

test('membership is rechecked after candidate detail reads before any APP work', async () => {
  const client = authorizedClient(issue => ({ issue })), original = client.json
  let explicitReads = 0
  client.json = async path => {
    const value = await original(path)
    if (path.includes('/api/workspace?') && ++explicitReads === 3) value.members[0].status = 'suspended'
    return value
  }
  await assert.rejects(selectScope(client, 'synthetic@example.invalid'), error => error.code === 'sample_changed')
  assert.equal(explicitReads, 3)
})

test('at most four detail reads start and outstanding reads settle after a refusal without retry', async () => {
  const taskIds = Array.from({ length: 12 }, (_, i) => id(i + 1)), started = [], blocked = []
  const fourStarted = Promise.withResolvers()
  let active = 0, maxActive = 0, settled = false
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : sharedView(),
    rpc: async (_action, [value]) => {
      started.push(value); active++; maxActive = Math.max(maxActive, active)
      if (started.length === 4) fourStarted.resolve()
      try {
        if (value === id(1)) throw Error('refused')
        const pending = Promise.withResolvers(); blocked.push(pending)
        await pending.promise
        return { issue: { id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'workspace' } }
      } finally { active-- }
    } }
  const verification = verifyScope(client, { ...scope, taskIds, taskOwners: owners(taskIds) }).finally(() => { settled = true })
  await fourStarted.promise
  assert.equal(settled, false); assert.equal(started.length, 4)
  for (const pending of blocked) pending.resolve()
  await assert.rejects(verification)
  assert.equal(active, 0); assert.ok(maxActive <= 4); assert.equal(started.length, 4)
  assert.equal(new Set(started).size, started.length)
})

test('the PG fixture gate refuses missing, remote, wrong database and inherited production targets before loading a driver', () => {
  const filename = fileURLToPath(new URL('./domain-history-before-1782.db.test.mjs', import.meta.url))
  for (const change of [{},
    { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@remote.invalid:5432/mikka_domain_history_1782_fixture' },
    { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/production' },
    { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_history_1782_fixture', MIKKA_DATABASE_URL: 'synthetic-production-target' },
    { DOMAIN_HISTORY_TEST_DATABASE_URL: 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_history_1782_fixture', DATABASE_URL: 'synthetic-production-target' },
  ]) {
    const result = spawnSync(process.execPath, ['--test', filename], { encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, DOMAIN_HISTORY_DEPENDENCIES: '/must-not-load-driver', ...change } })
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /fixture_target_refused/)
    assert.doesNotMatch(result.stdout + result.stderr, /MODULE_NOT_FOUND|synthetic-production-target/)
  }
})

test('PG17 SQL regression is a required pre-credential step with a dedicated loopback service', async () => {
  const source = await readFile(new URL('../../.github/workflows/issue1782-domain-history-before.yml', import.meta.url), 'utf8')
  const step = source.indexOf('      - name: Verify paired creator and verified-history SQL on isolated PG17 before credentials')
  assert.ok(step > source.indexOf('npm install --prefix'))
  assert.ok(step < source.indexOf('uses: Infisical/secrets-action'))
  assert.match(source, /image: postgres:17\n/)
  assert.match(source, /127\.0\.0\.1:5432:5432/)
  assert.match(source, /run: node --test scripts\/ops\/domain-history-before-1782.db.test.mjs/)
  assert.doesNotMatch(source, /continue-on-error/)
  const databaseTest = await readFile(new URL('./domain-history-before-1782.db.test.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(databaseTest, /\.skip\(|\bskip\s*:/)
})

test('before refuses exact canonical or old-alias Epic identities and reports their distinct closed counts', async () => {
  assert.equal(EPIC_MIGRATIONS.canonical.length, 9); assert.equal(EPIC_MIGRATIONS.legacy.length, 9)
  assert.equal(new Set([...EPIC_MIGRATIONS.canonical, ...EPIC_MIGRATIONS.legacy]).size, 18)
  for (const [index, name] of EPIC_MIGRATIONS.canonical.entries()) {
    assert.equal(name.replace('202611091430', '202611081203'), EPIC_MIGRATIONS.legacy[index])
    assert.ok(SQL.ledger.includes("'" + name + "'")); assert.ok(SQL.ledger.includes("'" + EPIC_MIGRATIONS.legacy[index] + "'"))
  }
  assert.doesNotMatch(SQL.ledger, /\bLIKE\b|202611081202|202611090350|202611091431|202611082304/)
  for (const counts of [{ epic: 0, legacy: 1 }, { epic: 1, legacy: 0 }]) {
    const db = database(counts), observed = []
    await assert.rejects(snapshot(db, scope, value => observed.push(value)), error => error.code === 'migration_already_applied')
    assert.deepEqual(observed.find(value => value.lastReadStage === 'ledger_refused'), { lastReadStage: 'ledger_refused',
      ledgerDigest: 'c'.repeat(32), canonicalEpicMigrations: counts.epic, legacyEpicMigrations: counts.legacy })
    assert.equal(observed.at(-1).transactionRolledBack, true)
    assert.equal(db.calls.some(value => value.sql === SQL.binding), false)
  }
})

test('the finite search tail reaches the 27 previously unread rows and retains exactly the last 100 in server order', async () => {
  const rows = Array.from({ length: 127 }, (_, index) => ({ id: id(2000 - index),
    ownerId: index % 3 === 0 ? scope.ownerId : 'authorized-other', title: 'never-record-this-title' }))
  let calls = 0
  const result = await searchCandidates({ json: async path => {
    const cursor = new URL(path, 'https://synthetic.invalid').searchParams.get('cursor')
    assert.equal(cursor, calls ? 'opaque' + calls : null)
    const start = calls++ * 50
    return { items: rows.slice(start, start + 50), nextCursor: calls < 3 ? 'opaque' + calls : null, truncated: false }
  } }, scope)
  const expected = rows.slice(-100)
  assert.equal(calls, 3); assert.equal(result.counts.returned, 127); assert.equal(result.counts.eligibleCount, 127)
  assert.equal(result.counts.candidateCount, 100); assert.equal(result.counts.discardedEarlierRows, 27)
  assert.equal(result.counts.discardedLaterRows, 0)
  assert.equal(result.counts.hasMore, false); assert.equal(result.counts.pageLimitReached, false)
  assert.equal(result.counts.candidateLimitReached, true)
  assert.equal(result.counts.retainedOwn, expected.filter(row => row.ownerId === scope.ownerId).length)
  assert.equal(result.counts.selection, 'last_100_of_bounded_api_search')
  assert.deepEqual(result.candidateTaskIds, expected.map(row => row.id).sort())
  assert.deepEqual(result.taskOwners, Object.fromEntries(expected.map(row => [row.id, row.ownerId])))
  assert.equal(Object.keys(result.taskOwners).length, 100)
  const summary = JSON.stringify(result.counts)
  for (const raw of ['never-record-this-title', 'authorized-other', scope.ownerId, id(1874)]) assert.ok(!summary.includes(raw))
})

test('a replayed opaque cursor is refused at the candidate limit and at the fifth-page boundary', async () => {
  for (const replayAt of [2, 5]) {
    let calls = 0
    await assert.rejects(searchCandidates({ json: async () => {
      const page = ++calls
      return { items: Array.from({ length: 50 }, (_, i) => ({ id: id((page - 1) * 50 + i + 1), ownerId: scope.ownerId })),
        nextCursor: page === replayAt ? 'cursor1' : 'cursor' + page, truncated: false }
    } }, scope), error => error.code === 'response_invalid')
    assert.equal(calls, replayAt)
  }
})

test('production first100 reads the complete 127-row API window and authorizes the previously unclassified first27', async () => {
  const email = 'synthetic@example.invalid', inventories = [], details = []
  const rows = Array.from({ length: 127 }, (_, index) => ({ id: id(2000 - index),
    ownerId: index < 18 ? scope.ownerId : 'authorized-other', title: 'never-record-this-title' }))
  const byId = new Map(rows.map(row => [row.id, row])); let pages = 0
  const client = {
    json: async path => {
      if (path === '/api/auth/get-session') return { user: { id: scope.ownerId, email } }
      if (path === '/api/workspace' || path === '/api/workspace?workspace=' + scope.workspaceId) return sharedView()
      const url = new URL(path, 'https://synthetic.invalid')
      assert.equal(url.pathname, '/api/issues/search'); assert.equal(url.searchParams.get('workspaceId'), scope.workspaceId)
      assert.equal(url.searchParams.get('cursor'), pages ? 'opaque' + pages : null)
      const start = pages++ * 50
      return { items: rows.slice(start, start + 50), nextCursor: pages < 3 ? 'opaque' + pages : null, truncated: false }
    },
    rpc: async (action, [taskId], options) => {
      assert.equal(action, 'issues.getIssue'); assert.deepEqual(options, { headers: { 'x-mikka-workspace-id': scope.workspaceId } })
      details.push(taskId); const row = byId.get(taskId)
      return { issue: { id: taskId, userId: row.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } }
    },
  }
  const selected = await selectScope(client, email, counts => inventories.push(counts)), expected = rows.slice(0, 100)
  assert.deepEqual(selected.candidateTaskIds, expected.map(row => row.id).sort())
  assert.deepEqual(details.sort(), selected.candidateTaskIds)
  assert.ok(rows.slice(0, 27).every(row => selected.candidateTaskIds.includes(row.id)))
  assert.deepEqual(selected.taskOwners, Object.fromEntries(expected.map(row => [row.id, row.ownerId])))
  const counts = inventories.at(-1)
  assert.equal(pages, 3); assert.equal(counts.returned, 127); assert.equal(counts.eligibleCount, 127)
  assert.equal(counts.candidateCount, 100); assert.equal(counts.discardedEarlierRows, 0); assert.equal(counts.discardedLaterRows, 27)
  assert.equal(counts.retainedOwn, 18); assert.equal(counts.hasMore, false); assert.equal(counts.pageLimitReached, false)
  assert.equal(counts.candidateLimitReached, true); assert.equal(counts.selection, 'first_100_of_bounded_api_search')
  for (const raw of ['never-record-this-title', 'authorized-other', scope.ownerId, id(2000)]) assert.ok(!JSON.stringify(inventories).includes(raw))
})

test('source-only first selection keeps both finite bounds and refuses replay after reaching one hundred', async () => {
  let calls = 0
  await assert.rejects(searchCandidates({ json: async () => { calls++ } }, scope, () => {}, 'all'), error => error.code === 'sample_invalid')
  assert.equal(calls, 0)
  const result = await searchCandidates({ json: async () => {
    const start = calls++ * 50
    return { items: Array.from({ length: 50 }, (_, index) => ({ id: id(start + index + 1), ownerId: scope.ownerId })),
      nextCursor: 'cursor' + calls, truncated: false }
  } }, scope, () => {}, 'first')
  assert.equal(calls, 5); assert.deepEqual(result.candidateTaskIds, Array.from({ length: 100 }, (_, index) => id(index + 1)))
  assert.equal(result.counts.eligibleCount, 250); assert.equal(result.counts.pageLimitReached, true)
  assert.equal(result.counts.discardedEarlierRows, 0); assert.equal(result.counts.discardedLaterRows, 150)
  assert.equal(result.counts.candidateLimitReached, true)
  for (const replayAt of [2, 5]) {
    let page = 0
    await assert.rejects(searchCandidates({ json: async () => {
      page++
      return { items: Array.from({ length: 50 }, (_, index) => ({ id: id((page - 1) * 50 + index + 1), ownerId: scope.ownerId })),
        nextCursor: page === replayAt ? 'cursor1' : 'cursor' + page, truncated: false }
    } }, scope, () => {}, 'first'), error => error.code === 'response_invalid')
    assert.equal(page, replayAt)
  }
})

test('publication diagnostics preserve only closed counts over the same authorized pairs', async () => {
  const counts = { receipts: 7, published: 6, runMissing: 1, issueMismatch: 1, executorMismatch: 1,
    workspaceNull: 0, workspaceDifferent: 1, verified: 2 }
  const db = database({ publicationOverride: { ...counts, secret: 'never-emit-private-value' } }), observed = []
  await snapshot(db, scope, value => observed.push(value))
  const row = observed.find(value => value.publicationCounts)
  assert.deepEqual(row, { publicationCounts: counts, publicationClassification: 'published_receipts_first_failed_guard' })
  assert.ok(!JSON.stringify(observed).includes('never-emit-private-value'))
  assert.deepEqual(db.calls.find(row => row.sql === SQL.publicationEvidence).args,
    [scope.candidateTaskIds, scope.candidateTaskIds.map(value => scope.taskOwners[value]), scope.workspaceId])
})

test('inconsistent or negative publication diagnostic counts fail before snapshots and still roll back', async () => {
  const counts = { receipts: 2, published: 2, runMissing: 0, issueMismatch: 0, executorMismatch: 0,
    workspaceNull: 0, workspaceDifferent: 0, verified: 2 }
  for (const change of [{ runMissing: -1 }, { runMissing: 1 }, { receipts: 1 }, { verified: 1, runMissing: 1 }]) {
    const db = database({ publicationOverride: { ...counts, ...change } }), observed = []
    await assert.rejects(snapshot(db, scope, value => observed.push(value)), error => error.code === 'database_binding')
    assert.equal(db.calls.some(row => row.sql === SQL.select), false)
    assert.equal(observed.at(-1).transactionRolledBack, true)
  }
})

function threadRow(n, issueId = id(n)) {
  return { id: id(8000 + n), issueId, createdAt: new Date(Date.now() - 60000).toISOString(),
    prompt: 'never-output-own-prompt', lastReply: 'never-output-own-reply' }
}
function historyTransport(response, threads = [threadRow(1), threadRow(2)]) {
  const actions = [], requests = [], email = 'synthetic@example.invalid'
  const client = createSessionClient('https://synthetic.invalid', async (url, init) => {
    requests.push({ path: url.pathname, headers: init.headers })
    if (url.pathname.endsWith('/api/auth/get-session')) return Response.json({ user: { id: scope.ownerId, email } },
      { headers: { 'set-cookie': 'mikka-workspace=' + id(999) + '; Path=/; HttpOnly' } })
    if (url.pathname.endsWith('/api/workspace')) return Response.json(sharedView())
    assert.equal(url.pathname, '/mikka/api/rpc')
    assert.equal(init.headers['x-mikka-workspace-id'], scope.workspaceId)
    assert.equal(init.headers['x-mikka-rpc'], '1')
    assert.ok(!init.headers.cookie || init.headers.cookie === 'mikka-workspace=' + id(999))
    const { action, args } = JSON.parse(init.body)
    actions.push({ action, args })
    if (action === 'task-runs.pollThreads') { assert.deepEqual(args, []); return Response.json({ ok: true, result: { items: threads } }) }
    assert.ok(['issues.getIssue', 'issue-operations.getDeletedIssue'].includes(action))
    const value = response(action, args[0])
    return value instanceof Response ? value : Response.json({ ok: true, result: value })
  })
  return { client, actions, requests, email }
}
const liveIssue = (value, owner = scope.ownerId) => ({ issue: { id: value, userId: owner,
  workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } })

test('fixed own-thread discovery authorizes live shared and owner-deleted Tasks through real transport without using titles or switching Workspace', async () => {
  const deletedAt = new Date(Date.now() - 120000).toISOString(), inventories = []
  const transport = historyTransport((action, value) => action === 'issues.getIssue'
    ? value === id(1) ? { error: 'issueNotFound', params: { $mikka: 'undefined' } } : liveIssue(value, 'other-authorized-creator')
    : { id: value, title: 'never-output-deleted-title', deletedAt }, [threadRow(1), threadRow(2), threadRow(3, id(1)), threadRow(4, null)])
  const selected = await beforeDriver.selectThreadScope(transport.client, transport.email, counts => inventories.push(counts))
  assert.deepEqual(selected.candidateTaskIds, [id(1), id(2)])
  assert.equal(selected.taskOwners[id(1)], scope.ownerId)
  assert.equal(selected.taskOwners[id(2)], 'other-authorized-creator')
  assert.deepEqual(selected.taskAccess, { [id(1)]: { mode: 'owned_deleted', deletedAt }, [id(2)]: { mode: 'live', deletedAt: null } })
  assert.deepEqual(inventories.at(-1), { selection: 'first_100_unique_task_refs_of_own_recent_threads', returnedRuns: 4,
    runLimitReached: false, maxRuns: 200, recentDays: 30, runsWithoutTask: 1, referencedTasks: 2,
    candidateCount: 2, discardedLaterTaskRefs: 0, maxCandidates: 100, authorizedLive: 1, authorizedOwnedDeleted: 1 })
  const rows = fixture(); rows.task[1].owner = 'other-authorized-creator'
  const projection = projectRows({ ...selected, taskIds: selected.candidateTaskIds }, rows)
  assert.equal(projection.task[0].accessMode, 'owned_deleted')
  assert.equal(projection.task[0].deletedAtSha256, createHash('sha256').update(deletedAt).digest('hex'))
  assert.equal(projection.task[1].accessMode, 'live'); assert.equal(projection.task[1].deletedAtSha256, null)
  for (const raw of ['never-output-', scope.ownerId, 'other-authorized-creator', deletedAt]) {
    assert.ok(!JSON.stringify({ inventories, projection }).includes(raw))
  }
  assert.equal(transport.actions.filter(row => row.action === 'task-runs.pollThreads').length, 1)
  assert.equal(transport.actions.filter(row => row.action === 'issue-operations.getDeletedIssue').length, 1)
  assert.ok(!transport.requests.some(row => /search|switch|restore/.test(row.path)))
})

for (const [name, response] of [
  ['auth error', () => ({ error: 'authRequired' })],
  ['workspace error', () => ({ error: 'workspaceAccessDenied' })],
  ['unknown action error', () => ({ error: 'issueNotFoundElsewhere' })],
  ['ambiguous issue and not-found error', () => ({ error: 'issueNotFound', issue: null })],
  ['empty result', () => null],
  ['HTTP 404', () => Response.json({ error: 'issueNotFound' }, { status: 404 })],
  ['RPC envelope refusal', () => Response.json({ ok: false, result: { error: 'issueNotFound' } })],
  ['live wrong tenant', (_action, value) => ({ issue: { ...liveIssue(value).issue, workspaceId: id(999) } })],
  ['live pending', (_action, value) => ({ issue: { ...liveIssue(value).issue, ownershipState: 'pending' } })],
  ['live unknown label', (_action, value) => ({ issue: { ...liveIssue(value).issue, scope: 'unknown' } })],
]) test('own-thread discovery refuses ' + name + ' without a deleted-detail fallback or database authority', async () => {
  const transport = historyTransport(response, [threadRow(1)])
  await assert.rejects(beforeDriver.selectThreadScope(transport.client, transport.email))
  assert.equal(transport.actions.filter(row => row.action === 'issue-operations.getDeletedIssue').length, 0)
})

for (const [name, deleted] of [
  ['null (missing, foreign owner or permission denied)', null],
  ['wrong Task', { id: id(9), deletedAt: '2026-11-01T12:00:00.000Z' }],
  ['missing deletion marker', { id: id(1), deletedAt: null }],
  ['invalid deletion marker', { id: id(1), deletedAt: 'not-a-date' }],
  ['action refusal', { id: id(1), deletedAt: '2026-11-01T12:00:00.000Z', error: 'workspaceAccessDenied' }],
]) test('exact not-found plus deleted-detail ' + name + ' cannot authorize a historical Task', async () => {
  const transport = historyTransport(action => action === 'issues.getIssue' ? { error: 'issueNotFound' } : deleted, [threadRow(1)])
  await assert.rejects(beforeDriver.selectThreadScope(transport.client, transport.email), error => error.code === 'sample_changed')
  assert.equal(transport.actions.filter(row => row.action === 'issue-operations.getDeletedIssue').length, 1)
})

test('generic client action_refused or transport failure never supplies an action code or triggers a deleted read', async () => {
  for (const error of [Error('startup_action_refused'), Error('issueNotFound'), Object.assign(Error('private transport'), { status: 404 })]) {
    let reads = 0
    await assert.rejects(beforeDriver.readHistoryTaskAccess({ json: async () => { reads++; throw error } }, scope, id(1)))
    assert.equal(reads, 1)
  }
})

test('a restored owner-deleted Task reauthorizes through normal live detail without mutating the before access proof', async () => {
  const deletedAt = '2026-11-01T12:00:00.000Z'
  const taskAccess = { [id(1)]: { mode: 'owned_deleted', deletedAt }, [id(2)]: { mode: 'live', deletedAt: null } }
  const transport = historyTransport((_action, value) => liveIssue(value))
  assert.deepEqual(await verifyScope(transport.client, { ...scope, taskAccess }), { live: 2, ownedDeleted: 0 })
  assert.deepEqual(taskAccess[id(1)], { mode: 'owned_deleted', deletedAt })
  assert.equal(transport.actions.filter(row => row.action === 'issue-operations.getDeletedIssue').length, 0)
  const changed = historyTransport((_action, value) => liveIssue(value, 'new-creator'))
  await assert.rejects(verifyScope(changed.client, { ...scope, taskAccess }), error => error.code === 'sample_changed')
})

test('past deletion mode cannot authorize a currently refused Task or relabel another frozen creator as the reader', async () => {
  const deletedAt = '2026-11-01T12:00:00.000Z'
  const taskAccess = { [id(1)]: { mode: 'owned_deleted', deletedAt }, [id(2)]: { mode: 'live', deletedAt: null } }
  const transport = historyTransport(action => action === 'issues.getIssue' ? { error: 'issueNotFound' } : null)
  await assert.rejects(verifyScope(transport.client, { ...scope, taskAccess }), error => error.code === 'sample_changed')
  const positive = historyTransport(action => action === 'issues.getIssue' ? { error: 'issueNotFound' } : { id: id(1), deletedAt })
  await assert.rejects(beforeDriver.readHistoryTaskAccess(positive.client, scope, id(1), 'previous-other-creator'), error => error.code === 'sample_changed')
})

test('thread discovery keeps the real two-hundred Run and one-hundred unique Task bounds without an invented cursor', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => threadRow(i + 1, id(i % 150 + 1)))
  let calls = 0
  const result = await beforeDriver.threadCandidates({ rpc: async (action, args, extra) => {
    calls++; assert.equal(action, 'task-runs.pollThreads'); assert.deepEqual(args, [])
    assert.equal(extra.headers['x-mikka-workspace-id'], scope.workspaceId)
    return { items: rows }
  } }, scope)
  assert.equal(calls, 1); assert.equal(result.candidateTaskIds.length, 100)
  assert.equal(result.counts.referencedTasks, 150); assert.equal(result.counts.discardedLaterTaskRefs, 50)
  assert.equal(result.counts.runLimitReached, true)
  assert.deepEqual(result.candidateTaskIds, Array.from({ length: 100 }, (_, n) => id(n + 1)).sort())
})

for (const [name, value] of [
  ['201 runs', () => ({ items: Array.from({ length: 201 }, (_, n) => threadRow(n + 1)) })],
  ['duplicate Run UUID', () => ({ items: [threadRow(1), threadRow(1)] })],
  ['invalid Task UUID', () => ({ items: [threadRow(1, 'not-a-task-uuid')] })],
  ['outside 30-day window', () => ({ items: [{ ...threadRow(1), createdAt: new Date(Date.now() - 31 * 86400000).toISOString() }] })],
  ['missing createdAt', () => ({ items: [{ ...threadRow(1), createdAt: undefined }] })],
  ['delta without the complete window', () => ({ items: [threadRow(1)], delta: true })],
]) test('thread discovery refuses ' + name + ' before Task detail or APP work', async () => {
  await assert.rejects(beforeDriver.threadCandidates({ rpc: async () => value() }, scope), error => error.code === 'response_invalid')
})

test('the database must independently match every current normal-API deletion proof inside the read-only transaction', async () => {
  const taskAccess = { [id(1)]: { mode: 'owned_deleted', deletedAt: '2026-11-01T12:00:00.000Z' }, [id(2)]: { mode: 'live', deletedAt: null } }
  const db = database(), observed = []
  const result = await snapshot(db, { ...scope, taskAccess }, value => observed.push(value))
  assert.deepEqual(db.calls.find(row => row.sql === SQL.taskAccess).args,
    [scope.taskIds, [scope.ownerId, scope.ownerId], scope.workspaceId, ['owned_deleted', 'live'], [taskAccess[id(1)].deletedAt, null], scope.ownerId])
  assert.equal(observed.find(row => row.normalApiAccessRechecked).authorizedOwnedDeleted, 1)
  assert.equal(result.rows.task[0].accessMode, 'owned_deleted')
  const refused = database({ accessOverride: { present: 2, authorized: 1 } })
  await assert.rejects(snapshot(refused, { ...scope, taskAccess }), error => error.code === 'database_binding')
  assert.equal(refused.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!refused.calls.some(row => row.sql === SQL.select))
  const mismatched = { ...scope, taskOwners: { ...scope.taskOwners, [id(1)]: 'another-creator' }, taskAccess }
  const untouched = database()
  await assert.rejects(snapshot(untouched, mismatched), error => error.code === 'sample_invalid')
  assert.equal(untouched.calls.length, 0)
})

test('production capture chooses only the compiled own-thread entry and retains original bounded live search contracts', async () => {
  const text = await readFile(new URL('./domain-history-before-1782.mjs', import.meta.url), 'utf8')
  assert.match(text, /const scope = await selectThreadScope\(client, email, counts/)
  assert.ok(!/process\.env\.(?:HISTORY_MODE|HISTORY_WORKSPACE|HISTORY_TASK_IDS)/.test(text))
  assert.equal(typeof beforeDriver.selectScope, 'function'); assert.equal(typeof beforeDriver.searchCandidates, 'function')
})


test('an expired before account window refuses even while main and served sources still match', async () => {
  const { window } = windowFixture()
  const fetchImpl = async url => Response.json(url.includes('api.github.com')
    ? { ref: 'refs/heads/main', object: { sha: MAIN, type: 'commit' } } : { build: MAIN })
  await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, fetchImpl, window, () => Date.parse(window.expiresAt)),
    error => error.code === 'window_expired')
})


test('before account grant is closed by default and only a real bounded recorded window can be activated', () => {
  const { window, record } = windowFixture()
  const values = Object.values(beforeDriver.WINDOW)
  if (values.some(value => value === null)) {
    assert.throws(() => beforeDriver.checkWindow(), error => error.code === 'window_unbound')
    assert.ok(values.every(value => value === null), 'a partially activated grant must fail the required test gate')
  } else assert.deepEqual(beforeDriver.checkWindow(), beforeDriver.WINDOW)
  assert.throws(() => beforeDriver.checkWindow({ ...window, workspaceId: null }), error => error.code === 'window_unbound')
  assert.throws(() => beforeDriver.checkWindow({ ...window, commentId: null }), error => error.code === 'window_unbound')
  assert.deepEqual(beforeDriver.windowRecord(window), record)
  for (const change of [{ workspaceId: 'wrong' }, { readerSha256: 'raw-owner' }, { opsParentSha: 'main' },
    { commentId: 0 }, { commentBodySha256: 'wrong' }, { expiresAt: window.startsAt },
    { startsAt: '2026-11-09T18:59:00Z' }, { expiresAt: '2026-11-09T20:00:00.000Z' }, { extra: true }])
    assert.throws(() => beforeDriver.checkWindow({ ...window, ...change }), error => error.code === 'window_unbound')
})

test('only one ordinary child of the exact Ops parent may use the window, so the next private repin cannot capture', () => {
  const { window } = windowFixture(), own = { ...event, before: window.opsParentSha }
  beforeDriver.guardWindowContext(own, [window.opsParentSha], window)
  for (const [changed, parents] of [[{ ...own, before: env.GITHUB_SHA }, [env.GITHUB_SHA]],
    [own, [env.GITHUB_SHA]], [own, []], [own, [window.opsParentSha, 'e'.repeat(40)]], [{ ...own, before: undefined }, [window.opsParentSha]]])
    assert.throws(() => beforeDriver.guardWindowContext(changed, parents, window), error => error.code === 'window_source_changed')
})

test('normal API Workspace and reader must match the actual recorded account window before APP is opened', () => {
  const { window } = windowFixture()
  beforeDriver.guardWindowScope(scope, window)
  for (const changed of [{ ...scope, workspaceId: id(99) }, { ...scope, ownerId: 'another-authorized-reader' }])
    assert.throws(() => beforeDriver.guardWindowScope(changed, window), error => error.code === 'window_scope_changed')
})

function windowFetch(change = () => {}) {
  const f = windowFixture(), calls = []
  f.issue = { number: 1752, comments: 7 }; f.comments = [f.comment]
  change(f)
  return { ...f, calls, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    if (url.includes('/comments?')) return Response.json(f.comments)
    if (url.endsWith('/issues/1752')) return Response.json(f.issue)
    if (url.includes('api.github.com')) return Response.json({ ref: 'refs/heads/main', object: { sha: MAIN, type: 'commit' } })
    assert.equal(init.headers.authorization, undefined)
    return Response.json({ build: MAIN })
  } }
}

test('window gate reads the current latest comment, exact owner, body digest and structured source before accepting', async () => {
  const f = windowFetch()
  const proof = await guardMain({ GITHUB_TOKEN: 'synthetic' }, f.fetchImpl, f.window, () => windowNow, 240000)
  assert.equal(proof.windowCommentId, f.window.commentId); assert.equal(proof.windowExpiresAt, f.window.expiresAt)
  assert.equal(proof.opsParentSha, f.window.opsParentSha)
  assert.ok(f.calls[3].url.endsWith('/comments?per_page=1&page=7'))
  assert.equal(f.calls[3].init.headers.authorization, 'Bearer synthetic')
  assert.ok(f.calls[1].url.includes('?verify=1782-before-'))
})
for (const [name, change] of [
  ['later owner or release comment', f => { f.comments = [{ ...f.comment, id: f.comment.id + 1 }] }],
  ['comment body edited', f => { f.comment.body += ' released' }],
  ['different actor', f => { f.comment.user.login = 'other' }],
  ['wrong numeric actor', f => { f.comment.user.id = 1 }],
  ['different issue', f => { f.comment.issue_url = f.comment.issue_url.replace('1752', '1503') }],
  ['empty latest page', f => { f.comments = [] }],
  ['invalid comment count', f => { f.issue.comments = 0 }],
  ['different pinned main in marker', f => { f.comment.body = f.comment.body.replace(MAIN, 'f'.repeat(40)); f.window.commentBodySha256 = createHash('sha256').update(f.comment.body).digest('hex') }],
  ['released state with valid body digest', f => { f.comment.body = f.comment.body.replace('active', 'released'); f.window.commentBodySha256 = createHash('sha256').update(f.comment.body).digest('hex') }],
  ['duplicate marker with valid body digest', f => { f.comment.body += f.comment.body; f.window.commentBodySha256 = createHash('sha256').update(f.comment.body).digest('hex') }],
]) test('actual account window refuses ' + name, async () => {
  const f = windowFetch(change)
  await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.fetchImpl, f.window, () => windowNow), error => error.code === 'window_changed')
})

test('unstarted, expired and insufficient-remaining windows refuse before network, credentials or sign-in', async () => {
  const f = windowFetch()
  for (const [at, minimum] of [[Date.parse(f.window.startsAt) - 1, 0], [Date.parse(f.window.expiresAt), 0],
    [Date.parse(f.window.expiresAt) - 240000, 240000]])
    await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.fetchImpl, f.window, () => at, minimum), error => error.code === 'window_expired')
  assert.equal(f.calls.length, 0)
})

test('every unit and real PG fixture still runs before the account gate, while every secret is behind it', async () => {
  const source = await readFile(new URL('../../.github/workflows/issue1782-domain-history-before.yml', import.meta.url), 'utf8')
  const unit = source.indexOf('node --test scripts/ops/domain-history-before-1782.test.mjs')
  const pg = source.indexOf('node --test scripts/ops/domain-history-before-1782.db.test.mjs')
  const gate = source.indexOf('node scripts/ops/domain-history-before-1782.mjs check')
  const secret = source.indexOf('uses: Infisical/secrets-action@')
  assert.ok(unit > 0 && pg > unit && gate > pg && secret > gate)
  assert.match(source, /      issues: read\n/); assert.match(source, /          fetch-depth: 2\n/)
  assert.doesNotMatch(source, /continue-on-error|if: false/)
  assert.equal((source.match(/secret-name:/g) ?? []).length, 3)
  const driver = await readFile(new URL('./domain-history-before-1782.mjs', import.meta.url), 'utf8')
  assert.ok(driver.indexOf('guardWindowContext(event,') < driver.indexOf('const { email, password } = smokeAcceptanceAccount(env)'))
  assert.ok(driver.indexOf('    guardWindowScope(scope)') < driver.indexOf('    pool = new Pool('))
  assert.equal((driver.match(/await guardMain\(env/g) ?? []).length, 3)
  assert.doesNotMatch(driver, /import .*publication-preflight/)
})


test('a window expiring during actual source reads cannot pass on its earlier check timestamp', async () => {
  const f = windowFetch(); let reads = 0
  await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, f.fetchImpl, f.window,
    () => ++reads === 1 ? windowNow : Date.parse(f.window.expiresAt)), error => error.code === 'window_expired')
  assert.equal(f.calls.length, 4)
})
