import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import type { AgentAdapter } from '../src/adapters/types'
import type { RunChunk } from '../src/chunks'
import { createLogger } from '../src/log'
import type { OutboxItem } from '../src/outbox'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { daemonTracer, runIdHash } from '../src/tracing'
import { createRepositoryGitTimer } from '../src/repository-git-timing'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)

async function fixture(collectCliTiming?: boolean, repositoryFailed = false) {
  const root = tempDir(), repo = await makeRepo(), chunks = new Map<string, RunChunk[]>()
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [],
    async start(options) {
      await daemonTracer.span('daemon.adapter.cli_init', {}, async () => {
        if (options.prompt === 'fail') throw Error('Synthetic initialization failure')
      })
      return { sessionId: 'session', async *events() {
        yield { type: 'exit' as const, outcome: 'succeeded' as const, stopReason: 'submitted' as const, report: { summary: 'Observed task' } }
      }, async cancel() {}, async send() {} }
    }, async resume() { throw Error('Unexpected resume') },
  }
  const supervisor = new RunSupervisor({ collectCliTiming,
    journal: new RunJournal(join(root, 'journal.json')), worktrees: new WorktreeManager(join(root, 'worktrees')),
    log: createLogger({ level: 'silent' }),
    outbox: { push(runId: string, item: OutboxItem) {
      if (item.kind === 'chunk') { const values = chunks.get(runId) ?? []; values.push(item.chunk); chunks.set(runId, values) }
    }, async compact() {}, lastChunkSeq() { return 0 } } as unknown as SupervisorDeps['outbox'],
    adapters: new Map([['mock', adapter]]), repository: () => ({ repoId: 'repo', name: 'fixture', path: repo }),
    baseRef: async () => 'main', prepareRepository: async (assignment, _signal, _env, _policy, observer) => {
      if (!observer) return
      const timer = createRepositoryGitTimer(runIdHash(assignment.runId), assignment.harness)
      let outcome: 'ok' | 'error' = 'error'
      try { await timer.measure('local', async () => { if (repositoryFailed) throw Error('Synthetic repository failure') }); outcome = 'ok' }
      finally { observer(timer.finish(outcome)) }
    },
  })
  const run = async (runId: string, taskEnv?: RunAssignment['taskEnv'], failed = false) => {
    supervisor.start({ runId, deviceId: 'device', issueId: 'issue', repoId: 'repo', harness: 'mock', kind: 'plan',
      prompt: failed ? 'fail' : 'read', ...(taskEnv ? { taskEnv } : {}) })
    await supervisor.idle()
    expect(supervisor.get(runId).state).toBe(failed ? 'failed' : 'succeeded')
    return chunks.get(runId)!
  }
  return { supervisor, run }
}

for (const failed of [false, true]) {
  it.each(['ordinary', 'task', 'host'] as const)(`keeps stored startup and finish diagnostics opt-in (%s, failed=${failed})`, async mode => {
    const f = await fixture(mode === 'host' ? true : undefined)
    const runId = `diagnostics-${mode}-${failed}`
    try {
      const chunks = await f.run(runId, mode === 'task' ? { CLOUD_STARTUP_TIMING: '1' } : undefined, failed)
      const stages = chunks.filter(chunk => chunk.type === 'data-run-stage')
      expect(stages.map(chunk => [chunk.data.stage, chunk.data.ok])).toEqual([
        ['repository', true], ['worktree', true], ['agent_start', !failed],
      ])
      expect(stages.every(chunk => typeof chunk.data.ms === 'number')).toBe(true)
      const finish = chunks.findLast(chunk => chunk.type === 'finish')
      expect(finish).toBeDefined()
      if (mode === 'ordinary') {
        for (const chunk of stages) expect(Object.keys(chunk.data).sort()).toEqual(['ms', 'ok', 'stage'])
        expect(finish).toEqual({ type: 'finish' })
      } else {
        expect(stages[0].data.repositoryTiming).toMatchObject({ runIdHash: runIdHash(runId), clock: 'repository_prepare_monotonic',
          phases: [{ name: 'daemon.repository.git.local', outcome: 'ok' }] })
        expect(stages[2].data.startupTiming).toMatchObject({ runIdHash: runIdHash(runId), outcome: failed ? 'error' : 'ok',
          phases: [{ name: 'daemon.adapter.cli_init', outcome: failed ? 'error' : 'ok' }] })
        expect(finish?.type === 'finish' && finish.messageMetadata).toMatchObject({ mikkaRuntimeTiming: {
          runIdHash: runIdHash(runId), complete: true, truncated: false,
        } })
      }
    } finally { await f.supervisor.stop() }
  })
}

it('does not carry a task diagnostic opt-in into the next ordinary run on the same daemon', async () => {
  const f = await fixture()
  try {
    expect((await f.run('diagnostic-first', { CLOUD_STARTUP_TIMING: '1' })).findLast(chunk => chunk.type === 'finish')).toHaveProperty('messageMetadata.mikkaRuntimeTiming')
    const ordinary = await f.run('ordinary-next', { CLOUD_STARTUP_TIMING: '0' })
    expect(ordinary.findLast(chunk => chunk.type === 'finish')).toEqual({ type: 'finish' })
    expect(ordinary.filter(chunk => chunk.type === 'data-run-stage').every(chunk => chunk.data.startupTiming === undefined)).toBe(true)
  } finally { await f.supervisor.stop() }
})

it('attaches an errored repository receipt to the same single failed stage', async () => {
  const f = await fixture(true, true)
  try {
    const chunks = await f.run('failed-repository', undefined, true)
    const stages = chunks.filter(chunk => chunk.type === 'data-run-stage')
    expect(stages).toHaveLength(1)
    expect(stages[0].data).toMatchObject({ stage: 'repository', ok: false, repositoryTiming: { outcome: 'error',
      phases: [{ name: 'daemon.repository.git.local', outcome: 'error' }] } })
  } finally { await f.supervisor.stop() }
})
