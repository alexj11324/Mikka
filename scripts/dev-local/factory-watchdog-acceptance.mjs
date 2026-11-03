// Item 10 isolates the server's unchanged 45-minute execute watchdog. The
// dedicated daemon uses its normal --stall-minutes 60 option (default: 10).
// Only this run's native process tree is suspended; daemon heartbeats and the
// existing minute cron stay live. No timestamps or recovery limits are edited.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertFlashTestModel } from '../test-model-policy.mjs'
import { assertOnlineDaemonStatus, daemonStatus } from './factory-handoff-acceptance.mjs'
import { nativeRunIdentity, ownedDaemonGroups, processTable, suspendOwnedDaemon } from './daemon-fault.mjs'

const EXECUTE_WINDOW_MS = 45 * 60_000
const STALE_CHECKPOINT = 'Checkpoint is older than the thirty-minute recovery window.'
const ended = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const time = value => value == null ? null : new Date(value).getTime()

export function assertOnlineQuietSample(current, baseline, epoch, now = Date.now()) {
  assert.equal(current.sourceEventId, epoch, 'Online recovery changed the owner target')
  assert.equal(current.runStatus, 'running', 'The long-running executor must not enter a legal input wait or end early')
  assert.ok(now - time(current.lastSeenAt) < 60_000, 'A lost its real device heartbeat')
  assert.ok(time(current.leaseExpiresAt) > now, 'A lost its real execution lease')
  assert.equal(time(current.toolOutputAt), time(baseline.toolOutputAt), 'Tool output advanced while the native executor was suspended')
  assert.equal(time(current.checkpointAt), time(baseline.checkpointAt), 'Checkpoint progress advanced during the quiet interval')
  assert.equal(time(current.progressAt), time(baseline.progressAt), 'Persisted task progress advanced during the quiet interval')
}

export function assertServerWatchdogStop(current, baseline, epoch) {
  assert.equal(current.watchdog?.reasonCode, 'task_stalled')
  assert.equal(current.watchdog?.requestEpoch, epoch)
  assert.ok(current.stopRequestedAt && current.watchdog.stoppedAt, 'The server did not request a real stop')
  const latencyMs = time(current.watchdog.stoppedAt) - time(baseline.progressAt)
  assert.ok(latencyMs >= EXECUTE_WINDOW_MS, 'The original 45-minute server window was bypassed')
  return latencyMs
}

export async function verifyFactoryWatchdog(context) {
  const { root, directory, runtime, ownerId, device, signal, progress, query, json, until, run, dispatch,
    observations, startSecondDaemon, stackPid, registerCleanup } = context
  const marker = `watchdog-${randomUUID()}`, filename = `${marker}.txt`, expected = Buffer.from(`${marker}\n`)
  const evidence = { version: 1, marker, status: 'running', startedAt: new Date().toISOString(),
    scenario: 'online-server-watchdog-with-stale-checkpoint-block', daemonDefaultStallMinutes: 10, daemonStallMinutes: 60,
    factoryExecuteWindowMs: EXECUTE_WINDOW_MS, checkpointRecoveryWindowMinutes: 30,
    boundaries: ['Normal owner APIs and real DeepSeek Flash initial execution', 'Existing independent minute cron; no private sweep calls or SQL writes',
      'Native executor only is suspended; daemon heartbeat and lease remain live', 'Server watchdog isolation, not default-daemon latency, a before/after benchmark, or cloud-device acceptance',
      'A stale checkpoint must block B before native/model execution; no recovery success is inferred'], samples: [] }
  const record = async (phase, data = {}) => {
    Object.assign(evidence, data, { phase, updatedAt: new Date().toISOString() })
    await writeFile(join(directory, 'item10-watchdog.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
    await progress('item10-online-watchdog', phase)
  }
  let fault
  registerCleanup(() => fault?.resume())
  try {
    const owned = JSON.parse(await readFile(join(root, '.cache/dev-local/owned-daemon.json'), 'utf8'))
    assert.equal(owned.parentPid, stackPid)
    assert.equal(owned.server, runtime.server)
    assert.equal(resolve(owned.dataDir), resolve(runtime.daemonDataDir))
    assert.equal(owned.stallMinutes, 60, 'Only the explicitly configured acceptance daemon may isolate the server watchdog')
    const aStatus = daemonStatus(root, runtime.daemonDataDir)
    assertOnlineDaemonStatus(aStatus, { dataDir: runtime.daemonDataDir, deviceId: device.id })
    ownedDaemonGroups(await processTable(), { ...owned, daemonPid: aStatus.pid, forbiddenPids: [process.pid, stackPid] })
    const [cloud] = await query(`SELECT EXISTS(SELECT 1 FROM user_e2b_keys WHERE "userId"=$1)
      OR EXISTS(SELECT 1 FROM workspace_e2b_keys WHERE "createdBy"=$1) AS present`, [ownerId])
    assert.equal(cloud.present, false, 'Use a dedicated ordinary owner without a cloud-first recovery source')
    const b = await startSecondDaemon()
    const bStatus = await until(async () => {
      try {
        const value = daemonStatus(root, b.dataDir)
        const devices = (await json('/api/mobile/threads')).devices ?? []
        return value.signedIn && value.server === 'online' && devices.some(entry => entry.id === value.deviceId && entry.online) ? value : null
      } catch (error) { if (error.code === 'ETIMEDOUT') throw error; return null }
    })
    assertOnlineDaemonStatus(bStatus, { dataDir: b.dataDir })
    assert.notEqual(bStatus.deviceId, device.id)
    const priorPrs = new Set((await observations()).pullRequests.map(pr => pr.number))
    const priorRefs = execFileSync('git', ['--git-dir', runtime.scenario.barePath, 'show-ref'], { encoding: 'utf8' })
    await record('two-authorized-devices', { deviceA: device.id, deviceB: bStatus.deviceId })
    const originalId = await dispatch('item10', `Create one new task on device ${device.name} (deviceId ${device.id}), harness Claude Code, repository https://github.com/mikka-e2e/core-loop.git, newThread:true, readOnly:false. Preserve this entire brief in the worker prompt and dispatch now.
Owner acceptance marker ${marker}. The only intended repository change is ${filename} containing exactly ${marker} followed by a newline. First create this file in one tool call. Then run one finite Bash sleep 300 with timeout 600000, without loops, progress output or further edits during that wait. Do not ask for user input.
This task exercises the host's existing stall recovery. Do not commit, push, create a PR, send messages or make any other external write before the finite wait finishes. If recovery is refused because a checkpoint is stale, preserve that blocker and the original workspace; do not start another task, refresh the checkpoint or weaken authorization. Do not repeatedly retry a refusal.`)
    const original = await until(async () => {
      const value = await run(originalId)
      assert.ok(!ended.has(value?.status), 'A ended before the real online-stall workload')
      return value?.sessionId && value.status === 'running' ? value : null
    })
    assert.equal(original.deviceId, device.id)
    assertFlashTestModel(original.agentDefinition?.model)
    const [linked] = await query(`SELECT t.id FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1 AND t."userId"=$2`, [original.id, ownerId])
    assert.ok(linked)
    const task = (await json(`/api/factory/tasks/${linked.id}`)).task
    assert.equal(task.stage, 'execute')
    const observe = async () => (await query(`SELECT t."sourceEventId",t.status AS "taskStatus",t.stage,r.status AS "runStatus",
      r."stopRequestedAt",r."finishedAt",r."leaseExpiresAt",r."stopReason",d."lastSeenAt",
      a.output->'watchdog' AS watchdog,cp."updatedAt" AS "checkpointAt",cp.files,cp."unavailableReason",
      (SELECT max(ch."createdAt") FROM run_chunks ch WHERE ch."runId"=r.id AND ch.chunk->>'type'='tool_output') AS "toolOutputAt",
      GREATEST(t."updatedAt",a."createdAt",a."finishedAt",c."createdAt",cp."updatedAt",
        (SELECT max(ch."createdAt") FROM run_chunks ch WHERE ch."runId"=r.id AND ch.chunk->>'type'='tool_output')) AS "progressAt"
      FROM factory_tasks t JOIN factory_attempts a ON a.id=$2 AND a."taskId"=t.id
      JOIN agent_runs r ON r.id=$3 AND r."userId"=t."userId" JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=t."userId"
      LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
      LEFT JOIN run_checkpoints cp ON cp."runId"=r.id AND cp."userId"=t."userId"
      WHERE t.id=$1 AND t."userId"=$4`, [task.id, task.attemptId, original.id, ownerId]))[0]
    const local = await until(async () => {
      const state = await observe()
      assert.equal(state.runStatus, 'running', 'A stopped or waited before its checkpoint')
      const active = daemonStatus(root, runtime.daemonDataDir).runs.find(entry => entry.runId === original.id)
      if (!active?.worktree || !state.files || state.unavailableReason) return null
      const bytes = await readFile(join(active.worktree, filename)).catch(() => null)
      return bytes?.equals(expected) ? active : null
    })
    const identity = await nativeRunIdentity({ ...owned, daemonPid: aStatus.pid, forbiddenPids: [process.pid, stackPid, b.pid, bStatus.pid] },
      { dataDir: runtime.daemonDataDir, runId: original.id, worktree: local.worktree })
    fault = await suspendOwnedDaemon(identity)
    // Let already-buffered output drain normally. Establish the observation
    // baseline only after that bounded drain; never change stored timestamps.
    await delay(5_000, undefined, { signal })
    const baseline = await observe()
    assertOnlineQuietSample(baseline, baseline, task.sourceEventId)
    const baselineAt = time(baseline.progressAt)
    assert.ok(Number.isFinite(baselineAt) && Date.now() - baselineAt < 5 * 60_000)
    await record('native-suspended-daemon-online', { taskId: task.id, requestEpoch: task.sourceEventId, originalRunId: original.id,
      originalAttemptId: task.attemptId, nativePgid: identity.pid, nativeGroups: fault.groups, nativeProcesses: fault.processes,
      suspendedAt: fault.suspendedAt, progressAt: baseline.progressAt, checkpointAt: baseline.checkpointAt, files: baseline.files,
      toolOutputAt: baseline.toolOutputAt })
    let stopped, nextSampleAt = 0, maxHeartbeatAgeMs = 0, minimumLeaseRemainingMs = Infinity
    for (;;) {
      signal.throwIfAborted()
      const current = await observe(), now = Date.now()
      if (current.stopRequestedAt) { stopped = current; break }
      assertOnlineQuietSample(current, baseline, task.sourceEventId, now)
      maxHeartbeatAgeMs = Math.max(maxHeartbeatAgeMs, now - time(current.lastSeenAt))
      minimumLeaseRemainingMs = Math.min(minimumLeaseRemainingMs, time(current.leaseExpiresAt) - now)
      if (now >= nextSampleAt) {
        const a = daemonStatus(root, runtime.daemonDataDir)
        assertOnlineDaemonStatus(a, { dataDir: runtime.daemonDataDir, deviceId: device.id })
        const native = ownedDaemonGroups(await processTable(), identity)
        assert.ok(native.members.every(row => ['T', 't', 'Z', 'X'].includes(row.state)), 'Native work resumed before the server stop')
        evidence.samples.push({ at: new Date(now).toISOString(), lastSeenAt: current.lastSeenAt, leaseExpiresAt: current.leaseExpiresAt,
          progressAt: current.progressAt, checkpointAt: current.checkpointAt, toolOutputAt: current.toolOutputAt })
        await record('online-without-progress', { quietMs: now - baselineAt, maxHeartbeatAgeMs, minimumLeaseRemainingMs })
        nextSampleAt = now + 60_000
      }
      // Near the real server window, observe frequently enough to SIGCONT
      // within spawnCli's normal TERM grace; do not postpone its stop/ack.
      await delay(now - baselineAt >= 44 * 60_000 ? 500 : 5_000, undefined, { signal })
    }
    await fault.resume()
    const latencyMs = assertServerWatchdogStop(stopped, baseline, task.sourceEventId)
    assert.ok(Date.now() - time(stopped.lastSeenAt) < 60_000, 'The server stop was actually an offline recovery')
    await record('server-stop-observed', { serverStoppedAt: stopped.watchdog.stoppedAt, stopRequestedAt: stopped.stopRequestedAt,
      detectionLatencyMs: latencyMs, maxHeartbeatAgeMs, minimumLeaseRemainingMs })
    const acknowledged = await until(async () => { const value = await run(original.id); return ended.has(value.status) ? value : null })
    assert.ok(time(acknowledged.finishedAt) >= time(stopped.stopRequestedAt))
    await record('native-stop-acknowledged', { acknowledgedAt: acknowledged.finishedAt, stopReason: acknowledged.stopReason,
      stopAcknowledgementMs: time(acknowledged.finishedAt) - time(stopped.stopRequestedAt) })
    const retry = await until(async () => {
      const children = await query('SELECT * FROM agent_runs WHERE "retryOf"=$1 AND "userId"=$2 ORDER BY "createdAt"', [original.id, ownerId])
      assert.ok(children.length <= 1, 'The watchdog admitted duplicate recovery runs')
      return children[0] && ended.has(children[0].status) ? children[0] : null
    })
    assert.equal(retry.deviceId, bStatus.deviceId)
    assert.equal(retry.issueId, original.issueId)
    assert.equal(retry.stopReason, 'blocked')
    assert.equal(retry.report?.summary, STALE_CHECKPOINT)
    assert.equal(retry.startedAt, null, 'B must reject the stale snapshot before native/model execution')
    assert.equal(retry.sessionId, null)
    assertFlashTestModel(retry.agentDefinition?.model)
    assert.ok(time(retry.createdAt) >= time(acknowledged.finishedAt), 'B was admitted before A acknowledged the stop')
    assert.equal(retry.agentDefinition.executionIdentity.requester, original.agentDefinition.executionIdentity.requester)
    assert.equal(retry.agentDefinition.executionIdentity.outputOwner, original.agentDefinition.executionIdentity.outputOwner)
    const handoffs = await query(`SELECT request,result FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_handoff'`, [task.id])
    const receipt = handoffs.find(row => retry.prompt.includes(row.request.digest) && row.result.requestEpoch === task.sourceEventId && row.result.checkpoint?.runId === original.id)
    assert.ok(receipt && receipt.result.goal.text.includes(marker), 'The recovery omitted the current goal/checkpoint handoff')
    assert.ok(time(retry.createdAt) - time(receipt.result.checkpoint.storedAt) > 30 * 60_000)
    const view = await json(`/api/mobile/threads/${retry.id}`)
    assert.equal(view.summary, STALE_CHECKPOINT, 'The ordinary owner API must show the actionable recovery blocker')
    const stableCounts = async () => {
      const current = (await json(`/api/factory/tasks/${task.id}`)).task
      assert.equal(current.sourceEventId, task.sourceEventId)
      assert.equal(current.status, 'blocked')
      const children = await query('SELECT id FROM agent_runs WHERE "retryOf"=$1 AND "userId"=$2', [original.id, ownerId])
      assert.deepEqual(children.map(row => row.id), [retry.id])
      const publications = await query('SELECT "runId" FROM run_publications WHERE "issueId"=$1 AND "userId"=$2 AND status=\'published\'', [original.issueId, ownerId])
      assert.equal(publications.length, 0, 'Blocked recovery published an external effect')
      assert.equal((await observations()).pullRequests.filter(pr => !priorPrs.has(pr.number)).length, 0)
      assert.equal(execFileSync('git', ['--git-dir', runtime.scenario.barePath, 'show-ref'], { encoding: 'utf8' }), priorRefs, 'Blocked recovery changed remote Git refs')
      const events = await query(`SELECT id,"deliveredAt",tier FROM coordinator_events WHERE "userId"=$1 AND "runId"=$2 AND kind='run_finished'`, [ownerId, retry.id])
      assert.equal(events.length, 1, 'The blocked run must have one durable notification event')
      const packets = await query(`SELECT id FROM coordinator_messages WHERE "userId"=$1 AND message ? 'mikkaEvent' AND message::text LIKE $2`, [ownerId, `%${events[0].id}%`])
      assert.ok(packets.length <= 1, 'The same blocker was delivered to the Coordinator more than once')
      return { retries: children.length, publishedEffects: publications.length, notificationEvents: events.length,
        deliveredNotifications: events.filter(event => event.deliveredAt).length, coordinatorInboxPackets: packets.length }
    }
    const counts = await until(async () => {
      const current = (await json(`/api/factory/tasks/${task.id}`)).task
      if (current.status !== 'blocked') return null
      const value = await stableCounts()
      return value.deliveredNotifications === 1 && value.coordinatorInboxPackets === 1 ? value : null
    })
    await record('bounded-checkpoint-block', { retryRunId: retry.id, handoffDigest: receipt.request.digest,
      blockCode: 'checkpointRecoveryUnavailable', publicSummary: view.summary, modelStartedOnB: false, counts,
      notificationBoundary: 'One durable blocked-run event and one Coordinator inbox delivery; normal owner Thread API confirms the blocker. Assistant prose is not counted as a fixed number of bubbles.' })
    await delay(125_000, undefined, { signal })
    assert.deepEqual(await stableCounts(), counts, 'Repeated independent minute schedules duplicated a recovery/effect/notification')
    await record('passed', { status: 'passed', outcome: 'bounded_checkpoint_block', finishedAt: new Date().toISOString() })
  } catch (error) {
    await record('failed', { status: 'failed', error: { name: error.name, code: error.code ?? null }, finishedAt: new Date().toISOString() })
    throw error
  } finally { await fault?.resume() }
}
