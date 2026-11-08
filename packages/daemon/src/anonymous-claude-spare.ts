// One fresh worker instance may prepare one official Claude process after
// bootstrap acceptance. No assignment, account or tool authority exists here.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { prewarm, type Options, type SpareProcess, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { AnonymousClaudeHint } from '@mikka/protocol/claude-startup'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import { prepareMikkaMcpBridge } from './agents/mikka-mcp-bridge'
import type { MikkaMcpAuthority, MikkaMcpContext } from './agents/mikka-mcp-backend.mjs'
import { runPaths } from './agents/run-context'
import { claudeMailboxServer, claudeSettings, CLAUDE_RUN_ENV } from './adapters/claude'
import type { RunMailbox } from './run-mailbox'
import { MACHINE_GITHUB_ENV } from './agents/machine-github'
import { stopGroup } from './process-group'
import { daemonTracer, runIdHash, type DaemonPreparationTiming } from './tracing'
import { startCliTimingCollector } from './official-cli-timing'

const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_HOST_SESSION_ID'] as const
const fixedJson = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
export type FreshCandidate = { runId: string; deviceId: string; workspaceId: string; model?: string; effort?: string; policyHash?: string | null; diagnostics: boolean; decisionCatalogue?: unknown }
type CandidateBinding = {
  identity: FreshCandidate
  options: Options
  context: MikkaMcpContext
  authority: MikkaMcpAuthority
  mailbox?: RunMailbox
  /** Actual fresh-claim credential, read locally from the existing lease. */
  oauthToken: string
  getOAuthToken: (request: { signal: AbortSignal }) => Promise<string | null>
  observe(child: ChildProcessWithoutNullStreams, stderr: string): void
}
export interface AnonymousClaudeCandidate {
  readonly runId: string
  readonly sessionId: string
  readonly ready: Promise<void>
  readonly nativeStarted: boolean
  readonly nativeExitObserved: boolean
  readonly preparationTiming: DaemonPreparationTiming | undefined
  recordAuthentication(adopted: boolean, tokenSource: string | undefined, apiKeySource: string | undefined): void
  matchesFresh(fresh: FreshCandidate): boolean
  takeTiming(fresh: FreshCandidate): Promise<Awaited<ReturnType<typeof startCliTimingCollector>> | undefined>
  measurePreparation<T>(work: () => Promise<T>): Promise<T>
  readonly state: 'preparing' | 'parked' | 'adopted' | 'closed'
  /** A mismatch consumes/closes the anonymous process before normal startup.
   * Authority failures never turn into a permissive fallback. */
  adopt(binding: CandidateBinding): Promise<SpareProcess | undefined>
  bindContext(context: MikkaMcpContext): Promise<void>
  close(): Promise<void>
}

/** The collector, UUID and temporary directory belong to this one accepted
 * bootstrap. Only a matching fresh claim may adopt them; the hint grants no
 * account, task, tool or measurement authority. */
export function startAnonymousClaude(input: {
  hint: AnonymousClaudeHint
  bootstrap: { sha256: string; deviceId: string; workspaceId: string }
  stateDir: string
  binary: string
  env: Record<string, string>
  signal: AbortSignal
  initializeTimeoutMs?: number
  unusedLifetimeMs?: number
}): AnonymousClaudeCandidate | undefined {
  const { hint } = input
  if (input.bootstrap.sha256 !== hint.bootstrapSha256 || AUTH_KEYS.some(name => Boolean(input.env[name])) || !input.env.HOME ||
    !hint.model || input.signal.aborted) return
  const sessionId = randomUUID(), runDir = runPaths(input.stateDir, hint.runId).runDir
  // An existing task directory can contain a previous lease/session. It is
  // never eligible for an anonymous restart, even when its run id is reused.
  mkdirSync(dirname(runDir), { recursive: true, mode: 0o700 })
  try { mkdirSync(runDir, { mode: 0o700 }) } catch { return }
  const tmpDir = join(runDir, 'tmp'), parking = join(runDir, 'anonymous-' + sessionId)
  mkdirSync(tmpDir, { mode: 0o700 }); mkdirSync(parking, { mode: 0o700 })
  const owned = lstatSync(tmpDir)
  const lifetime = new AbortController()
  const measurement = hint.diagnostics ? daemonTracer.beginBootstrapPreparation({ runIdHash: runIdHash(hint.runId), harness: 'claude_code' }) : undefined
  let measurementClaimed = false, timingTransferred = false
  const timingStarting = hint.diagnostics ? startCliTimingCollector({ runId: hint.runId, harness: 'claude_code',
    model: hint.model, remoteMcpServerCount: 0, decisionCatalogue: hint.decisionCatalogue }).catch(() => undefined) : Promise.resolve(undefined)
  let timing: Awaited<typeof timingStarting>
  const bridge = prepareMikkaMcpBridge({
    decisionCatalogue: JSON.stringify(hint.decisionCatalogue), captures: true,
    repositorySelection: ['implement', 'fix'].includes(hint.kind), artifactInspection: hint.policy.readOnly === true,
  })
  let state: AnonymousClaudeCandidate['state'] = 'preparing', consumed = false
  let spare: SpareProcess | undefined, child: ChildProcessWithoutNullStreams | undefined, childExit: Promise<void> | undefined
  let closing: Promise<void> | undefined, oauth: CandidateBinding['getOAuthToken'] | undefined
  let sawNativeExit = false
  let mailbox: RunMailbox | undefined, activeAuthority: MikkaMcpAuthority | undefined, stderr = ''
  const assertBound = () => {
    if (state !== 'adopted' || lifetime.signal.aborted || !activeAuthority) throw Error('Anonymous Claude is not bound')
    activeAuthority.signal.throwIfAborted(); activeAuthority.assertLive()
  }
  const mailboxProxy: RunMailbox = {
    tools: hint.mailboxTools.map(name => ({ name, description: '', inputSchema: {} })),
    request(body, signal) { assertBound(); if (!bridge.bound) return Promise.reject(Error('Mailbox context unavailable')); if (!mailbox) return Promise.reject(Error('Mailbox unavailable')); return mailbox.request(body, signal) },
    close: async () => {},
  }
  const env: Record<string, string> = { ...input.env, ...(hint.diagnostics ? { CLOUD_STARTUP_TIMING: '1' } : {}), ...(hint.github ? MACHINE_GITHUB_ENV : {}),
    MIKKA_RUN_ID: hint.runId, MIKKA_POLICY_HASH: policySnapshotHash(hint.policy), ...CLAUDE_RUN_ENV, CLAUDE_CODE_TMPDIR: tmpDir }
  const immutable: Options & { getOAuthToken: CandidateBinding['getOAuthToken'] } = {
    includePartialMessages: daemonTracer.enabled, cwd: parking, env, settingSources: ['user', 'project', 'local'],
    settings: { ...claudeSettings(hint.policy), forceLoginMethod: 'claudeai' },
    extraArgs: { 'replay-user-messages': null },
    mcpServers: { mikka: bridge.server, ...(hint.mailboxTools.length ? { mikka_mailbox: claudeMailboxServer(mailboxProxy) } : {}) },
    strictMcpConfig: false, systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    sessionId, model: hint.model, ...(hint.effort ? { effort: hint.effort } : {}),
    getOAuthToken: async request => {
      if (!oauth || state !== 'adopted' || request.signal.aborted || lifetime.signal.aborted) return null
      assertBound(); return oauth(request)
    },
    spawnClaudeCodeProcess: (config: SpawnOptions) => {
      lifetime.signal.throwIfAborted()
      if (child) throw Error('Anonymous Claude process already started')
      // The SDK adds its version to both this actual child environment and
      // process.env on its first call. Keep the fixed options equal to what
      // this process receives, including when bootstrap preceded that call.
      if (typeof config.env.CLAUDE_AGENT_SDK_VERSION === 'string')
        env.CLAUDE_AGENT_SDK_VERSION = config.env.CLAUDE_AGENT_SDK_VERSION
      child = spawn(input.binary, [...config.args, ...(timing?.args ?? [])], { cwd: config.cwd, env: { ...env, ...config.env, ...timing?.env }, detached: true, stdio: 'pipe' })
      childExit = new Promise<void>(resolve => { child!.once('close', resolve); child!.once('error', resolve) })
      child.stderr?.on('data', (part: Buffer) => { stderr = (stderr + part.toString()).slice(-16000) })
      child.once('exit', () => { sawNativeExit = true; abort() })
      return child
    },
  }
  const close = (): Promise<void> => {
    if (closing) return closing
    state = 'closed'
    closing = Promise.resolve().then(async () => {
      await starting.catch(() => undefined)
      try { spare?.close(); if (child) await stopGroup(child); await childExit; await spare?.exited }
      finally {
        await bridge.close()
        if (!timingTransferred) await (await timingStarting)?.close({ publish: false })
        if (!measurementClaimed) measurement?.finish('error')
        input.signal.removeEventListener('abort', abort)
        activeAuthority?.signal.removeEventListener('abort', abort)
        rmSync(parking, { recursive: true, force: true })
      }
    })
    clearTimeout(timer); lifetime.abort()
    return closing
  }
  const abort = () => { void close().catch(() => undefined) }
  const prepare = async () => {
    timing = await timingStarting
    if (hint.diagnostics && !timing) throw Error('Anonymous Claude collector unavailable')
    lifetime.signal.throwIfAborted()
    const value = await daemonTracer.span('daemon.adapter.cli_init.prewarm', { 'mikka.harness': 'claude_code', 'mikka.run.id_hash': runIdHash(hint.runId) },
      () => prewarm({ initializeTimeoutMs: input.initializeTimeoutMs ?? 30000, options: { ...immutable, abortController: lifetime } }))
    spare = value
    void value.claimed.catch(() => undefined)
    void value.exited.then(abort)
    if (lifetime.signal.aborted) throw Error('Anonymous Claude cancelled')
    state = 'parked'
    return value
  }
  const starting = Promise.resolve().then(() => measurement ? measurement.run(prepare) : prepare())
  const ready = starting.then(() => undefined)
  void ready.catch(abort)
  const timer = setTimeout(abort, input.unusedLifetimeMs ?? 90000)
  timer.unref()
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  const fields: Array<keyof Options> = ['includePartialMessages', 'env', 'settingSources', 'settings', 'extraArgs', 'strictMcpConfig',
    'permissionMode', 'allowDangerouslySkipPermissions', 'sessionId', 'model', 'effort']
  const matchesFresh = (fresh: FreshCandidate) => fresh.runId === hint.runId && fresh.deviceId === input.bootstrap.deviceId &&
    fresh.workspaceId === input.bootstrap.workspaceId && fresh.model === hint.model && fresh.effort === hint.effort &&
    fresh.policyHash === policySnapshotHash(hint.policy) && fresh.diagnostics === hint.diagnostics &&
    fixedJson(fresh.decisionCatalogue) === fixedJson(hint.decisionCatalogue)
  return {
    runId: hint.runId, sessionId, ready, get state() { return state }, close, matchesFresh,
    get nativeStarted() { return child?.pid !== undefined },
    get nativeExitObserved() { return sawNativeExit },
    get preparationTiming() { return measurementClaimed ? measurement?.receipt : undefined },
    recordAuthentication(adopted, tokenSource, apiKeySource) {
      const observed = tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'oauth_environment' :
        tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' ? 'oauth_descriptor' : apiKeySource === 'none' ? 'non_api_key_unspecified' : 'unknown'
      measurement?.authenticate(adopted ? observed === 'oauth_environment' ? 'oauth_environment' : 'unverified' : 'ordinary_path', observed)
    },
    async measurePreparation(work) {
      if (measurementClaimed) throw Error('Anonymous Claude preparation already claimed')
      measurementClaimed = true
      try { const value = await (measurement ? measurement.run(work) : work()); measurement?.finish('ok'); return value }
      catch (cause) { measurement?.finish('error'); throw cause }
    },
    async takeTiming(fresh) {
      if (!hint.diagnostics || !matchesFresh(fresh) || timingTransferred || state === 'closed') return
      const result = await timingStarting
      if (lifetime.signal.aborted || !result) return
      timingTransferred = true
      return result
    },
    async bindContext(context) {
      assertBound()
      try { await bridge.bind(context, activeAuthority!); assertBound() }
      catch (cause) { await close(); throw new Error('Anonymous Claude binding failed', { cause }) }
    },
    async adopt(binding) {
      try {
      // Fresh authority is checked even when the optional candidate is closed.
      binding.authority.signal.throwIfAborted(); binding.authority.assertLive()
      if (consumed) throw Error('Anonymous Claude candidate already consumed')
      if (state === 'closed') return
      consumed = true
      const actualMcp = binding.options.mcpServers ?? {}
      const expectedNames = Object.keys(immutable.mcpServers ?? {}).sort()
      const sameNames = fixedJson(Object.keys(actualMcp).sort()) === fixedJson(expectedNames)
      const sameMailbox = fixedJson(binding.mailbox?.tools.map(tool => tool.name).sort() ?? []) === fixedJson([...hint.mailboxTools].sort())
      if (!matchesFresh(binding.identity) || !sameNames || !sameMailbox || binding.context.decisionCatalogue !== JSON.stringify(hint.decisionCatalogue) ||
        fields.some(key => fixedJson(binding.options[key]) !== fixedJson(immutable[key]))) { await close(); return }
      try { await ready } catch { await close(); return }
      binding.authority.signal.throwIfAborted(); binding.authority.assertLive()
      if (state !== 'parked' || !spare || !child) { await close(); return }
      const current = lstatSync(tmpDir)
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid?.() ||
        (current.mode & 0o777) !== 0o700 || current.ino !== owned.ino || current.dev !== owned.dev || realpathSync(tmpDir) !== tmpDir)
        { await close(); throw Error('Anonymous Claude temporary directory ownership changed') }
      if (!binding.oauthToken || /[\r\n\0]/.test(binding.oauthToken) || binding.oauthToken.length > 32768)
        { await close(); throw Error('Anonymous Claude credential unavailable') }
      activeAuthority = binding.authority
      activeAuthority.signal.addEventListener('abort', abort, { once: true })
      activeAuthority.signal.throwIfAborted(); activeAuthority.assertLive()
      oauth = binding.getOAuthToken; mailbox = binding.mailbox; state = 'adopted'; clearTimeout(timer)
      binding.observe(child, stderr)
      const value = spare
      return {
        ...value,
        claimed: value.claimed, exited: value.exited,
        close() { value.close(); abort() },
        claim(request) {
          assertBound()
          if (!bridge.bound) throw Error('Anonymous Claude context is not bound')
          return value.claim({ ...request, options: { ...request.options, env: { CLAUDE_CODE_OAUTH_TOKEN: binding.oauthToken } } })
        },
      }
      } catch (cause) { await close(); throw cause }
    },
  }
}
