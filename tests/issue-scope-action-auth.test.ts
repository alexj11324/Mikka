import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createIssueForTeam, previewIssuePersonalScope, confirmIssuePersonalScope } from '../app/actions/issues'
import { runAction } from '../lib/action-error'
import { actAs } from '../lib/acting-user'
import { agentActor } from '../lib/activity-actor'

// The loader supplies a null session. This exercises authentication before any
// task or workspace query; it does not open a DB or mutate fixtures.
test('team creation and personal preview/confirmation serialize missing authentication', async () => {
  const id=randomUUID()
  const results=await Promise.all([
    createIssueForTeam({ requestId:randomUUID(), teamId:randomUUID(), title:'Task', content:{type:'doc',content:[]}, status:'todo', priority:'normal' }),
    previewIssuePersonalScope(id),
    confirmIssuePersonalScope({ id, revision:1, confirmation:'a'.repeat(64) }),
  ])
  for(const result of results) assert.deepEqual(result,{error:'authRequired',params:undefined})
})

test('unexpected failures still propagate through the action error boundary',async()=>{
  await assert.rejects(runAction(async()=>{throw new Error('unexpected failure')}),/unexpected failure/)
})

test('an internal acting context cannot impersonate a human team choice',async()=>{
  const input={requestId:randomUUID(),teamId:randomUUID(),title:'Task',content:{type:'doc',content:[]},status:'todo',priority:'normal'}
  assert.deepEqual(await actAs('synthetic-user',()=>createIssueForTeam(input)),{error:'teamIssueAccessDenied'})
  assert.deepEqual(await actAs('synthetic-user',()=>createIssueForTeam(input),agentActor(randomUUID())),{error:'teamIssueAccessDenied'})
})
