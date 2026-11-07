import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createExecutionClaim } from './execution-claim'
import { createFactoryClaim } from './claim'
import { FactoryError } from './contract'

for (const mode of ['ordinary', 'current', 'stopped', 'retry-unadopted', 'foreign-owner', 'access-removed', 'wrong-issue', 'multiple-tasks']) {
  test(`execution claim fence: ${mode}`, async () => {
    const commands: string[] = []
    let released = false
    const task = { id:'task', userId:mode==='foreign-owner'?'other':'owner', status:mode==='stopped'?'cancelled':'running', stage:'execute', attemptId:'attempt', issueId:'issue' }
    const tx = {
      async query(sql: string) {
        commands.push(sql)
        if (sql.startsWith('SELECT "userId","botId","deviceId","agentDefinition"')) return { rows: [{ userId: 'owner', botId: null, deviceId: 'device', agentDefinition: null }] }
        if (sql.includes('WITH RECURSIVE')) return { rows: mode==='ordinary'?[]:mode==='multiple-tasks'?[task,task]:[task] }
        if (sql.includes('FROM factory_attempts WHERE')) return { rows: [{ runId:mode==='retry-unadopted'?'parent':'run', stage:'execute', status:'running' }] }
        if (sql.includes('SELECT "issueId"')) return { rows:[{ issueId:mode==='wrong-issue'?'other':'issue' }] }
        if (sql.startsWith('UPDATE agent_runs')) return { rows:[{ id:'run' }] }
        return { rows:[] }
      },
      release() { released=true },
    }
    const pool={ connect:async()=>tx } as unknown as Pool
    const claim=createExecutionClaim(pool,async()=>mode!=='access-removed')
    if (['ordinary','current'].includes(mode)) {
      assert.deepEqual(await claim('owner','device','run',new Date().toISOString()),[{id:'run'}])
      assert.ok(commands.includes('COMMIT'))
      assert.match(commands.find(sql=>sql.startsWith('UPDATE agent_runs'))!, /"stopRequestedAt" IS NULL/)
    } else {
      await assert.rejects(()=>claim('owner','device','run',new Date().toISOString()),FactoryError)
      assert.ok(commands.includes('ROLLBACK'))
      assert.ok(!commands.some(sql=>sql.startsWith('UPDATE agent_runs')))
    }
    assert.ok(released)
  })
}

for (const purpose of ['repository', 'report', 'deliverable'] as const) test(`Factory ${purpose} claim uses metadata from its locked repository read`, async () => {
  const calls: string[] = []
  const task = { id: 'task', userId: 'owner', botId: null, status: 'running', stage: 'execute', attemptId: 'attempt', issueId: 'issue', candidateId: null }
  const repo = purpose === 'deliverable' ? { remoteUrl: null, repoPath: '/home/user/.mikka/bot-workspaces/fixture' }
    : { remoteUrl: 'https://github.com/fixture/repository.git', repoPath: '/repo' }
  const tx = { query: async (sql: string) => {
    calls.push(sql)
    if (sql.includes('WITH RECURSIVE')) return { rows: [task] }
    if (sql.includes('FROM factory_attempts')) return { rows: [{ status: 'running', runId: 'run', candidateId: null }] }
    if (sql.includes('FROM agent_runs')) return { rows: [{ id: 'run', userId: 'owner', issueId: 'issue', botId: null, deviceId: 'device', deviceRepoId: 'repo', agentId: 'agent', status: 'queued', agentDefinition: { readOnly: purpose === 'report' } }] }
    if (sql.includes('FROM agents a')) {
      assert.ok(sql.includes('FOR SHARE OF a,repo,d'))
      return { rows: [{ id: 'agent', ...repo }], rowCount: 1 }
    }
    assert.fail('a claimed repository already has its metadata under the existing row lock')
  } } as unknown as PoolClient
  const store = { lockTask: async () => task } as unknown as Parameters<typeof createFactoryClaim>[0]
  const questions = { claimContinuation: async () => assert.fail('ordinary execution is not a question continuation') }
  const claim = createFactoryClaim(store, questions)
  assert.deepEqual(await claim(tx, 'owner', 'device', 'run', new Date().toISOString()), { preserveQuestionWorktree: true, factoryExecuteKind: purpose })
  assert.equal(calls.filter(sql => sql.includes('device_repos')).length, 1)
})

test('non-execute Factory claims retain the original authorization projection', async () => {
  for (const stage of ['spec', 'review', 'verify', 'monitor'] as const) {
    let authorizedReads = 0, checks = 0
    const task = { id: 'task', userId: 'owner', botId: null, status: 'running', stage, attemptId: 'attempt', issueId: 'issue', candidateId: null }
    const tx = { query: async (sql: string) => {
      if (sql.includes('WITH RECURSIVE')) return { rows: [task] }
      if (sql.includes('FROM factory_attempts')) return { rows: [{ status: 'running', runId: 'run', candidateId: null }] }
      if (sql.includes('FROM agent_runs')) return { rows: [{ id: 'run', userId: 'owner', issueId: 'issue', botId: null, deviceId: 'device', deviceRepoId: 'repo', agentId: 'agent', status: 'queued' }] }
      assert.match(sql, /^SELECT a\.id FROM agents a/)
      assert.ok(sql.includes('FOR SHARE OF a,repo,d'))
      assert.equal(sql.includes('"remoteUrl"') || sql.includes('"repoPath"'), false, `${stage} must not transfer execution-only repository metadata`)
      authorizedReads++
      return { rows: [{ id: 'agent' }], rowCount: 1 }
    } } as unknown as PoolClient
    const store = { lockTask: async () => task } as unknown as Parameters<typeof createFactoryClaim>[0]
    const questions = { claimContinuation: async () => assert.fail('this claim is not a question continuation') }
    const claim = createFactoryClaim(store, questions, async () => { checks++; return {} })
    assert.deepEqual(await claim(tx, 'owner', 'device', 'run', new Date().toISOString()), { preserveQuestionWorktree: true })
    assert.equal(authorizedReads, 1)
    assert.equal(checks, stage === 'spec' ? 0 : 1)
  }
})
