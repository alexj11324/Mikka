import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MockAdapter } from '../src/adapters/mock'
import { consumeCloudBootstrap, installCloudCredential } from '../src/cloud-bootstrap'
import { ServerUnreachableError } from '../src/errors'
import { Daemon } from '../src/main'
import { RepositoryCache } from '../src/repositories'
import { RpcServer, type RpcHandlers, type RpcServerOptions } from '../src/rpc/server'
import * as workspaceControl from '../src/runs/workspace-control'
import { MemoryServer } from '../src/server-link'
import { SessionRejectedError } from '../src/server-link-http'
import * as service from '../src/service'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

const cleanups: (() => Promise<void>)[] = []
let handlers: RpcHandlers
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  // These tests exercise the actual daemon/claim/Git lifecycle. The unrelated
  // local IPC listener is not needed to deliver the server-side locator.
  vi.spyOn(RpcServer.prototype, 'listen').mockImplementation(async function (this: RpcServer) {
    handlers = (this as unknown as { options: RpcServerOptions }).options.handlers
  })
  // A cloud hint also enables the host's root-installed execution fence. This
  // claim/Git suite does not install an E2B host; real flock and supervisor
  // ordering are covered in runs/workspace-control.test.ts and supervisor.test.ts.
  vi.spyOn(workspaceControl, 'acquireCloudWorkspaceControl').mockImplementation(async () => ({
    setWorktree: vi.fn(), release: vi.fn(async () => {}),
  }))
})
afterEach(async () => {
  try { for (const close of cleanups.splice(0)) await close() }
  finally { vi.restoreAllMocks(); cleanupTempDirs() }
})

const config = () => ({ deviceId: randomUUID(), workspaceId: randomUUID(), credential: `orv_${'a'.repeat(43)}`, server: 'https://mikka.example/mikka' })
function handoff() {
  const directory = tempDir(), path = join(directory, 'bootstrap.json'), hint = join(directory, 'initial-run.json')
  const input = config(), body = JSON.stringify(input), runId = randomUUID()
  const locator = { version: 1, runId, bootstrapSha256: createHash('sha256').update(body).digest('hex') }
  writeFileSync(path, body, { mode: 0o600 })
  writeFileSync(hint, JSON.stringify(locator), { mode: 0o600 })
  return { directory, path, hint, input, body, runId, locator }
}

it('consumes a private locator tied to the exact one-use bootstrap without persisting it', async () => {
  const f = handoff()
  const consumed = consumeCloudBootstrap(f.path)
  expect(consumed).toEqual({ ...f.input, initialRunId: f.runId })
  expect(existsSync(f.path)).toBe(false)
  expect(existsSync(f.hint)).toBe(false)
  expect(JSON.parse(f.body)).toEqual(f.input) // The legacy strict bootstrap shape is unchanged.
  expect(await installCloudCredential(f.directory, consumed)).toBe('start')
  const device = readFileSync(join(f.directory, 'device.json'), 'utf8')
  expect(device).not.toContain(f.runId)
  expect(device).not.toContain(f.locator.bootstrapSha256)
})

it('preserves trace metadata and binds the locator to the complete original bootstrap bytes', () => {
  const f = handoff()
  const input = { ...f.input,
    traceContext: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, runId: f.runId,
      sessionId: 'replay_fixture', sampleRate: 1 },
    tracing: { endpoint: 'https://us.i.posthog.com/i/v1/traces', projectToken: 'phc_fixture12345', sampleRate: 1 },
  }
  const body = `${JSON.stringify(input, null, 2)}\n`
  // Neither the payload before telemetry was added nor a reserialized copy
  // matches the bytes actually handed over for this optional hint.
  for (const candidate of [body, f.body, JSON.stringify(input)]) {
    writeFileSync(f.path, body, { mode: 0o600 })
    writeFileSync(f.hint, JSON.stringify({ ...f.locator,
      bootstrapSha256: createHash('sha256').update(candidate).digest('hex'),
    }), { mode: 0o600 })
    expect(consumeCloudBootstrap(f.path)).toEqual({ ...input, ...(candidate === body ? { initialRunId: f.runId } : {}) })
    expect(existsSync(f.path)).toBe(false)
    expect(existsSync(f.hint)).toBe(false)
  }
})

it('does not reuse a locator across credential rotation or another device/workspace', () => {
  for (const changed of [
    { credential: `orv_${'b'.repeat(43)}` }, { deviceId: randomUUID() }, { workspaceId: randomUUID() },
  ]) {
    const f = handoff(), input = { ...f.input, ...changed }
    writeFileSync(f.path, JSON.stringify(input))
    expect(consumeCloudBootstrap(f.path)).toEqual(input)
    expect(existsSync(f.hint)).toBe(false)
  }
})

it('falls back to discovery for malformed, oversized, public, directory or symlink locators', () => {
  for (const invalid of ['malformed', 'oversized', 'public', 'directory', 'symlink', 'unknown', 'run-id'] as const) {
    const f = handoff()
    if (invalid === 'malformed') writeFileSync(f.hint, '{')
    if (invalid === 'oversized') writeFileSync(f.hint, 'x'.repeat(513))
    if (invalid === 'public') chmodSync(f.hint, 0o644)
    if (invalid === 'directory') { unlinkSync(f.hint); mkdirSync(f.hint) }
    if (invalid === 'unknown') writeFileSync(f.hint, JSON.stringify({ ...f.locator, assignment: {} }))
    if (invalid === 'run-id') writeFileSync(f.hint, JSON.stringify({ ...f.locator, runId: '../../other' }))
    if (invalid === 'symlink') {
      const target = join(f.directory, 'elsewhere')
      writeFileSync(target, JSON.stringify(f.locator))
      unlinkSync(f.hint); symlinkSync(target, f.hint)
    }
    expect(consumeCloudBootstrap(f.path)).toEqual(f.input)
    expect(existsSync(f.hint)).toBe(invalid === 'directory')
  }
})

it('a real FIFO locator cannot block the optional hint before fstat', () => {
  const f = handoff()
  unlinkSync(f.hint)
  execFileSync('mkfifo', [f.hint])
  const module = new URL('../src/cloud-bootstrap.ts', import.meta.url).href
  const script = `import { consumeCloudBootstrap } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(consumeCloudBootstrap(process.argv[1])))`
  // A regression to blocking open must fail within this bound, not hang the
  // Vitest event loop before its own asynchronous timeout can fire.
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.path], { encoding: 'utf8', timeout: 5_000 })
  expect(JSON.parse(output)).toEqual(f.input)
  expect(existsSync(f.hint)).toBe(false)
})

async function machine(hint = true, options: { delayedClaim?: boolean; cloud?: boolean; seed?: 'valid' | 'missing' | 'wrong-repo' | 'wrong-remote' | 'malformed' | 'continuation'; claimFailure?: boolean } = {}) {
  const deviceId = randomUUID(), repo = await makeRepo(), dataDir = tempDir()
  const server = new MemoryServer(deviceId)
  const recipe = { approved: true, copyFiles: ['.env.local'], command: `node -e "require('fs').writeFileSync('setup-ran','complete')"` }
  server.addRepo(deviceId, { repoId: 'repo-1', name: 'fixture', path: repo, setup: recipe })
  const runId = server.queueRun(deviceId, { issueId: 'issue-1', repoId: 'repo-1', baseBranch: 'main', harness: 'mock', prompt: 'complete prompt', fixture: 'stall' })
  const link = server.link(), original = { ...link }, calls: string[] = [], claimOptions: unknown[] = []
  const registerEntered = deferred(), registration = deferred()
  const reposEntered = deferred(), repositories = deferred()
  const claimEntered = deferred(), claimResponse = deferred(), queued = deferred<string[]>()
  const commandsEntered = deferred()
  let commands = 0, revoked = false
  link.registerDevice = async (...args) => { calls.push('register'); registerEntered.resolve(); await registration.promise; return original.registerDevice(...args) }
  link.heartbeat = async (...args) => { calls.push('heartbeat'); return original.heartbeat(...args) }
  link.listRepos = async (...args) => { calls.push('repos'); reposEntered.resolve(); await repositories.promise; return original.listRepos(...args) }
  link.pendingRuns = async (...args) => { calls.push('pending'); return original.pendingRuns(...args) }
  link.claimRun = async (...args) => {
    calls.push('claim'); claimOptions.push(args[3]); claimEntered.resolve(); if (options.claimFailure) throw new Error('Fixture claim refused')
    const assignment = await original.claimRun(...args)
    await claimResponse.promise
    if (!options.seed || options.seed === 'missing') return assignment
    const initialRepository = { ...(await original.listRepos(deviceId))[0], remoteUrl: assignment.remoteUrl, networkAllow: ['packages.example.invalid'] }
    if (options.seed === 'wrong-repo') initialRepository.repoId = 'other-repo'
    if (options.seed === 'wrong-remote') initialRepository.remoteUrl = 'https://github.com/fixture/other.git'
    if (options.seed === 'malformed') Object.assign(initialRepository, { setup: { approved: 'not-a-boolean' } })
    return { ...assignment, repo: initialRepository, ...(options.seed === 'continuation' ? { continuesRunId: 'previous-run' } : {}) }
  }
  if (!options.delayedClaim) claimResponse.resolve()
  link.verifyRunPolicy = vi.fn(async () => { calls.push('policy'); if (revoked) throw new Error('Current run was stopped') })
  link.fetchCommands = async (_deviceId, _wait, options) => {
    calls.push('commands'); commandsEntered.resolve()
    const aborted = deferred<string[]>(), abort = () => aborted.resolve([])
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted) abort()
    try {
      const runIds = await (commands++ === 0 ? Promise.race([queued.promise, aborted.promise]) : aborted.promise)
      if (!options?.signal?.aborted && runIds.length) options?.onQueuedRuns?.(runIds)
      return []
    } finally { options?.signal?.removeEventListener('abort', abort) }
  }
  const daemon = await new Daemon({ dataDir, flavor: 'dev', agentSandbox: null, link, credential: 'fixture-credential',
    ...(options.cloud ? { hostedSubscriptions: true, e2bContainerRuntime: true, harnessBinaries: { claude_code: resolve(import.meta.dirname, 'fakes/fake-claude-subscription.mjs') } } : {}),
    initialRunId: hint ? runId : undefined, harnesses: [{ harness: 'mock', installed: true, version: 'fixture' }],
    modelProbe: false, mockSpeed: Infinity, heartbeatMs: 60_000, quotaSource: null }).start()
  const started = vi.spyOn(daemon.supervisor, 'start')
  const warnings = vi.spyOn(daemon.log, 'warn')
  cleanups.push(async () => { registration.resolve(); repositories.resolve(); claimResponse.resolve(); await daemon.stop() })
  return { daemon, deviceId, runId, link, calls, recipe, started, registration, registerEntered, repositories, reposEntered,
    claimEntered, claimResponse, queued, commandsEntered, warnings, claimOptions, revoke: () => { revoked = true; server.requestStop(runId) } }
}

it.each([false, true])('uses the same first-pass RPCs and preserves complete setup/copyFiles (hint=%s)', async hint => {
  const prepare = vi.spyOn(RepositoryCache.prototype, 'prepare')
  const actualBootstrap = WorktreeManager.prototype.bootstrap
  const bootstrap = vi.spyOn(WorktreeManager.prototype, 'bootstrap').mockImplementation(async function (this: WorktreeManager, worktree, repo, recipe) {
    writeFileSync(join(repo, '.env.local'), 'CACHE_INPUT=1\n')
    return actualBootstrap.call(this, worktree, repo, recipe)
  })
  const adapter = vi.spyOn(MockAdapter.prototype, 'start')
  const f = await machine(hint)
  await f.registerEntered.promise
  expect(f.calls).toEqual(['register'])
  f.registration.resolve()
  await f.reposEntered.promise
  if (hint) await f.claimEntered.promise
  expect(f.calls.filter(name => name === 'claim')).toHaveLength(hint ? 1 : 0)
  expect(f.started).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(bootstrap).not.toHaveBeenCalled()
  expect(adapter).not.toHaveBeenCalled()
  f.repositories.resolve()
  await waitFor(() => adapter.mock.calls[0]?.[0])
  expect(f.started).toHaveBeenCalledOnce()
  expect(f.link.verifyRunPolicy).toHaveBeenCalledOnce()
  expect(bootstrap).toHaveBeenCalledWith(expect.any(String), expect.any(String), f.recipe)
  const options = adapter.mock.calls[0][0]
  expect(options.prompt).toContain('complete prompt')
  expect(readFileSync(join(options.cwd, '.env.local'), 'utf8')).toBe('CACHE_INPUT=1\n')
  expect(readFileSync(join(options.cwd, 'setup-ran'), 'utf8')).toBe('complete')
  expect(Object.fromEntries(['register', 'heartbeat', 'repos', 'pending', 'claim', 'commands', 'policy'].map(name =>
    [name, f.calls.filter(call => call === name).length]))).toEqual({ register: 1, heartbeat: 1, repos: 1, pending: 1, claim: 1, commands: 1, policy: 1 })
})

it('deduplicates the locator and a concurrent queued command while repository settings are pending', async () => {
  const f = await machine()
  f.registration.resolve()
  await Promise.all([f.claimEntered.promise, f.commandsEntered.promise, f.reposEntered.promise])
  f.queued.resolve([f.runId])
  // Drain the command response without releasing repository setup.
  await waitFor(() => f.calls.filter(call => call === 'commands').length === 2)
  expect(f.calls.filter(call => call === 'claim')).toHaveLength(1)
  expect(f.started).not.toHaveBeenCalled()
  f.repositories.resolve()
  await waitFor(() => f.started.mock.calls.length === 1)
  expect(f.calls.filter(call => call === 'claim')).toHaveLength(1)
})

it.each([false, true])('does not start when repository synchronization fails (late claim=%s)', async delayedClaim => {
  const adapter = vi.spyOn(MockAdapter.prototype, 'start')
  const f = await machine(true, { delayedClaim })
  f.registration.resolve()
  await Promise.all([f.claimEntered.promise, f.reposEntered.promise])
  f.repositories.reject(new Error('repository synchronization unavailable'))
  await waitFor(() => f.daemon.status().server === 'offline')
  f.claimResponse.resolve()
  const warning = await waitFor(() => f.warnings.mock.calls.find(args => args[1] === 'could not start run'))
  expect((warning[0] as { err: Error }).err.message).toBe('repository synchronization unavailable')
  await f.daemon.stop()
  expect(f.started).not.toHaveBeenCalled()
  expect(adapter).not.toHaveBeenCalled()
})

it.each(['shutdown', 'credential-cleared', 'credential-rotated'] as const)('keeps the existing final claim fence after repository wait (%s)', async mode => {
  const f = await machine(true, { delayedClaim: true })
  f.registration.resolve()
  await Promise.all([f.claimEntered.promise, f.reposEntered.promise])
  const stopping = mode === 'shutdown' ? f.daemon.stop() : undefined
  if (mode === 'credential-cleared') await handlers['device.clearCredential']({})
  if (mode === 'credential-rotated') await handlers['device.setCredential']({ credential: `orv_${'b'.repeat(43)}` })
  f.repositories.resolve()
  f.claimResponse.resolve()
  if (stopping) await stopping
  else {
    const warning = await waitFor(() => f.warnings.mock.calls.find(args => args[1] === 'could not start run'))
    const error = (warning[0] as { err: Error }).err
    expect(error).toBeInstanceOf(ServerUnreachableError)
    expect(error.cause).toBe('Device session changed while claiming run')
  }
  expect(f.started).not.toHaveBeenCalled()
})

it('still performs fresh policy authorization after the repository join and refuses a stop during that wait', async () => {
  const prepare = vi.spyOn(RepositoryCache.prototype, 'prepare'), adapter = vi.spyOn(MockAdapter.prototype, 'start')
  const f = await machine()
  f.registration.resolve()
  await Promise.all([f.claimEntered.promise, f.reposEntered.promise])
  f.revoke()
  f.repositories.resolve()
  await waitFor(() => f.started.mock.calls.length === 1)
  await f.daemon.supervisor.idle()
  expect(f.link.verifyRunPolicy).toHaveBeenCalledOnce()
  expect(f.daemon.supervisor.get(f.runId).state).toBe('failed')
  expect(prepare).not.toHaveBeenCalled()
  expect(adapter).not.toHaveBeenCalled()
})

it('does not start when the registered device session is rejected before repository sync', async () => {
  const f = await machine()
  f.link.heartbeat = async () => { f.calls.push('heartbeat'); throw new SessionRejectedError() }
  f.registration.resolve()
  await f.claimEntered.promise
  await waitFor(() => !JSON.parse(readFileSync(f.daemon.paths.device, 'utf8')).credential)
  await f.daemon.stop()
  expect(f.started).not.toHaveBeenCalled()
  expect(f.calls).not.toContain('repos')
})

it('uninstall rejects the repository wait and drains a late claim before closing without starting work', async () => {
  const uninstall = vi.spyOn(service, 'uninstallService').mockResolvedValue()
  const prepare = vi.spyOn(RepositoryCache.prototype, 'prepare'), adapter = vi.spyOn(MockAdapter.prototype, 'start')
  const f = await machine(true, { delayedClaim: true })
  const heartbeat = f.link.heartbeat
  f.link.heartbeat = async (...args) => ({ ...await heartbeat(...args), deviceCommands: [{ id: randomUUID(), kind: 'uninstall' }] })
  f.registration.resolve()
  await f.claimEntered.promise
  await waitFor(() => f.daemon.status().draining)
  f.claimResponse.resolve()
  await waitFor(() => uninstall.mock.calls.length === 1)
  expect(f.started).not.toHaveBeenCalled()
  expect(f.calls).not.toContain('repos')
  expect(prepare).not.toHaveBeenCalled()
  expect(adapter).not.toHaveBeenCalled()
})

it('uses claim repository settings once after the heartbeat barrier, preserving real setup and copyFiles', async () => {
  const acquire = vi.mocked(workspaceControl.acquireCloudWorkspaceControl)
  const actualBootstrap = WorktreeManager.prototype.bootstrap
  vi.spyOn(WorktreeManager.prototype, 'bootstrap').mockImplementation(async function (this: WorktreeManager, worktree, repo, recipe) {
    writeFileSync(join(repo, '.env.local'), 'CACHE_INPUT=1\n')
    return actualBootstrap.call(this, worktree, repo, recipe)
  })
  const adapter = vi.spyOn(MockAdapter.prototype, 'start')
  const f = await machine(true, { cloud: true, seed: 'valid' })
  const heartbeat = f.link.heartbeat, barrier = deferred()
  f.link.heartbeat = async (...args) => { await barrier.promise; return heartbeat(...args) }
  f.repositories.resolve()
  f.registration.resolve()
  await f.claimEntered.promise
  await new Promise(resolve => setImmediate(resolve))
  expect(f.started).not.toHaveBeenCalled()
  expect(acquire).not.toHaveBeenCalled()
  barrier.resolve()
  const options = await waitFor(() => adapter.mock.calls[0]?.[0])
  expect(acquire).toHaveBeenCalledOnce()
  expect(acquire.mock.calls[0][0]).toMatchObject({ runId: f.runId, deviceId: f.deviceId })
  const control = await acquire.mock.results[0].value
  expect(control.setWorktree).toHaveBeenCalledExactlyOnceWith(options.cwd)
  expect(f.calls.filter(name => name === 'repos')).toHaveLength(0)
  expect(f.claimOptions).toEqual([{ initialRepository: true }])
  expect(f.started.mock.calls[0][0].repo).toBeUndefined()
  expect(readFileSync(join(options.cwd, '.env.local'), 'utf8')).toBe('CACHE_INPUT=1\n')
  expect(readFileSync(join(options.cwd, 'setup-ran'), 'utf8')).toBe('complete')
  expect(JSON.parse(readFileSync(f.daemon.paths.device, 'utf8')).repos[0].networkAllow).toEqual(['packages.example.invalid'])
  await f.daemon.syncWithServer()
  expect(f.calls.filter(name => name === 'repos')).toHaveLength(1)
  expect(f.calls.filter(name => name === 'claim')).toHaveLength(1)
})

it.each(['missing', 'wrong-repo', 'wrong-remote', 'malformed', 'continuation'] as const)('retains normal repository GET for an unusable initial claim (%s)', async seed => {
  const f = await machine(true, { cloud: true, seed })
  f.repositories.resolve(); f.registration.resolve()
  await waitFor(() => f.started.mock.calls.length === 1)
  expect(f.calls.filter(name => name === 'repos')).toHaveLength(1)
  expect(f.claimOptions).toEqual([{ initialRepository: true }])
})

it('does not request the one-shot repository projection on a local hinted claim', async () => {
  const f = await machine(true, { seed: 'valid' })
  f.repositories.resolve(); f.registration.resolve()
  await waitFor(() => f.started.mock.calls.length === 1)
  expect(f.claimOptions).toEqual([undefined])
  expect(f.calls.filter(name => name === 'repos')).toHaveLength(1)
})

it('settles the repository handoff when the initial claim is refused', async () => {
  const f = await machine(true, { cloud: true, seed: 'valid', claimFailure: true })
  f.repositories.resolve(); f.registration.resolve()
  await waitFor(() => f.calls.includes('pending'))
  expect(f.calls.filter(name => name === 'repos')).toHaveLength(1)
  expect(f.started).not.toHaveBeenCalled()
  await f.daemon.stop()
})

it.each(['heartbeat-refused', 'credential-rotated', 'uninstall'] as const)('keeps the original initial barrier with claim settings (%s)', async refusal => {
  vi.spyOn(service, 'uninstallService').mockResolvedValue()
  const adapter = vi.spyOn(MockAdapter.prototype, 'start')
  const f = await machine(true, { cloud: true, seed: 'valid', delayedClaim: true })
  const heartbeat = f.link.heartbeat
  f.link.heartbeat = async (...args) => {
    if (refusal === 'heartbeat-refused') throw new SessionRejectedError()
    const result = await heartbeat(...args)
    if (refusal === 'uninstall') return { ...result, deviceCommands: [{ id: randomUUID(), kind: 'uninstall' as const }] }
    await handlers['device.setCredential']({ credential: 'orv_' + 'b'.repeat(43) })
    return result
  }
  f.repositories.resolve(); f.registration.resolve()
  await f.claimEntered.promise
  f.claimResponse.resolve()
  await waitFor(() => f.warnings.mock.calls.find(args => args[1] === 'could not start run') || f.daemon.status().draining)
  await f.daemon.stop()
  expect(f.started).not.toHaveBeenCalled()
  expect(adapter).not.toHaveBeenCalled()
})
