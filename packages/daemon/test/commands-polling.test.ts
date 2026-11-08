import { afterEach, expect, it, vi } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { runAssignmentSchema } from '@mikka/protocol/device'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import { POLICY_SNAPSHOT_TTL_MS, policySnapshotMessage, type PolicySnapshotPayload } from '@mikka/protocol/policy-snapshot'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type RunAssignment, type ServerLink } from '../src/server-link'
import { ServerUnreachableError } from '../src/errors'
import { DAEMON_VERSION } from '../src/paths'
import * as service from '../src/service'
import { mkdtempSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const daemons: Daemon[] = []

function pollCommands(fetchCommands: ServerLink['fetchCommands'], commandsWaitSeconds?: number) {
  const ackCommands = vi.fn(async () => {})
  const send = vi.fn(async () => {})
  const notifyMailbox = vi.fn(async () => {})
  const daemon = new Daemon({ dataDir: '/unused-commands-poll-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), fetchCommands, ackCommands },
    commandsWaitSeconds, log: createLogger({ level: 'silent' }) })
  // Isolate the polling boundary from RPC, filesystem and agent processes.
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'journal', { get: () => ({ state: 'running' }) })
  Reflect.set(daemon, 'supervisor', { send, notifyMailbox, stop: async () => {} })
  Reflect.set(daemon, 'commandsLoop', Reflect.get(daemon, 'pollCommands').call(daemon))
  daemons.push(daemon)
  return { daemon, ackCommands, send, notifyMailbox }
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([0, 5_000, 25_000])('paces an empty response after a %i ms server wait to one requested cycle', async serverWait => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, serverWait))
      return []
    })
    .mockResolvedValueOnce([]).mockRejectedValue(new Error('Unexpected additional poll'))
  const { daemon } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(24_999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('delivers and acknowledges a queued message immediately before the next poll', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockResolvedValueOnce([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
    .mockResolvedValueOnce([]).mockRejectedValue(new Error('Unexpected additional poll'))
  const { ackCommands, send } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledWith('run-1', 'hello')
  expect(ackCommands).toHaveBeenCalledWith('device-1', ['message-1'])
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('pushes a mailbox notice once and ACKs notification ids without treating it as user input', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const ids = ['10000000-0000-4000-8000-000000000001']
  const command = { kind: 'mailbox_notice' as const, runId: 'run-1', messageIds: ids }
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValueOnce([command]).mockResolvedValueOnce([command]).mockResolvedValue([])
  const { daemon, notifyMailbox, send, ackCommands } = pollCommands(fetch)
  ackCommands.mockRejectedValue(new ServerUnreachableError('lost receipt'))
  await vi.advanceTimersByTimeAsync(0)
  expect(notifyMailbox).toHaveBeenCalledOnce()
  expect(notifyMailbox).toHaveBeenCalledWith('run-1', ids)
  expect(send).not.toHaveBeenCalled()
  expect(ackCommands).toHaveBeenCalledWith('device-1', ids)
  await vi.advanceTimersByTimeAsync(1000)
  expect(notifyMailbox).toHaveBeenCalledOnce()
  await daemon.stop()
})

it('never delivers a mailbox notice to an ended run', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const { daemon, notifyMailbox, ackCommands } = pollCommands(async () => [])
  Reflect.set(daemon, 'journal', { get: () => ({ state: 'succeeded' }) })
  await Reflect.get(daemon, 'applyCommands').call(daemon, [{ kind: 'mailbox_notice', runId: 'run-1', messageIds: ['10000000-0000-4000-8000-000000000001'] }])
  expect(notifyMailbox).not.toHaveBeenCalled()
  expect(ackCommands).not.toHaveBeenCalled()
})

it('batches notification receipts within the ACK protocol limit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const commands = Array.from({ length: 11 }, () => ({ kind: 'mailbox_notice' as const, runId: 'run-1',
    messageIds: Array.from({ length: 50 }, () => crypto.randomUUID()) }))
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValueOnce(commands).mockResolvedValue([])
  const { ackCommands } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(ackCommands.mock.calls.map(call => (call as unknown as [string, string[]])[1].length)).toEqual([500, 50])
})

it('uses a one-second minimum when zero wait is configured', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValue(new Error('Unexpected additional poll'))
  pollCommands(fetch, 0)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('stops an in-flight poll without scheduling an idle pause or another request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>((_device, _wait, { signal } = {}) =>
    new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })))
  const { daemon } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch).toHaveBeenCalledTimes(1)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('bounds consecutive failures to capped exponential backoff and cancels retries on stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockRejectedValue(new ServerUnreachableError('offline'))
  const { daemon } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(0)
  let calls = 1
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(fetch).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(++calls)
  }
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetch).toHaveBeenCalledTimes(calls)
})

it('resets failure backoff after a successful response', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const error = new ServerUnreachableError('offline')
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    .mockResolvedValueOnce([]).mockRejectedValue(error)
  pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(28_000)
  expect(fetch).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetch).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(5)
})

it('does not deliver work returned by a poll that resolves during shutdown', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>((_device, _wait, { signal } = {}) =>
    new Promise(resolve => signal?.addEventListener('abort', () => resolve([
      { kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' },
    ]), { once: true })))
  const { daemon, send, ackCommands } = pollCommands(fetch)
  await daemon.stop()
  expect(send).not.toHaveBeenCalled()
  expect(ackCommands).not.toHaveBeenCalled()
})

it('resets backoff before immediately acknowledging work after failures', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const error = new ServerUnreachableError('offline')
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    .mockResolvedValueOnce([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
    .mockRejectedValue(error)
  const { ackCommands, send } = pollCommands(fetch)
  ackCommands.mockRejectedValue(error)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(send).toHaveBeenCalledTimes(1)
  expect(ackCommands).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(ackCommands).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(ackCommands).toHaveBeenCalledTimes(2)
})

function pollWithClaims(fetchCommands: ServerLink['fetchCommands'], claimAndStart: (runId: string) => Promise<unknown>) {
  const daemon = new Daemon({ dataDir: '/unused-commands-poll-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), fetchCommands, ackCommands: async () => {} },
    log: createLogger({ level: 'silent' }) })
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'journal', { get: () => undefined })
  Reflect.set(daemon, 'supervisor', { send: async () => {}, stop: async () => {} })
  Reflect.set(daemon, 'claimAndStart', claimAndStart)
  Reflect.set(daemon, 'commandsLoop', Reflect.get(daemon, 'pollCommands').call(daemon))
  daemons.push(daemon)
  return daemon
}

// Model the HTTP long-poll's cancellation contract so stop() can join it.
const waitForAbort: ServerLink['fetchCommands'] = async (_device, _wait, { signal } = {}) =>
  new Promise(resolve => {
    if (signal?.aborted) resolve([])
    else signal?.addEventListener('abort', () => resolve([]), { once: true })
  })

it('claims a run the commands poll reports queued at once, without waiting for a heartbeat', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const claim = vi.fn(async () => ({}))
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_device, _wait, options) => { options?.onQueuedRuns?.(['run-new']); return [] })
    .mockImplementation(waitForAbort)
  pollWithClaims(fetch, claim)
  await vi.advanceTimersByTimeAsync(0)
  expect(claim).toHaveBeenCalledWith('run-new')
  // The next poll follows immediately instead of pacing out the 25-second wait.
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('a failed claim stays out of the poll until the heartbeat retries it, so the poll cannot spin', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const claim = vi.fn(async () => { throw new Error('claim refused') })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_device, _wait, options) => { options?.onQueuedRuns?.(['run-bad']); return [] })
    .mockResolvedValueOnce([])
    .mockImplementation(waitForAbort)
  const daemon = pollWithClaims(fetch, claim)
  await vi.advanceTimersByTimeAsync(0)
  expect(claim).toHaveBeenCalledTimes(1)
  // The second poll was already sent while the claim was in flight; the third carries the failure in skip.
  Reflect.get(daemon, 'wakeCommands')?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(Reflect.get(daemon, 'queuedClaims').get('run-bad')).toBe('failed')
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fetch.mock.calls[2]?.[2]?.skipRuns).toContain('run-bad')
})

it('a run still being claimed is not claimed twice; the poll waits briefly instead of spinning', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const claim = vi.fn(async () => new Promise(() => {}))
  const report = async (_device: string, _wait: number, options?: Parameters<ServerLink['fetchCommands']>[2]) => { options?.onQueuedRuns?.(['run-slow']); return [] }
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockImplementationOnce(report).mockImplementationOnce(report)
    .mockImplementation(waitForAbort)
  pollWithClaims(fetch, claim)
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(claim).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(499)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(3)
})

function claimDaemon(claimRun: ServerLink['claimRun']) {
  const daemon = new Daemon({ dataDir: '/unused-commands-poll-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), claimRun },
    log: createLogger({ level: 'silent' }) })
  const start = vi.fn(() => ({}))
  const stop = vi.fn(async () => {})
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'journal', { get: () => undefined })
  Reflect.set(daemon, 'supervisor', { start, stop })
  daemons.push(daemon)
  const claim = (runId: string): Promise<unknown> => Reflect.get(daemon, 'claimAndStart').call(daemon, runId)
  return { daemon, start, stop, claim }
}

function desktopAssignment(subscriptionOwnerId: string) {
  const policy = defaultRunPolicy()
  return runAssignmentSchema.parse({
    runId: 'run-desktop', issueId: 'issue-1', deviceId: 'device-1', repoId: 'repo-1',
    harness: 'codex', model: 'gpt-6-luna', prompt: 'Fixture desktop task',
    leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    factoryExecuteKind: 'deliverable', preserveQuestionWorktree: true,
    policy: { ...policy, permissions: { ...policy.permissions, computer_use: 'allow' } },
    subscriptionBinding: {
      bindingId: '10000000-0000-4000-8000-000000000001', ownerId: subscriptionOwnerId,
      workspaceId: '10000000-0000-4000-8000-000000000002',
      consumerId: '10000000-0000-4000-8000-000000000003', route: 'codex_cli',
    },
    computer: { botId: '10000000-0000-4000-8000-000000000004', ownerId: 'task-owner', display: ':1', policyVersion: 0 },
  })
}

function desktopClaimDaemon(assignment: RunAssignment, broker = true) {
  const claimRun = vi.fn<ServerLink['claimRun']>(async () => assignment)
  const fixture = claimDaemon(claimRun)
  Reflect.set(fixture.daemon, 'options', { ...Reflect.get(fixture.daemon, 'options'),
    hostedSubscriptions: true, e2bContainerRuntime: true, cloudComputer: true })
  Reflect.set(fixture.daemon, 'device', { deviceId: 'device-1', credential: 'fixture',
    workspaceId: '10000000-0000-4000-8000-000000000002',
    repos: [{ repoId: assignment.repoId, name: 'fixture', path: '/home/user/.mikka/bot-workspaces/fixture' }] })
  // Keep the actual claim acceptance path; no driver, socket or agent starts.
  if (broker) Reflect.set(fixture.daemon, 'cloudComputerBroker', { close: async () => {} })
  return { ...fixture, claimRun }
}

function withDesktopSnapshot(assignment: RunAssignment, changed?: 'ownerId' | 'runId' | 'deviceId') {
  // Match the existing policy-distribution fixture: a genuine local test
  // signature, never a provider credential or a new assignment field.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const now = Date.now(), revision = 'a'.repeat(64), policy = assignment.policy!
  const payload: PolicySnapshotPayload = {
    version: 1, issuer: 'http://127.0.0.1:19723/mikka', ownerId: assignment.computer!.ownerId,
    runId: assignment.runId, deviceId: assignment.deviceId, revision,
    policyHash: policySnapshotHash(policy), scope: { workspaceIds: ['10000000-0000-4000-8000-000000000002'], hierarchy: null },
    policy, issuedAt: now, expiresAt: now + POLICY_SNAPSHOT_TTL_MS,
  }
  if (changed) payload[changed] = 'another-snapshot-subject'
  return runAssignmentSchema.parse({ ...assignment, policyRevision: revision, policySnapshot: {
    algorithm: 'Ed25519', keyId: createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex'),
    payload, signature: sign(null, policySnapshotMessage(payload), privateKey).toString('base64url'),
  } })
}

it.each(['task-owner', 'shared-subscription-owner'])('starts an owned desktop task using the authorized subscription of %s', async subscriptionOwnerId => {
  const assignment = desktopAssignment(subscriptionOwnerId)
  const { claim, claimRun, start } = desktopClaimDaemon(assignment)
  // The server authorizes the desktop for the task owner and a separately
  // shared subscription for billing. The payer does not own the desktop.
  await expect(claim(assignment.runId)).resolves.toEqual({})
  expect(claimRun).toHaveBeenCalledExactlyOnceWith(assignment.deviceId, assignment.runId, expect.any(AbortSignal), undefined)
  expect(start).toHaveBeenCalledExactlyOnceWith(assignment)
})

it('starts a desktop API-key assignment from an older server without a policy snapshot', async () => {
  const subscription = desktopAssignment('task-owner')
  delete subscription.subscriptionBinding
  const assignment = runAssignmentSchema.parse({ ...subscription, model: 'deepseek-flash',
    modelCredential: { kind: 'provider', protocol: 'openai', baseUrl: 'https://provider.example.invalid/v1', key: 'fixture' } })
  expect(assignment.policySnapshot).toBeUndefined()
  const { claim, start } = desktopClaimDaemon(assignment)
  await expect(claim(assignment.runId)).resolves.toEqual({})
  expect(start).toHaveBeenCalledExactlyOnceWith(assignment)
})

it('starts a shared-subscription desktop task whose signed policy names the task owner', async () => {
  const assignment = withDesktopSnapshot(desktopAssignment('shared-subscription-owner'))
  const { claim, start } = desktopClaimDaemon(assignment)
  await expect(claim(assignment.runId)).resolves.toEqual({})
  expect(start).toHaveBeenCalledExactlyOnceWith(assignment)
})

it.each(['ownerId', 'runId', 'deviceId'] as const)('refuses a desktop grant whose signed policy names another %s', async changed => {
  // Sign the other subject's payload correctly: this is a scope mismatch,
  // not a corrupt signature standing in for the ownership check.
  const assignment = withDesktopSnapshot(desktopAssignment('task-owner'), changed)
  const { claim, start } = desktopClaimDaemon(assignment)
  await expect(claim(assignment.runId)).rejects.toThrow()
  expect(start).not.toHaveBeenCalled()
})

it('refuses a desktop assignment when this daemon has no computer broker', async () => {
  const assignment = desktopAssignment('task-owner')
  const { claim, start } = desktopClaimDaemon(assignment, false)
  await expect(claim(assignment.runId)).rejects.toThrow('Cloud computer runtime unavailable')
  expect(start).not.toHaveBeenCalled()
})

it.each(['runId', 'deviceId'] as const)('refuses a desktop claim response for another %s', async changed => {
  const assignment = desktopAssignment('task-owner')
  const requestedRunId = assignment.runId
  assignment[changed] = 'another-assignment'
  const { claim, start } = desktopClaimDaemon(assignment)
  await expect(claim(requestedRunId)).rejects.toThrow()
  expect(start).not.toHaveBeenCalled()
})

it('shares an in-flight heartbeat or RPC claim with the commands poll', async () => {
  let finish!: (assignment: RunAssignment) => void
  const claimRun = vi.fn<ServerLink['claimRun']>(() => new Promise(resolve => { finish = resolve }))
  const { daemon, start, claim } = claimDaemon(claimRun)
  const pending = claim('run-shared')
  Reflect.get(daemon, 'claimQueued').call(daemon, ['run-shared'])
  expect(claimRun).toHaveBeenCalledTimes(1)
  finish({ runId: 'run-shared' } as RunAssignment)
  await pending
  expect(start).toHaveBeenCalledTimes(1)
})

it('aborts an in-flight claim when the daemon stops', async () => {
  const claimRun = vi.fn<ServerLink['claimRun']>((_device, _run, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('claim aborted')), { once: true })
  }))
  const { daemon, start, stop, claim } = claimDaemon(claimRun)
  const pending = claim('run-aborted').catch(error => error)
  await daemon.stop()
  expect(await pending).toMatchObject({ message: 'claim aborted' })
  expect(claimRun.mock.calls[0]?.[2]?.aborted).toBe(true)
  expect(start).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledOnce()
})

it('settles a late claim before shutdown without launching its run', async () => {
  let finish!: (assignment: RunAssignment) => void
  const { daemon, start, stop, claim } = claimDaemon(() => new Promise(resolve => { finish = resolve }))
  const pending = claim('run-late').catch(error => error)
  const stopping = daemon.stop()
  finish({ runId: 'run-late' } as RunAssignment)
  await stopping
  expect(await pending).toMatchObject({ message: 'Daemon is draining' })
  expect(start).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledOnce()
})

it.each(['deviceId', 'credential', 'workspaceId'] as const)('does not launch an in-flight claim after the device %s changes', async changed => {
  let finish!: (assignment: RunAssignment) => void
  const { daemon, start, claim } = claimDaemon(() => new Promise(resolve => { finish = resolve }))
  const pending = claim('run-old-session').catch(error => error)
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture', [changed]: 'changed-session' })
  finish({ runId: 'run-old-session' } as RunAssignment)
  expect(await pending).toMatchObject({ cause: 'Device session changed while claiming run' })
  expect(start).not.toHaveBeenCalled()
})

const UPDATE = { id: '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20', kind: 'update' as const }
function pollWithUpdates(fetch: ServerLink['fetchCommands'], runs: unknown[] = []) {
  const { daemon } = pollCommands(fetch)
  const install = vi.fn(async (_version: string) => {})
  const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  const sync = vi.spyOn(daemon, 'syncWithServer').mockResolvedValue(undefined)
  Reflect.set(daemon, 'options', { ...Reflect.get(daemon, 'options'), autoUpdate: { install } })
  Reflect.set(daemon, 'paths', { dataDir: mkdtempSync(join(tmpdir(), 'mikka-poll-update-')) })
  Reflect.set(daemon, 'supervisor', { ...Reflect.get(daemon, 'supervisor'), heartbeatRuns: () => runs })
  return { daemon, install, restart, sync }
}

it('a release named on the commands poll installs at once when idle, and later polls say the daemon knows it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_id, _wait, options) => { await Promise.resolve(); options?.onUpdates?.({ daemonVersions: { min: '0.0.299', latest: '999.0.0' }, deviceCommands: [] }); return [] })
    .mockResolvedValue([])
  const { daemon, install, restart, sync } = pollWithUpdates(fetch)
  await vi.advanceTimersByTimeAsync(0)
  await Reflect.get(daemon, 'maintenance')
  expect(install).toHaveBeenCalledExactlyOnceWith('999.0.0')
  expect(restart).toHaveBeenCalledOnce()
  expect(sync).not.toHaveBeenCalled()
  expect(fetch.mock.calls[0]![2]?.updates).toEqual({ daemonLatest: DAEMON_VERSION, skipDeviceCommands: [] })
  expect(fetch).toHaveBeenCalledTimes(2) // polls again at once, so stops and messages are not held back
  expect(fetch.mock.calls[1]![2]?.updates?.daemonLatest).toBe('999.0.0')
})

it('a release named while a run is active waits for the run to end, then installs at the next heartbeat', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const runs: unknown[] = [{ runId: 'run-1' }]
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_id, _wait, options) => { await Promise.resolve(); options?.onUpdates?.({ daemonVersions: { min: '0.0.299', latest: '999.0.0' }, deviceCommands: [] }); return [] })
    .mockResolvedValue([])
  const { daemon, install } = pollWithUpdates(fetch, runs)
  await vi.advanceTimersByTimeAsync(0)
  expect(install).not.toHaveBeenCalled()
  runs.length = 0
  Reflect.get(daemon, 'checkAutoUpdate').call(daemon) // the start of every heartbeat pass
  await Reflect.get(daemon, 'maintenance')
  expect(install).toHaveBeenCalledExactlyOnceWith('999.0.0')
})

it('an update a person asked for arrives on the commands poll and is carried out now, then left out of later polls', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_id, _wait, options) => { await Promise.resolve(); options?.onUpdates?.({ deviceCommands: [UPDATE] }); return [] })
    .mockImplementationOnce(async (_id, _wait, options) => { await Promise.resolve(); options?.onUpdates?.({ deviceCommands: [UPDATE] }); return [] })
    .mockResolvedValue([])
  const { install, sync } = pollWithUpdates(fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(sync).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[1]![2]?.updates?.skipDeviceCommands).toEqual([UPDATE.id])
  expect(sync).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledTimes(2) // the same command again is not news: the poll is paced as usual
  await vi.advanceTimersByTimeAsync(24_999)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(install).not.toHaveBeenCalled()
})

it('an older server sends neither releases nor device commands: the daemon keeps polling and never updates', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValue([])
  const { install, sync } = pollWithUpdates(fetch)
  await vi.advanceTimersByTimeAsync(50_000)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(install).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
})
