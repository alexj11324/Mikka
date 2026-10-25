import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Pool } from 'pg'

const origin = process.env.WAKE_HTTP_ORIGIN ?? 'http://127.0.0.1:3176',
  url = process.env.WAKE_TEST_DATABASE_URL
const secret = process.env.WAKE_TEST_AUTH_SECRET,
  cron = process.env.WAKE_TEST_CRON_SECRET,
  control = process.env.WAKE_CONTROL_TOKEN
if (
  new URL(origin).hostname !== '127.0.0.1' ||
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  !new URL(url).pathname.endsWith('_176') ||
  !secret ||
  !cron ||
  !control ||
  process.env.VERCEL ||
  process.env.AI_GATEWAY_API_KEY ||
  process.env.OPENAI_API_KEY
)
  throw new Error('isolated acceptance only')
const pool = new Pool({ connectionString: url }),
  stamp = () => new Date().toISOString(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (data) => console.log(JSON.stringify({ at: stamp(), ...data }))
let transport
const evidence = []
async function start() {
  transport = spawn(process.execPath, ['--import', 'tsx', 'scripts/fixtures/wake-transport.ts'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  transport.stdout.on('data', (d) => process.stdout.write(d))
  transport.stderr.on('data', (d) => process.stderr.write(d))
  await wait(async () => {
    try {
      const r = await fetch('http://127.0.0.1:6176/ready', { headers: { authorization: `Bearer ${control}` } })
      return r.status === 404
    } catch {
      return false
    }
  }, 'transport ready')
}
async function kill() {
  if (!transport) return
  const exited = once(transport, 'exit')
  transport.kill('SIGKILL')
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  transport = null
}
async function identity() {
  const owner = `http176-${randomUUID()}`,
    token = randomUUID()
  await pool.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
    [owner, `${owner}@example.invalid`],
  )
  await pool.query(
    'INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
    [randomUUID(), token, owner],
  )
  return {
    owner,
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)}`,
  }
}
async function request(path, { actor, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${origin}/mikka${path}`, {
    method,
    headers: {
      ...(actor ? { cookie: actor.cookie, origin } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}
async function wait(fn, label, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timeout: ${label}`)
}
async function sweep() {
  const r = await request('/api/cron/runtime', { headers: { authorization: `Bearer ${cron}` } })
  assert.equal(r.status, 200, JSON.stringify(r))
  return r.body
}
const row = async (id) => (await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [id])).rows[0]
async function until(id, state) {
  await wait(async () => {
    await sweep()
    return (await row(id)).wake_status === state
  }, `${id} ${state}`)
}
async function submit(actor) {
  const r = await request('/api/coordinator/messages', {
    actor,
    method: 'POST',
    body: { text: 'Isolated durable wake; no real model.', submissionId: randomUUID() },
  })
  assert.equal(r.status, 202, JSON.stringify(r))
  return r.body.sourceEventId
}
async function assertResult(id, expectedEffects = 1) {
  const event = await row(id)
  assert.equal(event.wake_status, 'completed')
  assert.ok(event.processed_at)
  const messages = (await pool.query('SELECT message FROM coordinator_messages WHERE source_event_id=$1', [id])).rows
  assert.equal(messages.filter((m) => m.message.role === 'assistant').length, 1)
  assert.equal(
    (
      await pool.query('SELECT COALESCE(sum(executions),0)::int n FROM wake_control_effects WHERE operation_id=$1', [
        id,
      ])
    ).rows[0].n,
    expectedEffects,
  )
  evidence.push({
    eventId: id,
    status: event.wake_status,
    attempts: event.wake_attempts,
    processedAt: event.processed_at,
    checkpoint: event.wake_checkpoint_digest,
    effects: expectedEffects,
  })
}
try {
  await wait(async () => {
    try {
      return (await request('/api/auth/get-session')).status === 200
    } catch {
      return false
    }
  }, 'built Next ready')
  await start()
  const actor = await identity(),
    other = await identity()
  assert.equal((await request('/api/auth/get-session', { actor })).body.user.id, actor.owner)
  assert.equal((await request('/api/cron/runtime')).status, 401)
  await pool.query("UPDATE wake_control_settings SET failures=3,phase='normal' WHERE id=1")
  const began = Date.now(),
    id = await submit(actor)
  await wait(async () => {
    await sweep()
    return (await row(id)).wake_attempts >= 3
  }, 'three persisted failed sends')
  const failed = await row(id)
  assert.equal(failed.wake_error, 'wakeTransportUnconfirmed')
  assert.ok(failed.wake_next_at)
  log({
    phase: 'three transport failures persisted; no additional user message',
    eventId: id,
    attempts: failed.wake_attempts,
    nextRetryAt: failed.wake_next_at,
    slaMs: 15000,
  })
  execFileSync('docker', ['restart', 'mikka176-next'], { stdio: 'ignore' })
  await wait(async () => {
    try {
      return (await request('/api/auth/get-session')).status === 200
    } catch {
      return false
    }
  }, 'Next OS restart')
  await until(id, 'completed')
  assert.ok(Date.now() - began < 15000)
  await assertResult(id)
  await Promise.all(Array.from({ length: 10 }, () => sweep()))
  await assertResult(id)
  const visible = await request('/api/coordinator/messages', { actor })
  assert.equal(visible.status, 200)
  assert.match(JSON.stringify(visible.body), /Controlled Workflow transport fixture/)
  assert.equal((await request(`/api/coordinator/events/${id}/wake`, { actor: other })).status, 404)
  log({
    phase: 'real Next restart and ten HTTP sweeps recovered original chat',
    eventId: id,
    elapsedMs: Date.now() - began,
  })
  await pool.query('UPDATE wake_control_settings SET drop_start_ack=true WHERE id=1')
  const lost = await submit(actor)
  await until(lost, 'completed')
  await assertResult(lost)
  for (const phase of ['hold_staged', 'hold_checkpoint', 'hold_result_ack', 'hold_effect']) {
    await pool.query('UPDATE wake_control_settings SET phase=$1 WHERE id=1', [phase])
    const eventId = await submit(actor)
    await wait(async () => {
      const e = await row(eventId)
      return phase === 'hold_staged'
        ? Boolean(e.processing_holder)
        : phase === 'hold_checkpoint'
          ? Boolean(e.wake_checkpoint)
          : phase === 'hold_result_ack'
            ? Boolean(e.processed_at)
            : (await pool.query('SELECT 1 FROM wake_control_effects WHERE operation_id=$1', [eventId])).rowCount > 0
    }, phase)
    await kill()
    log({ phase: 'actual transport consumer SIGKILL', atBoundary: phase, eventId })
    await pool.query("UPDATE wake_control_settings SET phase='normal' WHERE id=1")
    await start()
    if (phase === 'hold_effect') {
      await until(eventId, 'failed')
      assert.equal((await row(eventId)).wake_generation_state, 'uncertain')
      const replay = await request(`/api/coordinator/events/${eventId}/wake`, {
        actor,
        method: 'POST',
        body: { action: 'replay', expectedGeneration: 0 },
      })
      assert.equal(replay.status, 409)
      assert.equal(replay.body.error, 'wakeReconciliationRequired')
      assert.equal(
        (await pool.query('SELECT executions FROM wake_control_effects WHERE operation_id=$1', [eventId])).rows[0]
          .executions,
        1,
      )
      evidence.push({ eventId, status: 'failed', generationState: 'uncertain', effects: 1, replayStatus: 409 })
    } else {
      await until(eventId, 'completed')
      await assertResult(eventId)
    }
  }
  await pool.query('UPDATE wake_control_settings SET failures=5 WHERE id=1')
  const replayId = await submit(actor)
  await until(replayId, 'failed')
  assert.equal(
    (
      await request(`/api/coordinator/events/${replayId}/wake`, {
        actor: other,
        method: 'POST',
        body: { action: 'replay', expectedGeneration: 0 },
      })
    ).status,
    404,
  )
  await pool.query('UPDATE wake_control_settings SET failures=0 WHERE id=1')
  const replay = await request(`/api/coordinator/events/${replayId}/wake`, {
    actor,
    method: 'POST',
    body: { action: 'replay', expectedGeneration: 0 },
  })
  assert.equal(replay.status, 202)
  assert.equal(replay.body.operationId, replayId)
  await until(replayId, 'completed')
  await assertResult(replayId)
  // Formal completion transaction in separate OS processes: before-commit
  // SIGKILL must roll everything back; after-commit SIGKILL must leave all three.
  const device = randomUUID(),
    agent = randomUUID(),
    workspace = '00000000-0000-4000-8000-000000000001',
    deviceToken = randomUUID()
  const hash = createHash('sha256').update(`orvilo-default:${actor.owner}`).digest('hex')
  const actualWorkspace = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'actual default workspace\')', [
    actualWorkspace,
    actor.owner,
  ])
  await pool.query(
    'INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',
    [actualWorkspace, actor.owner, `${actor.owner}@example.invalid`],
  )
  assert.equal(
    (
      await pool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [
        workspace,
        actor.owner,
      ])
    ).rowCount,
    0,
  )
  log({
    phase: 'real default workspace present; protocol sentinel has no fabricated membership',
    actualWorkspace,
    protocolPartition: workspace,
  })
  await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)', [
    randomUUID(),
    actor.owner,
    createHash('sha256').update(deviceToken).digest('hex'),
  ])
  await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'controlled\')', [device, actor.owner])
  await pool.query(
    'INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'controlled\',\'codex\',$3)',
    [agent, actor.owner, device],
  )
  for (const phase of ['before_commit', 'after_commit']) {
    const runId = randomUUID(),
      mailbox = randomUUID()
    await pool.query(
      'INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey") VALUES($1,$2,$3,\'run\',$4)',
      [mailbox, actor.owner, workspace, runId],
    )
    await pool.query(
      'INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"mailboxId") VALUES($1,$2,$3,$4,\'running\',$5)',
      [runId, actor.owner, agent, device, mailbox],
    )
    await pool.query(
      'INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES($1,$2,$3,$4,now()+interval \'1 hour\')',
      [randomUUID(), runId, actor.owner, createHash('sha256').update(randomUUID()).digest('hex')],
    )
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/fixtures/wake-completion.ts'], {
      env: { ...process.env, WAKE_COMPLETION_INPUT: JSON.stringify({ owner: actor.owner, runId, workspace, phase }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const reader = createInterface({ input: child.stdout })
    await once(reader, 'line')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    assert.deepEqual(await exited, [null, 'SIGKILL'])
    reader.close()
    const state = (await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status,
      revoked = (await pool.query('SELECT "revokedAt" FROM run_tokens WHERE "runId"=$1', [runId])).rows[0].revokedAt,
      events = (await pool.query('SELECT id,kind FROM coordinator_events WHERE "runId"=$1', [runId])).rows
    if (phase === 'before_commit') {
      assert.equal(state, 'running')
      assert.equal(revoked, null)
      assert.equal(events.length, 0)
      const completions = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(`/v1/runs/${runId}/complete`, {
            method: 'POST',
            body: { stopReason: 'cancelled' },
            headers: { authorization: `Bearer ${deviceToken}` },
          }),
        ),
      )
      assert.ok(
        completions.every((r) => r.status === 204),
        JSON.stringify(completions),
      )
      const after = (await pool.query('SELECT id,tier FROM coordinator_events WHERE "runId"=$1', [runId])).rows
      assert.equal(after.length, 2)
      const foreground = after.find((e) => e.tier === 'result')
      assert.ok(foreground)
      await until(foreground.id, 'completed')
      await assertResult(foreground.id, 0)
    } else {
      assert.equal(state, 'succeeded')
      assert.ok(revoked)
      assert.equal(events.length, 2)
      const report = events.find((e) => e.kind === 'run_report')
      assert.ok(report)
      await until(report.id, 'completed')
      await assertResult(report.id)
      for (const e of events) {
        assert.equal((await row(e.id)).wake_workspace_id, null)
        assert.equal((await row(e.id)).wake_status, 'completed')
      }
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=ANY($1::uuid[]) AND message->>'role'='assistant'`,
            [events.map((e) => e.id)],
          )
        ).rows[0].n,
        1,
      )
    }
    log({
      phase: 'actual completion process SIGKILL',
      atBoundary: phase,
      runId,
      status: state,
      revoked: Boolean(revoked),
      events: events.map((e) => e.id),
    })
  }
  // Current membership is checked again after a staged consumer dies.
  await pool.query("UPDATE wake_control_settings SET phase='hold_staged' WHERE id=1")
  const scope = randomUUID()
  await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'revocation\')', [scope, actor.owner])
  await pool.query(
    'INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')',
    [scope, actor.owner, `${actor.owner}@example.invalid`],
  )
  const scoped = await request('/api/coordinator/messages', {
    actor,
    method: 'POST',
    body: { text: 'Revoked staged fixture', submissionId: randomUUID(), workspaceId: scope },
  })
  assert.equal(scoped.status, 202)
  const revokedId = scoped.body.sourceEventId
  await wait(async () => Boolean((await row(revokedId)).processing_holder), 'revoked event staged')
  await kill()
  await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1', [scope])
  await pool.query("UPDATE wake_control_settings SET phase='normal' WHERE id=1")
  await start()
  await until(revokedId, 'cancelled')
  assert.equal((await request(`/api/coordinator/events/${revokedId}/wake`, { actor })).status, 403)
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM wake_control_effects WHERE operation_id=$1', [revokedId])).rows[0].n,
    0,
  )
  assert.equal(
    (
      await request('/api/coordinator/messages', {
        actor,
        method: 'POST',
        body: { text: 'Forbidden scope', submissionId: randomUUID(), workspaceId: scope },
      })
    ).status,
    403,
  )
  log({
    phase: 'real HTTP current workspace revocation refused replay/read/new submission',
    eventId: revokedId,
    workspaceId: scope,
    effects: 0,
  })
  log({
    result: 'PASS isolated real Next/PG/process; controlled transport, NOT cloud Workflow/model/harness acceptance',
    evidence,
  })
} finally {
  await kill()
  await pool.end()
}
