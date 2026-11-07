import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { BASELINE_ARTIFACT, BASELINE_SKILL } from '../../../lib/self-improvement/builtin-skill'
import type { AgentAdapter, StartOptions } from '../src/adapters/types'
import { createLogger } from '../src/log'
import type { OutboxItem } from '../src/outbox'
import { RepositoryCache } from '../src/repositories'
import { createRunMailbox } from '../src/run-mailbox'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  cleanupTempDirs()
})

async function fixture(options: { cloneFailure?: boolean; pausedMethod?: string; delayedAbort?: boolean; lateHandoff?: boolean } = {}) {
  const root = tempDir(), source = await makeRepo()
  const remote = pathToFileURL(options.cloneFailure ? join(root, 'missing.git') : source).href
  const repositories = new RepositoryCache(join(root, 'cache'), true)
  const worktrees = new WorktreeManager(join(root, 'worktrees'))
  const journal = new RunJournal(join(root, 'journal.json'))
  const endpoint = new URL('https://mikka.invalid/mikka/api/mcp')
  const assignment: RunAssignment = { runId: randomUUID(), issueId: randomUUID(), deviceId: randomUUID(), repoId: randomUUID(),
    harness: 'mock', prompt: 'The complete task prompt', remoteUrl: remote, baseBranch: 'main',
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    mcp: { url: endpoint.href, token: 'mkw_' + 'x'.repeat(43), mailbox: true } }
  const repositoryEntered = deferred<AbortSignal>(), repositoryRelease = deferred(), repositoryDone = deferred()
  const handshakeEntered = deferred<AbortSignal>(), handshakeRelease = deferred(), handshakeAborted = deferred(), abortDrain = deferred()
  const handoffEntered = deferred(), handoffRelease = deferred(), opened = deferred<StartOptions>()
  if (!options.delayedAbort) abortDrain.resolve()
  if (!options.lateHandoff) handoffRelease.resolve()
  const methods: string[] = [], records: OutboxItem[] = []
  const close = vi.fn(async () => {})
  const start = vi.fn<AgentAdapter['start']>(async value => {
    opened.resolve(value)
    return { sessionId: 'session', async *events() { yield { type: 'exit', outcome: 'cancelled' } }, async cancel() {}, async send() {} }
  })
  const transport: typeof fetch = async (_url, init) => {
    const packet = JSON.parse(String(init?.body)) as { id?: number; method: string }
    methods.push(packet.method)
    if (packet.method === (options.pausedMethod ?? 'tools/list')) {
      const signal = init!.signal!, abort = deferred()
      const onAbort = () => { handshakeAborted.resolve(); abort.resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
      handshakeEntered.resolve(signal)
      try {
        if (signal.aborted) onAbort()
        await Promise.race([handshakeRelease.promise, abort.promise.then(async () => {
          await abortDrain.promise
          signal.throwIfAborted()
        })])
        signal.throwIfAborted()
      } finally { signal.removeEventListener('abort', onAbort) }
    }
    if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return Response.json({ jsonrpc: '2.0', id: packet.id, result: packet.method === 'initialize'
      ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'mailbox_inbox' }, { name: 'untrusted_extra' }] } })
  }
  const prepareRunMailbox = vi.fn<NonNullable<SupervisorDeps['prepareRunMailbox']>>(async (claimed, signal, check) => {
    const mailbox = await createRunMailbox({ assignment: claimed, endpoint, signal, check, fetch: transport })
    if (!mailbox) return undefined
    handoffEntered.resolve()
    await handoffRelease.promise
    return { ...mailbox, async close() { await close(); await mailbox.close() } }
  })
  const deps: SupervisorDeps = { journal, worktrees, log: createLogger({ level: 'silent' }),
    adapters: new Map([['mock', { harness: 'mock', capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [],
      start, async resume() { throw Error('Unexpected resume') } }]]),
    outbox: { push(_id: string, record: OutboxItem) { records.push(record) }, async compact() {}, lastChunkSeq() { return 0 } } as unknown as SupervisorDeps['outbox'],
    repository: () => ({ repoId: assignment.repoId, name: 'fixture', path: repositories.pathFor(remote) }),
    baseRef: () => repositories.baseRef(remote, 'main'),
    prepareRepository: async (_claimed, signal) => {
      repositoryEntered.resolve(signal)
      const aborted = deferred()
      const onAbort = () => aborted.resolve()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal.aborted) onAbort()
        await Promise.race([repositoryRelease.promise, aborted.promise])
        signal.throwIfAborted()
        await repositories.prepare(remote, signal)
        repositoryDone.resolve()
      } finally { signal.removeEventListener('abort', onAbort) }
    }, prepareRunMailbox,
  }
  const supervisor = new RunSupervisor(deps)
  cleanups.push(async () => {
    repositoryRelease.resolve(); handshakeRelease.resolve(); handoffRelease.resolve(); abortDrain.resolve()
    await supervisor.stop(); await supervisor.idle()
  })
  return { supervisor, deps, assignment, methods, records, close, start, opened, prepareRunMailbox,
    repositoryEntered, repositoryRelease, repositoryDone, handshakeEntered, handshakeRelease, handshakeAborted, abortDrain, handoffEntered, handoffRelease }
}

it.each(['repository', 'mailbox'] as const)('overlaps the enabled mailbox with clone and joins both when %s finishes first', async first => {
  const f = await fixture()
  f.supervisor.start(f.assignment)
  await f.repositoryEntered.promise
  await nextTurn()
  expect(f.prepareRunMailbox).toHaveBeenCalledOnce()
  await f.handshakeEntered.promise
  expect(f.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  expect(f.start).not.toHaveBeenCalled()
  if (first === 'repository') {
    f.repositoryRelease.resolve(); await f.repositoryDone.promise
  } else {
    f.handshakeRelease.resolve(); await f.handoffEntered.promise
  }
  await nextTurn()
  expect(f.start).not.toHaveBeenCalled()
  f.repositoryRelease.resolve(); f.handshakeRelease.resolve()
  const opened = await f.opened.promise
  expect(opened.prompt).toBe(f.assignment.prompt)
  expect(opened.mailbox?.tools.map(tool => tool.name)).toEqual(['mailbox_inbox'])
  await f.supervisor.idle()
  expect(f.close).toHaveBeenCalledOnce()
})

it('aborts and drains the read-ahead repository without starting mailbox or CLI when initial policy refuses', async () => {
  const f = await fixture(), entered = deferred(), release = deferred()
  f.deps.verifyRunPolicy = async () => { entered.resolve(); await release.promise; throw Error('Policy rejected') }
  f.supervisor.start(f.assignment)
  try {
    await entered.promise
    const repositorySignal = await f.repositoryEntered.promise
    expect(repositorySignal.aborted).toBe(false)
    expect(f.prepareRunMailbox).not.toHaveBeenCalled()
    expect(f.methods).toEqual([])
    expect(f.records).toEqual([])
    release.resolve()
    // Keep the fake clone's normal release blocked. Only the real abort
    // signal can settle its promise and allow the supervisor to drain it.
    await f.supervisor.idle()
    expect(repositorySignal.aborted).toBe(true)
    expect(f.prepareRunMailbox).not.toHaveBeenCalled()
    expect(f.methods).toEqual([])
    expect(f.start).not.toHaveBeenCalled()
    expect(f.supervisor.activeRunIds()).toEqual([])
    expect(f.supervisor.get(f.assignment.runId).error).toBe('Policy rejected')
  } finally {
    release.resolve(); f.repositoryRelease.resolve()
    await f.supervisor.idle()
  }
})

it.each(['digest', 'team-authorization'] as const)('keeps the initial Skill %s check before mailbox and clone', async mode => {
  const f = await fixture(), entered = deferred(), release = deferred()
  f.assignment.skills = [BASELINE_SKILL]
  f.assignment.skillReceipt = { id: randomUUID(), runId: f.assignment.runId, issueId: f.assignment.issueId,
    deviceId: f.assignment.deviceId, repoId: f.assignment.repoId, agentId: randomUUID(), assignedAt: new Date().toISOString(),
    leaseExpiresAt: f.assignment.leaseExpiresAt!, artifact: { ...BASELINE_ARTIFACT,
      ...(mode === 'digest' ? { sha256: '0'.repeat(64) } : { registryId: 'mikka-team' }) } }
  f.deps.revalidateSkillAssignment = async () => { entered.resolve(); await release.promise; throw Error('Skill withdrawn') }
  f.supervisor.start(f.assignment)
  if (mode === 'team-authorization') {
    await entered.promise
    expect(f.prepareRunMailbox).not.toHaveBeenCalled()
    release.resolve()
  }
  await f.supervisor.idle()
  expect(f.prepareRunMailbox).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.supervisor.get(f.assignment.runId).error).toBe(mode === 'digest' ? 'Assigned Skill artifact digest mismatch' : 'Skill withdrawn')
})

it('aborts and drains a pending mailbox request when the actual clone fails', async () => {
  const f = await fixture({ cloneFailure: true, pausedMethod: 'initialize', delayedAbort: true })
  f.supervisor.start(f.assignment)
  await f.repositoryEntered.promise
  await nextTurn()
  expect(f.prepareRunMailbox).toHaveBeenCalledOnce()
  const signal = await f.handshakeEntered.promise
  f.repositoryRelease.resolve()
  await f.handshakeAborted.promise
  expect(signal.aborted).toBe(true)
  let ended = false
  const ending = f.supervisor.idle().then(() => { ended = true })
  await nextTurn()
  expect(ended).toBe(false)
  expect(f.supervisor.activeRunIds()).toEqual([f.assignment.runId])
  f.abortDrain.resolve()
  await ending
  expect(f.methods).toEqual(['initialize'])
  expect(f.start).not.toHaveBeenCalled()
  expect(f.supervisor.get(f.assignment.runId)).toMatchObject({ state: 'failed', stopReason: 'error' })
  expect(f.records.filter(record => record.kind === 'complete')).toHaveLength(1)
})

it('closes a completed mailbox exactly once when clone fails afterwards', async () => {
  const f = await fixture({ cloneFailure: true })
  f.handshakeRelease.resolve()
  f.supervisor.start(f.assignment)
  await f.repositoryEntered.promise
  await nextTurn()
  expect(f.prepareRunMailbox).toHaveBeenCalledOnce()
  await f.handoffEntered.promise
  f.repositoryRelease.resolve()
  await f.supervisor.idle()
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.start).not.toHaveBeenCalled()
})

it.each(['cancel', 'revoke', 'shutdown'] as const)('aborts a late mailbox handoff on %s and closes it before releasing the run', async mode => {
  const f = await fixture({ lateHandoff: true })
  f.handshakeRelease.resolve()
  f.supervisor.start(f.assignment)
  await f.repositoryEntered.promise
  await nextTurn()
  expect(f.prepareRunMailbox).toHaveBeenCalledOnce()
  await f.handoffEntered.promise
  const signal = f.prepareRunMailbox.mock.calls[0]![1]
  const stopping = mode === 'cancel' ? f.supervisor.cancel(f.assignment.runId)
    : mode === 'shutdown' ? f.supervisor.stop() : Promise.resolve(f.supervisor.revokeLeases([f.assignment.runId]))
  expect(signal.aborted).toBe(true)
  f.repositoryRelease.resolve()
  await nextTurn()
  expect(f.supervisor.activeRunIds()).toEqual([f.assignment.runId])
  expect(f.close).not.toHaveBeenCalled()
  f.handoffRelease.resolve()
  await stopping; await f.supervisor.idle()
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.records.filter(record => record.kind === 'complete')).toHaveLength(mode === 'shutdown' ? 0 : 1)
})

it('observes an early mailbox rejection and never starts the CLI after clone completes', async () => {
  const f = await fixture()
  f.prepareRunMailbox.mockRejectedValueOnce(Error('Mailbox rejected'))
  f.supervisor.start(f.assignment)
  await f.repositoryEntered.promise
  await nextTurn()
  expect(f.prepareRunMailbox).toHaveBeenCalledOnce()
  // The runner reports unhandled rejections; keep clone held through an event-loop turn.
  expect(f.start).not.toHaveBeenCalled()
  f.repositoryRelease.resolve()
  await f.supervisor.idle()
  expect(f.supervisor.get(f.assignment.runId).error).toBe('Mailbox rejected')
  expect(f.start).not.toHaveBeenCalled()
})

it('keeps disabled mailbox preparation on its existing path without network requests', async () => {
  const f = await fixture()
  delete f.assignment.mcp!.mailbox
  f.supervisor.start(f.assignment)
  await f.repositoryEntered.promise
  await nextTurn()
  expect(f.prepareRunMailbox).not.toHaveBeenCalled()
  f.repositoryRelease.resolve()
  const opened = await f.opened.promise
  expect(opened.mailbox).toBeUndefined()
  expect(opened.prompt).toBe(f.assignment.prompt)
  await f.supervisor.idle()
  expect(f.prepareRunMailbox).toHaveBeenCalledOnce()
  expect(f.methods).toEqual([])
  expect(f.close).not.toHaveBeenCalled()
})
