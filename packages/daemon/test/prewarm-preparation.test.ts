// Actual Supervisor/Git/outbox and installed SDK/native protocol fixture.
// The controllable clone barrier distinguishes preparation from task input.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { ClaudeAdapter } from '../src/adapters/claude'
import { prepareAgentStart } from '../src/adapters/claude-prewarm'
import type { StartOptions } from '../src/adapters/types'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { createLogger } from '../src/log'
import type { OutboxItem } from '../src/outbox'
import { stopGroup } from '../src/process-group'
import { RepositoryCache } from '../src/repositories'
import { createRunMailbox } from '../src/run-mailbox'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { runDiagnosticsEnabled } from '../src/run-runtime-timing'
import { runIdHash } from '../src/tracing'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); cleanupTempDirs() })

async function fixture(options: { cloneFailure?: boolean; legacyCatalogue?: boolean; pendingMailbox?: boolean; diagnostics?: 'task' | 'host' } = {}) {
  const root = realpathSync(tempDir('mikka-prewarm-supervisor-')), source = await makeRepo(), home = join(root, 'home')
  const stateDir = join(root, 'adapters'); mkdirSync(stateDir); mkdirSync(home)
  const remote = pathToFileURL(options.cloneFailure ? join(root, 'missing.git') : source).href
  const repositories = new RepositoryCache(join(root, 'cache'), true), worktrees = new WorktreeManager(join(root, 'worktrees'))
  const journal = new RunJournal(join(root, 'journal.json'))
  const endpoint = new URL('https://mikka.invalid/api/mcp')
  const assignment: RunAssignment = { runId: randomUUID(), issueId: randomUUID(), deviceId: randomUUID(), repoId: randomUUID(),
    harness: 'claude_code', model: 'claude-haiku-5-5', prompt: 'Complete anonymous task', remoteUrl: remote, baseBranch: 'main',
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...(options.diagnostics === 'task' ? { taskEnv: { CLOUD_STARTUP_TIMING: '1' } } : {}),
    subscriptionBinding: { bindingId: randomUUID(), ownerId: randomUUID(), workspaceId: randomUUID(), consumerId: randomUUID(), route: 'claude_code_cli' },
    subscriptionLease: { accountId: 'fixture-account', revision: 1, route: 'claude_code_cli', modelId: 'claude-haiku-5-5',
      accessToken: 'synthetic-fixture-only', expiresAt: new Date(Date.now() + 600_000).toISOString() },
    mcp: { url: endpoint.href, token: 'mkw_' + 'x'.repeat(43), mailbox: true,
      ...(!options.legacyCatalogue ? { mailboxCatalogue: { version: 1, transport: 'mikka-stateless-2025-06-18', tools: ['mailbox_inbox'] } } : {}) } }
  const cloneEntered = deferred(), cloneRelease = deferred(), parked = deferred(), user = deferred(), agentStarted = deferred()
  const mailboxEntered = deferred(), mailboxAborted = deferred()
  const children: ChildProcess[] = [], events: Array<Record<string, unknown>> = [], records: OutboxItem[] = []
  const adapter = new ClaudeAdapter({ stateDir, subscriptionAuth: { accountId: 'fixture-account', automaticRefresh: true,
    token: async () => ({ accountId: 'fixture-account', accessToken: 'synthetic-fixture-only', expiresAt: assignment.subscriptionLease!.expiresAt }) },
    spawnHosted(config) {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'fakes/fake-claude-prewarm.mjs'), ...config.args],
        { cwd: config.cwd, env: config.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
      children.push(child); child.stderr?.resume()
      child.on('message', value => {
        const event = value as Record<string, unknown>
        events.push(event); if (event.event === 'user') user.resolve()
      })
      config.signal?.addEventListener('abort', () => { void stopGroup(child, 1000) }, { once: true })
      return child as ChildProcessWithoutNullStreams
    } })
  const nativeOptions = (value: StartOptions): StartOptions => ({ ...value, env: { ...value.env, HOME: home }, machineEnvironment: true })
  const prepare = vi.fn<NonNullable<SupervisorDeps['prepareSubscription']>>((claimed, input, signal) => {
    const value = nativeOptions(input)
    const prepared = prepareAgentStart(signal, control => adapter.startPrepared(value, { ...claimed.subscriptionBinding!,
      runId: claimed.runId, sessionId: randomUUID(), cwd: value.cwd, deviceId: claimed.deviceId,
      accountId: claimed.subscriptionLease!.accountId, revision: claimed.subscriptionLease!.revision, model: claimed.model!, policyHash: value.policyHash ?? null,
    }, { ...control, finalOptions: control.finalOptions.then(nativeOptions) }, async () => { await Promise.all(children.map(child => stopGroup(child, 1000))) }),
    runDiagnosticsEnabled(claimed.taskEnv, options.diagnostics === 'host') ? { runId: claimed.runId, harness: 'claude_code' } : undefined)
    void prepared.ready.then(() => parked.resolve(), () => undefined)
    return prepared
  })
  const ordinary = vi.fn<NonNullable<SupervisorDeps['startSubscription']>>((_assignment, value) => adapter.start(nativeOptions(value)))
  const methods: string[] = []
  const deps: SupervisorDeps = { journal, worktrees, adapterStateDir: stateDir, log: createLogger({ level: 'silent' }),
    collectCliTiming: options.diagnostics === 'host',
    adapters: new Map([['claude_code', adapter]]), startSubscription: ordinary, prepareSubscription: prepare,
    outbox: { push(_runId: string, record: OutboxItem) {
      records.push(record)
      if (record.kind === 'chunk' && record.chunk.type === 'data-run-stage' && record.chunk.data.stage === 'agent_start') agentStarted.resolve()
    }, async compact() {}, lastChunkSeq() { return 0 } } as unknown as SupervisorDeps['outbox'],
    repository: () => ({ repoId: assignment.repoId, name: 'fixture', path: repositories.pathFor(remote) }),
    baseRef: () => repositories.baseRef(remote, 'main'),
    prepareRepository: async (_claimed, signal) => {
      cloneEntered.resolve()
      const abort = () => cloneRelease.resolve()
      signal.addEventListener('abort', abort, { once: true })
      try { await cloneRelease.promise; signal.throwIfAborted(); await repositories.prepare(remote, signal) }
      finally { signal.removeEventListener('abort', abort) }
    },
    prepareRunToolApproval: async (claimed, signal, check) => new ToolApprovalGate(claimed.runId, {
      isLive: () => { if (signal.aborted) return false; try { check(); return true } catch { return false } },
    }, 'push'),
    prepareRunMailbox: async (claimed, signal, check) => {
      mailboxEntered.resolve()
      if (options.pendingMailbox) await new Promise<void>((_done, reject) => {
        const abort = () => { mailboxAborted.resolve(); reject(Error('Mailbox preparation aborted')) }
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      })
      return createRunMailbox({ assignment: claimed, endpoint, signal, check, fetch: async (_url, init) => {
        const packet = JSON.parse(String(init?.body)); methods.push(packet.method)
        if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return Response.json({ jsonrpc: '2.0', id: packet.id, result: packet.method === 'initialize'
          ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'mailbox_inbox' }] } })
      } })
    },
  }
  const supervisor = new RunSupervisor(deps)
  cleanups.push(async () => { cloneRelease.resolve(); await supervisor.stop(); await supervisor.idle(); await Promise.all(children.map(child => stopGroup(child, 1000))) })
  return { supervisor, deps, assignment, worktrees, cloneEntered, cloneRelease, parked, user, agentStarted, children, events, records, prepare, ordinary, methods, mailboxEntered, mailboxAborted }
}

it.each(['ordinary', 'task', 'host'] as const)('emits the earlier task-owned clock only on the existing opted-in stage (%s)', async diagnostics => {
  const f = await fixture({ diagnostics: diagnostics === 'ordinary' ? undefined : diagnostics })
  f.supervisor.start(f.assignment); await f.parked.promise
  expect(f.records.some(item => item.kind === 'chunk' && item.chunk.type === 'data-run-stage' && item.chunk.data.stage === 'agent_start')).toBe(false)
  f.cloneRelease.resolve(); await f.agentStarted.promise; await f.user.promise
  const stages = f.records.flatMap(item => item.kind === 'chunk' && item.chunk.type === 'data-run-stage' ? [item.chunk] : [])
  expect(stages.map(chunk => [chunk.data.stage, chunk.data.ok])).toEqual([['repository', true], ['worktree', true], ['agent_start', true]])
  if (diagnostics === 'ordinary') {
    for (const chunk of stages) expect(Object.keys(chunk.data).sort()).toEqual(['ms', 'ok', 'stage'])
  } else {
    const { startupTiming, preparationTiming } = stages[2].data
    expect(startupTiming).toMatchObject({ runIdHash: runIdHash(f.assignment.runId), outcome: 'ok', phases: [] })
    expect(preparationTiming).toMatchObject({ source: 'prepared_agent_start', runIdHash: runIdHash(f.assignment.runId), harness: 'claude_code', outcome: 'ok', truncated: false })
    expect(preparationTiming?.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'daemon.adapter.cli_init.prewarm', outcome: 'ok' }),
      expect.objectContaining({ name: 'daemon.adapter.cli_init', outcome: 'ok' }),
    ]))
    expect(preparationTiming!.startedAt).toBeLessThanOrEqual(startupTiming!.startedAt)
    expect(preparationTiming!.endedAt).toBeLessThanOrEqual(startupTiming!.endedAt)
  }
  await f.supervisor.stop(); await f.supervisor.idle()
})

it('overlaps the actual native initialize with clone, then joins checkout and passes the complete task exactly once', async () => {
  const f = await fixture(); f.supervisor.start(f.assignment)
  await f.cloneEntered.promise; await f.parked.promise
  expect(existsSync(f.worktrees.pathFor(f.assignment.runId))).toBe(false)
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(0)
  expect(f.methods).toEqual([])
  f.cloneRelease.resolve(); await f.user.promise
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(1)
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.ordinary).not.toHaveBeenCalled()
  await f.supervisor.stop(); await f.supervisor.idle()
})

it('drains the already parked process when the real Git clone fails', async () => {
  const f = await fixture({ cloneFailure: true }); f.supervisor.start(f.assignment)
  await f.parked.promise; f.cloneRelease.resolve(); await f.supervisor.idle()
  expect(f.supervisor.get(f.assignment.runId).state).toBe('failed')
  expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  expect(f.events.filter(event => event.event === 'user' || event.type === 'claim_session')).toHaveLength(0)
  expect(f.ordinary).not.toHaveBeenCalled()
})

it('aborts the mailbox dependency before draining a preparation that has not reached native spawn', async () => {
  const f = await fixture({ cloneFailure: true, pendingMailbox: true }); f.supervisor.start(f.assignment)
  await f.mailboxEntered.promise; f.cloneRelease.resolve(); await f.mailboxAborted.promise; await f.supervisor.idle()
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.children).toHaveLength(0)
  expect(f.supervisor.get(f.assignment.runId).state).toBe('failed')
})

it.each(['cancel', 'revoke', 'shutdown'] as const)('a %s during clone drains the real native spare without releasing task input', async mode => {
  const f = await fixture(); f.supervisor.start(f.assignment); await f.parked.promise
  const stopping = mode === 'cancel' ? f.supervisor.cancel(f.assignment.runId)
    : mode === 'shutdown' ? f.supervisor.stop() : Promise.resolve(f.supervisor.revokeLeases([f.assignment.runId]))
  f.cloneRelease.resolve(); await stopping; await f.supervisor.idle()
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(0)
  expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  expect(f.ordinary).not.toHaveBeenCalled()
})

it('does not speculate a native process before fresh policy authorization', async () => {
  const f = await fixture(); f.deps.verifyRunPolicy = async () => { throw Error('Policy refused') }
  f.supervisor.start(f.assignment); await f.supervisor.idle()
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.children).toHaveLength(0)
  expect(f.supervisor.get(f.assignment.runId).error).toBe('Policy refused')
})

it('keeps an old server mailbox claim on its three-call and ordinary adapter path', async () => {
  const f = await fixture({ legacyCatalogue: true }); f.supervisor.start(f.assignment)
  await f.cloneEntered.promise
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.children).toHaveLength(0)
  f.cloneRelease.resolve(); await f.user.promise
  expect(f.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.ordinary).toHaveBeenCalledOnce()
  await f.supervisor.stop(); await f.supervisor.idle()
})
