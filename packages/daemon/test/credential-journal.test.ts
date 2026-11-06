import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { RunJournal } from '../src/runs/journal'
import { cleanupTempDirs, tempDir } from './helpers'

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
