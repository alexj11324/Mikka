import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { loadEnvironment, assertDeploymentIdentity } from '../test-accounts/environment.mjs'
import { acquireTestAccounts, recordAuthenticationSecrets } from '../test-accounts/session.mjs'
import { TestAccountPool } from '../test-accounts/pool.mjs'
import { authorizeMcpSession } from '../../tests/support/mcp-closeout-session.mjs'

// The producer is the real authenticated Mikka MCP API. Only its external
// workflow-start transport is deliberately failed; the real durable recovery
// clock, production inbox consumer, database and chat API are not substituted.
// This is not model inference or a native coding-CLI completion claim.
const runnerRoot = fileURLToPath(new URL('../../', import.meta.url))
const sourceRoot = resolve(process.env.MIKKA_WAKE_SOURCE_ROOT ?? runnerRoot)
const source = path => import(pathToFileURL(join(sourceRoot, path)).href)
const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
const applicationSha = environment.deploymentSha
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), applicationSha)
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), '')
const evidence = await mkdtemp('/tmp/mikka-wake176-consumer-')
const database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 12 })
const { createWakeRecovery, deliverWake, WAKE_BACKOFF_MS } = await source('lib/coordinator/wake-recovery.ts')
const { hasWakingEvents, untriagedEvents } = await source('lib/coordinator/store.ts')
const sourcePool = (await source('lib/db/index.ts')).pool
const workspacePool = (await source('lib/workspace-db.ts')).workspacePool
let scope, passed = false
const observations = []
const mark = (phase, fields = {}) => { observations.push({ phase, at: new Date().toISOString(), ...fields }); console.log(phase) }
const recovery = createWakeRecovery(database)
async function consumer(userId) {
  const code = `import assert from 'node:assert/strict';
    const {takeInbox,releaseLease}=await import('./lib/coordinator/store.ts');
    const user=process.env.WAKE_CONSUMER_OWNER,holders=Array.from({length:10},()=>crypto.randomUUID());
    const takes=await Promise.all(holders.map(holder=>takeInbox(user,holder)));
    const added=takes.reduce((n,t)=>n+t.added,0);
    assert.ok(added===0||added===1);
    await Promise.all(takes.flatMap((take,index)=>take.held?[releaseLease(user,holders[index])]:[]));
    const {pool}=await import('./lib/db/index.ts');
    console.log(JSON.stringify({added}));await pool.end();
    const workspace=(await import('./lib/workspace-db.ts')).workspacePool;if(workspace!==pool)await workspace.end();`
  const child = spawn(process.execPath, ['--import', join(sourceRoot, 'scripts/server-test.mjs'), '--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: sourceRoot, env: { ...process.env, WAKE_CONSUMER_OWNER: userId }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { errors += value })
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer)
  assert.equal(exit, 0, 'The actual inbox consumer process must succeed')
  // stderr is private diagnostic evidence, not copied into the public result.
  await writeFile(join(evidence, `consumer-${randomUUID()}.log`), errors, { mode: 0o600 })
  return JSON.parse(output.trim())
}
try {
  // The normal helper renews this existing maximum five-minute lease while
  // the seven real elapsed minutes of backoff pass; no TTL guard is changed.
  await new TestAccountPool(database, environment).prepare({ pairs: Number(process.env.MIKKA_WAKE_ACCOUNT_PAIRS ?? '4') })
  scope = await acquireTestAccounts({ database, environment, runId: `wake176-${randomUUID()}`, workerId: 'actual-consumer', requestId: randomUUID(), ttlMs: 300_000 })
  const mcp = await authorizeMcpSession(scope.owner, environment, values => recordAuthenticationSecrets(values, { environment }))
  const marker = `Controlled CPU coordination result ${randomUUID()}`
  const digest = createHash('sha256').update(marker).digest('hex')
  const text = `${marker}; SHA-256=${digest}. This is a non-model protocol task result, not native CLI inference.`
  assert.equal((await mcp.call('send_to_coordinator', { text })).queued, true)
  const rows = (await database.query('SELECT id,tier,"createdAt","botId" FROM coordinator_events WHERE "userId"=$1 AND kind=\'run_report\' AND payload->>\'text\'=$2', [scope.owner.userId, text])).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tier, 'result', 'Only the existing host-classified peer-report path is used')
  // The message goes to the person's Coordinator, an ordinary bot row.
  assert.ok(rows[0].botId, 'the Coordinator chat is keyed by its bot row')
  const eventId = rows[0].id, wakeScope = { userId: scope.owner.userId, botId: rows[0].botId }
  mark('normal-mcp-producer-committed-result-event', { eventId, userId: scope.owner.userId, applicationSha })
  const started = performance.now()
  for (let index = 0; index < 3; index++) {
    const claims = await Promise.all(Array.from({ length: 10 }, () => recovery.claim(wakeScope)))
    const claim = claims.filter(Boolean)
    assert.equal(claim.length, 1)
    assert.equal(await deliverWake(claim[0], {
      triage: async value => { assert.equal((await untriagedEvents(value.userId)).length, 0) },
      hasWaking: value => hasWakingEvents(value.userId),
      start: async () => { throw new Error('Controlled workflow-start transport failure') },
      failed: recovery.failed,
    }), 'failed')
    const row = (await database.query('SELECT "wakeAttempts","nextWakeAt","wakeLastError","deliveredAt" FROM coordinator_events WHERE id=$1', [eventId])).rows[0]
    assert.equal(row.wakeAttempts, index + 1)
    assert.equal(row.wakeLastError, 'wake_failed')
    assert.equal(row.deliveredAt, null)
    const remaining = row.nextWakeAt.getTime() - Date.now()
    assert.ok(remaining > WAKE_BACKOFF_MS[index] - 5000 && remaining <= WAKE_BACKOFF_MS[index])
    mark('actual-backoff-persisted', { attempt: row.wakeAttempts, nextWakeAt: row.nextWakeAt.toISOString(), remainingMs: remaining })
    while (Date.now() < row.nextWakeAt.getTime()) await delay(Math.min(20_000, row.nextWakeAt.getTime() - Date.now()))
  }
  const replacement = createWakeRecovery(database)
  assert.ok((await replacement.due()).some(value => value.userId === wakeScope.userId && value.botId === wakeScope.botId))
  const claim = await replacement.claim(wakeScope)
  assert.ok(claim)
  assert.equal(claim.attempt, 4)
  assert.equal(await deliverWake(claim, {
    triage: async value => { assert.equal((await untriagedEvents(value.userId)).length, 0) },
    hasWaking: value => hasWakingEvents(value.userId),
    start: async value => { assert.equal((await consumer(value.userId)).added, 1) },
    failed: replacement.failed,
  }), 'started')
  assert.equal((await consumer(scope.owner.userId)).added, 0, 'Restarted consumer cannot consume the event again')
  assert.equal(await replacement.claim(wakeScope), null)
  assert.equal(await replacement.replay(eventId), false)
  const row = (await database.query('SELECT "wakeAttempts","deliveredAt" FROM coordinator_events WHERE id=$1', [eventId])).rows[0]
  assert.equal(row.wakeAttempts, 4); assert.ok(row.deliveredAt)
  const chat = await scope.owner.request('/api/coordinator/messages')
  assert.equal(chat.status, 200)
  const view = await chat.json(), matching = view.items.filter(item => item.from === 'event' && item.text.includes(marker))
  assert.equal(matching.length, 1)
  assert.ok(matching[0].text.includes(digest))
  const peer = await scope.peer.request('/api/coordinator/messages')
  assert.equal(peer.status, 200); assert.ok(!(await peer.text()).includes(marker))
  const elapsedMs = performance.now() - started
  assert.ok(elapsedMs >= WAKE_BACKOFF_MS.slice(0, 3).reduce((a, b) => a + b, 0))
  mark('actual-consumer-and-chat-readback-once-after-three-real-failures', { eventId, elapsedMs, eventDeliveries: matching.length, wakeAttempts: row.wakeAttempts })
  passed = true
} finally {
  if (scope) await scope.release({ outcome: 'dirty' })
  await database.end(); await sourcePool.end(); if (workspacePool !== sourcePool) await workspacePool.end()
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed, applicationSha,
    runnerSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runnerRoot, encoding: 'utf8' }).trim(),
    origin: environment.origin, observations,
    boundaries: ['Real authenticated MCP peer-report producer, real wall-clock backoff, production takeInbox consumer and real owner/peer chat HTTP readback', 'Controlled workflow-start transport failure/consumer subprocess; not the hosted Workflow SDK worker or a model turn', 'No native CLI inference, run_finished model classification, real SaaS business write or complete #176 acceptance is claimed'],
  }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ passed, evidence }))
}
