import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { candidateInventory, guardContext, guardMain, MAIN, projectRows, publicFailure, selectScope, snapshot, SQL, verifyScope } from './domain-history-before-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const scope = { ownerId: 'smoke-owner', workspaceId: id(90), taskIds: [id(1), id(2)], candidateTaskIds: [id(1), id(2)] }
const fixture = () => ({ task: scope.taskIds.map(value => ({ id: value, owner: scope.ownerId,
  workspace: scope.workspaceId, scope: 'workspace', identifier: 'MIK-' + value.slice(-1) })),
publication: [{ id: id(3), issueId: id(1), identifier: 'MIK-1', branch: 'private-branch', baseBranch: 'main', remoteKey: 'private-repo' }],
run: [{ id: id(3), issueId: id(1), hasProjectSnapshot: false, frozenDigest: 'a'.repeat(32) }] })
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
  GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108', GITHUB_EVENT_NAME: 'push',
  GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_JOB: 'domain_history_before',
  GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'b'.repeat(40),
  GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-domain-history-before.yml@refs/heads/ops/self-hosted-vault-closeout-20261108' }
const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
  after: env.GITHUB_SHA, deleted: false, forced: false }

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
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(url.includes('api.github.com') ? {
        ref: 'refs/heads/main', object: { sha: changed === 'main' ? 'a'.repeat(40) : MAIN, type: 'commit' },
      } : { build: changed === 'served' ? 'a'.repeat(40) : MAIN }))
    }
    if (changed) await assert.rejects(guardMain({ GITHUB_TOKEN: 'synthetic' }, fetchImpl))
    else assert.equal((await guardMain({ GITHUB_TOKEN: 'synthetic' }, fetchImpl)).mainSha, MAIN)
    assert.equal(calls[0].init.redirect, 'error')
    if (calls.length === 2) assert.equal(calls[1].init.headers.authorization, undefined)
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
  ['different owner', rows => { rows.task[0].owner = 'other' }],
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

function database({ readonly = 'on', isolation = 'repeatable read', epic = 0, failRun = false,
  selected = scope.taskIds.map(value => ({ id: value })) } = {}) {
  const calls = [], rows = fixture()
  return { calls, query: async (sql, args) => {
    calls.push({ sql, args })
    if (sql === SQL.settings) return { rows: [{ readonly, isolation }] }
    if (sql === SQL.ledger) return { rows: [{ epic, digest: 'c'.repeat(32) }] }
    if (sql === SQL.select) {
      assert.equal(args[1], scope.ownerId); assert.equal(args[2], scope.workspaceId)
      return { rows: selected }
    }
    for (const kind of ['task', 'publication', 'run']) if (sql === SQL[kind]) {
      if (kind === 'run' && failRun) throw Error('synthetic-private-provider-error')
      assert.deepEqual(args, [scope.taskIds]); return { rows: rows[kind] }
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
  assert.equal(db.calls.filter(({ args }) => args).length, 4)
})
for (const options of [{ readonly: 'off' }, { isolation: 'read committed' }, { epic: 1 }, { failRun: true }]) {
  test('fails closed and rolls back for ' + JSON.stringify(options), async () => {
    const db = database(options)
    await assert.rejects(snapshot(db, scope))
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  })
}

test('one hundred authorized candidate UUIDs produce only the fixed historical subset for all three snapshots', async () => {
  const db = database(), candidateTaskIds = Array.from({ length: 100 }, (_, i) => id(i + 1))
  const result = await snapshot(db, { ...scope, candidateTaskIds })
  assert.equal(result.candidateCount, 100)
  assert.deepEqual(result.taskIds, scope.taskIds)
  assert.deepEqual(db.calls.find(row => row.sql === SQL.select).args, [candidateTaskIds, scope.ownerId, scope.workspaceId])
  for (const kind of ['task', 'publication', 'run']) assert.deepEqual(db.calls.find(row => row.sql === SQL[kind]).args, [scope.taskIds])
  assert.match(SQL.select, /p.status='published'/)
  assert.match(SQL.select, /r.status IN \('succeeded','stopped','failed','cancelled'\)/)
  assert.match(SQL.select, /i\."userId"=\$2/)
  assert.match(SQL.select, /workspaceId',''\)=\$3/)
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

test('normal API candidates admit both owned labels and emit counts without raw identity or content', () => {
  const rows = [
    { id: id(1), ownerId: scope.ownerId, scope: 'workspace', status: 'completed', title: 'sensitive-title' },
    { id: id(2), ownerId: scope.ownerId, scope: 'personal', status: 'stopped', content: 'sensitive-body' },
    { id: id(3), ownerId: 'other-owner', scope: 'personal', status: 'active' },
    { id: id(4), ownerId: scope.ownerId, scope: 'unknown' },
    { id: id(5), userId: scope.ownerId, scope: 'personal' },
  ]
  const result = candidateInventory(rows, scope.ownerId)
  assert.deepEqual(result.candidateTaskIds, [id(1), id(2)])
  assert.deepEqual(result.counts, { returned: 5, ownerIdFieldPresent: 4, own: 3, ownWorkspace: 1, ownPersonal: 1,
    ownUnknownScope: 1, workspaceLabel: 1, personalLabel: 3, unknownScope: 1, listCapacityReached: false })
  const output = JSON.stringify(result.counts)
  for (const privateValue of [scope.ownerId, 'other-owner', 'sensitive-title', 'sensitive-body', id(1)]) assert.ok(!output.includes(privateValue))
  assert.equal(candidateInventory([], scope.ownerId).counts.returned, 0)
  assert.deepEqual(candidateInventory(rows.filter(row => row.ownerId !== scope.ownerId), scope.ownerId).candidateTaskIds, [])
})

test('normal API capacity is reported without claiming a complete scan or adding pagination', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: id(i + 1), ownerId: scope.ownerId, scope: 'personal' }))
  assert.equal(candidateInventory(rows, scope.ownerId).counts.listCapacityReached, true)
  assert.equal(candidateInventory(rows, scope.ownerId).candidateTaskIds.length, 100)
  assert.throws(() => candidateInventory([...rows, { id: id(101), ownerId: scope.ownerId, scope: 'personal' }], scope.ownerId))
  assert.throws(() => candidateInventory([rows[0], rows[0]], scope.ownerId))
})

test('post-query API authorization loss invalidates evidence', async () => {
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : {
    currentUserId: scope.ownerId, workspace: { id: scope.workspaceId }, role: 'member',
  }, rpc: async () => scope.taskIds.map(value => ({ id: value, ownerId: scope.ownerId, scope: 'workspace' })) }
  await verifyScope(client, scope)
  client.rpc = async () => []
  await assert.rejects(verifyScope(client, scope))
})

test('post-query API verifies the same owner and Workspace for a personal-label Task', async () => {
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : {
    currentUserId: scope.ownerId, workspace: { id: scope.workspaceId }, role: 'member',
  }, rpc: async () => scope.taskIds.map(value => ({ id: value, ownerId: scope.ownerId, scope: 'personal' })) }
  await verifyScope(client, scope)
  client.rpc = async () => scope.taskIds.map(value => ({ id: value, ownerId: 'other', scope: 'personal' }))
  await assert.rejects(verifyScope(client, scope))
  client.rpc = async () => scope.taskIds.map(value => ({ id: value, ownerId: scope.ownerId, scope: 'unknown' }))
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
  assert.match(beforeJob, /contents: read\n      id-token: write/)
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
