import test from 'node:test'
import assert from 'node:assert/strict'
import { browserPermission, browserMutationSchema, mutationFromStep } from './visual-contract'
import { browserLoginContinuation } from './login-result'

test('bots act without a human approval step: every effect, payment and sending included, is allowed by default',()=>{
 for(const effect of ['browse','edit_draft','write_external','payment','sensitive_delete','security_change'] as const) {
  assert.equal(browserPermission(effect,'allow',{},{}),'allow')
  // A stored 'ask' (retired per-step approval) is never a human gate.
  assert.equal(browserPermission(effect,'allow',{[`browser_${effect}`]:'ask'},{[`browser_${effect}`]:'ask'}),'allow')
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
test('the browser ask migration turns stored ask into allow and touches nothing else',async()=>{
 const {readFile}=await import('node:fs/promises')
 const sql=await readFile(new URL('../../drizzle/20261101191000_browser_ask_retired.sql',import.meta.url),'utf8')
 for(const table of ['agent_kit_heads','workspace_computer_policies']) assert.match(sql,new RegExp(`UPDATE ${table}`))
 assert.match(sql,/key LIKE 'browser\\_%' AND e\.value = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e\.value END/)
 assert.doesNotMatch(sql,/'"deny"'/)
})
