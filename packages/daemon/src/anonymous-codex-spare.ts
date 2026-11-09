// One auth-free initialize per newly accepted TaskVM bootstrap, never a pool.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AnonymousCodexHint } from '@mikka/protocol/codex-startup'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import type { RunTraceContext } from '@mikka/protocol/trace-context'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { jsonlConnection } from './agents/jsonl-rpc'
import { untilReady, type spawnCli } from './agents/child'
import { runPaths, type McpServerSpec } from './agents/run-context'
import { MACHINE_GITHUB_ENV } from './agents/machine-github'
import { writeCodexMcpContext } from './codex-mcp-context'
import { captureCodexSystemSkills, codexAnonymousParkingEligible, codexAnonymousRepositoryEligible, type CodexSystemSkills } from './codex-startup-config'
import { codexTraceEnvironment, startCodexGenerationCollector } from './codex-generation-telemetry'
import { rawCliShellAvailable } from './permissions'
import { stopGroup } from './process-group'
import { daemonTracer, runIdHash, type DaemonPreparationTiming } from './tracing'
import { buildChildEnv } from './env'
import { DAEMON_VERSION } from './paths'
import { startCliTimingCollector } from './official-cli-timing'
import type { FreshCandidate } from './anonymous-claude-spare'

type Child = Awaited<ReturnType<typeof spawnCli>>
type Timing = Awaited<ReturnType<typeof startCliTimingCollector>>
type Generations = Awaited<ReturnType<typeof startCodexGenerationCollector>>
export type CodexAdoption = {
  child: Child; rpc: MessageConnection; initialized: { userAgent?: string }
  threadConfig: Record<string, unknown>; nativeGenerations?: Generations
}
export interface AnonymousCodexCandidate {
  readonly runId: string
  readonly ready: Promise<void>
  readonly state: 'preparing' | 'parked' | 'adopted' | 'closed'
  readonly nativeStarted: boolean
  readonly nativeExitObserved: boolean
  readonly preparationTiming: DaemonPreparationTiming | undefined
  matchesFresh(fresh: FreshCandidate): boolean
  takeTiming(fresh: FreshCandidate): Promise<Timing | undefined>
  adopt(input: { fresh: FreshCandidate; cwd: string; env: Record<string, string | undefined>; binary: string;
    mcp: McpServerSpec; repositoryRoot?: string; traceContext?: RunTraceContext; assertLive(): void; onRevoke(callback: () => void): () => void }): Promise<CodexAdoption | undefined>
  close(): Promise<void>
}

/** Immutable process options are selected from the non-authoritative hint.
 * Fresh assignment, exact final environment and the real checkout qualify
 * them before any external token, thread or task input reaches this process. */
export function startAnonymousCodex(input: {
  hint: AnonymousCodexHint; bootstrap: { sha256: string; deviceId: string; workspaceId: string }
  stateDir: string; binary: string; env: Record<string, string>; signal: AbortSignal
  initializeTimeoutMs?: number; unusedLifetimeMs?: number
}): AnonymousCodexCandidate | undefined {
  const { hint } = input
  if (input.bootstrap.sha256 !== hint.bootstrapSha256 || !input.env.HOME || input.signal.aborted) return
  const paths = runPaths(input.stateDir, hint.runId)
  mkdirSync(dirname(paths.runDir), { recursive: true, mode: 0o700 })
  try { mkdirSync(paths.runDir, { mode: 0o700 }) } catch { return }
  const parking = join(paths.runDir, 'anonymous-codex')
  mkdirSync(parking, { mode: 0o700 })
  const lifetime = new AbortController()
  const measurement = hint.diagnostics ? daemonTracer.beginBootstrapPreparation({ harness: 'codex', runIdHash: runIdHash(hint.runId) }) : undefined
  let state: AnonymousCodexCandidate['state'] = 'preparing', consumed = false, adopted = false, nativeExitObserved = false
  let child: Child | undefined, rpc: MessageConnection | undefined, initialized: { userAgent?: string } | undefined
  let timing: Timing | undefined, nativeGenerations: Generations | undefined, timingTransferred = false
  let context: ReturnType<typeof writeCodexMcpContext> | undefined, closing: Promise<void> | undefined
  let offRevoke = () => {}, traceContext = daemonTracer.capture()
  let fixedEnv: Record<string, string> | undefined, systemSkills: CodexSystemSkills | undefined
  const clean = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env)
    .filter(([key, value]) => typeof value === 'string' && !key.startsWith('MIKKA_DECISION_MCP_') && key !== 'MIKKA_MCP_HTTP_OBSERVATION_URL'))
  const close = () => {
    if (closing) return closing
    state = 'closed'; lifetime.abort(); clearTimeout(timer)
    closing = Promise.resolve().then(async () => {
      try {
        await child?.kill()
        await starting.catch(() => undefined)
        await child?.kill()
        rpc?.dispose()
      } finally {
        await nativeGenerations?.close(nativeExitObserved)
        if (!timingTransferred) await timing?.close({ publish: false, cliExitObserved: nativeExitObserved })
        context?.close()
        measurement?.finish('error')
        input.signal.removeEventListener('abort', abort); offRevoke()
        rmSync(parking, { recursive: true, force: true })
      }
    })
    return closing
  }
  const abort = () => { void close().catch(() => undefined) }
  const prepare = async () => {
    if (!await codexAnonymousParkingEligible(parking, input.env)) throw Error('Anonymous Codex requires an unconfigured fresh home and parking directory')
    lifetime.signal.throwIfAborted()
    const home = join(input.env.HOME, '.codex')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    if (hint.diagnostics) {
      timing = await startCliTimingCollector({ runId: hint.runId, harness: 'codex', model: hint.model,
        remoteMcpServerCount: 0, decisionCatalogue: hint.decisionCatalogue })
    }
    fixedEnv = { ...input.env, ...buildChildEnv({ host: input.env, adapterAllow: [], runId: hint.runId }), ...(hint.diagnostics ? { CLOUD_STARTUP_TIMING: '1' } : {}),
      ...(hint.github ? MACHINE_GITHUB_ENV : {}), MIKKA_POLICY_HASH: policySnapshotHash(hint.policy),
      PATH: dirname(input.binary) + delimiter + (input.env.PATH ?? ''), CODEX_HOME: home, ...timing?.env }
    for (const key of timing?.unsetEnv ?? []) delete fixedEnv[key]
    const args = ['app-server', '-c', 'features.shell_tool=' + rawCliShellAvailable(hint.policy),
      '-c', 'shell_environment_policy.inherit="all"', '-c', 'shell_environment_policy.ignore_default_excludes=true',
      '-c', 'shell_environment_policy.set.MIKKA_POLICY_HASH=' + JSON.stringify(fixedEnv.MIKKA_POLICY_HASH),
      ...(timing?.args ?? [])]
    const childEnv = { ...fixedEnv }
    if (daemonTracer.generationsEnabled) {
      const bypass = codexTraceEnvironment(childEnv)
      if (!bypass) throw Error('Anonymous Codex native trace unavailable')
      nativeGenerations = await startCodexGenerationCollector(metrics => {
        // A bootstrap can lack a trace carrier. Keep its receiver local until
        // the fresh adoption supplies the run context; never invent a parent.
        if (traceContext) daemonTracer.generation(metrics, traceContext)
      })
      args.push(...nativeGenerations.args); Object.assign(childEnv, nativeGenerations.env, bypass)
    }
    lifetime.signal.throwIfAborted()
    const process = spawn(input.binary, args, { cwd: parking, env: childEnv, detached: true, stdio: 'pipe' })
    let tail = ''
    process.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-16000) })
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      process.once('error', () => resolve({ code: null, signal: null }))
      // A launcher can exit while descendants keep inherited pipes open.
      process.once('exit', () => { void stopGroup(process, 0) })
      process.once('close', (code, signal) => { nativeExitObserved = true; resolve({ code, signal }); abort() })
    })
    child = { process, exited, stderrTail: () => tail, kill: async (graceMs?: number) => { await stopGroup(process, graceMs); await exited } }
    rpc = jsonlConnection(process.stdout, process.stdin)
    const deny = rpc.onRequest(() => { throw Error('Anonymous Codex is not assigned') })
    rpc.listen()
    initialized = await daemonTracer.span('daemon.adapter.cli_init', { 'mikka.harness': 'codex' }, () =>
      untilReady(child!, rpc!.sendRequest<{ userAgent?: string }>('initialize', {
        clientInfo: { name: 'mikka', title: 'Mikka', version: DAEMON_VERSION }, capabilities: { experimentalApi: true },
      }), 'anonymous codex initialize', input.initializeTimeoutMs ?? 30000))
    if (!/^[A-Za-z0-9._-]+\/0\.166\.0(?:\s|$)/.test(initialized.userAgent ?? '')) throw Error('Anonymous Codex version unavailable')
    await rpc.sendNotification('initialized')
    systemSkills = await captureCodexSystemSkills(input.env)
    lifetime.signal.throwIfAborted()
    deny.dispose()
    state = 'parked'
  }
  const starting = Promise.resolve().then(() => measurement
    ? measurement.run(() => daemonTracer.span('daemon.adapter.cli_init.prewarm', { 'mikka.harness': 'codex' }, prepare))
    : prepare())
  const ready = starting.then(() => undefined)
  void ready.catch(abort)
  const timer = setTimeout(abort, input.unusedLifetimeMs ?? 90000); timer.unref()
  input.signal.addEventListener('abort', abort, { once: true }); if (input.signal.aborted) abort()
  const matchesFresh = (fresh: FreshCandidate) => fresh.runId === hint.runId && fresh.deviceId === input.bootstrap.deviceId &&
    fresh.workspaceId === input.bootstrap.workspaceId && fresh.model === hint.model && fresh.effort === hint.effort &&
    fresh.policyHash === policySnapshotHash(hint.policy) && fresh.diagnostics === hint.diagnostics &&
    isDeepStrictEqual(fresh.decisionCatalogue, hint.decisionCatalogue)
  return {
    runId: hint.runId, ready, close, matchesFresh, get state() { return state },
    get nativeStarted() { return child?.process.pid !== undefined }, get nativeExitObserved() { return nativeExitObserved },
    get preparationTiming() { return adopted ? measurement?.receipt : undefined },
    async takeTiming(fresh) {
      if (!matchesFresh(fresh) || timingTransferred || state === 'closed') return
      try { await ready } catch { return }
      if (lifetime.signal.aborted) return
      timingTransferred = true; return timing
    },
    async adopt(binding) {
      try {
        binding.assertLive()
        if (consumed) throw Error('Anonymous Codex candidate already consumed')
        consumed = true
        if (state === 'closed') return
        if (!matchesFresh(binding.fresh) || binding.binary !== input.binary) { await close(); return }
        try { await ready } catch { await close(); return }
        if (!await codexAnonymousRepositoryEligible(binding.cwd, binding.env, systemSkills, binding.repositoryRoot)) { await close(); return }
        binding.assertLive()
        const env = clean(binding.env)
        for (const key of timing?.unsetEnv ?? []) delete env[key]
        if (state !== 'parked' || !rpc || !child || !initialized || !isDeepStrictEqual(env, clean(fixedEnv!)) ||
          Boolean(nativeGenerations) !== Boolean(daemonTracer.generationsEnabled && binding.traceContext)) { await close(); return }
        // No token is serialized into native thread/start configuration.
        context = writeCodexMcpContext(paths.privateDir, hint.runId, binding.mcp)
        binding.assertLive()
        traceContext = binding.traceContext
        offRevoke = binding.onRevoke(abort)
        lifetime.signal.throwIfAborted(); binding.assertLive()
        state = 'adopted'; adopted = true; clearTimeout(timer)
        measurement?.finish('ok')
        return { child, rpc, initialized, nativeGenerations,
          threadConfig: { mcp_servers: { mikka: { ...context.server, required: true } } } }
      } catch (cause) { await close(); throw cause }
    },
  }
}
