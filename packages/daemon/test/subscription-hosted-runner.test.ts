// Real adapters/Claude Agent SDK with offline native CLI protocol fixtures.
// These tests run on a non-root Linux runner and never contact a provider.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultRunPolicy, type RunAssignment } from '@mikka/protocol'
import { createHostedBotRunner } from '../src/subscription-hosted-runner'
import { MemoryServer } from '../src/server-link'
import { createLogger } from '../src/log'
import { ComputerBroker } from '../src/computer/broker.mjs'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { Daemon } from '../src/main'
import { runRuntimeTimings } from '../src/run-runtime-timing'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)
async function fixture(harness: 'codex' | 'claude_code' = 'claude_code', collectCliTiming?: boolean) {
  const root = tempDir('machine-direct-'), stateDir = join(root, 'adapters'), home = join(root, 'home')
  mkdirSync(stateDir); mkdirSync(home)
  const runId = randomUUID(), deviceId = randomUUID(), cwd = await makeRepo()
  const never = vi.fn(async () => { throw Error('No operation may contact Mikka for credentials or proxying') })
  const link = Object.assign(new MemoryServer(deviceId).link(), {
    nativeLease: never, nativeContext: never, nativeRequest: never, githubLease: never,
  })
  const binary = resolve(import.meta.dirname, 'fakes', harness === 'codex' ? 'fake-codex-subscription.mjs' : 'fake-claude-subscription.mjs')
  chmodSync(binary, 0o700)
  const assignment: RunAssignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main',
    harness, prompt: 'hello', model: 'fixture-model',
    taskEnv: { FIXTURE_MACHINE_AUTH: '1', FIXTURE_MACHINE_VALUE: 'ordinary-machine-environment' },
    subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner', workspaceId: randomUUID(), consumerId: randomUUID(),
      route: harness === 'codex' ? 'codex_cli' : 'claude_code_cli' },
    subscriptionLease: { route: harness === 'codex' ? 'codex_cli' : 'claude_code_cli', accountId: 'fixture-account', revision: 2,
      modelId: 'fixture-model', accessToken: 'fixture-access', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  }
  const gate = new ToolApprovalGate(runId, { isLive: () => true })
  const options = { runId, toolApproval: gate, cwd, prompt: 'hello', model: 'fixture-model',
    env: { PATH: process.env.PATH!, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GH_CONFIG_DIR: join(home, '.config', 'gh') }, log: createLogger({ level: 'silent' }) }
  const config = join(home, harness === 'codex' ? '.codex' : '.claude')
  const runner = await createHostedBotRunner({ stateDir, link, binaries: { [harness]: binary }, collectCliTiming })
  return { root, stateDir, home, cwd, config, link, never, binary, assignment, options, gate, runner }
}
const collect = async (session: Awaited<ReturnType<Awaited<ReturnType<typeof createHostedBotRunner>>['start']>>) => {
  const events = []; for await (const event of session.events()) events.push(event); return events
}

for (const harness of ['codex', 'claude_code'] as const) {
  it.each(['default', 'acceptance_host', 'repository'] as const)(`${harness} collects CLI timing only for an explicit diagnostic opt-in (%s)`, async source => {
    const f = await fixture(harness, source === 'acceptance_host' ? true : undefined)
    // Normal personal-device claims have no cloud-only task environment.
    delete f.assignment.taskEnv
    if (source === 'repository') f.assignment.taskEnv = { CLOUD_STARTUP_TIMING: '1' }
    const before = structuredClone(f.assignment)
    const observation = runRuntimeTimings.begin(f.assignment.runId, f.assignment.deviceId, harness)
    try {
      const session = await f.runner.start(f.assignment, { ...f.options,
        env: { ...f.options.env, FIXTURE_MACHINE_AUTH: '1' } })
      expect((await collect(session)).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
      const receipt = observation.finish()!
      if (source === 'default') {
        expect(receipt.officialCliTiming).toBeUndefined()
        expect(receipt.mcpHttpTiming).toBeUndefined()
      }
      else expect(receipt.officialCliTiming).toMatchObject({ harness, source: 'official_cli_otlp',
        collection: 'best_effort', flush: 'not_confirmed', cliExitObserved: true, events: [] })
      expect(f.assignment).toEqual(before)
      expect(f.never).not.toHaveBeenCalled()
    } finally { observation.close() }
  })
}

it.each([true, false])('Codex clears inherited compression only with timing enabled (%s)', async enabled => {
  const f = await fixture('codex', enabled)
  const options = { ...f.options, env: { ...f.options.env, FIXTURE_TIMING_ENV: '1',
    OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: 'none' } }
  f.assignment.taskEnv = { ...f.assignment.taskEnv, OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip' }
  const assignmentBefore = structuredClone(f.assignment), envBefore = { ...options.env }
  expect((await collect(await f.runner.start(f.assignment, options))).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  expect(JSON.parse(readFileSync(join(f.config, 'fixture-timing-env.json'), 'utf8'))).toEqual({
    logsCompression: enabled ? null : 'none', genericCompression: enabled ? null : 'gzip', exporterConfigured: enabled,
  })
  expect(f.assignment).toEqual(assignmentBefore)
  expect(options.env).toEqual(envBefore)
  expect(f.never).not.toHaveBeenCalled()
})

it.each(['codex', 'claude_code'] as const)('%s consumes claim credentials and uses ordinary HOME/env/Git without any Mikka auth or proxy request', async harness => {
  const f = await fixture(harness)
  const session = await f.runner.start(f.assignment, { ...f.options, prompt: 'PROBE_MACHINE' })
  const events = await collect(session)
  expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  expect(f.never).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(join(f.config, 'fixture-auth.json'), 'utf8')))
    .toEqual({ tokenSha: createHash('sha256').update('fixture-access').digest('hex') })
  expect(JSON.parse(readFileSync(join(f.config, 'fixture-machine.json'), 'utf8')))
    .toEqual({ home: f.home, cwd: realpathSync(f.cwd), value: 'ordinary-machine-environment', git: realpathSync(join(f.cwd, '.git')) })
  expect(execFileSync('git', ['config', 'mikka.machineProbe'], { cwd: f.cwd, encoding: 'utf8' }).trim()).toBe('actual-directory')
  for (const path of ['runtime-git', 'runtime-home', 'native-home', 'codex-home', 'verify-git'])
    expect(existsSync(join(f.stateDir, 'runs', f.assignment.runId, path))).toBe(false)
  expect(existsSync(join(f.stateDir, 'native-brokers'))).toBe(false)
  const ledger = readFileSync(join(f.stateDir, 'native-ledgers', f.assignment.runId + '.json'), 'utf8')
  expect(JSON.parse(ledger)).toMatchObject({ scope: { ownerId: 'fixture-owner', accountId: 'fixture-account' }, sessionId: session.sessionId })
  expect(ledger + JSON.stringify(events)).not.toContain('fixture-access')
  const checked = await f.runner.command(f.cwd, 'git config mikka.verifyProbe actual-directory && printf ready > verify-probe', false, 10_000)
  expect(checked).toMatchObject({ exitCode: 0, timedOut: false, timing: { createMs: 0 } })
  expect(execFileSync('git', ['config', 'mikka.verifyProbe'], { cwd: f.cwd, encoding: 'utf8' }).trim()).toBe('actual-directory')
  expect(readFileSync(join(f.cwd, 'verify-probe'), 'utf8')).toBe('ready')
})

it.each(['codex', 'claude_code'] as const)('%s uses a delivered GitHub credential even when MCP was unavailable', async harness => {
  const f = await fixture(harness)
  f.assignment.github = { endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', branch: 'mikka/test',
    token: 'synthetic-actual-github-token', expiresAt: null }
  const ghDir = join(f.home, '.config', 'gh'); mkdirSync(ghDir, { recursive: true })
  writeFileSync(join(ghDir, 'hosts.yml'), 'enterprise.example:\n    oauth_token: keep-enterprise\n')
  const events = await collect(await f.runner.start(f.assignment, f.options))
  expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  expect(f.never).not.toHaveBeenCalled()
  const native = readFileSync(join(ghDir, 'hosts.yml'), 'utf8')
  expect(native).toContain('synthetic-actual-github-token')
  expect(native).toContain('keep-enterprise')
  expect(existsSync(join(f.stateDir, 'runs', f.assignment.runId, 'github', 'bin', 'gh'))).toBe(false)
})

it.each(['codex', 'claude_code'] as const)('%s passes the actual model key and provider address directly to its CLI', async harness => {
  const f = await fixture(harness), key = 'fixture-direct-provider-key'
  delete f.assignment.subscriptionBinding; delete f.assignment.subscriptionLease
  f.assignment.modelCredential = { kind: 'provider', protocol: harness === 'codex' ? 'openai' : 'anthropic', baseUrl: 'https://provider.example/v1', key }
  expect((await collect(await f.runner.start(f.assignment, f.options))).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  expect(JSON.parse(readFileSync(join(f.config, 'fixture-auth.json'), 'utf8')))
    .toEqual({ tokenSha: createHash('sha256').update(key).digest('hex'), baseUrl: 'https://provider.example/v1' })
  expect(existsSync(join(f.stateDir, 'native-brokers'))).toBe(false)
  expect(f.never).not.toHaveBeenCalled()
})

it.each(['codex', 'claude_code'] as const)('%s stops its actual CLI immediately after a local pushed stop', async harness => {
  const f = await fixture(harness)
  const session = await f.runner.start(f.assignment, { ...f.options, prompt: 'HANG' })
  const finished = collect(session)
  const file = join(f.config, 'fixture-process.json')
  const receipt = await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')) as { pid: number; prompts: number })
  const began = Date.now(); f.gate.revoke()
  await finished
  expect(Date.now() - began).toBeLessThan(5000)
  expect(() => process.kill(receipt.pid, 0)).toThrow()
  expect(f.never).not.toHaveBeenCalled()
  await expect(session.send('must never be delivered')).rejects.toThrow()
})

it.each(['route', 'model', 'expired', 'stopped'] as const)('refuses %s before any CLI receives the prompt', async reason => {
  // The trusted diagnostic switch must not weaken the ordinary run gates.
  const f = await fixture('claude_code', true)
  if (reason === 'route') f.assignment.subscriptionLease!.route = 'codex_cli'
  if (reason === 'model') f.assignment.model = 'wrong-model'
  if (reason === 'expired') f.assignment.subscriptionLease!.expiresAt = new Date(0).toISOString()
  if (reason === 'stopped') f.gate.revoke()
  await expect(f.runner.start(f.assignment, f.options)).rejects.toThrow()
  expect(existsSync(join(f.config, 'fixture-process.json'))).toBe(false)
  expect(f.never).not.toHaveBeenCalled()
})

it('does not send a prompt when the real native account guard refuses API-key mode', async () => {
  const f = await fixture(); f.assignment.subscriptionLease!.accessToken = 'fixture-paid'
  await expect(f.runner.start(f.assignment, f.options)).rejects.toThrow()
  expect(JSON.parse(readFileSync(join(f.config, 'fixture-process.json'), 'utf8')).prompts).toBe(0)
  expect(f.never).not.toHaveBeenCalled()
})

it('honors the installed official CLI model report before spawning', async () => {
  const f = await fixture()
  let report: { models: string[] } | null = null
  const runner = await createHostedBotRunner({ stateDir: f.stateDir, link: f.link, binaries: { claude_code: f.binary }, reportedModels: async () => report })
  for (const value of [null, { models: ['other-model'] }]) {
    report = value
    await expect(runner.start(f.assignment, f.options)).rejects.toThrow()
    expect(existsSync(join(f.config, 'fixture-process.json'))).toBe(false)
  }
  report = { models: ['fixture-model'] }
  expect((await collect(await runner.start(f.assignment, f.options))).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
  expect(f.never).not.toHaveBeenCalled()
})

it.each(['missing', 'shortcuts', 'failed'] as const)('Claude admits its exact prepared catalogue model with a %s CLI report and no remote check', async reportKind => {
  const f = await fixture()
  const model = 'claude-haiku-5-5'
  f.assignment.model = model
  Object.assign(f.assignment.subscriptionLease!, { modelId: model, modelCatalogueVerified: true })
  const runner = await createHostedBotRunner({ stateDir: f.stateDir, link: f.link, binaries: { claude_code: f.binary },
    reportedModels: async () => {
      if (reportKind === 'failed') throw Error('fixture probe failed')
      return reportKind === 'missing' ? null : { models: ['haiku', 'sonnet', 'opus'] }
    },
  })
  expect((await collect(await runner.start(f.assignment, { ...f.options, model }))).at(-1))
    .toMatchObject({ type: 'exit', outcome: 'succeeded' })
  expect(f.never).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(join(f.stateDir, 'native-ledgers', f.assignment.runId + '.json'), 'utf8')).scope.modelId).toBe(model)
})

it.each(['codex', 'different-model'] as const)('catalogue evidence cannot admit %s outside the selected model and Claude route', async reason => {
  const harness = reason === 'codex' ? 'codex' : 'claude_code'
  const f = await fixture(harness)
  f.assignment.subscriptionLease!.modelCatalogueVerified = true
  const runner = await createHostedBotRunner({ stateDir: f.stateDir, link: f.link, binaries: { [harness]: f.binary },
    reportedModels: async () => ({ models: [] }),
  })
  await expect(runner.start(f.assignment, { ...f.options, ...(reason === 'different-model' ? { model: 'another-model' } : {}) })).rejects.toThrow()
  expect(existsSync(join(f.config, 'fixture-process.json'))).toBe(false)
  expect(f.never).not.toHaveBeenCalled()
})

it.each([
  ['codex', 'ask'], ['codex', 'allow'], ['codex', 'deny'],
  ['claude_code', 'ask'], ['claude_code', 'allow'], ['claude_code', 'deny'],
] as const)('retains local %s computer policy %s without server authorization', async (harness, permission) => {
  const f = await fixture(harness); let executions = 0
  const broker = new ComputerBroker({ socketPath: join(f.root, 'computer.sock'),
    driver: { installed: true, version: 'fixture', path: '/fake', fingerprint: 'f'.repeat(64) }, permitted: () => true,
    execute: async (_driver, call, display) => { executions++; expect(display).toBe(':2'); return { content: [{ type: 'text', text: JSON.stringify(call) }] } },
  })
  await broker.listen()
  try {
    f.assignment.policy = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use: permission } }
    f.assignment.computer = { botId: randomUUID(), ownerId: 'fixture-owner', display: ':2', policyVersion: 0 }
    const runner = await createHostedBotRunner({ stateDir: f.stateDir, link: f.link, binaries: { [harness]: f.binary }, computerBroker: broker })
    const started = runner.start(f.assignment, { ...f.options, policy: f.assignment.policy, prompt: 'COMPUTER' })
    if (permission === 'deny') {
      await expect(started).rejects.toThrow(); expect(executions).toBe(0); return
    }
    const finished = collect(await started)
    if (permission === 'ask') {
      const review = await waitFor(() => broker.list()[0]); expect(executions).toBe(0)
      await broker.decide(review.id, review.digest, true)
    }
    expect((await finished).at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
    expect(executions).toBe(1)
    expect(f.never).not.toHaveBeenCalled()
  } finally { await broker.close() }
})

it.each([true, false])('advertises hosted execution only with the installed local gate factory: %s', async available => {
  const f = await fixture()
  f.link.prepareRunToolApproval = available ? async assignment => new ToolApprovalGate(assignment.runId, { isLive: () => true }) : undefined
  const registered = vi.spyOn(f.link, 'registerDevice')
  const daemon = new Daemon({ dataDir: join(f.root, 'daemon'), flavor: 'dev', link: f.link, credential: 'synthetic-device', hostedSubscriptions: true,
    harnessBinaries: { claude_code: f.binary }, quotaSource: null, modelProbe: false, log: createLogger({ level: 'silent' }) })
  try {
    await daemon.start(); await daemon.syncWithServer()
    const advertised = registered.mock.calls.at(-1)?.[1].harnesses.find(info => info.harness === 'claude_code')
    expect(advertised?.installed).toBe(true)
    expect(advertised?.subscriptionBroker).toBe(true)
    expect(advertised?.subscriptionModelCatalogue).toBe(true)
    expect(advertised?.toolApproval).toBe(available ? true : undefined)
    expect(f.never).not.toHaveBeenCalled()
  } finally { await daemon.stop() }
})
