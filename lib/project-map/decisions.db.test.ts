import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedProject, seedRun, seedTeam, seedUser, seedPersonalWorkspace, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { ProjectMapError, recordDecisionSchema, type RecordDecisionInput } from './contracts'

test('decision input rejects forged authority, malformed choices and unsupported external sources', () => {
  const valid = { kind: 'choose', title: 'Choose a store', summary: 'Use PostgreSQL', reason: 'Atomic writes', options: [
    { id: 'pg', title: 'PostgreSQL', disposition: 'selected' }, { id: 'files', title: 'Files', disposition: 'rejected', reason: 'No atomic multi-record writes' },
  ], selectedOptionId: 'pg', idempotencyKey: 'choice-1' }
  assert.ok(recordDecisionSchema.safeParse(valid).success)
  for (const input of [
    { ...valid, ownerId: 'someone-else' },
    { ...valid, selectedOptionId: 'files' },
    { ...valid, options: [valid.options[0], valid.options[0]] },
    { ...valid, options: [{ ...valid.options[1], reason: null }] },
    { ...valid, sources: [{ source: { type: 'external_session', id: 'outside' } }] },
    { ...valid, reason: '' },
    { ...valid, provenance: 'inferred', sources: [] },
    { ...valid, kind: 'abandon', contextOptionRef: null },
    { ...valid, recordStatus: 'retracted' },
  ]) assert.equal(recordDecisionSchema.safeParse(input).success, false)
})

test('project decisions: real PostgreSQL authority, atomic appends, retries and correction', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 3 })
  const { recordProjectDecision, listProjectDecisions } = await import('./decisions')
  const { resolveProjectScope } = await import('./scope')
  const { issueRunToken, revokeRunTokens } = await import('@/lib/mcp/worker')
  const { pool } = await import('@/lib/db')
  const { workspacePool } = await import('@/lib/workspace-db')
  t.after(async () => { await Promise.all([connection.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(connection, 'decision-owner')
  const stranger = await seedUser(connection, 'decision-stranger')
  const member = await seedUser(connection, 'decision-member')
  const personal = { id: await seedPersonalWorkspace(connection, owner) }
  const other = await seedWorkspace(connection, stranger, [{ userId: stranger, role: 'admin' }])
  const teamWorkspace = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const team = await seedTeam(connection, teamWorkspace.id, owner)
  const projectId = await seedProject(connection, owner, [])
  const sharedProject = await seedProject(connection, owner, [{ teamId: team.id, workspaceId: teamWorkspace.id }])
  const issueId = await seedIssue(connection, owner)
  await connection.query('update workspace_projects set "issueIds"=$2 where id=$1', [projectId, JSON.stringify([issueId])])
  const botId = await seedBot(connection, personal.id, owner)
  const agentId = await seedAgent(connection, owner)
  const human = { kind: 'human' as const, user: owner, workspaceId: personal.id }
  const base = (key: string = randomUUID()): RecordDecisionInput => ({ projectId, workspaceId: personal.id, issueId,
    kind: 'choose', title: 'Store the decision', summary: 'Use a transactional append', reason: 'A retry must not create a second decision',
    options: [{ id: 'append', title: 'Append in PostgreSQL', disposition: 'selected' }, { id: 'overwrite', title: 'Overwrite the previous value', disposition: 'rejected', reason: 'Loses the original reason' }],
    selectedOptionId: 'append', idempotencyKey: key })
  const rejected = (work: Promise<unknown>, code?: string) => assert.rejects(work, (error: unknown) =>
    error instanceof ProjectMapError && (code ? error.code === code : [400, 403, 404, 409].includes(error.status)))

  await t.test('eight simultaneous retries commit one decision and preserve payload conflicts', async () => {
    const input = base('concurrent-key')
    const results = await Promise.all(Array.from({ length: 8 }, () => recordProjectDecision(human, input)))
    assert.equal(new Set(results.map(result => result.decisionId)).size, 1)
    assert.equal(results.filter(result => !result.duplicate).length, 1)
    await rejected(recordProjectDecision(human, { ...input, reason: 'A different payload' }), 'IDEMPOTENCY_CONFLICT')
    const { rows } = await connection.query('select count(*)::int as count from project_decisions where id=$1', [results[0].decisionId])
    assert.equal(rows[0].count, 1)
  })
  await t.test('bot and live worker use host identities; tokens cannot switch owner, run, task or workspace', async () => {
    const bot = await recordProjectDecision({ kind: 'bot', userId: owner, workspaceId: personal.id, botId, sessionId: 'fixture', modelId: 'host-model', harness: 'ai_sdk' }, base('bot-choice'))
    const runId = await seedRun(connection, { userId: owner, agentId, issueId, status: 'running' })
    const { token } = await issueRunToken({ id: runId, userId: owner })
    const run = await recordProjectDecision({ kind: 'run', userId: owner, runId, token }, base('worker-choice'))
    assert.notEqual(bot.decisionId, run.decisionId)
    const { rows } = await connection.query('select "captureMode","recordedBy","runId" from project_decisions where id=$1', [run.decisionId])
    assert.equal(rows[0].captureMode, 'live')
    assert.equal(rows[0].recordedBy.userId, owner)
    assert.equal(rows[0].runId, runId)
    assert.equal('token' in rows[0].recordedBy, false)
    await rejected(recordProjectDecision({ kind: 'run', userId: stranger, runId, token }, base()))
    await rejected(recordProjectDecision({ kind: 'run', userId: owner, runId, token }, { ...base(), runId: randomUUID() }))
    await rejected(recordProjectDecision({ kind: 'run', userId: owner, runId, token }, { ...base(), workspaceId: other.id }))
    const messageId = randomUUID()
    await connection.query("insert into run_messages (id,\"runId\",\"userId\",text,origin) values ($1,$2,$3,$4,'owner')", [messageId, runId, owner, 'Use the confirmed alternative.'])
    const humanChoice = await recordProjectDecision({ kind: 'run', userId: owner, runId, token }, {
      ...base('human-choice'), decidedBy: { kind: 'human' }, sources: [{ role: 'evidence', source: { type: 'run_message', id: messageId } }],
    })
    const decider = (await connection.query('select "decidedBy","recordedBy" from project_decisions where id=$1', [humanChoice.decisionId])).rows[0]
    assert.deepEqual(decider.decidedBy, { kind: 'human', id: owner })
    assert.equal(decider.recordedBy.kind, 'agent')
    const reused = await recordProjectDecision({ kind: 'run', userId: owner, runId, token }, {
      ...base('two-source-roles'), sources: [
        { role: 'evidence', source: { type: 'run', id: runId } },
        { role: 'branch_work', optionId: 'append', source: { type: 'run', id: runId } },
      ],
    })
    assert.equal((await connection.query('select count(*)::int as count from project_decision_sources where "decisionId"=$1', [reused.decisionId])).rows[0].count, 2)
    const chunkId = randomUUID()
    await connection.query('insert into run_chunks (id,"runId",seq,chunk,"createdAt") values ($1,$2,0,$3,$4)', [chunkId, runId, JSON.stringify({ type: 'text', text: 'Prior evidence' }), new Date('2026-01-01T00:00:00Z')])
    const live = await recordProjectDecision({ kind: 'run', userId: owner, runId, token }, {
      ...base('new-choice-old-evidence'), sources: [{ role: 'evidence', source: { type: 'run_chunk', id: chunkId } }],
    })
    const times = (await connection.query('select "occurredAt","recordedAt" from project_decisions where id=$1', [live.decisionId])).rows[0]
    assert.equal(times.occurredAt.getTime(), times.recordedAt.getTime(), 'old evidence does not backdate a live decision')
    await revokeRunTokens(runId)
    await rejected(recordProjectDecision({ kind: 'run', userId: owner, runId, token }, base()), 'RUN_NOT_AUTHORIZED')
  })
  await t.test('stop and lease expiry revoke write authority before terminal status', async () => {
    for (const stopped of [true, false]) {
      const runId = await seedRun(connection, { userId: owner, agentId, issueId, status: 'running' })
      const { token } = await issueRunToken({ id: runId, userId: owner })
      if (stopped) await connection.query('update agent_runs set "stopRequestedAt"=now() where id=$1', [runId])
      else {
        const deviceId = randomUUID()
        await connection.query('insert into devices (id,"ownerId",name) values ($1,$2,\'expired test device\')', [deviceId, owner])
        await connection.query('update agent_runs set "deviceId"=$2,"leaseExpiresAt"=now()-interval \'1 second\' where id=$1', [runId, deviceId])
      }
      await rejected(recordProjectDecision({ kind: 'run', userId: owner, runId, token }, base()), 'RUN_NOT_AUTHORIZED')
    }
  })
  await t.test('personal project and PAT scopes do not bleed into another workspace', async () => {
    await rejected(recordProjectDecision({ ...human, user: stranger }, base()), 'PROJECT_NOT_FOUND')
    await rejected(resolveProjectScope(owner, projectId, teamWorkspace.id), 'PROJECT_NOT_FOUND')
    await rejected(resolveProjectScope({ id: owner, [tokenWorkspace]: teamWorkspace.id }, projectId, personal.id), 'PROJECT_NOT_FOUND')
    await rejected(recordProjectDecision({ ...human, user: { id: owner, [tokenWorkspace]: teamWorkspace.id } }, base()), 'PROJECT_NOT_FOUND')
    const own = await listProjectDecisions(await resolveProjectScope(owner, projectId, personal.id))
    assert.ok(own.length > 0)
    assert.ok(own.every(row => row.ownerId === owner))
  })
  await t.test('membership revocation takes effect on the next write; workspace changes never expose old reasons', async () => {
    const input = { ...base(), issueId: undefined, projectId: sharedProject, workspaceId: teamWorkspace.id }
    await recordProjectDecision({ kind: 'human', user: owner, workspaceId: teamWorkspace.id }, input)
    assert.deepEqual(await listProjectDecisions(await resolveProjectScope(member, sharedProject, teamWorkspace.id)), [])
    await connection.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [teamWorkspace.id, member])
    await rejected(recordProjectDecision({ kind: 'human', user: member, workspaceId: teamWorkspace.id }, { ...input, idempotencyKey: randomUUID() }), 'PROJECT_NOT_FOUND')
  })
  await t.test('failed source validation writes neither a decision nor a source row', async () => {
    const before = (await connection.query('select count(*)::int as count from project_decisions where "ownerId"=$1', [owner])).rows[0].count
    await rejected(recordProjectDecision(human, { ...base(), sources: [{ role: 'evidence', source: { type: 'run', id: randomUUID() } }] }))
    const after = (await connection.query('select count(*)::int as count from project_decisions where "ownerId"=$1', [owner])).rows[0].count
    assert.equal(after, before)
  })
  await t.test('corrections append, concurrent corrections conflict, and route references remain scoped', async () => {
    const original = await recordProjectDecision(human, base())
    const correction = { ...base(), kind: 'redirect' as const, supersedesId: original.decisionId,
      predecessorDecisionIds: [original.decisionId], contextOptionRef: { decisionId: original.decisionId, optionId: 'append' }, reason: 'Now the requirements changed' }
    const corrected = await recordProjectDecision(human, correction)
    assert.notEqual(original.decisionId, corrected.decisionId)
    await rejected(recordProjectDecision(human, { ...correction, idempotencyKey: randomUUID() }), 'DECISION_VERSION_CONFLICT')
    await rejected(recordProjectDecision(human, { ...base(), contextOptionRef: { decisionId: original.decisionId, optionId: 'invented' } }), 'UNKNOWN_OPTION')
    const { rows } = await connection.query('select reason from project_decisions where id=$1', [original.decisionId])
    assert.equal(rows[0].reason, base().reason)
  })
  await t.test('claims that a human decided require that human\'s real evidence', async () => {
    await rejected(recordProjectDecision({ kind: 'bot', userId: owner, workspaceId: personal.id, botId }, {
      ...base(), decidedBy: { kind: 'human', id: owner },
    }), 'HUMAN_DECISION_REQUIRES_EVIDENCE')
  })
  await t.test('deleted run leaves an immutable decision and an unavailable locator, not a broken FK', async () => {
    const runId = await seedRun(connection, { userId: owner, agentId, issueId, status: 'running' })
    const { token } = await issueRunToken({ id: runId, userId: owner })
    const recorded = await recordProjectDecision({ kind: 'run', userId: owner, runId, token }, base())
    await connection.query('delete from agent_runs where id=$1', [runId])
    const { rows } = await connection.query('select "runId" from project_decisions where id=$1', [recorded.decisionId])
    assert.equal(rows[0].runId, null)
    assert.equal((await connection.query('select count(*)::int as count from project_decision_sources where "decisionId"=$1', [recorded.decisionId])).rows[0].count, 1)
    const visible = await listProjectDecisions(await resolveProjectScope(owner, projectId, personal.id))
    assert.equal(visible.find(row => row.id === recorded.decisionId)?.sources[0].availability, 'unavailable')
  })
})
