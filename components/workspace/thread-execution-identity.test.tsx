import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThreadExecutionEvidence } from '../../lib/thread-execution-identity-view'

mock.module('next-intl',{namedExports:{useTranslations:()=> (key:string)=>key}})
let Content: typeof import('./thread-execution-identity')['ThreadExecutionIdentityContent']
before(async()=>{({ThreadExecutionIdentityContent:Content}=await import('./thread-execution-identity'))})
const evidence:ThreadExecutionEvidence={id:'00000000-0000-4000-8000-000000000001',harness:'claude_code',model:'claude-test',credentialType:'subscription',subscriptionRoute:'claude_code_cli',
  executionIdentity:{version:1,requester:'requester',botId:null,botOwner:'bot-owner',executionPrincipal:'principal',workspaceId:'00000000-0000-4000-8000-000000000003',outputOwner:'output-owner',
    resourceBindings:[{kind:'subscription',id:'binding',ownerId:'model-payer',access:'workspace_share',revision:'3'}],
    billingAccount:{model:{kind:'subscription',ownerId:'model-payer',resourceId:'binding',amount:'provider_unknown'},runtime:{kind:'local_device',ownerId:'device-owner',resourceId:'device',amount:'not_applicable'}},personalResourcePolicy:'requester_only'}}

test('the frozen subscription route, distinct actors and unknown external billing are visible without a fabricated zero',()=>{
  const html=renderToStaticMarkup(<Content evidence={evidence} />)
  for(const value of [evidence.id,evidence.executionIdentity!.workspaceId!,'claude_code_cli','credentialKinds.subscription','requester','bot-owner','principal','output-owner','model-payer','device-owner','binding','device','access.workspace_share','amounts.provider_unknown','amounts.not_applicable'])assert.ok(html.includes(value),value)
  assert.match(html,/copyRunId/);assert.doesNotMatch(html,/\$0|0\.00|agentDefinition|apiKey/)
})

test('a legacy run displays its missing snapshot and never invents actors or billing from current settings',()=>{
  const html=renderToStaticMarkup(<Content evidence={{...evidence,credentialType:'unknown',subscriptionRoute:null,executionIdentity:null}} />)
  assert.match(html,/snapshotMissing/);assert.match(html,/credentialKinds.unknown/)
  assert.doesNotMatch(html,/model-payer|output-owner|amounts\.|claude_code_cli|access\.workspace_share/)
})

test('the frozen Agent 配置 words its selection reason in the reader\'s language; a pre-code English sentence shows no reason row, and no digest shows',()=>{
  const profile={profileId:'00000000-0000-4000-8000-000000000009',name:'Frontend',version:3,digest:'d'.repeat(64),source:'decision' as const}
  const coded=renderToStaticMarkup(<Content evidence={{...evidence,agentProfile:{...profile,reason:'stage_fit'}}} />)
  assert.match(coded,/selectionReasons\.stage_fit/)
  assert.doesNotMatch(coded,/d{64}|>digest</,'the configuration digest is not shown')
  const legacy=renderToStaticMarkup(<Content evidence={{...evidence,agentProfile:{...profile,reason:'Declared capabilities fit the task.'}}} />)
  assert.doesNotMatch(legacy,/selectionReason/,'选择方式 already says it; a second 「按任务能力选择」 would repeat it')
  assert.match(legacy,/selectionSources\.decision/)
  assert.doesNotMatch(legacy,/Declared capabilities/)
})
