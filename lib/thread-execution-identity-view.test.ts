import assert from 'node:assert/strict'
import test from 'node:test'
import { currentThreadExecutionEvidence, readThreadExecutionEvidence, threadExecutionEvidence } from './thread-execution-identity-view'

const runId='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002'
const host = () => ({ run: { id:runId,harness:'claude_code',model:'claude-test',credentialType:'subscription',subscriptionRoute:'claude_code_cli',
  executionIdentity:{version:1,requester:'requester',botId:other,botOwner:'bot-owner',executionPrincipal:'requester',workspaceId:other,outputOwner:'requester',
    resourceBindings:[{kind:'subscription',id:'binding',ownerId:'payer',access:'workspace_share',revision:'3',token:'PRIVATE_TOKEN'}],
    billingAccount:{model:{kind:'subscription',ownerId:'payer',resourceId:'binding',amount:'provider_unknown'},runtime:{kind:'local_device',ownerId:'requester',resourceId:'device',amount:'not_applicable'}},
    personalResourcePolicy:'requester_only',privatePrompt:'PRIVATE_PROMPT'},agentDefinition:{secret:'PRIVATE_CREDENTIAL'} },
  artifacts:[{url:'https://private.invalid'}],captures:[] })

test('the existing owner response is reduced to frozen display metadata, with unknown external cost and distinct payer',()=>{
  const value=threadExecutionEvidence(host(),runId)
  assert.equal(value.credentialType,'subscription');assert.equal(value.subscriptionRoute,'claude_code_cli')
  assert.equal(value.executionIdentity?.billingAccount.model.ownerId,'payer')
  assert.equal(value.executionIdentity?.billingAccount.model.amount,'provider_unknown')
  assert.equal(value.executionIdentity?.requester,'requester')
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE|private\.invalid|agentDefinition|token|artifacts|captures/)
  const legacy=threadExecutionEvidence({run:{...host().run,executionIdentity:null,credentialType:'unknown',subscriptionRoute:null}},runId)
  assert.equal(legacy.executionIdentity,null);assert.equal(legacy.credentialType,'unknown')
})

test('wrong-run evidence is rejected and a late old-run response can never be selected for the new run',async()=>{
  await assert.rejects(readThreadExecutionEvidence(runId,async(_url,options)=>{
    assert.equal(options?.method,'GET');assert.equal(options?.credentials,'same-origin');assert.equal(options?.cache,'no-store');assert.equal(options?.redirect,'error')
    return Response.json({run:{...host().run,id:other}})
  }),/thread_execution_evidence_unavailable/)
  let resolve!: (response:Response)=>void
  const pending=readThreadExecutionEvidence(runId,async()=>new Promise<Response>(done=>{resolve=done}))
  const selectedRun=other
  assert.equal(currentThreadExecutionEvidence(undefined,selectedRun),null)
  resolve(Response.json(host()))
  const old=await pending
  assert.equal(currentThreadExecutionEvidence(old,selectedRun),null)
  assert.equal(currentThreadExecutionEvidence(old,runId)?.id,runId)
  await assert.rejects(readThreadExecutionEvidence(runId,async()=>Response.json({error:'PRIVATE_BODY'},{status:404})),error=>{
    assert.equal((error as Error).message,'thread_execution_evidence_unavailable');return true
  })
})
