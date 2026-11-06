import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import pino from 'pino'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { WorktreeManager } from '../src/worktrees'
import type { AgentAdapter, StartOptions } from '../src/adapters/types'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
it('keeps claim credentials usable in memory and excludes them from every journal write', () => {
  const file = join(tempDir(), 'journal.json'), journal = new RunJournal(file)
  const assignment: RunAssignment = { runId: 'run', issueId: 'issue', deviceId: 'device', repoId: 'repo', harness: 'codex', prompt: 'work', model: 'model',
    subscriptionLease: { route: 'codex_cli', accountId: 'account', revision: 1, modelId: 'model', accessToken: 'private-subscription-access', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    github: { endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', token: 'private-github-access', expiresAt: null },
    taskEnv: { SECRET_TOKEN: 'private-task-env' },
  }
  journal.put({ assignment, state: 'queued', sessionId: null, worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
  journal.update('run', { state: 'running' })
  expect(journal.get('run')?.assignment.subscriptionLease?.accessToken).toBe('private-subscription-access')
  expect(journal.get('run')?.assignment.github?.token).toBe('private-github-access')
  expect(readFileSync(file, 'utf8')).not.toMatch(/private-(?:subscription|github|task)/)
  const restored = new RunJournal(file).get('run')!
  expect(restored.assignment.subscriptionLease).toBeUndefined()
  expect(restored.assignment.github).toEqual({ endpoint: assignment.github!.endpoint, repository: 'owner/repo', expiresAt: null })
  expect(restored.credentialWithheld).toBeUndefined()
})

it('masks initial and renewed credentials in real logger Error serialization and journal terminal errors', async () => {
  const root = tempDir(), repo = await makeRepo(), file = join(root, 'journal.json'), journal = new RunJournal(file)
  const key = 'private-initial-model-key', github = 'private-initial-github-key', renewed = 'private-renewed-access-key'
  const lines: string[] = [], items: unknown[] = []
  const log = pino({ level: 'trace' }, { write(line: string) { lines.push(line) } })
  const start = async (options: StartOptions): Promise<never> => {
    options.onCredential?.('SUBSCRIPTION_ACCESS_TOKEN', renewed)
    options.log.warn({ err: new AggregateError([new Error(key)], `native diagnostic ${renewed}`, { cause: new Error(github) }), stderr: `native stderr ${github} ${renewed}` }, 'synthetic native failure')
    throw new Error(`failed ${key} ${github} ${renewed}`, { cause: new Error(`upstream ${renewed}`) })
  }
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsResume: true, supportsInterject: false }, envAllow: [], start, resume: async (_session, options) => start({ ...options, prompt: '' }) }
  const outbox = { push(_runId: string, item: unknown) { items.push(item) }, lastChunkSeq() { return 0 }, async compact() {} } as unknown as SupervisorDeps['outbox']
  const supervisor = new RunSupervisor({ journal, log, outbox, adapterStateDir: join(root, 'adapters'),
    adapters: new Map([['mock', adapter]]), worktrees: new WorktreeManager(join(root, 'worktrees')),
    repository: () => ({ repoId: 'repo', name: 'fixture', path: repo }), prepareRepository: async () => {}, baseRef: async () => 'main',
  })
  try {
    supervisor.start({ runId: 'diagnostic-run', deviceId: 'device', issueId: 'issue', repoId: 'repo', harness: 'mock', prompt: 'work',
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(), modelCredential: { kind: 'api_key', key },
      github: { endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', token: github, expiresAt: null },
    })
    await supervisor.idle()
    expect(journal.get('diagnostic-run')?.state).toBe('failed')
    expect(journal.get('diagnostic-run')?.error).toContain('[secret:SUBSCRIPTION_ACCESS_TOKEN]')
    const persisted = readFileSync(file, 'utf8') + lines.join('') + JSON.stringify(items)
    for (const secret of [key, github, renewed]) expect(persisted).not.toContain(secret)
    expect(lines.some(line => line.includes('synthetic native failure'))).toBe(true)
    expect(lines.some(line => line.includes('run failed'))).toBe(true)
  } finally { await supervisor.stop() }
})
