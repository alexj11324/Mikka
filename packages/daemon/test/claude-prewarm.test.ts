import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prewarm, type Query, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareClaudeSession, type ClaudePrewarmBinding } from '../src/adapters/claude-prewarm'
import { stopGroup } from '../src/process-group'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(mode = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-prewarm-'))
  const parking = join(dir, 'parking'), cwd = join(dir, 'checkout')
  mkdirSync(parking)
  const sessionId = randomUUID()
  const binding: ClaudePrewarmBinding = { runId: randomUUID(), sessionId, cwd,
    deviceId: randomUUID(), bindingId: randomUUID(), ownerId: randomUUID(), workspaceId: randomUUID(),
    consumerId: randomUUID(), accountId: 'anonymous-account', revision: 1, model: 'claude-haiku-5-5', policyHash: 'fixture-policy' }
  const abort = new AbortController()
  let live = true, child: ChildProcess | undefined
  const events: Array<Record<string, unknown>> = []
  const listeners = new Set<() => void>()
  const wait = (predicate: (event: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((done, reject) => {
    const check = () => { const event = events.find(predicate); if (event) { clearTimeout(timer); listeners.delete(check); done(event) } }
    const timer = setTimeout(() => { listeners.delete(check); reject(Error('Fixture event did not arrive')) }, 5000)
    listeners.add(check); check()
  })
  const stop = vi.fn(async () => {
    if (child) await stopGroup(child, 1000)
    events.push({ event: 'group_stopped' }); for (const listener of listeners) listener()
  })
  const start = vi.fn((abortController: AbortController) => prewarm({ initializeTimeoutMs: 5000, options: {
    cwd: parking, sessionId, abortController, settingSources: [], permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true, model: binding.model,
    mcpServers: { fixture_only: { type: 'stdio', command: '/unused-anonymous-fixture' } },
    env: { HOME: dir, PATH: process.env.PATH, DISABLE_NON_ESSENTIAL_TRAFFIC: '1' },
    spawnClaudeCodeProcess(config: SpawnOptions): SpawnedProcess {
      abortController.signal.throwIfAborted()
      child = spawn(process.execPath, [resolve(import.meta.dirname, 'fakes/fake-claude-prewarm.mjs'),
        ...config.args, '--fixture-mode', mode, '--termination-file', join(dir, 'child-terminated')], {
        cwd: config.cwd, env: config.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      })
      child.stderr?.resume()
      child.on('message', event => { events.push(event as Record<string, unknown>); for (const listener of listeners) listener() })
      // The first three descriptors above are all pipes; IPC is a fourth.
      return child as ChildProcessWithoutNullStreams
    },
  } }))
  const handle = prepareClaudeSession({ binding, signal: abort.signal, prepare: start, stop,
    assertLive: () => { if (!live) throw Error('Local run lease revoked') } })
  cleanups.push(async () => { try { await handle.cancel() } finally { rmSync(dir, { recursive: true, force: true }) } })
  return { dir, binding, handle, abort, start, stop, events, wait,
    checkout: () => mkdirSync(cwd), expire: () => { live = false }, revoke: () => { live = false; abort.abort() },
    child: () => child!, userFrames: () => events.filter(event => event.event === 'user'),
    claimFrames: () => events.filter(event => event.event === 'control' && event.type === 'claim_session') }
}

it('parks the actual SDK transport before checkout, then withholds all user frames until claim and verification finish', async () => {
  const f = await fixture('pause_claim')
  await f.handle.ready
  expect(existsSync(f.binding.cwd)).toBe(false)
  expect(await f.wait(event => event.event === 'spawn')).toMatchObject({ cwd: join(f.dir, 'parking'), awaitingClaim: true, mcpNames: ['fixture_only'] })
  expect(f.claimFrames()).toHaveLength(0)
  expect(f.userFrames()).toHaveLength(0)
  f.checkout()
  const verifying = deferred(), verified = deferred()
  let result: Awaited<ReturnType<typeof f.handle.consume>> | undefined
  const consuming = f.handle.consume({ binding: f.binding, appendSystemPrompt: 'Complete anonymous instructions.',
    verify: async query => { expect((await query.accountInfo()).apiProvider).toBe('firstParty'); verifying.resolve(); await verified.promise },
  }).then(value => { result = value; return value })
  await f.wait(event => event.event === 'control' && event.type === 'claim_session')
  expect(result).toBeUndefined()
  expect(f.userFrames()).toHaveLength(0)
  f.child().send({ release: 'claim' })
  await verifying.promise
  expect(f.userFrames()).toHaveLength(0)
  verified.resolve()
  const session = await consuming
  const uuid = session.send('Only now is the complete task permitted.')
  expect(await f.wait(event => event.event === 'user')).toMatchObject({ uuid, sessionId: f.binding.sessionId })
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.claimFrames()).toHaveLength(1)
  await session.close()
  expect(() => session.send('late task')).toThrow()
})

it('cancels and drains a native process still waiting for initialize', async () => {
  const f = await fixture('pause_initialize')
  await f.wait(event => event.event === 'control' && event.type === 'initialize')
  const ready = expect(f.handle.ready).rejects.toThrow()
  f.revoke()
  await f.handle.cancel(); await ready
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true)
  expect(f.userFrames()).toHaveLength(0)
  expect(f.claimFrames()).toHaveLength(0)
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('clone failure discards an unused parked process without starting or claiming another', async () => {
  const f = await fixture()
  await f.handle.ready
  const first = f.handle.cancel(), second = f.handle.cancel()
  expect(first).toBe(second)
  await first
  expect(f.userFrames()).toHaveLength(0)
  expect(f.claimFrames()).toHaveLength(0)
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('an unexpected parked CLI exit automatically closes its ownership before clone finishes', async () => {
  const f = await fixture(); await f.handle.ready
  f.child().kill('SIGTERM')
  await f.wait(event => event.event === 'group_stopped')
  expect(f.handle.state).toBe('closed')
  expect(existsSync(f.binding.cwd)).toBe(false)
  expect(f.userFrames()).toHaveLength(0)
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(1)
})

it.each(['runId', 'accountId', 'model', 'policyHash'] as const)('refuses a changed %s before any claim or prompt', async key => {
  const f = await fixture(); await f.handle.ready; f.checkout()
  await expect(f.handle.consume({ binding: { ...f.binding, [key]: 'different' }, appendSystemPrompt: '', verify: async () => {} })).rejects.toThrow('binding')
  expect(f.claimFrames()).toHaveLength(0)
  expect(f.userFrames()).toHaveLength(0)
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true)
})

it.each(['refuse_claim', 'wrong_session', 'wrong_cwd'])('closes %s without cold fallback or task input', async mode => {
  const f = await fixture(mode); await f.handle.ready; f.checkout()
  const verify = vi.fn(async (_query: Query) => {})
  await expect(f.handle.consume({ binding: f.binding, appendSystemPrompt: '', verify })).rejects.toThrow()
  expect(verify).not.toHaveBeenCalled()
  expect(f.userFrames()).toHaveLength(0)
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true)
})

it('rechecks local authority after verification before exposing send', async () => {
  const f = await fixture(); await f.handle.ready; f.checkout()
  await expect(f.handle.consume({ binding: f.binding, appendSystemPrompt: '', verify: async () => { f.revoke() } })).rejects.toThrow()
  expect(f.userFrames()).toHaveLength(0)
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('cancels during the final verification and drains it without releasing a task frame', async () => {
  const f = await fixture(); await f.handle.ready; f.checkout()
  const verifying = deferred(), drained = vi.fn()
  const result = f.handle.consume({ binding: f.binding, appendSystemPrompt: '', verify: async (_query, signal) => {
    verifying.resolve()
    try {
      await new Promise<never>((_, reject) => {
        if (signal.aborted) reject(Error('Verification cancelled'))
        else signal.addEventListener('abort', () => reject(Error('Verification cancelled')), { once: true })
      })
    } finally { drained() }
  } })
  const rejected = expect(result).rejects.toThrow('Verification cancelled')
  await verifying.promise
  f.revoke()
  await f.handle.cancel(); await rejected
  expect(drained).toHaveBeenCalledTimes(1)
  expect(f.userFrames()).toHaveLength(0)
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true)
})

it('an expired local lease refuses send and cancels the owned process without a new remote check', async () => {
  const f = await fixture(); await f.handle.ready; f.checkout()
  const session = await f.handle.consume({ binding: f.binding, appendSystemPrompt: '', verify: async () => {} })
  f.expire()
  expect(() => session.send('Must never be submitted')).toThrow('lease revoked')
  await f.handle.cancel()
  expect(f.userFrames()).toHaveLength(0)
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true)
})

it('refuses a duplicate consume while the first claim is still pending', async () => {
  const f = await fixture('pause_claim'); await f.handle.ready; f.checkout()
  const input = { binding: f.binding, appendSystemPrompt: '', verify: async () => {} }
  const first = f.handle.consume(input)
  await f.wait(event => event.event === 'control' && event.type === 'claim_session')
  await expect(f.handle.consume(input)).rejects.toThrow('once')
  f.child().send({ release: 'claim' })
  await (await first).close()
  expect(f.claimFrames()).toHaveLength(1)
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('revocation stops the owned native group and its descendant while another run stays parked', async () => {
  const f = await fixture('descendant'), other = await fixture()
  await Promise.all([f.handle.ready, other.handle.ready])
  await f.wait(event => event.event === 'descendant')
  f.revoke(); await f.handle.cancel()
  expect(readFileSync(join(f.dir, 'child-terminated'), 'utf8')).toBe('terminated')
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true)
  expect(other.child().exitCode).toBeNull(); expect(other.child().signalCode).toBeNull()
  expect(other.handle.state).toBe('parked')
  expect(f.userFrames()).toHaveLength(0)
})
