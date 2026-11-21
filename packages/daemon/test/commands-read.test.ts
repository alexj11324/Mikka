import { afterEach, expect, it, vi } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { runAssignmentSchema } from '@mikka/protocol/device'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import { POLICY_SNAPSHOT_TTL_MS, policySnapshotMessage, type PolicySnapshotPayload } from '@mikka/protocol/policy-snapshot'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type RunAssignment, type ServerLink } from '../src/server-link'
import { DeviceSessionRequiredError, ServerUnreachableError } from '../src/errors'
import { DAEMON_VERSION } from '../src/paths'
import * as service from '../src/service'
import { mkdtempSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The commands read (decision 2026-11-17-2215): one `GET /commands?wait=0`
// per gateway push or socket open, never a long-poll and never on a timer.

const daemons: Daemon[] = []

function readsCommands(fetchCommands: ServerLink['fetchCommands']) {
  const ackCommands = vi.fn(async () => {})
  const send = vi.fn(async () => {})
  const notifyMailbox = vi.fn(async () => {})
  const daemon = new Daemon({ dataDir: '/unused-commands-read-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), fetchCommands, ackCommands },
    log: createLogger({ level: 'silent' }) })
  // Isolate the read from RPC, filesystem and agent processes.
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'journal', { get: () => ({ state: 'running' }) })
  Reflect.set(daemon, 'supervisor', { send, notifyMailbox, stop: async () => {}, activeRunIds: () => [] })
  daemons.push(daemon)
  /** What the session does on a push: one read. */
  const read = (): Promise<void> => Reflect.get(daemon, 'pullSignaledWork').call(daemon, 'device-1', new AbortController().signal)
  return { daemon, ackCommands, send, notifyMailbox, read }
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('reads with wait 0 and the release this daemon knows: it never long-polls', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValue([])
  const { read } = readsCommands(fetch)
  await read()
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0]![1]).toBe(0)
  expect(fetch.mock.calls[0]![2]?.updates).toEqual({ daemonLatest: DAEMON_VERSION })
})

it('delivers and acknowledges a message on the read; a lost acknowledgement is sent again on the next read, without redelivery', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockResolvedValueOnce([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
    .mockResolvedValue([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
  const { read, send, ackCommands } = readsCommands(fetch)
  ackCommands.mockRejectedValueOnce(new ServerUnreachableError('offline'))
  await expect(read()).rejects.toBeInstanceOf(ServerUnreachableError)
  expect(send).toHaveBeenCalledOnce()
  await read()
  expect(send).toHaveBeenCalledOnce()
  expect(ackCommands).toHaveBeenCalledTimes(2)
  expect(ackCommands).toHaveBeenLastCalledWith('device-1', ['message-1'])
})

it('pushes a mailbox notice once and ACKs notification ids without treating it as user input', async () => {
  const ids = ['10000000-0000-4000-8000-000000000001']
  const command = { kind: 'mailbox_notice' as const, runId: 'run-1', messageIds: ids }
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValue([command])
  const { read, notifyMailbox, send, ackCommands } = readsCommands(fetch)
  ackCommands.mockRejectedValueOnce(new ServerUnreachableError('lost receipt'))
  await read().catch(() => undefined)
  expect(notifyMailbox).toHaveBeenCalledOnce()
  expect(notifyMailbox).toHaveBeenCalledWith('run-1', ids)
  expect(send).not.toHaveBeenCalled()
  expect(ackCommands).toHaveBeenCalledWith('device-1', ids)
  await read()
  expect(notifyMailbox).toHaveBeenCalledOnce()
})

it('never delivers a mailbox notice to an ended run', async () => {
  const { daemon, notifyMailbox, ackCommands } = readsCommands(async () => [])
  Reflect.set(daemon, 'journal', { get: () => ({ state: 'succeeded' }) })
  await Reflect.get(daemon, 'applyCommands').call(daemon, [{ kind: 'mailbox_notice', runId: 'run-1', messageIds: ['10000000-0000-4000-8000-000000000001'] }])
  expect(notifyMailbox).not.toHaveBeenCalled()
  expect(ackCommands).not.toHaveBeenCalled()
})

it('batches notification receipts within the ACK protocol limit', async () => {
  const commands = Array.from({ length: 11 }, () => ({ kind: 'mailbox_notice' as const, runId: 'run-1',
    messageIds: Array.from({ length: 50 }, () => crypto.randomUUID()) }))
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValueOnce(commands).mockResolvedValue([])
  const { read, ackCommands } = readsCommands(fetch)
  await read()
  expect(ackCommands.mock.calls.map(call => (call as unknown as [string, string[]])[1].length)).toEqual([500, 50])
})

it('does not deliver work returned by a read that resolves during shutdown', async () => {
  let answer!: () => void
  const fetch = vi.fn<ServerLink['fetchCommands']>(() => new Promise(resolve => {
    answer = () => resolve([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
  }))
  const { daemon, read, send, ackCommands } = readsCommands(fetch)
  const reading = read()
  await daemon.stop()
  answer()
  await reading
  expect(send).not.toHaveBeenCalled()
  expect(ackCommands).not.toHaveBeenCalled()
})

function readsWithClaims(fetchCommands: ServerLink['fetchCommands'], claimAndStart: (runId: string) => Promise<unknown>) {
  const daemon = new Daemon({ dataDir: '/unused-commands-read-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), fetchCommands, ackCommands: async () => {} },
    log: createLogger({ level: 'silent' }) })
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'journal', { get: () => undefined })
  Reflect.set(daemon, 'supervisor', { send: async () => {}, stop: async () => {}, activeRunIds: () => [] })
  Reflect.set(daemon, 'claimAndStart', claimAndStart)
  daemons.push(daemon)
  const read = (): Promise<void> => Reflect.get(daemon, 'pullSignaledWork').call(daemon, 'device-1', new AbortController().signal)
  return { daemon, read }
}

const queued = (runId: string): ServerLink['fetchCommands'] => async (_device, _wait, options) => { options?.onQueuedRuns?.([runId]); return [] }

it('claims a run the commands read reports queued at once', async () => {
  const claim = vi.fn(async () => ({}))
  const { read } = readsWithClaims(vi.fn(queued('run-new')), claim)
  await read()
  expect(claim).toHaveBeenCalledWith('run-new')
})

it('a failed claim is left out of the next read until a pass retries it', async () => {
  const claim = vi.fn(async () => { throw new Error('claim refused') })
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockImplementationOnce(queued('run-bad')).mockResolvedValue([])
  const { daemon, read } = readsWithClaims(fetch, claim)
  await read()
  await vi.waitFor(() => expect(Reflect.get(daemon, 'queuedClaims').get('run-bad')).toBe('failed'))
  await read()
  expect(claim).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[1]?.[2]?.skipRuns).toContain('run-bad')
})

it('a run still being claimed is not claimed twice by a second push', async () => {
  const claim = vi.fn(async () => new Promise(() => {}))
  const { read } = readsWithClaims(vi.fn(queued('run-slow')), claim)
  await read()
  await read()
  expect(claim).toHaveBeenCalledTimes(1)
})

it('a claim the server refuses for want of an open session redials the socket instead of retrying', async () => {
  const claim = vi.fn(async () => { throw new DeviceSessionRequiredError() })
  const { daemon, read } = readsWithClaims(vi.fn(queued('run-early')), claim)
  const redial = vi.fn()
  Reflect.set(daemon, 'session', { redial, stop: async () => {} })
  await read()
  await vi.waitFor(() => expect(redial).toHaveBeenCalledOnce())
  expect(claim).toHaveBeenCalledOnce()
})

function claimDaemon(claimRun: ServerLink['claimRun']) {
  const daemon = new Daemon({ dataDir: '/unused-commands-read-test', flavor: 'dev',
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
    computer: { botId: '10000000-0000-4000-8000-000000000004', ownerId: 'task-owner', display: ':1' },
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

it('shares an in-flight pass or RPC claim with a commands read', async () => {
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
function readsWithUpdates(fetch: ServerLink['fetchCommands'], runs: unknown[] = []) {
  const { daemon, read } = readsCommands(fetch)
  const install = vi.fn(async (_version: string) => {})
  const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  Reflect.set(daemon, 'options', { ...Reflect.get(daemon, 'options'), autoUpdate: { install } })
  Reflect.set(daemon, 'paths', { dataDir: mkdtempSync(join(tmpdir(), 'mikka-read-update-')) })
  Reflect.set(daemon, 'supervisor', { ...Reflect.get(daemon, 'supervisor'), activeRunIds: () => runs })
  return { daemon, read, install, restart }
}

it('a release named on a commands read installs at once when idle, and later reads say the daemon knows it', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_id, _wait, options) => { options?.onUpdates?.({ daemonVersions: { min: '0.0.299', latest: '999.0.0' }, deviceCommands: [] }); return [] })
    .mockResolvedValue([])
  const { daemon, read, install, restart } = readsWithUpdates(fetch)
  await read()
  await Reflect.get(daemon, 'maintenance')
  expect(install).toHaveBeenCalledExactlyOnceWith('999.0.0')
  expect(restart).toHaveBeenCalledOnce()
  await read()
  expect(fetch.mock.calls[1]![2]?.updates?.daemonLatest).toBe('999.0.0')
})

it('a release named while a run is active waits for the run to end, then the local timer installs it', async () => {
  const runs: unknown[] = [{ runId: 'run-1' }]
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async (_id, _wait, options) => { options?.onUpdates?.({ daemonVersions: { min: '0.0.299', latest: '999.0.0' }, deviceCommands: [] }); return [] })
    .mockResolvedValue([])
  const { daemon, read, install } = readsWithUpdates(fetch, runs)
  await read()
  expect(install).not.toHaveBeenCalled()
  runs.length = 0
  Reflect.get(daemon, 'checkAutoUpdate').call(daemon) // what the local timer calls
  await Reflect.get(daemon, 'maintenance')
  expect(install).toHaveBeenCalledExactlyOnceWith('999.0.0')
})

it('an update a person asked for arrives on a commands read and waits for the pass to carry it out', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementation(async (_id, _wait, options) => { options?.onUpdates?.({ deviceCommands: [UPDATE] }); return [] })
  const { daemon, read, install } = readsWithUpdates(fetch)
  await read()
  await read()
  expect(Reflect.get(daemon, 'heldDeviceCommand')).toEqual(UPDATE)
  expect(install).not.toHaveBeenCalled()
})
