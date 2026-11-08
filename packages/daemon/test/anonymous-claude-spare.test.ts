import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startAnonymousClaude } from '../src/anonymous-claude-spare'
import { claudeSettings, CLAUDE_RUN_ENV } from '../src/adapters/claude'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import type { AnonymousClaudeHint } from '@mikka/protocol/claude-startup'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { daemonTracer, runIdHash } from '../src/tracing'
import { buildChildEnv } from '../src/env'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })
function fixture(mode = 'normal', diagnostics = false) {
  const root = mkdtempSync(join(tmpdir(), 'anonymous-claude-')), stateDir = join(root, 'adapters'), home = join(root, 'home')
  mkdirSync(home)
  const trace = join(root, 'protocol.jsonl'), binary = join(root, 'claude')
  let fake = readFileSync(resolve('test/fakes/fake-claude-prewarm.mjs'), 'utf8')
  fake = "import { appendFileSync } from 'node:fs'\n" + fake
  fake = fake.replace("const mode = flag('--fixture-mode')", "const mode = process.env.FIXTURE_MODE")
  fake = fake.replace('const emit = event => process.send?.(event)', 'const emit = event => appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(event) + "\\n")')
  fake = fake.replace("emit({ event: 'control', type })", "emit({ event: 'control', type, ...(type === 'claim_session' ? { envKeys: Object.keys(frame.request.env ?? {}), hasOAuth: Boolean(frame.request.env?.CLAUDE_CODE_OAUTH_TOKEN) } : {}) })")
  // This fixture proves the exact refusal/acceptance branch, not the native CLI's reported source.
  fake = fake.replace("} else {\n        if (sdkServers.includes('mikka_mailbox'))", "} else {\n        initialization.account.tokenSource = process.env.FIXTURE_ACCOUNT_SOURCE ?? 'CLAUDE_CODE_OAUTH_TOKEN'\n        if (sdkServers.includes('mikka_mailbox'))")
  writeFileSync(binary, '#!' + process.execPath + '\n' + fake, { mode: 0o755 })
  const policy = defaultRunPolicy(), runId = randomUUID()
  const hint: AnonymousClaudeHint = { version: 1, profile: 'cloud_repository_claude_v1', runId,
    bootstrapSha256: createHash('sha256').update('fixture-bootstrap').digest('hex'), model: 'claude-test-model', effort: 'high',
    kind: 'implement', github: false, diagnostics, policy, mailboxTools: [],
    decisionCatalogue: { version: 1, tool: { name: 'record_decision', title: 'Record fixture', description: 'Fixture canonical decision',
      inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'], additionalProperties: false },
      annotations: { idempotentHint: true } } } }
  const bootstrap = { sha256: hint.bootstrapSha256, deviceId: randomUUID(), workspaceId: randomUUID() }
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), HOME: home, PATH: process.env.PATH!, FIXTURE_MODE: mode, FIXTURE_TRACE: trace,
    ...(mode.startsWith('source_') ? { FIXTURE_ACCOUNT_SOURCE: mode === 'source_unknown' ? 'unknown' : 'ANTHROPIC_API_KEY' } : {}) }
  const lifetime = new AbortController()
  const start = (overrides: Partial<Parameters<typeof startAnonymousClaude>[0]> = {}) => {
    const candidate = startAnonymousClaude({ hint, bootstrap, stateDir, binary, env, signal: lifetime.signal, initializeTimeoutMs: 2000, ...overrides })
    if (candidate) cleanups.push(candidate.close)
    return candidate
  }
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const events = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
  const cwd = join(root, 'future-repository'), runDir = join(stateDir, 'runs', runId), tmp = join(runDir, 'tmp'), captures = join(runDir, 'captures')
  // Match the supervisor's real run environment and the hosted runner's
  // current machine environment, including SDK-owned process metadata.
  const runEnv = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...env, ...buildChildEnv({ host: env, runId }),
  })
  function binding(candidate: NonNullable<ReturnType<typeof startAnonymousClaude>>) {
    const options: Options = {
      includePartialMessages: daemonTracer.enabled, cwd, env: { ...runEnv(), ...(diagnostics ? { CLOUD_STARTUP_TIMING: '1' } : {}), MIKKA_POLICY_HASH: policySnapshotHash(policy), ...CLAUDE_RUN_ENV, CLAUDE_CODE_TMPDIR: tmp },
      settingSources: ['user', 'project', 'local'], settings: { ...claudeSettings(policy), forceLoginMethod: 'claudeai' },
      extraArgs: { 'replay-user-messages': null }, mcpServers: { mikka: { type: 'stdio', command: 'not-spawned', args: [] } },
      strictMcpConfig: false, systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      sessionId: candidate.sessionId, model: hint.model, effort: hint.effort,
    }
    return { identity: { runId, deviceId: bootstrap.deviceId, workspaceId: bootstrap.workspaceId, model: hint.model, effort: hint.effort,
      policyHash: policySnapshotHash(policy), diagnostics: hint.diagnostics, decisionCatalogue: hint.decisionCatalogue }, options, context: { handoffFile: join(runDir, 'handoff.json'), capturesDir: captures,
      captureRoots: [cwd, tmp], repositoryRoot: cwd, decisionCatalogue: JSON.stringify(hint.decisionCatalogue),
      decisionUrl: 'https://fixture.invalid/api/mcp', decisionToken: 'mkw_' + 'A'.repeat(43), env: options.env },
      authority: { signal: lifetime.signal, assertLive: () => lifetime.signal.throwIfAborted() },
      oauthToken: 'anonymous-fixture-not-a-provider-credential',
      getOAuthToken: async () => 'anonymous-fixture-not-a-provider-credential', observe: () => {} }
  }
  return { root, hint, bootstrap, env, runEnv, stateDir, lifetime, start, events, binding, cwd, captures, tmp, readyRepository() { mkdirSync(cwd); mkdirSync(captures, { recursive: true }) } }
}
const empty = { async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> { /* no task input */ } }

it('disables only PR attribution in the anonymous native SDK prewarm', async () => {
  const f = fixture(), candidate = f.start()!
  await candidate.ready
  expect(candidate.state).toBe('parked')
  // Read the real SDK's process arguments, not the shared settings factory.
  expect(f.events().find(e => e.event === 'spawn').attribution).toEqual({ pr: '' })
})

it('prepares with no task/account frame before checkout, then late-binds one real context and OAuth claim', async () => {
  const f = fixture(), candidate = f.start()!
  await candidate.ready
  expect(candidate.state).toBe('parked'); expect(existsSync(f.cwd)).toBe(false)
  expect(f.events().filter(e => e.event === 'user')).toEqual([])
  expect(f.events().filter(e => e.type === 'claim_session')).toEqual([])
  expect(f.events().find(e => e.event === 'spawn').home).toBe(f.env.HOME)
  const binding = f.binding(candidate), spare = await candidate.adopt(binding)
  expect(spare).toBeDefined()
  expect(() => spare!.claim({ prompt: empty, options: { cwd: f.cwd } })).toThrow('context is not bound')
  f.readyRepository(); await candidate.bindContext(binding.context)
  const query = spare!.claim({ prompt: empty, options: { cwd: f.cwd, appendSystemPrompt: 'normal mounted skills and project instructions' } })
  expect(await spare!.claimed).toMatchObject({ cwd: f.cwd, sessionId: candidate.sessionId })
  expect(f.events().find(e => e.type === 'claim_session')).toMatchObject({ envKeys: ['CLAUDE_CODE_OAUTH_TOKEN'], hasOAuth: true })
  expect(f.events().filter(e => e.event === 'user')).toEqual([])
  query.close(); await candidate.close()
  expect(candidate.state).toBe('closed')
})

it('does not reuse a session identity or another instance task directory', async () => {
  const a = fixture(), b = fixture(), one = a.start()!, two = b.start()!
  await Promise.all([one.ready, two.ready])
  expect(one.sessionId).not.toBe(two.sessionId)
  expect(a.start()).toBeUndefined()
  await Promise.all([one.close(), two.close()])
})

it('drains a mismatched immutable environment and never consumes its claim', async () => {
  const f = fixture(), candidate = f.start()!
  await candidate.ready
  const binding = f.binding(candidate); binding.options.env = { ...binding.options.env, TASK_CONFIG: 'different' }
  expect(await candidate.adopt(binding)).toBeUndefined()
  expect(candidate.state).toBe('closed')
  expect(f.events().filter(e => e.type === 'claim_session' || e.event === 'user')).toEqual([])
  await expect(candidate.adopt(f.binding(candidate))).rejects.toThrow('already consumed')
})

it.each(['run_id', 'sdk_version'])('drains a changed %s before claim without relaxing environment equality', async field => {
  const f = fixture(), candidate = f.start()!
  await candidate.ready
  const binding = f.binding(candidate)
  binding.options.env = field === 'run_id'
    ? { ...binding.options.env, ...buildChildEnv({ host: binding.options.env, runId: randomUUID() }) }
    : { ...binding.options.env, CLAUDE_AGENT_SDK_VERSION: 'different-sdk' }
  expect(await candidate.adopt(binding)).toBeUndefined()
  expect(candidate.state).toBe('closed')
  expect(f.events().filter(e => e.type === 'claim_session' || e.event === 'user')).toEqual([])
})

it('preserves credential-bearing/old-task configurations on the ordinary path without spawn', () => {
  const f = fixture()
  expect(f.start({ env: { ...f.env, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only' } })).toBeUndefined()
  expect(f.events()).toEqual([])
})

it('cancels while real SDK initialization is pending and leaves no claim or task frame', async () => {
  const f = fixture('pause_initialize'), candidate = f.start()!
  await expect.poll(() => f.events().some(e => e.type === 'initialize')).toBe(true)
  f.lifetime.abort()
  await candidate.close()
  await expect(candidate.ready).rejects.toThrow()
  expect(candidate.state).toBe('closed')
  expect(f.events().filter(e => e.type === 'claim_session' || e.event === 'user')).toEqual([])
})

it('does not accept changed temporary-directory ownership/mode or fresh authority refusal', async () => {
  const f = fixture(), candidate = f.start()!
  await candidate.ready
  const binding = f.binding(candidate)
  f.lifetime.abort()
  await expect(candidate.adopt(binding)).rejects.toThrow()
  await candidate.close()
  expect(f.events().filter(e => e.type === 'claim_session' || e.event === 'user')).toEqual([])
})

it.each(['normal', 'project_settings', 'refuse_claim', 'normal_diagnostics', 'project_settings_diagnostics', 'source_unknown', 'source_api'])('adopts or precisely refuses %s through the real adapter without a second unknown attempt', async mode => {
  const f = fixture(mode.replace(/_diagnostics$/, ''), mode.endsWith('_diagnostics')), candidate = f.start()!
  await candidate.ready
  const { ClaudeAdapter } = await import('../src/adapters/claude')
  const { prepareAgentStart } = await import('../src/adapters/claude-prewarm')
  const { ToolApprovalGate } = await import('../src/agents/tool-approval')
  const { createLogger } = await import('../src/log')
  const { runRuntimeTimings } = await import('../src/run-runtime-timing')
  const observation = f.hint.diagnostics ? runRuntimeTimings.begin(f.hint.runId, f.bootstrap.deviceId, 'claude_code') : undefined
  const timing = await candidate.takeTiming(f.binding(candidate).identity)
  if (timing) cleanups.push(async () => { await timing.close({ cliExitObserved: true }); observation?.close() })
  const { spawn, execFileSync } = await import('node:child_process')
  const { stopGroup } = await import('../src/process-group')
  const gate = new ToolApprovalGate(f.hint.runId, { isLive: () => !f.lifetime.signal.aborted }, 'push')
  const children: import('node:child_process').ChildProcess[] = []
  let replacementSpawns = 0
  const ledger: string[] = []
  const adapter = new ClaudeAdapter({ stateDir: f.stateDir, binary: join(f.root, 'claude'), anonymousClaudeCandidate: candidate,
    anonymousClaudeFresh: f.binding(candidate).identity,
    onHostedSession: async id => { ledger.push(id) },
    subscriptionAuth: { accountId: 'fixture-account', automaticRefresh: true,
      token: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-only-token', expiresAt: new Date(Date.now() + 60000).toISOString() }) },
    spawnHosted(config) {
      replacementSpawns++
      const child = spawn(join(f.root, 'claude'), config.args, { cwd: config.cwd, env: config.env, detached: true, stdio: 'pipe' })
      children.push(child); return child
    },
  })
  const options = { runId: f.hint.runId, cwd: f.cwd, env: { ...f.runEnv(), ...(f.hint.diagnostics ? { CLOUD_STARTUP_TIMING: '1' } : {}) }, model: f.hint.model, effort: f.hint.effort,
    policy: f.hint.policy, policyHash: policySnapshotHash(f.hint.policy), machineEnvironment: true as const,
    kind: 'implement' as const, toolApproval: gate, mcpHttpObservationUrl: timing?.mcpHttpObservationUrl, prompt: 'anonymous local fixture task',
    mcp: { url: 'https://fixture.invalid/api/mcp', token: 'mkw_' + 'A'.repeat(43), decisionCatalogue: f.hint.decisionCatalogue },
    log: createLogger({ stdout: false }),
  }
  const prepared = prepareAgentStart(f.lifetime.signal, control => candidate.measurePreparation(() => adapter.startPrepared(options, {
    runId: f.hint.runId, sessionId: candidate.sessionId, cwd: f.cwd, deviceId: f.bootstrap.deviceId,
    bindingId: randomUUID(), ownerId: randomUUID(), workspaceId: f.bootstrap.workspaceId, consumerId: randomUUID(),
    accountId: 'fixture-account', revision: 1, model: f.hint.model, policyHash: options.policyHash,
  }, control, async () => { await Promise.all(children.map(child => stopGroup(child))); await candidate.close() })))
  cleanups.push(prepared.cancel)
  await prepared.ready
  expect(existsSync(f.cwd)).toBe(false)
  expect(f.events().some(e => e.event === 'user')).toBe(false)
  f.readyRepository()
  execFileSync('git', ['init', '-q', f.cwd])
  if (mode === 'refuse_claim' || mode.startsWith('source_')) {
    await expect(prepared.start(options)).rejects.toThrow()
    expect(replacementSpawns).toBe(0)
    expect(f.events().filter(e => e.event === 'user')).toEqual([])
    return
  }
  const session = await prepared.start(options)
  expect(replacementSpawns).toBe(mode.startsWith('project_settings') ? 1 : 0)
  expect(session.sessionId).toBe(candidate.sessionId)
  expect(ledger).toEqual([candidate.sessionId])
  expect(f.events().filter(e => e.event === 'spawn')).toHaveLength(mode.startsWith('project_settings') ? 2 : 1)
  expect(f.events().filter(e => e.type === 'claim_session')).toHaveLength(1)
  await expect.poll(() => f.events().filter(e => e.event === 'user')).toHaveLength(1)
  await session.cancel()
  if (timing) {
    expect(candidate.preparationTiming).toMatchObject({ source: 'bootstrap_claude_start', runIdHash: runIdHash(f.hint.runId), outcome: 'ok', truncated: false, claimAuthentication: mode.startsWith('project_settings') ? 'ordinary_path' : 'oauth_environment' })
    expect(candidate.preparationTiming!.phases.map(phase => phase.name)).toEqual(expect.arrayContaining(['daemon.adapter.cli_init.prewarm', 'daemon.adapter.cli_init']))
    const response = await fetch(timing.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }, { key: 'duration_ms', value: { intValue: 3 } }] }] }] }] }) })
    expect(response.status).toBe(200)
    await timing.close({ cliExitObserved: true })
    const receipt = observation!.finish()!
    expect(candidate.preparationTiming!.startedAt).toBeLessThanOrEqual(receipt.startedAt)
    expect(receipt.officialCliTiming).toMatchObject({ runIdHash: runIdHash(f.hint.runId), recordsReceived: 1 })
  }
}, 10000)

it('rejects a modified adopted temporary directory before claim', async () => {
  const f = fixture(), candidate = f.start()!
  await candidate.ready
  chmodSync(f.tmp, 0o755)
  await expect(candidate.adopt(f.binding(candidate))).rejects.toThrow('ownership changed')
  expect(candidate.state).toBe('closed')
  expect(f.events().filter(e => e.type === 'claim_session' || e.event === 'user')).toEqual([])
})

it.each([false, true, 'host'] as const)('the actual hosted runner adopts one bootstrap process with diagnostics=%s and no credential RPC', async diagnosticMode => {
  const diagnostics = diagnosticMode !== false, hostOnly = diagnosticMode === 'host'
  // A fresh worker has not invoked query/prewarm before this bootstrap.
  vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', undefined)
  const f = fixture('normal', diagnostics)
  for (const key of ['HOME', 'PATH', 'FIXTURE_MODE', 'FIXTURE_TRACE'] as const) vi.stubEnv(key, f.env[key])
  const fullEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const candidate = f.start({ env: fullEnv })!
  await candidate.ready
  const { createHostedBotRunner } = await import('../src/subscription-hosted-runner')
  const { MemoryServer } = await import('../src/server-link')
  const { ToolApprovalGate } = await import('../src/agents/tool-approval')
  const { createLogger } = await import('../src/log')
  const { runRuntimeTimings } = await import('../src/run-runtime-timing')
  const { execFileSync } = await import('node:child_process')
  let credentialCalls = 0
  const never = async () => { credentialCalls++; throw Error('Unexpected credential RPC') }
  const link = Object.assign(new MemoryServer(f.bootstrap.deviceId).link(), { nativeLease: never, nativeContext: never, nativeRequest: never, githubLease: never })
  const runner = await createHostedBotRunner({ stateDir: f.stateDir, link, binaries: { claude_code: join(f.root, 'claude') }, anonymousClaudeCandidate: candidate,
    ...(hostOnly ? { collectCliTiming: true } : {}) })
  const assignment = {
    runId: f.hint.runId, deviceId: f.bootstrap.deviceId, issueId: randomUUID(), repoId: randomUUID(),
    baseBranch: 'main', harness: 'claude_code' as const, prompt: 'offline local task', model: f.hint.model, effort: f.hint.effort,
    ...(diagnostics && !hostOnly ? { taskEnv: { CLOUD_STARTUP_TIMING: '1' } } : {}),
    subscriptionBinding: { bindingId: randomUUID(), ownerId: randomUUID(), workspaceId: f.bootstrap.workspaceId, consumerId: randomUUID(), route: 'claude_code_cli' as const },
    subscriptionLease: { route: 'claude_code_cli' as const, accountId: 'fixture-account', revision: 1,
      modelId: f.hint.model, accessToken: 'fixture-token', expiresAt: new Date(Date.now() + 3600000).toISOString() },
  }
  if (hostOnly) expect(assignment.taskEnv).toBeUndefined()
  const gate = new ToolApprovalGate(f.hint.runId, { isLive: () => !f.lifetime.signal.aborted }, 'push')
  const options = { runId: f.hint.runId, cwd: f.cwd, env: buildChildEnv({ runId: f.hint.runId }), model: f.hint.model, effort: f.hint.effort,
    policy: f.hint.policy, policyHash: policySnapshotHash(f.hint.policy), kind: 'implement' as const,
    toolApproval: gate, prompt: 'offline local task', mcp: { url: 'https://fixture.invalid/api/mcp',
      token: 'mkw_' + 'A'.repeat(43), decisionCatalogue: f.hint.decisionCatalogue }, log: createLogger({ stdout: false }) }
  const observation = runRuntimeTimings.begin(f.hint.runId, f.bootstrap.deviceId, 'claude_code')
  const prepared = runner.prepare(assignment, options, f.lifetime.signal)
  cleanups.push(async () => { await prepared.cancel(); observation.close() })
  await prepared.ready
  expect(f.events().filter(row => row.event === 'spawn')).toHaveLength(1)
  expect(f.events().filter(row => row.event === 'user')).toEqual([])
  f.readyRepository(); execFileSync('git', ['init', '-q', f.cwd])
  let late: import('../src/tracing').DaemonStartupTiming | undefined
  const session = await daemonTracer.span('daemon.adapter.start', { 'mikka.run.id_hash': runIdHash(f.hint.runId), 'mikka.harness': 'claude_code' },
    () => prepared.start(options), { onStartupTiming: value => { late = value } })
  await expect.poll(() => f.events().filter(row => row.event === 'user')).toHaveLength(1)
  await session.cancel()
  expect(credentialCalls).toBe(0)
  expect(f.events().filter(row => row.event === 'spawn')).toHaveLength(1)
  expect(f.events().filter(row => row.type === 'claim_session')).toHaveLength(1)
  const receipt = observation.finish()!
  if (diagnostics) {
    expect(prepared.preparationTiming).toMatchObject({ source: 'bootstrap_claude_start', outcome: 'ok', truncated: false, claimAuthentication: 'oauth_environment', observedAuthSource: 'oauth_environment' })
    expect(prepared.preparationTiming!.phases.map(row => row.name)).toEqual(expect.arrayContaining(['daemon.adapter.cli_init.prewarm', 'daemon.adapter.cli_init']))
    expect(prepared.preparationTiming!.startedAt).toBeLessThanOrEqual(receipt.startedAt)
    expect(receipt.officialCliTiming).toMatchObject({ runIdHash: runIdHash(f.hint.runId), cliExitObserved: true })
    const readerUrl = new URL('../../../scripts/acceptance/cloud-startup.mjs', import.meta.url)
    const { observeChunks, hasStartupInitialization } = await import(readerUrl.href)
    const record = { runIdHash: runIdHash(f.hint.runId), harness: 'claude_code' }
    observeChunks(record, { chunks: [{ at: new Date(late!.endedAt).toISOString(), chunk: { type: 'data-run-stage', data: {
      stage: 'agent_start', ms: late!.ms, ok: true, startupTiming: late, preparationTiming: prepared.preparationTiming,
    } } }] }, Date.now())
    expect(hasStartupInitialization(record)).toBe(true)
  } else {
    expect(prepared.preparationTiming).toBeUndefined()
    expect(receipt.officialCliTiming).toBeUndefined()
    expect(receipt.mcpHttpTiming).toBeUndefined()
  }
}, 10000)

it('transfers one collector with actual preclaim events only to the matching identity', async () => {
  const f = fixture('normal', true), candidate = f.start()!
  await candidate.ready
  const fresh = f.binding(candidate).identity
  for (const change of [{ runId: randomUUID() }, { deviceId: randomUUID() }, { workspaceId: randomUUID() },
    { diagnostics: false }, { policyHash: '0'.repeat(64) }])
    expect(await candidate.takeTiming({ ...fresh, ...change })).toBeUndefined()
  const timing = await candidate.takeTiming(fresh)
  expect(timing).toBeDefined(); expect(await candidate.takeTiming(fresh)).toBeUndefined()
  const response = await fetch(timing!.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [
      { attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }, { key: 'duration_ms', value: { intValue: 2 } }] },
    ] }] }] }) })
  expect(response.status).toBe(200)
  const { runRuntimeTimings } = await import('../src/run-runtime-timing')
  const observation = runRuntimeTimings.begin(f.hint.runId, f.bootstrap.deviceId, 'claude_code')
  cleanups.push(async () => { await timing!.close(); observation.close() })
  await candidate.close()
  await timing!.close({ cliExitObserved: candidate.nativeExitObserved })
  const receipt = observation.finish()!
  expect(receipt.officialCliTiming?.recordsReceived).toBe(1)
  expect(receipt.officialCliTiming!.events[0].receivedAt).toBeLessThanOrEqual(receipt.startedAt)
  expect(receipt.officialCliTiming?.runIdHash).toBe(runIdHash(f.hint.runId))
  expect(candidate.preparationTiming).toBeUndefined()
})

it('closing an unclaimed diagnostic candidate cannot publish a run receipt', async () => {
  const f = fixture('normal', true), candidate = f.start()!
  await candidate.ready
  const { runRuntimeTimings } = await import('../src/run-runtime-timing')
  const observation = runRuntimeTimings.begin(f.hint.runId, f.bootstrap.deviceId, 'claude_code')
  cleanups.push(() => observation.close())
  await candidate.close()
  const receipt = observation.finish()!
  expect(receipt.officialCliTiming).toBeUndefined()
  expect(receipt.mcpHttpTiming).toBeUndefined()
  expect(candidate.preparationTiming).toBeUndefined()
})
