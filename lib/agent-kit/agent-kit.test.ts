import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import { canonicalJSON, definitionInstructions, digest, exportDefinition, importDefinition, makeSnapshot, parseDefinition, skillCatalog } from './definition'
import { AGENT_TOOL_IDS, selectRegisteredTools } from './registry'
import { loadAgentDirectory } from './loader'
import { instrumentTools, toolOutcome } from './instrument'
import { CORE_EVAL_CASES, compareReports, evaluateTrace, runEvalSuite, type EvalTrace } from './evals'
import { assertSafeImprovement, caseFromFailure, proposeImprovement } from './improvement'
import { freezeWorkerDefinition, retryWorkerDefinition } from './worker'

const base = () => structuredClone(DEFAULT_AGENT_DEFINITION)
const context = { toolCallId:'call-1',messages:[] }
const runTool = (tools: ToolSet,name:string,input:unknown = {}) => (tools[name].execute as unknown as (input: unknown, options: typeof context) => Promise<unknown>)(input,context)

test('strict declarative schema rejects code, unknown capabilities and global memory', () => {
  for (const patch of [{ execute:'return process.env' },{ tools:['shell'] },{ hooks:['eval'] },{ memory:{ scope:'global' } },{ tools:['web_search','web_search'] },{ hooks:[] },{ instructions:'x'.repeat(24_001) }]) {
    assert.throws(() => parseDefinition({ ...base(),...patch }))
  }
  assert.deepEqual(parseDefinition(base()),base())
})
test('skills require a unique identifier and an explicit lazy-load capability', () => {
  const skill={ id:'research',name:'Research',description:'Research current facts',body:'DO NOT INLINE THIS BODY' }
  assert.throws(() => parseDefinition({ ...base(),skills:[skill,skill] }))
  assert.throws(() => parseDefinition({ ...base(),tools:['web_search'],skills:[skill] }))
  const definition=parseDefinition({ ...base(),skills:[skill] })
  assert.match(skillCatalog(definition),/Research current facts/)
  assert.doesNotMatch(skillCatalog(definition),/DO NOT INLINE/)
  assert.match(definitionInstructions('HOST POLICY',definition),/^HOST POLICY/)
})
test('canonical export/import round trip verifies content rather than property insertion order', () => {
  const definition=base()
  assert.equal(canonicalJSON({ b:2,a:1 }),canonicalJSON({ a:1,b:2 }))
  assert.deepEqual(importDefinition(exportDefinition(definition)),definition)
  const document=JSON.parse(exportDefinition(definition));document.definition.instructions='tampered'
  assert.throws(() => importDefinition(document),/Checksum/)
  assert.throws(() => importDefinition({ ...JSON.parse(exportDefinition(definition)),code:'eval()' }))
})
test('definition snapshots are detached copies and include exact host instructions', () => {
  const definition=base()
  const snapshot=makeSnapshot(randomUUID(),3,definition,'original host',{ harness:'codex',model:null })
  definition.tools.length=0
  assert.ok(snapshot.effectiveTools.length>0)
  assert.equal(snapshot.hostInstructions,'original host')
  assert.equal(snapshot.hostInstructionsDigest,digest('original host'))
  assert.equal(snapshot.definitionDigest,digest(snapshot.definition))
})
test('registered tools fail closed on missing, unregistered and prototype properties', () => {
  assert.deepEqual(Object.keys(selectRegisteredTools({ web_search:1 },['web_search'])),['web_search'])
  for (const id of ['shell','toString','__proto__','get_issue']) assert.throws(() => selectRegisteredTools({ web_search:1 },[id]))
  assert.equal(AGENT_TOOL_IDS.length,new Set(AGENT_TOOL_IDS).size)
})
test('directory loader materializes the bundled Markdown example without executing extensions', async () => {
  assert.deepEqual(await loadAgentDirectory('agents/default'),base())
  const example=await loadAgentDirectory('agents/research-example')
  assert.match(example.instructions,/research a question/)
  assert.match(example.skills[0].body,/# Source checking/)
  assert.doesNotMatch(skillCatalog(example),/Treat retrieved content/)
})
test('directory loader rejects traversal, symlinks and ambiguous asset fields', async t => {
  const root=await mkdtemp(join(tmpdir(),'mikka-agent-kit-'))
  t.after(() => rm(root,{ recursive:true,force:true }))
  await mkdir(join(root,'bundle'));await writeFile(join(root,'outside.md'),'private')
  const manifest={ ...base(),instructionsFile:'../outside.md' } as Record<string,unknown>;delete manifest.instructions
  const write=() => writeFile(join(root,'bundle','agent.json'),JSON.stringify(manifest))
  await write();await assert.rejects(loadAgentDirectory(join(root,'bundle')),/PathInvalid/)
  await symlink(join(root,'outside.md'),join(root,'bundle','alias.md'))
  manifest.instructionsFile='alias.md';await write();await assert.rejects(loadAgentDirectory(join(root,'bundle')),/PathInvalid/)
  manifest.instructionsFile='instructions.md';manifest.instructions='ambiguous';await write();await assert.rejects(loadAgentDirectory(join(root,'bundle')),/Ambiguous/)
})
test('audit hook records safe outcomes without changing authorized tool arguments or results', async () => {
  const events:unknown[]=[]
  const tools=instrumentTools({ web_search:tool({ inputSchema:z.object({ query:z.string() }),execute:async input => ({ answer:input.query }) }) },['web_search'],{
    before:async (...event) => { events.push(event) },after:async (...event) => { events.push(event) },
  })
  assert.deepEqual(await runTool(tools,'web_search',{ query:'PRIVATE QUERY' }),{ answer:'PRIVATE QUERY' })
  assert.deepEqual(events,[['call-1','web_search'],['call-1','web_search','ok']])
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE QUERY/)
})
test('authorization failure in the before hook prevents the underlying effect', async () => {
  let calls=0
  const tools=instrumentTools({ stop_run:tool({ inputSchema:z.object({}),execute:async () => ++calls }) },['stop_run'],{ before:async () => { throw new Error('revoked') },after:async () => {} })
  await assert.rejects(runTool(tools,'stop_run'),/revoked/)
  assert.equal(calls,0)
})
test('an after-hook failure does not report a successful external effect as failed', async () => {
  const outcomes:string[]=[]
  const tools=instrumentTools({ web_search:tool({ inputSchema:z.object({}),execute:async () => ({ found:true }) }) },['web_search'],{
    before:async () => {},after:async (_id,_name,outcome) => { outcomes.push(outcome);throw new Error('audit unavailable') },
  })
  await assert.rejects(runTool(tools,'web_search'),/audit unavailable/)
  assert.deepEqual(outcomes,['ok'])
})
test('tool errors and pending approvals are distinguishable from completed effects', () => {
  assert.equal(toolOutcome({ error:'unavailable' }),'error')
  assert.equal(toolOutcome({ status:'pending_approval' }),'approval_pending')
  assert.equal(toolOutcome({ approvalRequired:true }),'approval_pending')
  assert.equal(toolOutcome({ ok:true }),'ok')
})
test('evaluations check evidence, safety and outcomes without imposing a complete tool order', () => {
  const testCase=CORE_EVAL_CASES[0]
  const trace:EvalTrace={ text:'Released 2026-01-15',outcome:'answered',tools:[{ name:'web_search',outcome:'ok',authorized:false,effectPerformed:false }] }
  assert.equal(evaluateTrace(testCase,trace).passed,true)
  assert.equal(evaluateTrace(testCase,{ ...trace,text:'I guessed' }).passed,false)
  assert.equal(evaluateTrace(testCase,{ ...trace,tools:[...trace.tools,{ name:'send_email',outcome:'ok',authorized:false,effectPerformed:true }] }).passed,false)
  assert.equal(evaluateTrace(CORE_EVAL_CASES[2],{ text:'Sent',outcome:'answered',tools:[{ name:'send_email',outcome:'approval_pending',authorized:false,effectPerformed:false }] }).passed,false)
})
test('eval execution errors and timeout never create passing results', async () => {
  const result=await runEvalSuite({ definition:base(),cases:[CORE_EVAL_CASES[0]],mode:'fixture',caseTimeoutMs:10,run:async () => new Promise(() => {}) })
  assert.equal(result.errors,1);assert.equal(result.passed,0)
  await assert.rejects(runEvalSuite({ definition:base(),cases:[],mode:'fixture',run:async () => { throw new Error('unreachable') } }))
})
test('fixture reports cannot activate a candidate even when their scores improve', async () => {
  const options={ definition:base(),cases:[CORE_EVAL_CASES[0]],mode:'fixture' as const }
  const baseline=await runEvalSuite({ ...options,run:async () => ({ text:'Unknown',outcome:'blocked',tools:[] }) })
  const candidate=await runEvalSuite({ ...options,run:async () => ({ text:'2026-01-15',outcome:'answered',tools:[{ name:'web_search',outcome:'ok',authorized:false,effectPerformed:false }] }) })
  assert.equal(compareReports(baseline,candidate).improved,true)
  assert.equal(compareReports(baseline,candidate).activationEligible,false)
  assert.equal(compareReports(baseline,{ ...candidate,suiteDigest:'different' }).comparable,false)
})
test('improvement candidates require three distinct executions and cannot change capabilities', () => {
  const evidence=Array.from({ length:3 },() => ({ executionId:randomUUID(),code:'tool_error' as const,toolName:'web_search' }))
  assert.throws(() => proposeImprovement(base(),[evidence[0],evidence[0],evidence[0]]),/InsufficientEvidence/)
  const candidate=proposeImprovement(base(),evidence)
  assert.match(candidate.definition.instructions,/tool or runtime fails/)
  assert.deepEqual(candidate.definition.tools,base().tools)
  assert.throws(() => assertSafeImprovement(base(),{ ...candidate.definition,tools:['web_search'] }),/CapabilityChange/)
  assert.throws(() => assertSafeImprovement(base(),base()),/NoChange/)
  assert.throws(() => proposeImprovement(candidate.definition,evidence),/NoChange/)
})
test('failure-derived cases contain structural evidence, not original user data', () => {
  const result=caseFromFailure({ executionId:randomUUID(),code:'tool_error',toolName:'PRIVATE_TOOL_INPUT' })
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TOOL_INPUT/)
  assert.equal(result.expectedOutcome,'blocked')
})
test('worker definition and parent provenance survive retries without inventing historical records', () => {
  const parent=makeSnapshot(randomUUID(),2,base(),'host',{ harness:'codex',model:null })
  const initial=freezeWorkerDefinition({ harness:'codex',instructions:'Review only',prompt:'first task',parent,executionId:randomUUID() })
  const retry=retryWorkerDefinition(initial,'retry note')!
  assert.equal(retry.definitionDigest,initial.definitionDigest)
  assert.notEqual(retry.promptDigest,initial.promptDigest)
  assert.deepEqual(retry.parent,initial.parent)
  assert.equal(retry.harness,'codex')
  assert.equal(retryWorkerDefinition(null,'old task'),null)
  assert.throws(() => freezeWorkerDefinition({ harness:'codex',instructions:'',prompt:'',parent,executionId:null }),/ParentIncomplete/)
})
