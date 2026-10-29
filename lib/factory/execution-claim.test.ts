import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { createExecutionClaim } from './execution-claim'
import { FactoryError } from './contract'

for (const mode of ['ordinary', 'current', 'stopped', 'retry-unadopted', 'foreign-owner', 'access-removed', 'wrong-issue', 'multiple-tasks']) {
  test(`execution claim fence: ${mode}`, async () => {
    const commands: string[] = []
    let released = false
    const task = { id:'task', userId:mode==='foreign-owner'?'other':'owner', status:mode==='stopped'?'cancelled':'running', stage:'execute', attemptId:'attempt', issueId:'issue' }
    const tx = {
      async query(sql: string) {
        commands.push(sql)
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
