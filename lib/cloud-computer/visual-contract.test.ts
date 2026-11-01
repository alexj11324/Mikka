import test from 'node:test'
import assert from 'node:assert/strict'
import { browserPermission, browserMutationSchema, mutationFromStep } from './visual-contract'
import { browserLoginContinuation } from './login-result'

test('bots act without a human approval step by default: every effect, payment and sending included; an explicit ask is followed',()=>{
 for(const effect of ['browse','edit_draft','write_external','payment','sensitive_delete','security_change'] as const) {
  assert.equal(browserPermission(effect,'allow',{},{}),'allow')
  // An explicit ask the person or an admin set is followed, on either layer; it is never read as allow.
  assert.equal(browserPermission(effect,'allow',{[`browser_${effect}`]:'ask'},{}),'ask')
  assert.equal(browserPermission(effect,'allow',{},{[`browser_${effect}`]:'ask'}),'ask')
  // Deny on either layer still wins over ask.
  assert.equal(browserPermission(effect,'allow',{[`browser_${effect}`]:'ask'},{[`browser_${effect}`]:'deny'}),'deny')
 }
 assert.throws(()=>browserPermission('browse','allow',null,{}))
 assert.throws(()=>browserPermission('browse','allow',{},{browser_browse:'maybe'}))
})
test('deny stays enforced: a workspace computer deny, or an explicit deny for the effect on either layer',()=>{
 for(const effect of ['browse','edit_draft','write_external','payment','sensitive_delete','security_change'] as const) assert.equal(browserPermission(effect,'deny',{[`browser_${effect}`]:'allow'},{}),'deny')
 assert.equal(browserPermission('browse','allow',{browser_browse:'deny'},{}),'deny')
 assert.equal(browserPermission('payment','allow',{browser_payment:'allow'},{browser_payment:'deny'}),'deny')
 assert.equal(browserPermission('write_external','allow',{browser_payment:'deny'},{}),'allow')
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
