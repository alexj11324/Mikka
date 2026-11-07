import { setImmediate as immediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { prepareAgentStart } from '../src/adapters/claude-prewarm'
import type { AgentSession, StartOptions } from '../src/adapters/types'
import { createLogger } from '../src/log'
import { daemonTracer, runIdHash, type DaemonStartupTiming } from '../src/tracing'

const session: AgentSession = {
  sessionId: 'anonymous-session', async *events() { yield { type: 'exit', outcome: 'succeeded' } },
  async send() {}, async cancel() {},
}
const options = (runId: string): StartOptions => ({ runId, cwd: process.cwd(), env: {}, prompt: 'anonymous task', log: createLogger({ level: 'silent' }) })
const attributes = (runId: string) => ({ 'mikka.run.id_hash': runIdHash(runId), 'mikka.harness': 'claude_code' })

it('carries real initialization across the already-running Promise without changing the later stage origin', async () => {
  const runId = 'prepared-async-context', attributes = { 'mikka.run.id_hash': runIdHash(runId), 'mikka.harness': 'claude_code' }
  const stages: DaemonStartupTiming[] = []
  const prepared = prepareAgentStart(new AbortController().signal, async control => {
    await daemonTracer.span('daemon.adapter.cli_init.prewarm', attributes, async () => { await immediate() })
    control.parked()
    await control.finalOptions
    await daemonTracer.span('daemon.adapter.cli_init', attributes, async () => { await immediate() })
    return session
  }, { runId, harness: 'claude_code' })
  try {
    await prepared.ready
    await immediate()
    expect(await daemonTracer.span('daemon.adapter.start', attributes, () => prepared.start(options(runId)),
      { onStartupTiming: timing => stages.push(timing) })).toBe(session)
    // Resolving finalOptions in this scope does not move the earlier async
    // continuation here. Its timing needs its own truthful preparation origin.
    expect(stages[0].phases).toEqual([])
    expect(prepared.preparationTiming).toMatchObject({ version: 1, source: 'prepared_agent_start',
      runIdHash: runIdHash(runId), harness: 'claude_code', outcome: 'ok', truncated: false,
      phases: [{ name: 'daemon.adapter.cli_init.prewarm', outcome: 'ok' }, { name: 'daemon.adapter.cli_init', outcome: 'ok' }] })
    const early = prepared.preparationTiming!
    expect(early.startedAt).toBeLessThanOrEqual(stages[0].startedAt)
    expect(early.ms).toBeGreaterThan(stages[0].ms)
    expect(early.phases.every(phase => phase.ms > 0 && phase.startMs >= 0 && phase.endMs <= early.ms + 0.01)).toBe(true)
  } finally { await prepared.cancel() }
})

it('does not collect the early Promise without the task diagnostic opt-in', async () => {
  const runId = 'ordinary-preparation', stages: DaemonStartupTiming[] = []
  const prepared = prepareAgentStart(new AbortController().signal, async control => {
    await daemonTracer.span('daemon.adapter.cli_init.prewarm', attributes(runId), async () => { await immediate() })
    control.parked(); await control.finalOptions
    await daemonTracer.span('daemon.adapter.cli_init', attributes(runId), async () => {})
    return session
  })
  try {
    await prepared.ready
    await daemonTracer.span('daemon.adapter.start', attributes(runId), () => prepared.start(options(runId)),
      { onStartupTiming: timing => stages.push(timing) })
    expect(stages[0].phases).toEqual([])
    expect(prepared.preparationTiming).toBeUndefined()
  } finally { await prepared.cancel() }
})

it('keeps concurrently prepared runs separate when final joins arrive in reverse order', async () => {
  const phases = ['daemon.adapter.auth.token', 'daemon.adapter.account_check'] as const
  const handles = ['concurrent-preparation-a', 'concurrent-preparation-b'].map((runId, index) => {
    const prepared = prepareAgentStart(new AbortController().signal, async control => {
      await daemonTracer.span('daemon.adapter.cli_init.prewarm', attributes(runId), async () => { await immediate() })
      // Even a known phase is excluded if its identity belongs to another run.
      await daemonTracer.span('daemon.adapter.auth.context', attributes('foreign-run'), async () => {})
      control.parked(); await control.finalOptions
      await daemonTracer.span(phases[index], attributes(runId), async () => { await immediate() })
      await daemonTracer.span('daemon.adapter.cli_init', attributes(runId), async () => {})
      return session
    }, { runId, harness: 'claude_code' })
    return { runId, prepared }
  })
  try {
    await Promise.all(handles.map(({ prepared }) => prepared.ready))
    for (const { runId, prepared } of [...handles].reverse()) await prepared.start(options(runId))
    for (const [index, { runId, prepared }] of handles.entries()) {
      expect(prepared.preparationTiming?.runIdHash).toBe(runIdHash(runId))
      expect(prepared.preparationTiming?.phases.map(phase => phase.name)).toEqual([
        'daemon.adapter.cli_init.prewarm', phases[index], 'daemon.adapter.cli_init',
      ])
    }
  } finally { await Promise.all(handles.map(({ prepared }) => prepared.cancel())) }
})

it('closes an aborted real asynchronous initialization as error without inventing a completed CLI phase', async () => {
  const lifetime = new AbortController(), runId = 'cancel-initialization'
  let entered!: () => void
  const inside = new Promise<void>(resolve => { entered = resolve })
  const prepared = prepareAgentStart(lifetime.signal, async control => {
    await daemonTracer.span('daemon.adapter.cli_init.prewarm', attributes(runId), () => new Promise<void>((_resolve, reject) => {
      control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true })
      entered()
    }))
    control.parked(); await control.finalOptions
    return session
  }, { runId, harness: 'claude_code' })
  await inside; lifetime.abort(); await prepared.cancel()
  await expect(prepared.ready).rejects.toMatchObject({ name: 'AbortError' })
  await expect(prepared.start(options(runId))).rejects.toThrow('closed')
  expect(prepared.preparationTiming).toMatchObject({ outcome: 'error', truncated: false,
    phases: [{ name: 'daemon.adapter.cli_init.prewarm', outcome: 'error' }] })
})

it('retains a parked cancellation as an error and never reports an unperformed final initialization', async () => {
  const runId = 'cancel-parked'
  const prepared = prepareAgentStart(new AbortController().signal, async control => {
    await daemonTracer.span('daemon.adapter.cli_init.prewarm', attributes(runId), async () => {})
    control.parked(); await control.finalOptions
    return session
  }, { runId, harness: 'claude_code' })
  await prepared.ready
  expect(prepared.preparationTiming).toBeUndefined()
  await prepared.cancel()
  expect(prepared.preparationTiming).toMatchObject({ outcome: 'error', truncated: false,
    phases: [{ name: 'daemon.adapter.cli_init.prewarm', outcome: 'ok' }] })
})
