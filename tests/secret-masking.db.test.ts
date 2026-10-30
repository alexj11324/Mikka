// #438 A/C/E/F: masking checked by writing through the real code paths and reading the rows back.
// Uses an ephemeral local WORKSPACE_SECRETS_KEY and flips MIKKA_BYO_E2B_KEY on for this process only.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import test from 'node:test'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('#438 masking write-then-read-back', { skip: !dbUrl }, async t => {
  const saved = { key: process.env.WORKSPACE_SECRETS_KEY, flag: process.env.MIKKA_BYO_E2B_KEY }
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYO_E2B_KEY = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => {
    for (const [name, value] of [['WORKSPACE_SECRETS_KEY', saved.key], ['MIKKA_BYO_E2B_KEY', saved.flag]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const store = await import('../lib/secrets/store')
  const e2b = await import('../lib/secrets/e2b')
  const runtime = await import('../lib/secrets/runtime')
  const { hashDeviceToken } = await import('../lib/device-link')

  const admin = await seedUser(pool, 'admin')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
  const SECRET = 'sk_live_' + randomBytes(12).toString('hex')
  const E2B_KEY = 'e2b_' + randomBytes(16).toString('hex')
  await store.createWorkspaceSecret(admin, ws.id, { name: 'API_TOKEN', kind: 'secret', value: SECRET })
  await e2b.setE2BKey(admin, ws.id, { apiKey: E2B_KEY }, { verify: async () => ({ ok: true }) })

  // A cloud device whose token is bound to the workspace (the only callers that get masked).
  const device = (await pool.query(`insert into devices (id,name,"ownerId",kind) values (gen_random_uuid(),'cloud',$1,'cloud') returning id`, [admin])).rows[0].id as string
  await pool.query(`insert into cloud_machines ("workspaceId","ownerId","operationId","deviceId") values ($1,$2,gen_random_uuid(),$3)`, [ws.id, admin, device])
  const token = 'dt_' + randomBytes(24).toString('hex')
  await pool.query(`insert into device_tokens (id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") values (gen_random_uuid(),$1,$2,$3,$4,now()+interval '1 hour')`, [admin, hashDeviceToken(token), device, ws.id])
  const agent = (await pool.query(`insert into agents (id,"userId",harness,name) values (gen_random_uuid(),$1,'codex','a') returning id`, [admin])).rows[0].id as string
  const newRun = async () => (await pool.query(`insert into agent_runs (id,"agentId","userId","deviceId",status) values (gen_random_uuid(),$1,$2,$3,'running') returning id`, [agent, admin, device])).rows[0].id as string
  const call = (method: string, path: string, body: unknown) => new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  /** The row is committed before Next's `after()` (the wake-up) runs; outside a request it throws. */
  const afterOnly = (error: unknown) => { if (!String((error as Error)?.message).includes('outside a request scope')) throw error }
  const noPlain = (label: string, text: string) => {
    assert.ok(!text.includes(SECRET), `${label}: secret in plaintext`)
    assert.ok(!text.includes(SECRET.slice(0, 12)), `${label}: secret prefix in plaintext`)
    assert.ok(!text.includes(E2B_KEY), `${label}: E2B key in plaintext`)
  }

  await t.test('C: the workspace E2B key is masked like a secret', async () => {
    const mask = await runtime.workspaceSecretMasker(ws.id)
    assert.equal(mask(`key ${E2B_KEY}`), 'key [secret:E2B_API_KEY]')
  })

  await t.test('A: a secret split over 2 deltas and over single-char deltas never reaches run_chunks or lastReply', async () => {
    const events = await import('../app/v1/runs/[runId]/events/route')
    for (const split of ['two', 'chars'] as const) {
      const runId = await newRun()
      const text = `here is ${SECRET} and Bearer ${Buffer.from(`u:${SECRET}`).toString('base64')} done`
      const pieces = split === 'two' ? [text.slice(0, text.indexOf(SECRET) + 10), text.slice(text.indexOf(SECRET) + 10)] : [...text]
      let seq = 1
      const post = async (chunks: Record<string, unknown>[]) => {
        const response = await events.POST(call('POST', `/v1/runs/${runId}/events`, { fromSeq: seq, chunks }), { params: Promise.resolve({ runId }) })
        assert.equal(response.status, 200, await response.clone().text())
        seq += chunks.length
      }
      await post([{ type: 'text-start', id: 'p1' }])
      // One delta per batch: the hold-back has to survive between requests.
      for (const piece of pieces) await post([{ type: 'text-delta', id: 'p1', delta: piece }])
      await post([{ type: 'text-end', id: 'p1' }])
      const { rows } = await pool.query(`select chunk from run_chunks where "runId"=$1 order by seq`, [runId])
      const stored = JSON.stringify(rows)
      noPlain(`${split} run_chunks`, stored)
      const joined = rows.map(row => row.chunk.type === 'text-delta' ? row.chunk.delta : '').join('')
      assert.equal(joined, 'here is [secret:API_TOKEN] and Bearer [secret:API_TOKEN] done', split)
      const { rows: [run] } = await pool.query(`select "lastReply" from agent_runs where id=$1`, [runId])
      noPlain(`${split} lastReply`, run.lastReply)
      assert.equal(run.lastReply, 'here is [secret:API_TOKEN] and Bearer [secret:API_TOKEN] done')
      const { rows: buffers } = await pool.query(`select * from run_mask_buffers where "runId"=$1`, [runId])
      assert.equal(buffers.length, 0, 'part ended: no hold-back left')
    }
  })

  await t.test('A: held-back text is stored sealed, and a re-sent batch does not append twice', async () => {
    const events = await import('../app/v1/runs/[runId]/events/route')
    const runId = await newRun()
    const send = (fromSeq: number, delta: string) => events.POST(call('POST', `/v1/runs/${runId}/events`, { fromSeq, chunks: [{ type: 'text-delta', id: 'p', delta }] }), { params: Promise.resolve({ runId }) })
    await send(1, `x ${SECRET.slice(0, 15)}`)
    const { rows: [buffer] } = await pool.query(`select * from run_mask_buffers where "runId"=$1`, [runId])
    assert.ok(buffer && !JSON.stringify(buffer).includes(SECRET.slice(0, 15)), 'buffer row is ciphertext')
    await send(1, `x ${SECRET.slice(0, 15)}`)
    await send(2, `${SECRET.slice(15)} y`)
    const { rows } = await pool.query(`select chunk->>'delta' as d from run_chunks where "runId"=$1 order by seq`, [runId])
    assert.deepEqual(rows.map(row => row.d), ['x ', '[secret:API_TOKEN] y'])
  })

  await t.test('F: PATCH error, checkpoint text, report, artifact, read back masked', async () => {
    const runId = await newRun()
    const runRoute = await import('../app/v1/runs/[runId]/route')
    const patch = await runRoute.PATCH(call('PATCH', `/v1/runs/${runId}`, { state: 'running', error: `boom ${SECRET}` }), { params: Promise.resolve({ runId }) })
    assert.equal(patch.status, 204)
    const { rows: [run] } = await pool.query(`select error from agent_runs where id=$1`, [runId])
    assert.equal(run.error, 'boom [secret:API_TOKEN]')

    const checkpoint = await import('../app/v1/runs/[runId]/checkpoint/route')
    const diff = `--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+API_TOKEN=${SECRET}\n`
    const cp = await checkpoint.POST(call('POST', `/v1/runs/${runId}/checkpoint`, { baseCommit: 'a'.repeat(40), patch: gzipSync(diff).toString('base64'), files: 1, takenAt: new Date().toISOString() }), { params: Promise.resolve({ runId }) })
    assert.equal(cp.status, 204, await cp.clone().text())
    const { rows: [saved] } = await pool.query(`select patch, files from run_checkpoints where "runId"=$1`, [runId])
    noPlain('checkpoint', gunzipSync(saved.patch).toString('utf8'))
    assert.ok(gunzipSync(saved.patch).toString('utf8').includes('+API_TOKEN=[secret:API_TOKEN]'))

    const bomb = await checkpoint.POST(call('POST', `/v1/runs/${runId}/checkpoint`, { baseCommit: 'a'.repeat(40), patch: Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]).toString('base64'), files: 1, takenAt: new Date().toISOString() }), { params: Promise.resolve({ runId }) })
    assert.equal(bomb.status, 422, 'a gzip stream that cannot be inflated is refused, not stored unmasked')

    const worker = await import('../lib/mcp/worker')
    await worker.report({ id: runId, userId: admin, botId: null, issueId: null }, `done, used ${SECRET}`).catch(afterOnly)
    const { rows: reports } = await pool.query(`select * from coordinator_events where "userId"=$1`, [admin])
    assert.ok(reports.length > 0, 'report stored')
    noPlain('report', JSON.stringify(reports))
    assert.ok(JSON.stringify(reports).includes('[secret:API_TOKEN]'))

    const artifacts = await import('../lib/mcp/artifacts')
    const submitter = await artifacts.runSubmitter({ id: runId, userId: admin, issueId: null })
    await artifacts.submit(submitter, { title: `t ${SECRET}`, kind: 'markdown', content: `body ${SECRET}` }).catch(afterOnly)
    const { rows: arts } = await pool.query(`select a.title, v.* from artifacts a join artifact_versions v on v."artifactId"=a.id where a."userId"=$1`, [admin])
    assert.ok(arts.length > 0, 'artifact stored')
    noPlain('artifact', JSON.stringify(arts))
  })

  await t.test('F: a real DrizzleQueryError from the masked write path carries no params', async () => {
    const { persistRunEventBatch } = await import('../lib/secrets/run-events')
    const mask = await runtime.workspaceSecretMasker(ws.id)
    const missingRun = randomUUID()
    const error = await persistRunEventBatch(missingRun, 1, [{ type: 'data-x', data: `v ${SECRET}` }], mask).then(() => null, (e: unknown) => e)
    assert.ok(error, 'FK violation expected')
    const seen = `${String(error)} ${(error as Error).stack} ${JSON.stringify(error)} ${String((error as { cause?: unknown }).cause)}`
    assert.ok(!seen.includes(SECRET), 'masked before the query: the secret is not in the error')
  })

  await t.test('A: an unmasked lastReply built directly (stored text + new delta) is masked on rebuild', async () => {
    const { persistRunEventBatch } = await import('../lib/secrets/run-events')
    const mask = await runtime.workspaceSecretMasker(ws.id)
    const runId = await newRun()
    // Plaintext written straight into the row (as a pre-masking deploy would have), same part id.
    await pool.query(`update agent_runs set "lastReply"=$2, "lastReplyPart"='p1' where id=$1`, [runId, `here ${SECRET}`])
    await persistRunEventBatch(runId, 1, [{ type: 'text-delta', id: 'p1', delta: ' more' }, { type: 'text-end', id: 'p1' }], mask)
    const { rows: [run] } = await pool.query(`select "lastReply" from agent_runs where id=$1`, [runId])
    noPlain('lastReply', run.lastReply)
    assert.equal(run.lastReply, 'here [secret:API_TOKEN] more')
  })

  await t.test('subagent: step / needs from the model are masked in bot_subagents and subagent_events', async () => {
    const { SubagentStore } = await import('../lib/cloud-computer/subagents')
    const subagents = new SubagentStore(pool)
    const actor = { userId: admin, workspaceId: ws.id }
    const bot = await seedBot(pool, ws.id, admin)
    const created = await subagents.create(actor, bot, 'look up the order')
    await pool.query(`update bot_subagents set status='running' where id=$1`, [created.id])
    await subagents.update(actor, bot, created.id, 'needs_you', `typed ${SECRET} into the form`, { kind: 'approval', actionId: randomUUID(), summary: `confirm ${SECRET}` })
    const { rows: [row] } = await pool.query(`select step,needs from bot_subagents where id=$1`, [created.id])
    noPlain('bot_subagents', JSON.stringify(row))
    assert.match(row.step, /\[secret:API_TOKEN\]/)
    const { rows: events } = await pool.query(`select event from subagent_events where "subagentId"=$1`, [created.id])
    assert.ok(events.length > 0, 'an event was published')
    noPlain('subagent_events', JSON.stringify(events))
    assert.match(JSON.stringify(events), /\[secret:API_TOKEN\]/)
  })

  await t.test('subagent: a secret in the task itself is masked in every published subagent_event (D1)', async () => {
    const { SubagentStore } = await import('../lib/cloud-computer/subagents')
    const subagents = new SubagentStore(pool)
    const actor = { userId: admin, workspaceId: ws.id }
    const bot = await seedBot(pool, ws.id, admin)
    const created = await subagents.create(actor, bot, `deploy with ${SECRET} please`)
    await pool.query(`update bot_subagents set status='running' where id=$1`, [created.id])
    await subagents.update(actor, bot, created.id, 'needs_you', 'waiting on the form', { kind: 'approval', actionId: randomUUID(), summary: 'confirm the deploy' })
    const { rows: events } = await pool.query(`select event from subagent_events where "subagentId"=$1`, [created.id])
    assert.ok(events.length > 0, 'an event was published')
    noPlain('subagent_events (task)', JSON.stringify(events))
    for (const { event } of events) assert.match(String(event.data.task), /\[secret:API_TOKEN\]/)
  })

  await t.test('mailbox: a run\'s peer message is masked in run_messages and coordinator_events', async () => {
    // The mailbox schema is still review-only (docs/backend/personal-mailbox-schema.review.sql), so the
    // write goes to a throwaway local _e2e database with that SQL applied, never to the shared test DB.
    const { maskWorkerMailboxInput } = await import('../lib/personal-mailbox-runtime')
    const { SessionMailbox } = await import('../lib/session-mailbox')
    const { execFileSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    const base = new URL(dbUrl!)
    const name = `mailbox_mask_${randomBytes(8).toString('hex')}_e2e`
    const throwaway = new URL(base); throwaway.pathname = `/${name}`
    await pool.query(`create database ${name}`)
    const mailboxPool = new Pool({ connectionString: throwaway.toString(), max: 3 })
    try {
      execFileSync(process.execPath, ['scripts/setup-e2e-db.mjs'], { env: { ...process.env, E2E_DATABASE_URL: throwaway.toString() }, stdio: 'ignore' })
      await mailboxPool.query(readFileSync('docs/backend/personal-mailbox-schema.review.sql', 'utf8'))
      const runId = await newRun()
      const input = await maskWorkerMailboxInput(runId, { to: '', key: randomUUID(), text: `use ${SECRET} for the deploy` }) as { to: string; key: string; text: string }
      // Same ids in the throwaway DB, so the run is live there too.
      await mailboxPool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [admin, `${admin}@example.invalid`])
      await mailboxPool.query(`insert into devices (id,name,"ownerId",kind,enabled) values ($1,'cloud',$2,'cloud',true)`, [device, admin])
      await mailboxPool.query(`insert into agents (id,"userId",harness,name) values ($1,$2,'codex','a')`, [agent, admin])
      await mailboxPool.query(`insert into agent_runs (id,"agentId","userId","deviceId",status,"leaseExpiresAt") values ($1,$2,$3,$4,'running',now()+interval '10 minutes')`, [runId, agent, admin, device])
      const mailbox = new SessionMailbox(mailboxPool, ws.id)
      const sender = await mailbox.run(admin, runId)
      const coordinator = await mailbox.conversation(admin, 'coordinator')
      await mailbox.send(sender, { ...input, to: coordinator.mailboxId })
      const { rows: messages } = await mailboxPool.query(`select text from run_messages where "senderMailboxId"=$1`, [sender.mailboxId])
      assert.equal(messages.length, 1)
      noPlain('run_messages', JSON.stringify(messages))
      assert.equal(messages[0].text, 'use [secret:API_TOKEN] for the deploy')
      const { rows: events } = await mailboxPool.query(`select payload from coordinator_events where "runId"=$1`, [runId])
      noPlain('coordinator_events', JSON.stringify(events))
    } finally {
      await mailboxPool.end()
      await pool.query(`drop database if exists ${name} with (force)`)
    }
  })

  // E is covered in lib/agent-tool-approval/store.db.test.ts (needs that suite's policy fixture).
})
