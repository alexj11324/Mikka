import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedIssue, seedPersonalWorkspace, seedProject, seedRun, seedUser } from '../../tests/support/workspace-admin-db'
import type { EnvironmentSaveInput } from './contract'
import { saveEnvironment } from './store'
import {
  cancelExecution, createRunActionExecution, freezeRunEnvironment, listRunActionExecutions, readRunEnvironmentBinding,
} from './runs'

const config = (overrides: Record<string, unknown> = {}) => ({
  name: 'Node', description: '', runtime: 'cloud' as const, workdir: 'apps/web',
  setupScript: 'pnpm install', installScript: '', repositories: [] as string[], actions: [],
  ...overrides,
}) as unknown as EnvironmentSaveInput['config']

test('a claim freezes the project default once; a later config edit leaves the run on its revision', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  t.after(() => pool.end())
  const owner = await seedUser(pool, 'env-runs-owner')
  const workspaceId = await seedPersonalWorkspace(pool, owner)
  const agentId = await seedAgent(pool, owner)
  const projectId = await seedProject(pool, owner, [])
  const issueId = await seedIssue(pool, owner, workspaceId)
  await pool.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [projectId, JSON.stringify([issueId])])
  const actor = { userId: owner, workspaceId }
  const repositoryKey = 'v2/github.com/acme/app'

  const environment = await saveEnvironment(pool, actor, {
    projectId, isDefault: true,
    config: config({ repositories: [repositoryKey], actions: [{ id: randomUUID(), name: 'test', kind: 'test', command: 'pnpm test', timeoutSeconds: 120 }] }),
  })
  const firstRun = await seedRun(pool, { userId: owner, agentId, workspaceId, issueId })
  const frozen = await freezeRunEnvironment(pool, pool, { runId: firstRun, ownerId: owner, workspaceId, issueId, repositoryKey })
  assert.equal(frozen?.environment.environmentId, environment.id)
  assert.equal(frozen?.environment.revision, 1)
  assert.match(frozen?.setupCommand ?? '', /pnpm install/)

  await saveEnvironment(pool, actor, { id: environment.id, revision: 1, projectId, isDefault: true, config: config({ setupScript: 'pnpm build' }) })
  const again = await freezeRunEnvironment(pool, pool, { runId: firstRun, ownerId: owner, workspaceId, issueId, repositoryKey })
  assert.equal(again?.environment.revision, 1, 'the frozen binding wins over the edited row')
  assert.match(again?.setupCommand ?? '', /pnpm install/)

  const secondRun = await seedRun(pool, { userId: owner, agentId, workspaceId, issueId })
  const next = await freezeRunEnvironment(pool, pool, { runId: secondRun, ownerId: owner, workspaceId, issueId, repositoryKey })
  assert.equal(next?.environment.revision, 2, 'a new run freezes the current revision')
  assert.match(next?.setupCommand ?? '', /pnpm build/)

  const forbidden = await freezeRunEnvironment(pool, pool, { runId: await seedRun(pool, { userId: owner, agentId, workspaceId }),
    ownerId: owner, workspaceId, issueId: null, repositoryKey: 'v2/github.com/acme/other' })
  assert.equal(forbidden, null, 'a repository outside the allow-list does not inherit the project default')

  assert.equal((await readRunEnvironmentBinding(pool, firstRun))?.revision, 1)
})

test('one active action per run, idempotent request keys and stale recovery', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  t.after(() => pool.end())
  const owner = await seedUser(pool, 'env-actions-owner')
  const workspaceId = await seedPersonalWorkspace(pool, owner)
  const agentId = await seedAgent(pool, owner)
  const runId = await seedRun(pool, { userId: owner, agentId, workspaceId, status: 'running' })
  const environmentId = randomUUID()
  const base = {
    runId, ownerId: owner, workspaceId, environmentId, environmentRevision: 3,
    actionId: randomUUID(), actionName: 'test', actionKind: 'test' as const,
    command: 'pnpm test', cwd: '/home/user/.mikka/worktrees/run-1/apps/web', sandboxId: 'sandbox-1',
    timeoutSeconds: 120, requestedBy: owner,
  }
  const requestKey = randomUUID()
  const created = await createRunActionExecution(pool, { ...base, id: randomUUID(), requestKey })
  assert.equal(created.kind, 'created')
  if (created.kind !== 'created') return

  const replay = await createRunActionExecution(pool, { ...base, id: randomUUID(), requestKey })
  assert.equal(replay.kind, 'replayed')
  if (replay.kind === 'replayed') assert.equal(replay.execution.id, created.execution.id)

  assert.deepEqual(await createRunActionExecution(pool, { ...base, id: randomUUID(), requestKey: null }), { kind: 'busy' })

  await pool.query(`UPDATE run_action_executions SET status='running',"createdAt"=now()-interval '31 minutes' WHERE id=$1`, [created.execution.id])
  const recovered = await createRunActionExecution(pool, { ...base, id: randomUUID(), requestKey: null })
  assert.equal(recovered.kind, 'created')
  const stale = (await listRunActionExecutions(pool, runId)).find(row => row.id === created.execution.id)
  assert.equal(stale?.status, 'failed')
  assert.equal(stale?.errorCode, 'stale')

  const cancelled = await cancelExecution(pool, runId, recovered.kind === 'created' ? recovered.execution.id : '')
  assert.ok(cancelled?.cancelRequestedAt)
})
