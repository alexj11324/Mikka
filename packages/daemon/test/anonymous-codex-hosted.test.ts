// Real hosted adapter + real IPC processes; all OAuth values and RPC responses are synthetic.
// Native initialize/config contracts are compared separately at fixed upstream commits.
import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultRunPolicy, type RunAssignment } from '@mikka/protocol'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import { startAnonymousCodex } from '../src/anonymous-codex-spare'
import { createHostedBotRunner } from '../src/subscription-hosted-runner'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { MemoryServer } from '../src/server-link'
import { createLogger } from '../src/log'
import { buildChildEnv } from '../src/env'
import { runRuntimeTimings } from '../src/run-runtime-timing'
import { daemonTracer, runIdHash, type DaemonStartupTiming } from '../src/tracing'
import { WorktreeManager } from '../src/worktrees'
import { worktreeGitWritePaths } from '../src/agents/publish'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'
const closing: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close(); cleanupTempDirs() })
async function fixture(diagnostics = false, hostOnly = false, version = '0.166.0') {
  const root = tempDir('codex-bootstrap-hosted-'), home = join(root, 'home'), stateDir = join(home, '.mikka', 'worker', 'adapters')
  mkdirSync(home); mkdirSync(stateDir, { recursive: true })
  const repositoryRoot = join(home, '.mikka', 'repos', 'repo'); mkdirSync(join(home, '.mikka', 'repos'), { recursive: true }); renameSync(await makeRepo(), repositoryRoot)
  const runId = randomUUID(), deviceId = randomUUID(), workspaceId = randomUUID(), trace = join(root, 'wire.jsonl')
  const cwd = await new WorktreeManager(join(home, '.mikka', 'worker', 'worktrees')).create(runId, repositoryRoot, 'main')
  const gitWritePaths = await worktreeGitWritePaths(repositoryRoot, cwd, runId)
  expect(lstatSync(join(cwd, '.git')).isFile()).toBe(true)
  const binary = join(root, 'codex')
  let fake = readFileSync(resolve(import.meta.dirname, 'fakes/fake-codex-subscription.mjs'), 'utf8')
  fake = fake.replace('existsSync, mkdirSync,', 'appendFileSync, existsSync, mkdirSync,')
    .replace('  if (!method) {', "  appendFileSync(process.env.FIXTURE_WIRE, JSON.stringify({ method, pid: process.pid, cwd: params?.cwd, config: params?.config, argv: process.argv }) + '\\n')\n  if (!method) {")
  writeFileSync(binary, fake); chmodSync(binary, 0o700)
  const env = Object.fromEntries(Object.entries({ ...process.env, HOME: home,
    FAKE_CODEX_USER_AGENT: `mikka/${version} (offline fixture)`, FIXTURE_WIRE: trace }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const policy = defaultRunPolicy(), policyHash = policySnapshotHash(policy), decisionCatalogue = {
    version: 1 as const, tool: { name: 'record_decision' as const, title: 'Decision', description: 'Offline catalogue',
      inputSchema: { type: 'object' as const }, annotations: { idempotentHint: true as const } } }
  const assignment: RunAssignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main',
    harness: 'codex', prompt: 'hello', model: 'fixture-model', policy,
    ...(diagnostics && !hostOnly ? { taskEnv: { CLOUD_STARTUP_TIMING: '1' } } : {}),
    mcp: { url: 'https://mikka.invalid/api/mcp', token: 'synthetic-mcp-token', decisionCatalogue },
    subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner', workspaceId, consumerId: randomUUID(), route: 'codex_cli' },
    subscriptionLease: { route: 'codex_cli', accountId: 'fixture-account', revision: 2, modelId: 'fixture-model',
      accessToken: 'fixture-access', expiresAt: new Date(Date.now() + 3600000).toISOString() } }
  const hint = { version: 1 as const, profile: 'cloud_repository_codex_0166_v1' as const,
    bootstrapSha256: 'a'.repeat(64), runId, model: assignment.model!, kind: 'implement' as const, github: false,
    diagnostics, policy, decisionCatalogue, mailboxTools: [] }
  const candidate = startAnonymousCodex({ hint, bootstrap: { sha256: hint.bootstrapSha256, deviceId, workspaceId },
    stateDir, binary, env, signal: new AbortController().signal })!
  closing.push(candidate.close)
  const gate = new ToolApprovalGate(runId, { isLive: () => true })
  const options = { runId, cwd, gitWritePaths, prompt: 'hello', model: assignment.model, policy, policyHash, toolApproval: gate,
    mcp: assignment.mcp, env: { ...env, ...buildChildEnv({ host: env, runId }) }, log: createLogger({ level: 'silent' }) }
  const link = new MemoryServer(deviceId).link()
  const runner = await createHostedBotRunner({ stateDir, link, binaries: { codex: binary }, anonymousCodexCandidate: candidate,
    ...(hostOnly ? { collectCliTiming: true } : {}) })
  return { root, home, cwd, repositoryRoot, stateDir, assignment, options, candidate, gate, runner,
    wire: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] }
}
const collect = async (session: Awaited<ReturnType<Awaited<ReturnType<typeof createHostedBotRunner>>['start']>>) => {
  const events = []; for await (const event of session.events()) events.push(event); return events
}
it.each([false, true, 'host'] as const)('adopts one initialized child, retains original login/thread/turn and its late MCP context (diagnostics=%s)', async diagnosticMode => {
  const diagnostics = diagnosticMode !== false, hostOnly = diagnosticMode === 'host'
  const f = await fixture(diagnostics, hostOnly); await f.candidate.ready
  if (hostOnly) expect(f.assignment.taskEnv).toBeUndefined()
  expect(f.wire().every(frame => ['initialize', 'initialized'].includes(frame.method))).toBe(true)
  const observation = diagnostics ? runRuntimeTimings.begin(f.assignment.runId, f.assignment.deviceId, 'codex') : undefined
  const prepared = f.runner.prepare(f.assignment, { ...f.options, cwd: join(f.root, 'not-yet-checked-out') }, new AbortController().signal)
  try {
    await prepared.ready
    expect(f.wire().some(frame => frame.method === 'account/login/start')).toBe(false)
    const session = await prepared.start(f.options)
    expect((await collect(session)).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
    const wire = f.wire(), threads = wire.filter(frame => frame.method === 'thread/start')
    expect(wire.filter(frame => frame.method === 'initialize')).toHaveLength(1)
    expect(new Set(wire.map(frame => frame.pid)).size).toBe(1)
    expect(wire.filter(frame => frame.method === 'account/login/start')).toHaveLength(1)
    expect(threads).toHaveLength(1); expect(threads[0].cwd).toBe(f.cwd)
    expect(JSON.stringify(threads[0].config)).not.toContain('synthetic-mcp-token')
    const mcp = threads[0].config.mcp_servers.mikka
    expect(mcp.required).toBe(true)
    expect(mcp.args[0]).toContain('mikka-mcp-context.mjs'); expect(existsSync(mcp.args[1])).toBe(false)
    const ledger = JSON.parse(readFileSync(join(f.stateDir, 'native-ledgers', f.assignment.runId + '.json'), 'utf8'))
    expect(ledger.scope.accountId).toBe('fixture-account'); expect(ledger.sessionId).toBe(session.sessionId)
    expect(f.candidate.nativeExitObserved).toBe(true)
    if (diagnostics) {
      expect(prepared.preparationTiming).toMatchObject({ source: 'bootstrap_codex_initialize', harness: 'codex', outcome: 'ok' })
      expect(observation!.finish()!.officialCliTiming).toMatchObject({ harness: 'codex', cliExitObserved: true })
    } else expect(prepared.preparationTiming).toBeUndefined()
  } finally { observation?.close(); await prepared.cancel() }
})
it.each(['0.166.0', '0.167.0'])('records the adopted %s child\'s asynchronous login in the late startup scope without repeating initialize', async version => {
  const f = await fixture(true, true, version); await f.candidate.ready
  const prepared = f.runner.prepare(f.assignment, { ...f.options, cwd: join(f.root, 'not-yet-checked-out') }, new AbortController().signal)
  const timings: DaemonStartupTiming[] = []
  try {
    await prepared.ready
    expect(f.wire().every(frame => ['initialize', 'initialized'].includes(frame.method))).toBe(true)
    const rejected: DaemonStartupTiming[] = []
    const session = await daemonTracer.span('daemon.adapter.start', {
      'mikka.run.id_hash': runIdHash(f.assignment.runId), 'mikka.harness': 'codex',
    }, async () => {
      const starting = prepared.start(f.options)
      await expect(daemonTracer.span('daemon.adapter.start', {
        'mikka.run.id_hash': runIdHash('duplicate-caller'), 'mikka.harness': 'codex',
      }, () => prepared.start(f.options), { onStartupTiming: timing => rejected.push(timing) })).rejects.toThrow('consumed')
      return starting
    }, { onStartupTiming: timing => timings.push(timing) })
    expect(rejected).toMatchObject([{ runIdHash: runIdHash('duplicate-caller'), outcome: 'error', phases: [] }])
    expect((await collect(session)).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
    expect(timings).toHaveLength(1)
    const timing = timings[0]
    expect(timing).toMatchObject({ version: 1, runIdHash: runIdHash(f.assignment.runId), harness: 'codex',
      outcome: 'ok', truncated: false })
    expect(timing.phases.map(phase => phase.name)).toEqual(['daemon.adapter.auth.token', 'daemon.adapter.account_check.login'])
    const login = timing.phases.find(phase => phase.name === 'daemon.adapter.account_check.login')!
    expect(login.ms).toBeGreaterThan(0)
    expect(timing.phases.every(phase => phase.outcome === 'ok' && phase.startMs >= 0
      && phase.endMs >= phase.startMs && phase.endMs <= timing.ms + 0.01)).toBe(true)
    const early = prepared.preparationTiming!
    expect(early).toMatchObject({ source: 'bootstrap_codex_initialize', runIdHash: timing.runIdHash, harness: 'codex', outcome: 'ok' })
    expect(early.startedAt).toBeLessThanOrEqual(timing.startedAt)
    expect(early.phases.map(phase => phase.name)).toContain('daemon.adapter.cli_init')
    const wire = f.wire()
    expect(wire.filter(frame => frame.method === 'initialize')).toHaveLength(1)
    expect(wire.filter(frame => frame.method === 'account/login/start')).toHaveLength(1)
    expect(wire.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    expect(new Set(wire.map(frame => frame.pid)).size).toBe(1)
    expect(f.candidate.nativeExitObserved).toBe(true)
  } finally { await prepared.cancel() }
})
it('drains an incompatible project before the original cold child receives any login', async () => {
  const f = await fixture(); await f.candidate.ready
  mkdirSync(join(f.cwd, '.codex')); writeFileSync(join(f.cwd, '.codex', 'config.toml'), 'model = "project-owned-model"\n')
  const session = await f.runner.start(f.assignment, f.options)
  expect((await collect(session)).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  const wire = f.wire(), starts = wire.filter(frame => frame.method === 'initialize'), login = wire.find(frame => frame.method === 'account/login/start')
  expect(starts).toHaveLength(2); expect(starts[0].pid).not.toBe(starts[1].pid)
  expect(login.pid).toBe(starts[1].pid); expect(f.candidate.nativeExitObserved).toBe(true)
  expect(login.argv).toContain('mcp_servers.mikka.required=true')
  expect(f.candidate.preparationTiming).toBeUndefined()
})
it('keeps a real login refusal on the adopted child as failure with no cold retry or task input', async () => {
  const f = await fixture(); await f.candidate.ready; f.assignment.subscriptionLease!.accessToken = 'fixture-unsupported'
  await expect(f.runner.start(f.assignment, f.options)).rejects.toThrow()
  const wire = f.wire()
  expect(wire.filter(frame => frame.method === 'initialize')).toHaveLength(1)
  expect(wire.some(frame => ['thread/start', 'turn/start'].includes(frame.method))).toBe(false)
  expect(f.candidate.nativeExitObserved).toBe(true)
})
it('cancels before final options without delivering a login or waiting for a repository', async () => {
  const f = await fixture(); await f.candidate.ready
  const prepared = f.runner.prepare(f.assignment, { ...f.options, cwd: join(f.root, 'missing') }, new AbortController().signal)
  await prepared.ready; await prepared.cancel()
  expect(f.candidate.nativeExitObserved).toBe(true)
  expect(f.wire().some(frame => frame.method === 'account/login/start')).toBe(false)
  await expect(prepared.start(f.options)).rejects.toThrow('closed')
})

it.each(['primary-config', 'backlink'])('drains late %s changes before a cold process receives login', async kind => {
  const f = await fixture(); await f.candidate.ready
  if (kind === 'primary-config') {
    mkdirSync(join(f.repositoryRoot, '.codex')); writeFileSync(join(f.repositoryRoot, '.codex', 'hooks.json'), '{}\n')
  } else {
    const gitdir = readFileSync(join(f.cwd, '.git'), 'utf8').trim().slice('gitdir: '.length)
    writeFileSync(join(gitdir, 'gitdir'), join(f.root, 'foreign', '.git') + '\n')
  }
  const session = await f.runner.start(f.assignment, f.options)
  expect((await collect(session)).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  const wire = f.wire(), starts = wire.filter(frame => frame.method === 'initialize'), login = wire.find(frame => frame.method === 'account/login/start')
  expect(starts).toHaveLength(2); expect(login.pid).toBe(starts[1].pid)
  expect(f.candidate.nativeExitObserved).toBe(true)
  expect(f.candidate.preparationTiming).toBeUndefined()
})
