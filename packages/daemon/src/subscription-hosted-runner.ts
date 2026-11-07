// Each hosted task owns its E2B machine. The owner-bound claim supplies
// credentials once; official CLIs connect directly to their providers and use
// the machine's normal HOME, environment and working directory Git metadata.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { harnessReportsModel, type HarnessInfo, type RunAssignment } from '@mikka/protocol'
import { CodedError, logCodedError } from '@mikka/protocol/coded-error'
import type { UserErrorDetail } from '@mikka/protocol/user-error-codes'
import { ClaudeAdapter, ClaudeInitializationError } from './adapters/claude'
import { CodexAdapter } from './adapters/codex'
import type { AgentSession, StartOptions } from './adapters/types'
import { runPaths } from './agents/run-context'
import type { spawnCli } from './agents/child'
import type { AgentSandbox } from './agents/sandbox'
import { requireRunToolApproval } from './agents/tool-approval'
import { prepareMachineGitHub } from './agents/machine-github'
import { prepareSubscriptionCredentials, type PreparedSubscription } from './subscription-credentials'
import type { ServerLink } from './server-link'
import type { RunJournal } from './runs/journal'
import { readJson, writeJsonAtomic } from './fs-util'
import type { ComputerBroker } from './computer/broker.mjs'
import { decide } from './permissions'
import { removeRunCredentials } from './run-scratch'
import { daemonTracer, runIdHash } from './tracing'
import { runDiagnosticsEnabled, runRuntimeTimings } from './run-runtime-timing'
import { startCliTimingCollector } from './official-cli-timing'
import { hostedBinaries } from './hosted-binaries'
import { stopGroup } from './process-group'
export { hostedBinaries } from './hosted-binaries'

const computerProxy = fileURLToPath(new URL('./computer/proxy.mjs', import.meta.url))
type Detail = UserErrorDetail<'subscription_hosted_runtime_unavailable'>
const unavailable = (detail: Detail, cause?: unknown) => cause instanceof ClaudeInitializationError
  ? new Error(cause.code, { cause }) : new CodedError('subscription_hosted_runtime_unavailable', { detail, cause })

const directSpawnOnly: AgentSandbox = { kind: 'none', async wrap() { throw unavailable('host_unsupported') } }

/** Verification owns the same task directory as its CLI. Its entire process
 * group must stop on cancellation, timeout or a shell leader's early exit. */
export async function runHostedCommand(worktree: string, script: string, _readOnly: boolean, timeoutMs: number, signal?: AbortSignal) {
  const began = performance.now()
  let child: ChildProcess | undefined, stopping: Promise<void> | undefined, timer: NodeJS.Timeout | undefined
  let timedOut = false, overflow = false
  let exitCode: number | null = null, exitSignal: string | null = null, output = 'hosted_command_failed'
  const stop = () => child ? stopping ??= stopGroup(child) : Promise.resolve()
  const abort = () => { void stop() }
  try {
    signal?.throwIfAborted()
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const lengths = { stdout: 0, stderr: 0 }
    const collect = (stream: 'stdout' | 'stderr', chunks: Buffer[], chunk: Buffer) => {
      lengths[stream] += chunk.length
      if (lengths[stream] > 1024 * 1024) { overflow = true; abort() }
      else chunks.push(chunk)
    }
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child = spawn('/bin/sh', ['-c', script], {
        cwd: realpathSync(worktree), env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk: Buffer) => collect('stdout', stdout, chunk))
      child.stderr?.on('data', (chunk: Buffer) => collect('stderr', stderr, chunk))
      child.once('error', reject)
      child.once('close', (code, term) => resolve({ code, signal: term }))
      child.once('exit', abort)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
    })
    exitCode = result.code; exitSignal = result.signal
    if (exitCode === 0 && !timedOut && !overflow && !signal?.aborted)
      output = (Buffer.concat(stdout).toString('utf8') + Buffer.concat(stderr).toString('utf8')).slice(-4000)
    else if (exitCode === 0) exitCode = null
  } catch {
    exitCode = child?.exitCode ?? null
    exitSignal = child?.signalCode ?? null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await stop()
  }
  return { exitCode, signal: exitSignal, timedOut: timedOut && !signal?.aborted, output,
    timing: { createMs: 0, runMs: Math.round(performance.now() - began) } }
}

export async function createHostedBotRunner(host: {
  stateDir: string
  link: ServerLink
  journal?: Pick<RunJournal, 'get'>
  binaries?: Partial<Record<'codex' | 'claude_code', string>>
  /** Trusted host diagnostic opt-in; never changes the assignment or its authority. */
  collectCliTiming?: boolean
  /** Kept for old trusted worker callers; no inner container is created. */
  dockerSocket?: 'unix:///run/mikka-container/docker.sock'
  computerBroker?: ComputerBroker
  /** Claude's shortcut menu is not exhaustive: a prepared lease may confirm
   * its exact model through the run's current account catalogue. Codex still
   * requires its CLI report; neither path substitutes another model. */
  reportedModels?: (harness: 'codex' | 'claude_code') => Promise<Pick<HarnessInfo, 'models' | 'modelSlots'> | null>
}) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw unavailable('host_unsupported')
  if (host.dockerSocket !== undefined && host.dockerSocket !== 'unix:///run/mikka-container/docker.sock') throw unavailable('host_unsupported')
  const binaries = hostedBinaries(host.binaries)
  if (!binaries.codex && !binaries.claude_code) throw unavailable('cli_missing')
  return {
    harnesses: Object.keys(binaries).filter(kind => binaries[kind as keyof typeof binaries]) as ('codex' | 'claude_code')[],
    binaries: { ...binaries }, command: runHostedCommand,
    async start(assignment: RunAssignment, options: StartOptions): Promise<AgentSession> {
      const gate = requireRunToolApproval(options.runId, options.toolApproval)
      const selected = assignment.subscriptionBinding
      const apiKey = assignment.modelCredential
      const kind = assignment.harness
      const protocol = kind === 'codex' ? 'openai' : 'anthropic'
      if (Boolean(selected) === Boolean(apiKey) || options.runId !== assignment.runId ||
        (kind !== 'codex' && kind !== 'claude_code') || !binaries[kind] ||
        (selected && (selected.consumerId.length !== 36 || selected.route !== (kind === 'codex' ? 'codex_cli' : 'claude_code_cli'))) ||
        (apiKey?.kind === 'provider' && apiKey.protocol !== protocol) ||
        (assignment.requireSessionResume && !selected) ||
        (options.continueSession && (!selected || !assignment.requireSessionResume))) throw unavailable('assignment_invalid')
      const continuation = options.continueSession
      if (selected && assignment.requireSessionResume) {
        const source = host.journal?.get(continuation?.runId ?? assignment.runId)
        const binding = source?.assignment.subscriptionBinding
        if (!assignment.resumeSessionId || !assignment.continuesRunId || !source?.worktree ||
          source.sessionId !== assignment.resumeSessionId ||
          (continuation && (continuation.runId !== assignment.continuesRunId || continuation.sessionId !== assignment.resumeSessionId)) ||
          (!continuation && source.questionResumeState !== 'accepted') ||
          source.assignment.harness !== kind || source.assignment.model !== assignment.model || options.model !== assignment.model ||
          source.assignment.effort !== assignment.effort || options.effort !== assignment.effort ||
          source.assignment.deviceId !== assignment.deviceId || source.assignment.issueId !== assignment.issueId ||
          source.assignment.repoId !== assignment.repoId || realpathSync(source.worktree) !== realpathSync(options.cwd) ||
          !binding || binding.bindingId !== selected.bindingId || binding.ownerId !== selected.ownerId ||
          binding.workspaceId !== selected.workspaceId || binding.consumerId !== selected.consumerId || binding.route !== selected.route)
          throw unavailable('resume_mismatch')
      }
      const trace = { 'mikka.harness': kind, 'mikka.run.id_hash': runIdHash(assignment.runId) }
      const lifetime = new AbortController()
      const children = new Set<ReturnType<typeof spawn>>()
      let cliStarted = 0
      let cliExited = 0
      let cliTiming: Awaited<ReturnType<typeof startCliTimingCollector>> | undefined
      let subscription: PreparedSubscription | undefined
      let github: ReturnType<typeof prepareMachineGitHub> | undefined
      let computerGrant: ReturnType<ComputerBroker['spec']>
      let closed = false
      let closing: Promise<void> | undefined
      let offRevoke = () => {}
      const assertOpen = () => { if (closed || lifetime.signal.aborted || gate.revoked) throw unavailable('run_closed') }
      const close = () => {
        if (closing) return closing
        closed = true
        subscription?.close()
        // Publish first: abort callbacks and child exit can re-enter close.
        closing = Promise.resolve().then(async () => {
          try { await Promise.all([...children].map(child => stopGroup(child))) }
          finally {
            await cliTiming?.close({ cliExitObserved: cliStarted > 0 && cliStarted === cliExited })
            offRevoke()
            // The VM belongs to this task. Keep its last native login for
            // final verification/publication; the VM reclaims it afterwards.
            github?.close({ retainCredential: true })
            removeRunCredentials(host.stateDir, assignment.runId)
          }
        })
        if (computerGrant) host.computerBroker?.revoke(computerGrant.token)
        lifetime.abort()
        return closing
      }
      offRevoke = gate.onRevoke(() => { void close().catch(() => undefined) })
      try {
        if (!await gate.checkLive()) { gate.revoke(); throw unavailable('run_closed') }
        // The claim already prepared owner-bound secrets; local metadata/model
        // work may run alongside the old-server one-time lease fallback.
        const [prepared, report] = await Promise.all([
          selected ? prepareSubscriptionCredentials(assignment, {
            link: host.link, signal: lifetime.signal, onCredential: options.onCredential,
            onRefreshError: () => { options.log.warn({ event: 'subscription_refresh_deferred' }, 'Subscription renewal will retry in the background') },
          }) : Promise.resolve(undefined),
          selected && host.reportedModels ? daemonTracer.span('daemon.adapter.model_report', trace,
            () => host.reportedModels!(kind)).catch(() => null) : Promise.resolve(undefined),
        ])
        subscription = prepared
        assertOpen()
        if (selected && host.reportedModels && (!options.model || options.model !== subscription?.first.modelId ||
          (!(report && harnessReportsModel(report, options.model) === true) &&
            !(kind === 'claude_code' && subscription?.first.modelCatalogueVerified === true)))) {
          throw Error('subscription_model_not_reported')
        }
        const paths = runPaths(host.stateDir, assignment.runId)
        mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
        const cwd = realpathSync(options.cwd)
        const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env, ...assignment.taskEnv })
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        const selectedGithub = options.github ?? (assignment.github ? { ...assignment.github, issueId: assignment.issueId, runToken: assignment.mcp?.token } : undefined)
        if (selectedGithub) {
          const credential = selectedGithub.token ? selectedGithub : { ...selectedGithub,
            ...await host.link.githubLease?.(assignment.deviceId, assignment.runId, lifetime.signal) }
          assertOpen()
          github = prepareMachineGitHub(credential, { env, signal: lifetime.signal, onCredential: options.onCredential,
            refresh: async () => {
              if (!host.link.githubLease) throw Error('github_refresh_unavailable')
              return runRuntimeTimings.backgroundCredentialRefresh(assignment.runId,
                () => daemonTracer.span('daemon.adapter.auth.github_refresh', trace,
                  () => host.link.githubLease!(assignment.deviceId, assignment.runId, lifetime.signal)))
            },
            onRefreshError: () => { options.log.warn({ event: 'github_refresh_deferred' }, 'GitHub renewal will retry in the background') },
          })
          Object.assign(env, github.env)
        }
        const ledger = join(host.stateDir, 'native-ledgers', assignment.runId + '.json')
        const scope = selected && subscription ? {
          runId: assignment.runId, bindingId: selected.bindingId, ownerId: selected.ownerId,
          workspaceId: selected.workspaceId, consumerId: selected.consumerId, route: selected.route,
          revision: subscription.first.revision, accountId: subscription.first.accountId, modelId: subscription.first.modelId,
        } : undefined
        if (continuation && existsSync(ledger)) throw unavailable('ledger_mismatch')
        const previousLedger = continuation ? join(host.stateDir, 'native-ledgers', continuation.runId + '.json') : ledger
        const previous = scope ? readJson(previousLedger) as { scope: typeof scope; sessionId: string } | undefined : undefined
        const expectedScope = scope && continuation ? { ...scope, runId: continuation.runId } : scope
        if (scope && ((existsSync(previousLedger) && (!previous || JSON.stringify(previous.scope) !== JSON.stringify(expectedScope) || typeof previous.sessionId !== 'string')) ||
          (assignment.requireSessionResume && (!previous || previous.sessionId !== assignment.resumeSessionId)))) throw unavailable('ledger_mismatch')
        if (scope) mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 })
        const record = async (sessionId: string) => { assertOpen(); if (scope) writeJsonAtomic(ledger, { scope, sessionId }) }
        const computer = assignment.computer
        if (computer && (!host.computerBroker || (selected && computer.ownerId !== selected.ownerId))) throw unavailable('computer_unavailable')
        computerGrant = computer ? host.computerBroker!.spec(assignment.runId, decide('computer_use', { policy: assignment.policy }), { display: computer.display }) : undefined
        if (computer && !computerGrant) throw unavailable('computer_unavailable')
        const computerMcp = computerGrant ? {
          command: process.execPath, args: [computerProxy, computerGrant.socketPath, computerGrant.token, '--captures'], env: {},
        } : undefined
        if (runDiagnosticsEnabled(assignment.taskEnv, host.collectCliTiming)) {
          try {
            cliTiming = await startCliTimingCollector({ runId: assignment.runId, harness: kind, model: options.model,
              remoteMcpServerCount: options.apps?.apps.length ?? 0 })
          } catch { /* Missing observation is unavailable evidence, not a business or authorization failure. */ }
          assertOpen()
        }
        const spawnHosted = (config: SpawnOptions, oauthToken?: string): SpawnedProcess => {
          assertOpen()
          const childEnv = { ...env, ...config.env, ...cliTiming?.env }
          for (const key of cliTiming?.unsetEnv ?? []) delete childEnv[key]
          if (oauthToken !== undefined) {
            childEnv.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = '3'
            delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
            delete childEnv.ANTHROPIC_API_KEY
          }
          const child = spawn(binaries[kind]!, [...config.args, ...(cliTiming?.args ?? [])], {
            cwd, env: childEnv, detached: true,
            stdio: oauthToken === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
          })
          children.add(child)
          cliStarted++
          child.once('exit', () => { cliExited++; void stopGroup(child, 0).finally(() => children.delete(child)) })
          if (oauthToken !== undefined) {
            const pipe = child.stdio[3] as import('node:stream').Writable
            pipe.on('error', () => { void stopGroup(child) })
            pipe.end(oauthToken)
          }
          const stop = AbortSignal.any([lifetime.signal, ...(config.signal ? [config.signal] : [])])
          if (stop.aborted) void stopGroup(child)
          else stop.addEventListener('abort', () => { void stopGroup(child) }, { once: true })
          return child
        }
        const codexSpawn: typeof spawnCli = async (_sandbox, argv, input) => {
          const child = spawnHosted({ command: argv[0], args: argv.slice(1), cwd: input.cwd,
            env: input.env, signal: lifetime.signal }) as ReturnType<typeof spawn>
          child.stderr?.resume()
          const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
            child.once('exit', (code, signal) => resolve({ code, signal }))
            child.once('error', () => resolve({ code: null, signal: null }))
          })
          return { process: child as Awaited<ReturnType<typeof spawnCli>>['process'], exited,
            stderrTail: () => '', kill: async () => { await stopGroup(child); await close() } }
        }
        const adapter = kind === 'codex'
          ? new CodexAdapter({ stateDir: host.stateDir, binary: binaries.codex, sandbox: directSpawnOnly,
            spawnCli: codexSpawn, computerMcp, onHostedSession: record,
            ...(subscription ? { subscriptionAuth: { accountId: subscription.first.accountId,
              token: async () => {
                assertOpen()
                const value = subscription!.current()
                return { accessToken: value.accessToken, chatgptAccountId: value.accountId, ...(value.plan ? { chatgptPlanType: value.plan } : {}) }
              },
            } } : {}),
          })
          : new ClaudeAdapter({ stateDir: host.stateDir, binary: binaries.claude_code,
            computerMcp, onHostedSession: record, spawnHosted,
            ...(subscription ? { subscriptionAuth: { accountId: subscription.first.accountId, automaticRefresh: true as const,
              token: async () => { assertOpen(); return subscription!.current() },
            } } : {}),
          })
        const runtimeOptions = { ...options, env, cwd, machineEnvironment: true as const,
          mcpHttpObservationUrl: cliTiming?.mcpHttpObservationUrl,
          credential: apiKey, ...(assignment.requireSessionResume ? { requireSessionResume: true } : {}) }
        const session = previous && !continuation
          ? await adapter.resume(previous.sessionId, runtimeOptions) : await adapter.start(runtimeOptions)
        if (assignment.requireSessionResume && session.sessionId !== assignment.resumeSessionId) {
          await session.cancel(); throw unavailable('session_mismatch')
        }
        return {
          sessionId: session.sessionId,
          get runtimeModel() { return session.runtimeModel },
          async *events() {
            try {
              for await (const event of session.events()) {
                // Existing finish metadata reads its receipt after this exit.
                if (event.type === 'exit') await close()
                yield event
              }
            } finally { await close() }
          },
          send: async text => { assertOpen(); await session.send(text) },
          cancel: async () => { try { await session.cancel() } finally { await close() } },
          detach: async () => { try { await session.detach?.() } finally { await close() } },
        }
      } catch (error) {
        await close().catch(() => undefined)
        const refusal = error instanceof CodedError ? error : unavailable('adapter_start_failed', error)
        if (refusal instanceof CodedError) logCodedError(refusal, { runId: assignment.runId, harness: kind }, options.log)
        throw refusal
      }
    },
  }
}
