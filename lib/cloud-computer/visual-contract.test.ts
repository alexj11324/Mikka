import test from 'node:test'
import assert from 'node:assert/strict'
import { browserPermission, browserMutationSchema, mutationFromStep } from './visual-contract'
import { browserLoginContinuation } from './login-result'

test('ordinary authorized browser work is not a per-click approval, and effects retain their own policy',()=>{
 for(const computer of ['ask','allow'] as const) {
  assert.equal(browserPermission('browse',computer,{},{}),'allow')
  assert.equal(browserPermission('edit_draft',computer,{},{}),'allow')
  assert.equal(browserPermission('payment',computer,{},{}),'ask')
  assert.equal(browserPermission('write_external',computer,{browser_write_external:'allow'},{}),'allow')
  assert.equal(browserPermission('write_external',computer,{browser_write_external:'allow'},{browser_write_external:'deny'}),'deny')
 }
 for(const effect of ['browse','edit_draft','write_external','payment','sensitive_delete','security_change'] as const) assert.equal(browserPermission(effect,'deny',{browser_payment:'allow'},{}),'deny')
 assert.throws(()=>browserPermission('browse','allow',null,{}))
})
test('explicit scoped decisions narrow ordinary browsing even when computer use is allowed',()=>{
 assert.equal(browserPermission('browse','allow',{browser_browse:'deny'},{}),'deny')
 assert.equal(browserPermission('browse','allow',{}, {browser_browse:'ask'}),'ask')
 assert.equal(browserPermission('edit_draft','allow',{browser_edit_draft:'allow'},{browser_edit_draft:'deny'}),'deny')
 assert.equal(browserPermission('payment','allow',{}, {browser_payment:'allow'}),'ask')
})
test('visual actions admit bounded coordinates but no JavaScript, selectors or authority',()=>{
 assert.deepEqual(mutationFromStep({action:'click',x:20,y:30,step:'Open',summary:'Open the item'}),{action:'click',x:20,y:30})
 for(const value of [{action:'click',selector:'button'},{action:'click',x:-1,y:20},{action:'click',x:5,y:9,allow:true},{action:'type',text:'x',javascript:'alert(1)'},{action:'drag',x:0,y:0,toX:9000,toY:0}]) assert.equal(browserMutationSchema.safeParse(value).success,false)
})
test('login continuation resumes observation, never turns guarded or unknown results into success',()=>{
 for(const status of ['resumed','session_applied','submitted']) assert.equal(browserLoginContinuation(status),'running')
 assert.equal(browserLoginContinuation('guarded'),'guarded')
 for(const status of ['needs_login','outcome_unknown','failed','authenticated']) assert.equal(browserLoginContinuation(status),'needs_login')
})
