import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import { policySnapshotMessage, POLICY_SNAPSHOT_TTL_MS, type PolicyDistributionContext } from '@mikka/protocol/policy-snapshot'
import type { AgentAdapter } from '../src/adapters/types'
import { createLogger } from '../src/log'
import type { OutboxItem } from '../src/outbox'
import { RepositoryCache } from '../src/repositories'
import { prepareRunRepository } from '../src/run-repository'
import { daemonTracer, runIdHash } from '../src/tracing'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { HttpServerLink } from '../src/server-link-http'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const close of cleanups.splice(0)) await close() }
  finally { vi.restoreAllMocks(); cleanupTempDirs() }
})
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // Test barriers can be rejected before production attaches its waiter.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function fixture(options: { remote?: string; environment?: Record<string, string>; local?: boolean; legacy?: boolean; retain?: boolean; onComplete?(): void } = {}) {
  const root = tempDir(), source = await makeRepo(), policy = defaultRunPolicy()
  const remote = options.remote ?? pathToFileURL(source).href
  const cache = new RepositoryCache(join(root, 'repos'), true, options.retain)
  const runId = randomUUID(), issuer = 'https://mikka.example/mikka', now = Date.now()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  const context: PolicyDistributionContext = { version: 1, algorithm: 'Ed25519', issuer, ownerId: 'owner', runId,
    deviceId: 'device', revision: 'a'.repeat(64), scope: { workspaceIds: [], hierarchy: null }, required: true,
    keyId: createHash('sha256').update(der).digest('hex'), publicKey: der.toString('base64url') }
  const payload = { version: 1 as const, issuer, ownerId: context.ownerId, deviceId: context.deviceId, runId,
    revision: context.revision, scope: context.scope, policy, policyHash: policySnapshotHash(policy),
    issuedAt: now, expiresAt: now + POLICY_SNAPSHOT_TTL_MS }
  const assignment: RunAssignment = { runId, deviceId: 'device', issueId: 'issue', repoId: 'repo', harness: 'codex',
    prompt: 'Inspect the fixture', remoteUrl: remote, baseBranch: 'main', kind: 'plan', policy,
    leaseExpiresAt: new Date(now + 600_000).toISOString(), policyRevision: context.revision, policySnapshotRequired: true,
    policySnapshot: { algorithm: 'Ed25519', keyId: context.keyId, payload, signature: sign(null, policySnapshotMessage(payload), privateKey).toString('base64url') },
    ...(options.legacy || options.environment ? { github: { endpoint: `${issuer}/api/runs/github-token`, repository: 'fixture/repository',
      ...(!options.legacy ? { token: 'synthetic-fixture-credential' } : {}) } } : {}),
  }
  const policyReady = deferred(), policyEntered = deferred(), items: OutboxItem[] = []
  const fetcher = vi.fn(async (_url, init) => {
    policyEntered.resolve()
    const signal = init?.signal
    const aborted = deferred()
    const stop = () => aborted.reject(signal?.reason ?? new Error('policy cancelled'))
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    try { await Promise.race([policyReady.promise, aborted.promise]); return Response.json(context) }
    finally { signal?.removeEventListener('abort', stop) }
  })
  const link = new HttpServerLink(issuer, fetcher)
  const prepareRepository = vi.fn((run: RunAssignment, signal: AbortSignal, environment?: Record<string, string>, ready?: Promise<unknown>) =>
    prepareRunRepository(cache, join(root, 'private'), run, signal, options.environment ?? environment, ready))
  const worktrees = new WorktreeManager(join(root, 'worktrees'))
  const create = vi.spyOn(worktrees, 'create'), bootstrap = vi.spyOn(worktrees, 'bootstrap')
  const start = vi.fn(async () => ({ sessionId: 'session', async *events() {
    yield { type: 'exit' as const, outcome: 'succeeded' as const, stopReason: 'turn_ended' as const }
  }, async cancel() {}, async send() {} }))
  const adapter: AgentAdapter = { harness: 'codex', envAllow: [], capabilities: { supportsResume: true, supportsInterject: false }, start, resume: start }
  const journal = new RunJournal(join(root, 'journal.json'))
  const supervisor = new RunSupervisor({ journal, worktrees, adapterStateDir: join(root, 'state'), log: createLogger({ level: 'silent' }),
    outbox: { push(_runId: string, item: OutboxItem) { items.push(item); if (item.kind === 'complete') options.onComplete?.() }, lastChunkSeq() { return 0 }, async compact() {} } as unknown as SupervisorDeps['outbox'],
    adapters: new Map([['codex', adapter]]), repository: () => ({ repoId: 'repo', name: 'fixture', path: cache.pathFor(remote) }),
    baseRef: () => cache.baseRef(remote, assignment.baseBranch), prepareRepository,
    verifyRunPolicy: link.verifyRunPolicy.bind(link),
    ...(options.local ? { prepareRunGitHub: async () => undefined } : {}),
  })
  cleanups.push(async () => { policyReady.resolve(); await supervisor.stop() })
  return { root, source, remote, cache, assignment, policyReady, policyEntered, fetcher, items, supervisor, journal,
    prepareRepository, worktrees, create, bootstrap, start }
}

it('overlaps one fresh policy GET with the same real clone while keeping frames, worktree and adapter behind policy', async () => {
  const trace = join(tempDir(), 'git-trace.jsonl')
  const f = await fixture({ environment: { GIT_TRACE2_EVENT: trace } })
  f.supervisor.start(f.assignment)
  await f.policyEntered.promise
  await waitFor(() => f.prepareRepository.mock.calls.length === 1, 3000)
  await waitFor(() => existsSync(join(f.cache.pathFor(f.remote), '.git')), 3000)
  expect(f.items).toEqual([])
  expect(f.create).not.toHaveBeenCalled()
  expect(f.bootstrap).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  f.policyReady.resolve()
  await f.supervisor.idle()
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(f.prepareRepository).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(1)
  const connections = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event?: string; argv?: string[] })
    .filter(event => event.event === 'start' && /(?:^|\/)git-upload-pack$/.test(event.argv?.[0] ?? ''))
  expect(connections).toHaveLength(1)
  const preparing = f.items.findIndex(item => item.kind === 'run' && item.patch.state === 'preparing')
  const repository = f.items.findIndex(item => item.kind === 'chunk' && item.chunk.type === 'data-run-stage' && item.chunk.data.stage === 'repository')
  expect(preparing).toBeGreaterThanOrEqual(0)
  expect(repository).toBeGreaterThan(preparing)
  expect(readFileSync(join(f.supervisor.get(f.assignment.runId).worktree!, 'README.md'), 'utf8')).toBe('# Sandbox\n')
  expect(f.items.filter(item => item.kind === 'chunk' && item.chunk.type === 'data-run-stage').map(item =>
    item.kind === 'chunk' && item.chunk.type === 'data-run-stage' ? item.chunk.data.stage : null)).toEqual(['repository', 'worktree', 'agent_start'])
})

for (const mode of ['resume', 'local', 'legacy'] as const) it(`keeps the original policy-first path for ${mode}`, async () => {
  const f = await fixture({ local: mode === 'local', legacy: mode === 'legacy' })
  if (mode === 'resume') {
    f.journal.put({ assignment: f.assignment, state: 'queued', sessionId: null, worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
    await f.supervisor.resumeAll()
  } else f.supervisor.start(f.assignment)
  await f.policyEntered.promise
  expect(f.prepareRepository).not.toHaveBeenCalled()
  f.policyReady.resolve()
  await f.supervisor.idle()
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(f.prepareRepository).toHaveBeenCalledTimes(1)
  expect(f.start).toHaveBeenCalledTimes(1)
})

for (const [end, retain] of [['policy-denied', false], ['stop', false], ['approved-stop', false], ['lease', false], ['stop', true]] as const)
it(`reaps the real Git child when ${end} wins during the speculative clone (retain=${retain})`, async () => {
  const files = tempDir(), started = join(files, 'started'), stopped = join(files, 'stopped'), helper = join(files, 'ssh.cjs')
  // Publishing readiness lets the parent cancel immediately, so the signal
  // handler must already be installed when the started marker becomes visible.
  writeFileSync(helper, `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'term');process.exit(0)});fs.writeFileSync(${JSON.stringify(started)},String(process.pid));setTimeout(()=>process.exit(1),30000)`)
  let completeWithChildDead = false
  const f = await fixture({ remote: 'ssh://git@fixture.invalid/owner/repository.git', retain,
    environment: { GIT_SSH_COMMAND: `${process.execPath} ${helper}`, GIT_SSH_VARIANT: 'ssh' }, onComplete() {
      try { process.kill(Number(readFileSync(started, 'utf8')), 0) }
      catch { completeWithChildDead = true }
    } })
  if (retain) {
    mkdirSync(dirname(f.cache.pathFor(f.remote)), { recursive: true })
    git(f.source, 'clone', '--no-checkout', f.source, f.cache.pathFor(f.remote))
    writeFileSync(join(f.cache.pathFor(f.remote), 'retained.txt'), 'TaskVM evidence remains\n')
  }
  f.supervisor.start(f.assignment)
  await f.policyEntered.promise
  await waitFor(() => existsSync(started), 3000)
  if (end === 'approved-stop') {
    f.policyReady.resolve()
    await waitFor(() => f.supervisor.get(f.assignment.runId).state === 'preparing')
  }
  const ending = end === 'stop' || end === 'approved-stop' ? f.supervisor.cancel(f.assignment.runId)
    : end === 'lease' ? (f.supervisor.revokeLeases([f.assignment.runId]), Promise.resolve())
    : (f.policyReady.reject(new Error('policySnapshotSignatureInvalid')), Promise.resolve())
  await ending
  await f.supervisor.idle()
  expect(existsSync(stopped)).toBe(true)
  expect(() => process.kill(Number(readFileSync(started, 'utf8')), 0)).toThrow()
  expect(completeWithChildDead).toBe(true)
  expect(f.supervisor.get(f.assignment.runId).state).toBe(end === 'stop' || end === 'approved-stop' ? 'cancelled' : 'failed')
  if (end === 'lease') expect(f.supervisor.get(f.assignment.runId).stopReason).toBe('device_lost')
  expect(f.create).not.toHaveBeenCalled()
  expect(f.bootstrap).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(existsSync(f.cache.pathFor(f.remote))).toBe(retain)
  const partialClones = readdirSync(dirname(f.cache.pathFor(f.remote))).filter(name => name.includes('.clone-'))
  expect(partialClones).toEqual([])
  // Retained TaskVM files are not erased; a reaped child is not a deleted VM.
  if (retain) expect(readFileSync(join(f.cache.pathFor(f.remote), 'retained.txt'), 'utf8')).toBe('TaskVM evidence remains\n')
})

it('preserves the original error and drains a completed repository read when a later entry check refuses the run', async () => {
  const f = await fixture()
  f.assignment.requireSessionResume = true
  f.supervisor.start(f.assignment)
  await f.policyEntered.promise
  await waitFor(() => existsSync(join(f.cache.pathFor(f.remote), '.git')), 3000)
  f.policyReady.resolve()
  await f.supervisor.idle()
  expect(f.supervisor.get(f.assignment.runId)).toMatchObject({ state: 'failed', error: 'Question continuation requires the original resumable session' })
  expect(f.create).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.items.filter(item => item.kind === 'chunk' && item.chunk.type === 'data-run-stage')).toEqual([])
})

it('never seeds an empty remote when the policy barrier refuses it', async () => {
  const root = tempDir(), bare = join(root, 'empty.git')
  git(root, 'init', '--bare', '--initial-branch=main', bare)
  const f = await fixture({ remote: pathToFileURL(bare).href })
  const denied = Promise.reject(new Error('policySnapshotSignatureInvalid'))
  void denied.catch(() => undefined)
  const seed = vi.spyOn(f.cache, 'seedEmpty')
  await expect(prepareRunRepository(f.cache, join(f.root, 'private'), f.assignment, new AbortController().signal, undefined, denied)).rejects.toThrow('policySnapshotSignatureInvalid')
  expect(seed).not.toHaveBeenCalled()
  expect(git(bare, 'for-each-ref')).toBe('')
})


it.each(['ordinary', 'assignment', 'trusted_host'] as const)('records closed Git subprocess phases only for %s diagnostics', async mode => {
  const f = await fixture()
  const spans = vi.spyOn(daemonTracer, 'span')
  const assignment = { ...f.assignment, ...(mode === 'assignment' ? { taskEnv: { CLOUD_STARTUP_TIMING: '1' } } : {}) }
  for (let pass = 0; pass < 2; pass++)
    await prepareRunRepository(f.cache, join(f.root, 'private'), assignment, new AbortController().signal,
      undefined, undefined, mode === 'trusted_host')
  const measured = spans.mock.calls.filter(([name]) => name.startsWith('daemon.repository.git.'))
  if (mode === 'ordinary') expect(measured).toEqual([])
  else {
    expect(measured.map(([name]) => name)).toContain('daemon.repository.git.clone')
    expect(measured.map(([name]) => name)).toContain('daemon.repository.git.fetch')
    expect(measured.map(([name]) => name)).toContain('daemon.repository.git.remote_head')
    for (const [name, attributes] of measured) {
      expect(['daemon.repository.git.clone', 'daemon.repository.git.fetch', 'daemon.repository.git.remote_head',
        'daemon.repository.git.remote_refs', 'daemon.repository.git.local']).toContain(name)
      expect(attributes).toEqual({ 'mikka.run.id_hash': runIdHash(assignment.runId), 'mikka.harness': assignment.harness })
    }
    expect(JSON.stringify(measured.map(([name, attrs]) => ({ name, attrs })))).not.toContain(f.root)
    expect(JSON.stringify(measured.map(([name, attrs]) => ({ name, attrs })))).not.toContain(f.remote)
  }
  expect(git(f.cache.pathFor(f.remote), 'rev-parse', 'origin/main')).toBe(git(f.source, 'rev-parse', 'HEAD'))
})
