import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThreadExecutionEvidence } from '../../lib/thread-execution-identity-view'

mock.module('next-intl',{namedExports:{useTranslations:()=> (key:string,params?:Record<string,unknown>)=>params?`${key}(${Object.values(params).join('|')})`:key}})
let Content: typeof import('./thread-execution-identity')['ThreadExecutionIdentityContent']
before(async()=>{({ThreadExecutionIdentityContent:Content}=await import('./thread-execution-identity'))})
const evidence:ThreadExecutionEvidence={id:'00000000-0000-4000-8000-000000000001',harness:'claude_code',model:'claude-test',credentialType:'subscription',subscriptionRoute:'claude_code_cli',
  executionIdentity:{version:1,requester:'requester',botId:null,botOwner:'bot-owner',executionPrincipal:'principal',workspaceId:'00000000-0000-4000-8000-000000000003',outputOwner:'output-owner',
    resourceBindings:[{kind:'subscription',id:'binding',ownerId:'model-payer',access:'workspace_share',revision:'3'}],
    billingAccount:{model:{kind:'subscription',ownerId:'model-payer',resourceId:'binding',amount:'provider_unknown'},runtime:{kind:'local_device',ownerId:'device-owner',resourceId:'device',amount:'not_applicable'}},personalResourcePolicy:'requester_only'}}

const labels={workspace:{name:'Alex 的工作区'},people:{requester:{name:'Alex',image:null,you:true},'bot-owner':{name:'Bob Chen',image:null,you:false},principal:{name:'Alex',image:null,you:true},'output-owner':{name:'Alex',image:null,you:true},'model-payer':{name:'Alex',image:null,you:true},'device-owner':{name:'Bob Chen',image:null,you:false}},
  devices:{device:{name:'Bob 的 Mac mini',kind:'laptop' as const}},subscriptions:{binding:{provider:'claude' as const,account:'alex@example.com',mine:true}},apiKeys:{},mcp:{},e2b:null}

test('people, machines and accounts read by name; raw references stay out of the dialog and go into the diagnostics copy',()=>{
  const html=renderToStaticMarkup(<Content evidence={{...evidence,labels}} />)
  for(const value of ['Alex 的工作区','Bob Chen','Bob 的 Mac mini','alex@example.com','shared','costSentence','copyDiagnostics','roles.botOwner'])assert.ok(html.includes(value),value)
  // The run id stays a DOM attribute for the stale-response guard; it is never text.
  const visible=html.replace(/data-execution-evidence-run="[^"]*"/,'')
  for(const value of [evidence.id,evidence.executionIdentity!.workspaceId!,'model-payer','device-owner','output-owner','binding','claude_code_cli'])assert.ok(!visible.includes(value),value)
  assert.doesNotMatch(html,/\$0|0\.00|agentDefinition|apiKey"/)
})

test('one person in several roles is one row naming the roles',()=>{
  const identity={...evidence.executionIdentity!,requester:'alex',executionPrincipal:'alex',outputOwner:'alex',botOwner:'bob'}
  const people={alex:{name:'Alex',image:null,you:true},bob:{name:'Bob Chen',image:null,you:false}}
  const html=renderToStaticMarkup(<Content evidence={{...evidence,executionIdentity:identity,labels:{...labels,people}}} />)
  // requester, principal and output owner are Alex; bot owner is Bob: two rows, Alex's names the three roles.
  assert.equal(html.match(/rolesTogether/g)?.length,1)
  assert.match(html,/roles\.requester/)
  assert.match(html,/roleSeparator/)
})

test('a legacy run displays its missing snapshot and never invents actors or billing from current settings',()=>{
  const html=renderToStaticMarkup(<Content evidence={{...evidence,credentialType:'unknown',subscriptionRoute:null,executionIdentity:null}} />)
  assert.match(html,/snapshotMissing/)
  assert.doesNotMatch(html,/costSentence|roles\.|resources/)
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

test('configured Skills are listed separately from the ones the run actually loaded', () => {
  const agentProfile = { profileId: '00000000-0000-4000-8000-000000000009', name: 'Reviewer', version: 1, digest: 'd'.repeat(64), source: 'explicit' as const, reason: 'explicit' }
  const configuredSkills = [
    { id: 'independent-review', name: 'Independent review', version: 1, digest: 'a'.repeat(64), source: 'official' as const },
    { id: 'personal:00000000-0000-4000-8000-000000000010', name: 'Deploy check', version: 1, digest: 'b'.repeat(64), source: 'personal' as const },
  ]
  const loadedSkills = [{ id: 'official:independent-review', name: 'Independent review', source: 'official' as const, digest: 'a'.repeat(64), loadedAt: '2026-11-10T00:00:00.000Z' }]
  const html = renderToStaticMarkup(<Content evidence={{ ...evidence, agentProfile, configuredSkills, loadedSkills }} />)
  for (const value of ['Independent review', 'Deploy check', 'skillSources.official', 'skillSources.personal']) assert.ok(html.includes(value), value)
  // A configured Skill without a daemon receipt is not claimed as used.
  assert.equal(html.match(/skillLoaded/g)?.length, 1)
  assert.equal(html.match(/skillNotLoaded/g)?.length, 1)
  assert.doesNotMatch(html, /00000000-0000-4000-8000-000000000010/)
})

test('a run without Profile Skills shows the empty state, not an invented list', () => {
  const agentProfile = { profileId: '00000000-0000-4000-8000-000000000009', name: 'Reviewer', version: 1, digest: 'd'.repeat(64), source: 'decision' as const, reason: 'stage_fit' }
  const html = renderToStaticMarkup(<Content evidence={{ ...evidence, agentProfile, configuredSkills: null, loadedSkills: null }} />)
  assert.match(html, /skillsNone/)
  assert.doesNotMatch(html, /skillLoaded|skillNotLoaded/)
})


test('the judged model strength, selected model, effort and reason are visible independently of the run model', () => {
  const html = renderToStaticMarkup(<Content evidence={{ ...evidence, modelRouting: {
    version: 2, required: 'light', model: 'gpt-6-luna', harness: 'codex', tier: 'light', effort: 'low', reason: 'difficulty_fit',
  } }} />)
  for (const value of ['modelRouting', 'routingTier.light', 'gpt-6-luna', 'routingEffort.low', 'routingReasons.difficulty_fit', 'data-model-routing="difficulty_fit"']) assert.ok(html.includes(value), value)
  assert.doesNotMatch(html, /previousModel|routingDifficulty/)
})

test('a frozen version-1 difficulty still renders as it was recorded', () => {
  const html = renderToStaticMarkup(<Content evidence={{ ...evidence, modelRouting: {
    version: 1, difficulty: 'easy', model: 'gpt-6-luna', harness: 'codex', tier: 'light', effort: 'low', reason: 'difficulty_fit',
  } }} />)
  assert.ok(html.includes('routingDifficulty.easy'))
  const unknown = renderToStaticMarkup(<Content evidence={{ ...evidence, modelRouting: {
    version: 1, difficulty: 'unknown', model: 'gpt-6.1-sol', harness: 'codex', tier: 'strongest', reason: 'low_confidence',
  } }} />)
  assert.doesNotMatch(unknown, /routingDifficulty|→/)
})

test('routing fallback and escalation reasons are localized, with no unjudged label and no invented effort', () => {
  const reasons = ['list_order', 'low_confidence', 'decision_unavailable', 'invalid_answer', 'no_selection', 'escalated'] as const
  for (const reason of reasons) {
    const html = renderToStaticMarkup(<Content evidence={{ ...evidence, modelRouting: {
      version: 2, required: 'unknown', model: 'gpt-6.1-sol', harness: 'codex', tier: 'strongest', reason,
      ...(reason === 'escalated' ? { previousModel: 'gpt-6-luna' } : {}),
    } }} />)
    assert.doesNotMatch(html, /routingTier|routingDifficulty|→/)
    assert.ok(html.includes(`routingReasons.${reason}`))
    assert.doesNotMatch(html, /routingEffort\./)
    if (reason === 'escalated') {
      assert.match(html, /previousModel/)
      assert.match(html, /gpt-6-luna/)
    }
  }
})

test('legacy evidence never shows a made-up routing decision', () => {
  for (const modelRouting of [undefined, null]) {
    const html = renderToStaticMarkup(<Content evidence={{ ...evidence, modelRouting }} />)
    assert.doesNotMatch(html, /data-model-routing|routingTier|routingDifficulty|routingEffort|routingReason/)
  }
})
