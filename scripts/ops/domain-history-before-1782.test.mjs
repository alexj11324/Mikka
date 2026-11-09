import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSessionClient } from '../acceptance/cloud-startup.mjs'
import { candidateInventory, guardContext, guardMain, MAIN, projectRows, publicFailure, searchCandidates, selectScope, snapshot, SQL, verifyScope } from './domain-history-before-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const scope = { ownerId: 'smoke-owner', workspaceId: id(90), workspaceKind: 'personal', taskIds: [id(1), id(2)], candidateTaskIds: [id(1), id(2)] }
const personalView = () => ({ currentUserId: scope.ownerId, workspace: { id: scope.workspaceId, kind: 'personal' }, role: 'admin',
  choices: [{ id: scope.workspaceId, kind: 'personal' }], members: [{ userId: scope.ownerId, role: 'admin', status: 'active' }] })
const fixture = () => ({ task: scope.taskIds.map(value => ({ id: value, owner: scope.ownerId,
  workspace: scope.workspaceId, scope: 'workspace', identifier: 'MIK-' + value.slice(-1) })),
publication: scope.taskIds.map((value, index) => ({ id: id(index + 3), issueId: value, identifier: 'MIK-' + (index + 1), branch: 'private-branch', baseBranch: 'main', remoteKey: 'private-repo' })),
run: scope.taskIds.map((value, index) => ({ id: id(index + 3), issueId: value, hasProjectSnapshot: false, frozenDigest: 'a'.repeat(32) })) })
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

function database({ readonly = 'on', isolation = 'repeatable read', epic = 0, failRun = false, bindingOverride,
  selected = scope.taskIds.map(value => ({ id: value })) } = {}) {
  const calls = [], rows = fixture()
  return { calls, query: async (sql, args) => {
    calls.push({ sql, args })
    if (sql === SQL.settings) return { rows: [{ readonly, isolation }] }
    if (sql === SQL.ledger) return { rows: [{ epic, digest: 'c'.repeat(32) }] }
    if (sql === SQL.binding) {
      assert.equal(args[1], scope.ownerId); assert.equal(args[2], scope.workspaceId)
      return { rows: [bindingOverride ?? { present: args[0].length, bound: args[0].length, published: 2, ended: 2, historical: 2 }] }
    }
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
  assert.equal(db.calls.filter(({ args }) => args).length, 5)
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
    ownUnknownScope: 1, ownScopeOmitted: 0, workspaceLabel: 1, personalLabel: 3, unknownScope: 1, scopeOmitted: 0, listCapacityReached: false })
  const output = JSON.stringify(result.counts)
  for (const privateValue of [scope.ownerId, 'other-owner', 'sensitive-title', 'sensitive-body', id(1)]) assert.ok(!output.includes(privateValue))
  assert.equal(candidateInventory([], scope.ownerId).counts.returned, 0)
  assert.deepEqual(candidateInventory(rows.filter(row => row.ownerId !== scope.ownerId), scope.ownerId).candidateTaskIds, [])
})

test('each candidate collection has a hard one-hundred UUID bound', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: id(i + 1), ownerId: scope.ownerId, scope: 'personal' }))
  assert.equal(candidateInventory(rows, scope.ownerId).counts.listCapacityReached, true)
  assert.equal(candidateInventory(rows, scope.ownerId).candidateTaskIds.length, 100)
  assert.throws(() => candidateInventory([...rows, { id: id(101), ownerId: scope.ownerId, scope: 'personal' }], scope.ownerId))
  assert.throws(() => candidateInventory([rows[0], rows[0]], scope.ownerId))
})

test('post-query API authorization loss invalidates evidence', async () => {
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : personalView(), rpc: async (action, [value]) => {
    assert.equal(action, 'issues.getIssue')
    return { issue: { id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'workspace' } }
  } }
  await verifyScope(client, scope)
  client.rpc = async () => ({})
  await assert.rejects(verifyScope(client, scope))
})

test('post-query API verifies the same owner and Workspace for a personal-label Task', async () => {
  const client = { json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : personalView(), rpc: async (action, [value]) => {
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

test('real opaque search pagination reaches own historical Tasks beyond the first one hundred visible rows', async () => {
  const paths = [], inventories = []
  const client = { json: async path => {
    paths.push(path); const page = paths.length
    const rows = Array.from({ length: page < 3 ? 50 : 2 }, (_, index) => ({
      id: id((page - 1) * 50 + index + 1), ownerId: page < 3 ? 'other-owner' : scope.ownerId,
      title: 'private-title', content: 'private-content',
    }))
    return { items: rows, nextCursor: page < 3 ? 'opaque' + page : null, truncated: false }
  } }
  const result = await searchCandidates(client, scope, counts => inventories.push(counts))
  assert.deepEqual(result.candidateTaskIds, [id(101), id(102)])
  assert.equal(result.counts.pages, 3); assert.equal(result.counts.returned, 102)
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

test('search stops at five pages or one hundred own candidates and declares the finite boundary', async () => {
  for (const own of [false, true]) {
    let calls = 0
    const result = await searchCandidates({ json: async () => {
      const page = calls++
      return { items: Array.from({ length: 50 }, (_, i) => ({ id: id(page * 50 + i + 1), ownerId: own ? scope.ownerId : 'other' })),
        nextCursor: 'cursor' + calls, truncated: false }
    } }, scope)
    assert.equal(calls, own ? 2 : 5)
    assert.equal(result.candidateTaskIds.length, own ? 100 : 0)
    assert.equal(result.counts.hasMore, true)
    assert.equal(result.counts.pageLimitReached, !own)
    assert.equal(result.counts.candidateLimitReached, own)
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
    json: async path => path.includes('get-session') ? { user: { id: scope.ownerId } } : personalView(),
    rpc: async (action, [value], options) => { seen.push({ action, value });
      assert.deepEqual(options, { headers: { 'x-mikka-workspace-id': scope.workspaceId } }); return { issue: {
      id: value, userId: scope.ownerId, workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal', content: 'never-recorded',
    } } },
  }
  await verifyScope(client, { ...scope, taskIds: [id(501)] })
  assert.deepEqual(seen, [{ action: 'issues.getIssue', value: id(501) }])
  client.rpc = async (_action, [value]) => ({ issue: { id: value, userId: scope.ownerId, workspaceId: id(999), ownershipState: 'bound', scope: 'personal' } })
  await assert.rejects(verifyScope(client, { ...scope, taskIds: [id(501)] }))
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
      return new Response(JSON.stringify(personalView()))
    }
    assert.equal(url.pathname, '/mikka/api/rpc')
    const body = JSON.parse(init.body)
    assert.equal(body.action, 'issues.getIssue')
    // The account's saved choice is deliberately different. The existing API
    // requires the membership-checked transport preference for this target.
    if (init.headers['x-mikka-workspace-id'] !== scope.workspaceId) return new Response('{}', { status: 403 })
    return new Response(JSON.stringify({ ok: true, result: { issue: { id: body.args[0], userId: scope.ownerId,
      workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } } }))
  })
  await verifyScope(client, scope)
  assert.deepEqual(paths, ['/mikka/api/auth/get-session', '/mikka/api/workspace', '/mikka/api/rpc', '/mikka/api/rpc'])
})

test('normal session transport selects its unique owned Personal Workspace and revalidates fixed Tasks without switching the Team cookie', async () => {
  const teamId = id(999), email = 'synthetic@example.invalid', calls = []
  const client = createSessionClient('https://synthetic.invalid', async (url, init) => {
    calls.push({ path: url.pathname, search: url.search, body: init.body })
    if (url.pathname.endsWith('/api/auth/get-session')) return new Response(JSON.stringify({ user: { id: scope.ownerId, email } }), {
      headers: { 'set-cookie': 'mikka-workspace=' + teamId + '; Path=/mikka' },
    })
    assert.equal(init.headers.cookie, 'mikka-workspace=' + teamId)
    if (url.pathname.endsWith('/api/workspace')) {
      const value = personalView(); value.choices.push({ id: teamId, kind: 'team' })
      if (url.searchParams.has('workspace')) assert.equal(url.searchParams.get('workspace'), scope.workspaceId)
      else value.workspace = { id: teamId, kind: 'team' }
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
    return new Response(JSON.stringify({ ok: true, result: { issue: { id: body.args[0], userId: scope.ownerId,
      workspaceId: scope.workspaceId, ownershipState: 'bound', scope: 'personal' } } }))
  })
  const selected = await selectScope(client, email)
  assert.equal(selected.workspaceId, scope.workspaceId)
  assert.equal(selected.workspaceKind, 'personal')
  assert.deepEqual(selected.candidateTaskIds, [id(501)])
  await verifyScope(client, { ...selected, taskIds: selected.candidateTaskIds })
  assert.equal(calls.filter(row => row.path.endsWith('/api/issues/search')).length, 1)
  assert.deepEqual(calls.filter(row => row.body).map(row => JSON.parse(row.body).action), ['issues.getIssue'])
})

for (const [name, change] of [
  ['missing Personal choice', value => { value.choices = [] }],
  ['ambiguous Personal choices', value => { value.choices.push({ id: id(998), kind: 'personal' }) }],
  ['another session owner', value => { value.currentUserId = 'other' }],
  ['another explicit Workspace', value => { value.workspace.id = id(998) }],
  ['a Team returned for the Personal target', value => { value.workspace.kind = 'team' }],
  ['no own membership', value => { value.members = [{ userId: 'other', role: 'admin', status: 'active' }] }],
  ['suspended own membership', value => { value.members[0].status = 'suspended' }],
  ['duplicate own membership', value => { value.members.push({ ...value.members[0] }) }],
  ['membership role mismatch', value => { value.members[0].role = 'member' }],
]) test('Personal selection rejects ' + name + ' before searching Task IDs', async () => {
  const email = 'synthetic@example.invalid'
  const client = { json: async path => {
    if (path.includes('get-session')) return { user: { id: scope.ownerId, email } }
    assert.ok(path.startsWith('/api/workspace'), 'refused scope never reaches Task search')
    const value = personalView()
    if (path.includes('?workspace=') || name.startsWith('missing') || name.startsWith('ambiguous')) change(value)
    return value
  } }
  await assert.rejects(selectScope(client, email))
})

test('a revoked Personal membership fails fixed-UUID revalidation before any Task read', async () => {
  const client = { json: async path => {
    if (path.includes('get-session')) return { user: { id: scope.ownerId } }
    const value = personalView(); value.members[0].status = 'suspended'; return value
  }, rpc: async () => { assert.fail('revoked membership cannot read a Task') } }
  await assert.rejects(verifyScope(client, scope))
})
