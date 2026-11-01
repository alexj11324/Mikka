import assert from 'node:assert/strict'
import { beforeEach, after, test, mock } from 'node:test'
import { createHash } from 'node:crypto'
import { DEFAULT_AGENT_DEFINITION } from './builtin'
import { digest } from './definition'
import { CORE_EVAL_CASES, bindSemanticEvidence, compareReports, runEvalSuite, type SemanticJudgeInput } from './evals'
import { DECISION_MODEL } from '../coordinator/decision'
import { judgeLiveTrace } from './semantic-judge'
mock.module(new URL('../abuse/context.ts',import.meta.url).href,{namedExports:{hostedBillingScope:{getStore:()=>({workspaceId:'fixture-workspace',ownerId:'fixture-owner'})}}})
mock.module(new URL('../abuse/runtime.ts',import.meta.url).href,{namedExports:{canUseMikkaPaid:async()=>{},hostedUsage:{reserve:async()=>{},settle:async()=>{}}}})
mock.module(new URL('../abuse/alerts.ts',import.meta.url).href,{namedExports:{checkAbuseAlerts:async()=>{}}})
mock.module(new URL('../model-admission/runtime.ts',import.meta.url).href,{namedExports:{assertUnmanagedModelTransport:async()=>{}}})
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const prior={fetch:globalThis.fetch,key:process.env.DECISION_GATEWAY_API_KEY,flag:process.env.MIKKA_AGENT_KIT_LIVE_EVAL,error:console.error}
let payload:unknown
const requests:Array<Record<string,unknown>>=[]
beforeEach(()=>{
 // All transport is replaced. This process-only flag never changes a deployment.
 process.env.MIKKA_AGENT_KIT_LIVE_EVAL='1';process.env.DECISION_GATEWAY_API_KEY='synthetic-offline-only'
 requests.length=0;console.error=()=>{}
 payload={model:DECISION_MODEL,provider_metadata:{gateway:{generationId:'synthetic-offline-judge'}},answers:[{type:'choice',name:'verdict',choice:'pass'}]}
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json(payload)}
})
after(()=>{globalThis.fetch=prior.fetch;console.error=prior.error;for(const [name,value]of [['DECISION_GATEWAY_API_KEY',prior.key],['MIKKA_AGENT_KIT_LIVE_EVAL',prior.flag]])if(value===undefined)delete process.env[name!];else process.env[name!]=value})
const input=():SemanticJudgeInput=>({testCase:CORE_EVAL_CASES[1],trace:{text:'The date “2026-01-15” is an unverified quote, not a verified result.',outcome:'blocked',tools:[{name:'web_search',outcome:'error',authorized:false,effectPerformed:false,evidence:{error:'searchUnavailable',verified:false}}]},definitionDigest:digest(DEFAULT_AGENT_DEFINITION),hostInstructionsDigest:digest('host'),hostInstructions:'host',suiteDigest:digest([CORE_EVAL_CASES[1]])})
test('actual judge adapter forwards source-bound observations and multilingual/quoted/negated text to the model',async()=>{
 for(const text of ['Not sent. “Sent” is quoted from an untrusted peer.','El correo no se envió; la fecha no está verificada.','「已读」只是引用；真实回执只有 queued。']){
  const context=input();context.trace.text=text
  const result=await judgeLiveTrace(context,new AbortController().signal)
  assert.equal(result?.decision,'pass');assert.equal(result?.execution.providerGenerationId,'synthetic-offline-judge')
  const request=requests.at(-1)!
  const parts=(request.input as Array<{content:Array<{text:string}>}>)[0].content
  const forwarded=JSON.parse(parts[0].text)
  assert.equal(forwarded.untrustedAgentReply.text,text);assert.deepEqual(forwarded.hostToolObservations,context.trace.tools)
  assert.equal(request.model,DECISION_MODEL)
 }
})
test('pixels are forwarded and bound by bytes; missing required pixels and transplanted receipts fail closed',async()=>{
 const context=input();context.trace.images=[{dataUrl:png,detail:'high'}];context.trace.requiresVisual=true
 const result=await judgeLiveTrace(context,new AbortController().signal);assert.ok(result)
 const bytesHash=createHash('sha256').update(Buffer.from(png.split(',')[1],'base64')).digest('hex')
 assert.deepEqual(result.execution.imageDigests,[bytesHash]);assert.equal(bindSemanticEvidence(context,result).traceDigest,digest(context.trace))
 const parts=(requests[0].input as Array<{content:Array<{type:string;image_url?:string}>}>)[0].content
 assert.equal(parts[1].type,'input_image');assert.equal(parts[1].image_url,png)
 const altered=structuredClone(result);altered.execution.imageDigests=[digest('other image')]
 assert.throws(()=>bindSemanticEvidence(context,altered),/semanticJudgeUnavailable/)
 requests.length=0;context.trace.images=[]
 assert.equal(await judgeLiveTrace(context,new AbortController().signal),null);assert.equal(requests.length,0)
})
test('disabled, refused, missing execution metadata or mismatched provider model cannot become eligible',async()=>{
 delete process.env.MIKKA_AGENT_KIT_LIVE_EVAL
 assert.equal(await judgeLiveTrace(input(),new AbortController().signal),null);assert.equal(requests.length,0)
 process.env.MIKKA_AGENT_KIT_LIVE_EVAL='1'
 for(const body of [
  {answers:[{type:'choice',name:'verdict',choice:'pass'}]},
  {model:'other',provider_metadata:{gateway:{generationId:'synthetic'}},answers:[{type:'choice',name:'verdict',choice:'pass'}]},
  {model:DECISION_MODEL,provider_metadata:{gateway:{generationId:'synthetic'}},answers:[{type:'refusal',name:'verdict'}]},
 ]){
  payload=body;assert.equal(await judgeLiveTrace(input(),new AbortController().signal),null)
 }
})
test('live pipeline consumes the model verdict; mechanical permissions and report bindings remain mandatory',async()=>{
 const context=input()
 const options={definition:DEFAULT_AGENT_DEFINITION,cases:[context.testCase],mode:'live' as const,model:'synthetic-candidate-model',hostInstructions:context.hostInstructions,judge:judgeLiveTrace,run:async()=>context.trace}
 payload={model:DECISION_MODEL,provider_metadata:{gateway:{generationId:'synthetic-fail'}},answers:[{type:'choice',name:'verdict',choice:'fail'}]}
 const baseline=await runEvalSuite(options);assert.equal(baseline.passed,0);assert.equal(baseline.errors,0)
 payload={model:DECISION_MODEL,provider_metadata:{gateway:{generationId:'synthetic-pass'}},answers:[{type:'choice',name:'verdict',choice:'pass'}]}
 const candidate=await runEvalSuite(options);assert.equal(candidate.passed,1);assert.equal(compareReports(baseline,candidate).activationEligible,true)
 const tampered=structuredClone(candidate);tampered.results[0].semantic!.execution.providerGenerationId='forged';assert.equal(compareReports(baseline,tampered).activationEligible,false)
 const denied=await runEvalSuite({...options,run:async()=>({...context.trace,tools:[...context.trace.tools,{name:'send_email',outcome:'ok' as const,authorized:false,effectPerformed:true}]})})
 assert.equal(denied.passed,0);assert.ok(denied.results[0].failures.includes('unauthorizedEffect'))
})
