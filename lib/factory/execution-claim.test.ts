import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { withFactoryQuestionDeliveryContext } from './questions/continuation-delivery-context'
import type { Pool, PoolClient } from 'pg'
import { createExecutionClaim } from '../../tests/helpers/factory-execution-claim'
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


describe('Factory native question publication context', () => {
  const issueId = '11111111-1111-4111-8111-111111111111';
  const claim = {
    questionId: '22222222-2222-4222-8222-222222222222',
    requireSessionResume: true,
    continuesRunId: '33333333-3333-4333-8333-333333333333',
    resumeSessionId: 'retained-native-session',
    followUp: 'Accepted human answer. Continue the same task; do not repeat this permission question.',
    preserveQuestionWorktree: true,
  };
  const context = {
    issueId,
    kind: 'implement',
    readOnly: false,
    gitPush: 'allow',
    repository: 'example/project',
    branch: 'mikka/f1503-13',
    baseBranch: 'main',
  };

  test('same-session answer receives the admitted branch, remote and canonical PR marker', () => {
    const result = withFactoryQuestionDeliveryContext(claim, context);
    const followUp = String(result.followUp);
    assert.ok(followUp.startsWith(claim.followUp + '\n\n'));
    assert.match(followUp, /https:\/\/github\.com\/example\/project/);
    assert.match(followUp, /"taskBranch":"mikka\/f1503-13"/);
    assert.ok(followUp.includes(`<!-- mikka-issue:${issueId} -->`));
    assert.match(followUp, /"baseBranch":"main"/);
    assert.equal(result.questionId, claim.questionId);
    assert.equal(result.resumeSessionId, claim.resumeSessionId);
    assert.equal(result.continuesRunId, claim.continuesRunId);
    assert.equal(result.requireSessionResume, true);
    assert.equal(result.preserveQuestionWorktree, true);
    assert.equal(claim.followUp.includes('mikka/f1503-13'), false);
  });

  test('fix continuation receives the same publication destination without replaying a task prompt', () => {
    const supplied = { ...context, kind: 'fix', prompt: 'ORIGINAL_TASK_MUST_NOT_BE_REPLAYED',
      token: 'TOKEN_MUST_NOT_BE_COPIED', nativeSessionId: 'SID_MUST_NOT_BE_COPIED' };
    const followUp = String(withFactoryQuestionDeliveryContext(claim, supplied).followUp);
    for (const forbidden of ['ORIGINAL_TASK_MUST_NOT_BE_REPLAYED', 'TOKEN_MUST_NOT_BE_COPIED',
      'SID_MUST_NOT_BE_COPIED', claim.resumeSessionId]) assert.equal(followUp.includes(forbidden), false);
    assert.equal(followUp.split(claim.followUp).length - 1, 1);
  });

  test('the final read-only and git-push policy each withhold the publication context', () => {
    assert.equal(withFactoryQuestionDeliveryContext(claim, { ...context, readOnly: true }), claim);
    for (const gitPush of ['deny', 'ask', undefined])
      assert.equal(withFactoryQuestionDeliveryContext(claim, { ...context, gitPush }), claim);
  });

  test('planning, review and other non-execution stages are unchanged', () => {
    for (const kind of ['plan', 'review', 'verify', 'report'])
      assert.equal(withFactoryQuestionDeliveryContext(claim, { ...context, kind }), claim);
  });

  test('ordinary continuation and missing Factory question identities are unchanged', () => {
    const generic = { ...claim, requireSessionResume: false };
    assert.equal(withFactoryQuestionDeliveryContext(generic, context), generic);
    const withoutQuestion = { ...claim, questionId: undefined };
    assert.equal(withFactoryQuestionDeliveryContext(withoutQuestion, context), withoutQuestion);
    const withoutAnswer = { ...claim, followUp: undefined };
    assert.equal(withFactoryQuestionDeliveryContext(withoutAnswer, context), withoutAnswer);
  });

  test('a missing publication never invents a branch or repository', () => {
    for (const branch of [undefined, ''])
      assert.equal(withFactoryQuestionDeliveryContext(claim, { ...context, branch }), claim);
    for (const repository of [undefined, '', 'https://user:token@github.com/example/project'])
      assert.equal(withFactoryQuestionDeliveryContext(claim, { ...context, repository }), claim);
  });

  test('re-applying the response decoration does not duplicate delivery context', () => {
    const once = withFactoryQuestionDeliveryContext(claim, context);
    assert.equal(withFactoryQuestionDeliveryContext(once, context), once);
    const admitted = withFactoryQuestionDeliveryContext(claim, { ...context, branch: 'already-admitted/task-branch' });
    assert.ok(String(admitted.followUp).includes('already-admitted/task-branch'));
  });

});
