// Opt-in item 9: real local daemons, normal owner APIs, unchanged lease/cron.
// SQL is read-only evidence in the runner's disposable database. This does not
// prove the separate 45-minute online-progress watchdog or production custody.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertFlashTestModel } from '../test-model-policy.mjs'
import { ownedDaemonGroups, processTable, suspendOwnedDaemon } from './daemon-fault.mjs'

const ended = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const sha256 = value => createHash('sha256').update(value).digest('hex')

export const daemonStatus = (root, dataDir) => JSON.parse(execFileSync(join(root, 'packages/daemon/node_modules/.bin/tsx'),
  [join(root, 'packages/daemon/bin/mikka.ts'), 'daemon', 'status', '--data-dir', dataDir],
  { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'] }))

export function assertHandoffConfiguration({ existing, platform, revision, expectedSource }) {
  assert.ok(!existing, 'Item 9 must own its fresh local stack; --existing cannot suspend another runner\'s daemon')
  assert.equal(platform, 'linux', 'Item 9 requires Linux process-tree ownership evidence')
  assert.match(revision, /^[a-f0-9]{40}$/, 'Item 9 source must be an immutable commit')
  assert.equal(expectedSource, revision, 'Item 9 requires the reviewed immutable LOCAL_LOOP_EXPECTED_SOURCE_SHA')
}

/** daemon.status.server is a connectivity enum, not the configured URL.
 * The owned launcher/descriptor pins the URL; RPC binds this process to its
 * private data directory and the device returned by the normal owner API. */
export function assertOnlineDaemonStatus(status, { dataDir, deviceId }) {
  assert.equal(status.server, 'online', 'The daemon must be connected to its configured server')
  assert.equal(status.signedIn, true)
  assert.equal(resolve(status.dataDir), resolve(dataDir), 'Daemon RPC returned another data directory')
  assert.ok(typeof status.deviceId === 'string' && status.deviceId.length, 'The daemon needs its own approved device')
  if (deviceId !== undefined) assert.equal(status.deviceId, deviceId)
}

// A heartbeat registers the owner-visible device before syncPass finishes
// loading repos and marks RPC server=online. Both observations are required.
export async function waitForOnlineDaemonStatus({ root, dataDir, deviceId, until, devices,
  readStatus = () => daemonStatus(root, dataDir), timeoutMs = 60_000, now = Date.now }) {
  const deadline = now() + timeoutMs
  let observed = 'RPC not listening'
  return until(async () => {
    assert.ok(now() < deadline, `Daemon readiness timed out after ${timeoutMs}ms (${observed})`)
    let value
    try { value = await readStatus() } catch (error) {
      // This is the CLI's explicit socket-not-created response. Authentication,
      // malformed protocol, RPC timeout and owner API failures must surface.
      if (error.status === 1 && String(error.stderr).trim() === `No daemon running for ${dataDir}`) return null
      throw error
    }
    assert.equal(resolve(value.dataDir), resolve(dataDir), 'Daemon RPC returned another data directory')
    if (deviceId !== undefined && value.deviceId != null) assert.equal(value.deviceId, deviceId)
    assert.ok(['unregistered', 'offline', 'online'].includes(value.server), 'Unexpected daemon server state')
    observed = `server=${value.server}, signedIn=${value.signedIn}`
    if (value.server !== 'online' || !value.signedIn || !value.deviceId) return null
    assertOnlineDaemonStatus(value, { dataDir, deviceId })
    const ownerOnline = (await devices()).some(entry => entry.id === value.deviceId && entry.online)
    observed += `, ownerDeviceOnline=${ownerOnline}`
    return ownerOnline ? value : null
  })
}

export function assertHandoffEvidence({ original, retry, task, receipt, ownerId, deviceB, marker }) {
  assert.equal(retry.retryOf, original.id, 'B must claim the server-created retry of A')
  assert.equal(retry.userId, ownerId)
  assert.equal(retry.issueId, original.issueId)
  assert.equal(retry.deviceId, deviceB)
  assert.notEqual(retry.deviceId, original.deviceId)
  assert.ok(retry.startedAt && retry.sessionId, 'B must actually start a native execution')
  assertFlashTestModel(retry.agentDefinition?.model)
  const before = original.agentDefinition?.executionIdentity
  const after = retry.agentDefinition?.executionIdentity
  assert.ok(before && after, 'Both executions must carry their frozen identity')
  for (const field of ['requester', 'executionPrincipal', 'outputOwner', 'botId', 'botOwner', 'workspaceId', 'personalResourcePolicy']) assert.deepEqual(after[field], before[field], `Handoff changed ${field}`)
  assert.deepEqual(after.billingAccount.model, before.billingAccount.model, 'Handoff changed model payer')
  assert.equal(after.billingAccount.runtime.ownerId, before.billingAccount.runtime.ownerId)
  assert.equal(after.billingAccount.runtime.resourceId, deviceB)
  assert.ok(after.resourceBindings.some(binding => binding.kind === 'device' && binding.id === deviceB && binding.ownerId === ownerId))
  const handoff = receipt.result
  assert.equal(receipt.request.kind, 'task_handoff')
  assert.match(receipt.request.digest, /^[a-f0-9]{64}$/)
  assert.equal(handoff.taskId, task.id)
  assert.equal(handoff.requestEpoch, task.sourceEventId)
  assert.equal(handoff.goal.sourceEventId, task.sourceEventId)
  assert.ok(handoff.goal.text.includes(marker), 'Handoff lost the current owner target')
  assert.equal(handoff.ownerId, ownerId)
  assert.equal(handoff.checkpoint?.runId, original.id)
  assert.ok(handoff.checkpoint.files > 0 && !handoff.checkpoint.unavailableReason, 'Handoff must carry an available real checkpoint')
  assert.ok(Array.isArray(handoff.completed) && handoff.pending && handoff.constraints && handoff.nextAction)
  assert.ok(Array.isArray(handoff.risks) && handoff.risks.length)
  for (const field of ['effects', 'publications', 'operations']) assert.ok(Array.isArray(handoff.externalEffects?.[field]), `Handoff omitted ${field} receipts`)
  assert.ok(!handoff.externalEffects.effects.some(effect => ['reserved', 'uncertain'].includes(effect.status)), 'Uncertain external effects must block replay')
  assert.ok(!handoff.externalEffects.publications.some(effect => effect.status === 'processing'), 'A publication is still in flight')
  assert.ok(!handoff.externalEffects.operations.some(effect => ['executing', 'uncertain'].includes(effect.status)), 'An operation is still in flight')
  assert.ok(retry.prompt.includes(receipt.request.digest) && retry.prompt.includes('Host task handoff'), 'B was not given this persisted handoff')
  return handoff
}

export async function verifyFactoryHandoff(context) {
  const { root, directory, runtime, ownerId, device, signal, progress, query, json, until, run, dispatch, terminal,
    factoryApproval, observations, startSecondDaemon, stackPid, registerCleanup } = context
  const marker = `handoff-${randomUUID()}`, filename = `${marker}.txt`, expected = Buffer.from(`${marker}\n`)
  const evidence = { version: 1, marker, status: 'running', startedAt: new Date().toISOString(),
    daemonStallMinutes: context.daemonStallMinutes ?? 10,
    boundaries: ['Real DeepSeek Flash via normal account authorization', 'Real daemons and unchanged 90s leases/minute cron',
      'Disposable local database; SELECT evidence only', 'Local fixture GitHub and real bare Git publication',
      'Offline handoff only; not the 45-minute online-stall watchdog or production acceptance'] }
  const record = async (phase, data = {}) => {
    Object.assign(evidence, data, { phase, updatedAt: new Date().toISOString() })
    await writeFile(join(directory, 'item9-handoff.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
    await progress('item9-factory-handoff', phase)
  }
  const status = dataDir => daemonStatus(root, dataDir)
  const online = (dataDir, deviceId) => waitForOnlineDaemonStatus({ root, dataDir, deviceId, until,
    devices: async () => (await json('/api/mobile/threads')).devices ?? [] })
  let fault
  registerCleanup(() => fault?.resume())
  try {
    const owned = JSON.parse(await readFile(join(root, '.cache/dev-local/owned-daemon.json'), 'utf8'))
    assert.equal(owned.parentPid, stackPid, 'A must belong to this runner\'s stack')
    assert.equal(owned.server, runtime.server)
    assert.equal(resolve(owned.dataDir), resolve(runtime.daemonDataDir))
    const aStatus = await online(runtime.daemonDataDir, device.id)
    ownedDaemonGroups(await processTable(), { ...owned, daemonPid: aStatus.pid, forbiddenPids: [process.pid, stackPid] })
    // A cloud source would legitimately take precedence over local B. Do not
    // disable or edit one merely to force this acceptance outcome.
    const [cloud] = await query(`SELECT EXISTS(SELECT 1 FROM user_e2b_keys WHERE "userId"=$1)
      OR EXISTS(SELECT 1 FROM workspace_e2b_keys WHERE "createdBy"=$1) AS present`, [ownerId])
    assert.equal(cloud.present, false, 'Use a dedicated ordinary owner without an E2B source for the dual-local-device case')
    const b = await startSecondDaemon()
    const bStatus = await online(b.dataDir)
    assert.notEqual(bStatus.deviceId, aStatus.deviceId, 'A and B need independent approved device IDs')
    assertOnlineDaemonStatus(bStatus, { dataDir: b.dataDir })
    await record('two-authorized-devices', { deviceA: device.id, deviceB: bStatus.deviceId })
    const priorPrs = new Set((await observations()).pullRequests.map(pr => pr.number))
    const brief = `Create a new task on device ${device.name} (deviceId ${device.id}), harness Claude Code, repository https://github.com/mikka-e2e/core-loop.git, newThread:true, readOnly:false. Preserve the entire brief in the worker prompt and dispatch now.
Owner acceptance marker ${marker}. Create ${filename} with exactly one UTF-8 line: ${marker} followed by a newline. This is the sole repository change.
On the ORIGINAL execution only, create that file and then run one finite sleep 300 before committing, pushing or creating a PR. This pause allows the host's normal checkpoint capture. Do not finish before the finite wait.
If the host provides a retry/Host task handoff, do NOT repeat the sleep: inspect the restored checkpoint and existing publication receipts, keep the same exact file bytes, then complete the task. Never append a duplicate line or repeat an already completed push/PR. Use normal review/verification and existing permissions; do not ask to change authorization. Publish one PR for this task.`
    const originalId = await dispatch('item9', brief)
    const original = await until(async () => {
      const value = await run(originalId)
      assert.ok(!ended.has(value?.status), `A ended before the real fault checkpoint (${value?.status})`)
      return value?.sessionId && value.status === 'running' ? value : null
    })
    assert.equal(original.deviceId, device.id, 'Initial execution must run on A')
    assertFlashTestModel(original.agentDefinition?.model)
    const [linked] = await query(`SELECT t.id FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1 AND t."userId"=$2`, [original.id, ownerId])
    assert.ok(linked, 'The normal dispatch must have a real Factory Task')
    const task = (await json(`/api/factory/tasks/${linked.id}`)).task
    assert.equal(task.issueId, original.issueId)
    await record('a-running', { taskId: task.id, requestEpoch: task.sourceEventId, originalRunId: original.id, sessionA: original.sessionId })
    const checkpoint = await until(async () => {
      const current = await run(original.id)
      assert.ok(!ended.has(current.status), 'A ended before its checkpoint was captured')
      assert.notEqual(current.publication, 'published', 'Fault must happen before A publishes')
      const local = status(runtime.daemonDataDir).runs.find(entry => entry.runId === original.id)
      if (!local?.worktree) return null
      assert.ok(resolve(local.worktree).startsWith(`${resolve(runtime.daemonDataDir)}${sep}`), 'A worktree escaped its owned data directory')
      const bytes = await readFile(join(local.worktree, filename)).catch(() => null)
      if (!bytes?.equals(expected)) return null
      return (await query('SELECT "baseCommit",files,"updatedAt","unavailableReason" FROM run_checkpoints WHERE "runId"=$1 AND "userId"=$2 AND files>0', [original.id, ownerId]))[0]
    })
    assert.ok(!checkpoint.unavailableReason)
    const latestA = await run(original.id)
    assert.ok(latestA.leaseExpiresAt && new Date(latestA.leaseExpiresAt).getTime() > Date.now(), 'A needs a live natural lease before suspension')
    fault = await suspendOwnedDaemon({ ...owned, daemonPid: aStatus.pid, forbiddenPids: [process.pid, stackPid, b.pid, bStatus.pid] })
    // Freeze first, then read the final lease: an already in-flight heartbeat
    // may have renewed it after the pre-suspension observation.
    await delay(1_000, undefined, { signal })
    const suspendedA = await run(original.id)
    await record('a-suspended', { checkpoint: { baseCommit: checkpoint.baseCommit, files: checkpoint.files, capturedAt: checkpoint.updatedAt },
      leaseExpiresAt: suspendedA.leaseExpiresAt, fault: { kind: 'SIGSTOP owned daemon tree', at: fault.suspendedAt, groups: fault.groups, processes: fault.processes } })
    const retry = await until(async () => {
      const rows = await query('SELECT * FROM agent_runs WHERE "retryOf"=$1 AND "userId"=$2 ORDER BY "createdAt"', [original.id, ownerId])
      assert.ok(rows.length <= 1, 'One lost execution produced duplicate retries')
      if (!rows.length) return null
      assert.ok(!['failed', 'stopped', 'cancelled'].includes(rows[0].status), 'B retry failed before actual execution')
      return rows[0].startedAt && rows[0].sessionId ? rows[0] : null
    })
    assert.ok(new Date(retry.createdAt) >= new Date(suspendedA.leaseExpiresAt), 'Retry bypassed the unchanged lease expiry')
    const finalA = await run(original.id)
    assert.equal(finalA.stopReason, 'device_lost')
    const currentTask = (await json(`/api/factory/tasks/${task.id}`)).task
    assert.equal(currentTask.sourceEventId, task.sourceEventId, 'Offline recovery must not create a new owner target')
    const receipts = await query(`SELECT request,result FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_handoff' ORDER BY "createdAt" DESC`, [task.id])
    const receipt = receipts.find(entry => retry.prompt.includes(entry.request.digest) && entry.result.checkpoint?.runId === original.id)
    assert.ok(receipt, 'Missing persisted handoff used by B')
    const handoff = assertHandoffEvidence({ original, retry, task, receipt, ownerId, deviceB: bStatus.deviceId, marker })
    const claimed = status(b.dataDir).runs.find(entry => entry.runId === retry.id)
    assert.ok(claimed?.sessionId && claimed.worktree, 'B daemon RPC must confirm the native claim')
    await record('b-claimed', { retryRunId: retry.id, sessionB: claimed.sessionId, handoff: { digest: receipt.request.digest,
      goalSha256: sha256(handoff.goal.text), checkpoint: handoff.checkpoint, pending: handoff.pending,
      externalEffects: Object.fromEntries(Object.entries(handoff.externalEffects).map(([name, rows]) => [name, rows.map(row => ({ status: row.status, runId: row.runId }))])) } })
    await fault.resume()
    await until(async () => {
      const local = status(runtime.daemonDataDir).runs.find(entry => entry.runId === original.id)
      return local && ended.has(local.state) ? local : null
    })
    assert.equal((await run(original.id)).stopReason, 'device_lost', 'Resumed A rewrote the host fence')
    const done = await terminal(retry.id)
    assert.equal(done.status, 'succeeded', 'B must complete the real worker task')
    const published = await until(async () => { const value = await run(retry.id); return value.publication === 'published' && value.pullRequest ? value : null })
    assert.ok(done.report?.publish?.pushed && done.report.publish.commit, 'B did not push its artifact')
    const bytes = execFileSync('git', ['--git-dir', runtime.scenario.barePath, 'show', `${done.report.publish.commit}:${filename}`])
    assert.deepEqual(bytes, expected, 'Published artifact has incorrect or duplicate bytes')
    const checked = await factoryApproval(retry.id)
    assert.equal(checked.id, task.id)
    assert.equal(checked.sourceEventId, task.sourceEventId)
    const approval = await json(`/api/factory/tasks/${task.id}/approval`)
    assert.equal(approval.manifest.candidate.sha, done.report.publish.commit, 'Human acceptance must read the exact B artifact')
    const ledger = await json(`/api/factory/tasks/${task.id}/approval?view=ledger`)
    const acceptance = { operation: 'accept', input: { binding: ledger.binding, eventId: randomUUID() } }
    const accepted = await until(async () => {
      const result = await json(`/api/factory/tasks/${task.id}/approval`, acceptance)
      return result.status === 'merging' ? null : result
    })
    assert.equal(accepted.status, 'merged', 'Normal human API must accept the independently verified repository candidate')
    const countEffects = async () => {
      const publications = await query('SELECT "runId",status,"pullRequest" FROM run_publications WHERE "userId"=$1 AND "issueId"=$2 AND status=\'published\'', [ownerId, original.issueId])
      assert.equal(publications.length, 1, 'Task published more than once')
      assert.equal(publications[0].runId, retry.id, 'The fenced A published an effect')
      const prs = (await observations()).pullRequests.filter(pr => !priorPrs.has(pr.number))
      assert.equal(prs.length, 1, 'Fixture observed duplicate PR publication')
      assert.equal(prs[0].url, published.pullRequest.url, 'The sole new PR must be B\'s accepted publication')
      const retries = await query('SELECT id FROM agent_runs WHERE "retryOf"=$1 AND "userId"=$2', [original.id, ownerId])
      assert.deepEqual(retries.map(row => row.id), [retry.id])
      return { publications: publications.length, pullRequests: prs.length, retries: retries.length }
    }
    const effects = await countEffects()
    await record('accepted', { artifact: { filename, bytes: bytes.length, sha256: sha256(bytes), commit: done.report.publish.commit },
      pullRequest: published.pullRequest.url, mergeId: accepted.mergeId, effects })
    // Observe another normal minute schedule after A resumed; do not invoke a
    // private sweeper or shorten production heartbeat/lease/watchdog constants.
    await delay(65_000, undefined, { signal })
    assert.deepEqual(await countEffects(), effects)
    assert.equal((await json(`/api/factory/tasks/${task.id}`)).task.sourceEventId, task.sourceEventId)
    await record('passed', { status: 'passed', finishedAt: new Date().toISOString() })
  } catch (error) {
    await record('failed', { status: 'failed', error: { name: error.name, code: error.code ?? null }, finishedAt: new Date().toISOString() })
    throw error
  } finally { await fault?.resume() }
}
