// Every dispatch is a Factory task (docs/design/decisions/2026-11-03-0415-all-dispatch-through-factory.md),
// against a real PostgreSQL with synthetic Acme-like data: one Coordinator dispatch_run creates a Factory task
// and its execute attempt bound to the run it queued.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub } from './support/github-app-stub'
import { codexItemChunks } from '../packages/daemon/src/adapters/codex'

mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

const REPO = 'acme-corp/storefront'
const codex = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]

test('a Coordinator dispatch_run goes through the Factory', { skip: !dbUrl, timeout: 180_000 }, async t => {
  const prior = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { overrideDeploymentSwitch } = await import('../lib/deployment-switches')
  overrideDeploymentSwitch('factoryRouting', true)
  overrideDeploymentSwitch('factoryLifecycle', true)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const github = githubAppStub()
  github.install(REPO, { contents: 'write', pull_requests: 'write' })
  t.after(async () => {
    github.restore()
    overrideDeploymentSwitch('factoryRouting', undefined)
    overrideDeploymentSwitch('factoryLifecycle', undefined)
    if (prior === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = prior
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  // Acme's operations lead, their Acme workspace, a ChatGPT subscription listing gpt-5 (优先使用的模型),
  // Acme's always-on build server with Codex, and one storefront task.
  const userId = await seedUser(pool, 'acme-ops')
  const githubAccountId = String(9_700_000 + Math.floor(Math.random() * 100_000))
  await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, userId])
  github.allowWriter(REPO, githubAccountId)
  await connectGitHub(github, userId, githubAccountId, [REPO])
  await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [userId, normalizeRepository(REPO).key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() })])
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }], 'Acme')
  const connection = randomUUID()
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'acme-subject',$6,$7)`,
    [connection, userId, ws.id, `acme-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: null }] })])
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), userId, ws.id, connection])
  const deviceId = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'acme-build-01','local','server',true,now(),$3)`, [deviceId, userId, JSON.stringify(codex)])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Codex on acme-build-01')`, [randomUUID(), userId, deviceId])
  const issueId = randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Checkout rounds sales tax down on multi-item carts',$3,'todo','high')`,
    [issueId, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1000000000) } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acme storefront: a cart of 3 x $19.99 in CA shows $5.24 tax instead of $5.25.' }] }] })])
  const botId = await chatBotId(userId, null, ws.id)
  const sourceEventId = randomUUID()
  await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$4,$5)`,
    [sourceEventId, userId, botId, `acme:${sourceEventId}`, JSON.stringify({ text: `Please fix the checkout tax rounding in ${REPO}.` })])

  const dispatched = await steps.dispatchRun(userId, { issueId, repo: REPO, requestKey: `acme:${randomUUID()}`, sourceEventId }, undefined, botId) as unknown as { runId?: string; error?: string }
  const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM factory_tasks WHERE "userId"=$1) AS tasks,
      (SELECT count(*)::int FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1) AS attempts,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs`, [userId])).rows[0]
  console.log(`factory-all-dispatch: dispatch=${JSON.stringify(dispatched)} factory_tasks=${counts.tasks} factory_attempts=${counts.attempts} agent_runs=${counts.runs}`)
  assert.ok(dispatched.runId, `dispatch_run queued a run: ${JSON.stringify(dispatched)}`)
  assert.equal(counts.tasks, 1, 'one Factory task for the dispatch')
  assert.equal(counts.attempts, 1, 'its execute attempt')
  const { rows: [bound] } = await pool.query(`SELECT t.stage,t.status,a."runId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t."userId"=$1`, [userId])
  assert.deepEqual({ stage: bound.stage, status: bound.status, runId: bound.runId }, { stage: 'execute', status: 'running', runId: dispatched.runId })
  const command = 'node --test'
  await pool.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE "userId"=$1', [userId, command])
  const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
  const runtime = factoryRuntimeForBot(botId)
  const sha = 'a'.repeat(40)
  const finish = async (id: string, check: boolean) => {
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"startedAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [id, `independent-${id}`])
    if (check) {
      const call = { id: `check-${id}`, type: 'mcpToolCall' as const, server: 'mikka', tool: 'verify_command', arguments: { command }, status: 'completed' as const,
        result: { content: [{ type: 'text', text: JSON.stringify({ exitCode: 0 }) }], structuredContent: null }, error: null };
      const chunks = [...codexItemChunks('started', call, new Set(), '/tmp'), ...codexItemChunks('completed', call, new Set(), '/tmp')];
      for (const [seq, chunk] of chunks.entries()) await pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,$3,$4)', [randomUUID(), id, seq + 1, JSON.stringify(chunk)])
      const { verifierCommandEvidence } = await import('../lib/factory/checks');
      // A failed or malformed MCP response cannot attest a passing command.
      for (const text of [JSON.stringify({ exitCode: 1 }), 'not-json']) {
        await pool.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}', $2::jsonb) WHERE "runId"=$1 AND seq=2`, [id, JSON.stringify([{ type: 'text', text }])]);
        await pool.query(`UPDATE agent_runs SET "finishedAt"=clock_timestamp() WHERE id=$1`, [id]);
        assert.deepEqual(await verifierCommandEvidence(pool, id, command), []);
      }
      await pool.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}', $2::jsonb) WHERE "runId"=$1 AND seq=2`, [id, JSON.stringify(call.result.content)]);
    }
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`, [id, JSON.stringify({
      summary: 'Checked tax rounding with concrete evidence.', filesChanged: [], openQuestions: [], nextStep: null, sourceCommit: sha,
      verify: check ? { status: 'passed', command, exitCode: 0, signal: null, timedOut: false, output: 'passed' } : { status: 'not_run' },
      ...(check ? { check: { sha, readOnly: true }, criteria: [{ text: 'Tax rounds to the cent', passed: true, evidence: 'The fixture command passed.', command, exitCode: 0 }] } : { publish: { commit: sha, pushed: true, branch: 'mikka/fixture', remote: 'origin' } }),
    })])
    await runtime.reconcile.run(userId, id)
  }
  await finish(dispatched.runId!, false)
  const current = async () => (await pool.query(`SELECT t.id,t.stage,t.status,a."runId",r.kind,r."baseBranch",r."agentDefinition" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" LEFT JOIN agent_runs r ON r.id=a."runId" WHERE t."userId"=$1`, [userId])).rows[0]
  const review = await current()
  assert.equal(review.stage, 'review')
  assert.equal(review.status, 'running')
  assert.equal(review.baseBranch, sha)
  assert.equal(review.agentDefinition.readOnly, true)
  assert.notEqual(review.runId, dispatched.runId)
  await finish(review.runId, true)
  const verify = await current()
  assert.equal(verify.stage, 'verify')
  assert.equal(verify.status, 'running')
  assert.notEqual(verify.runId, review.runId)
  await finish(verify.runId, true)
  const acceptance = await current()
  assert.equal(acceptance.stage, 'approval')
  assert.equal(acceptance.status, 'pending', 'only the person may accept')
  const attempts = (await pool.query('SELECT stage,"runId" FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [acceptance.id])).rows
  assert.deepEqual(attempts.map(attempt => attempt.stage), ['execute', 'review', 'verify', 'approval'])
  assert.equal(new Set(attempts.slice(0, 3).map(attempt => attempt.runId)).size, 3)
})
