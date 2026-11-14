import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {watch} from 'node:fs'
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile,open} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import {Client} from 'eve/client'
import {internalEveAuthorization} from './auth'
import {runEveEvaluation} from './evaluation-client'
import {makeSnapshot} from '../agent-kit/definition'
import {DEFAULT_AGENT_DEFINITION} from '../agent-kit/builtin'
import {CORE_EVAL_CASES} from '../agent-kit/evals'
import type {EvaluationPlan} from './evaluation-store'

const root=resolve(import.meta.dirname,'../..')
const secret='synthetic-evaluation-service-key-1918-test-only'
const scope={ownerId:'fixture-owner',botId:'018f0000-0000-7000-8000-000000000001',workspaceId:'018f0000-0000-7000-8000-000000000002',surface:'web' as const}

test('Agent Kit evaluations run through compiled public Eve sessions with inert capabilities',{timeout:180000},async t=>{
 const fixture=await mkdtemp(join(tmpdir(),'mikka-eve-evaluations-')),cwd=join(fixture,'apps/eve')
 let child:ReturnType<typeof spawn>|undefined
 const saved={BETTER_AUTH_SECRET:process.env.BETTER_AUTH_SECRET,MIKKA_EVE_ORIGIN:process.env.MIKKA_EVE_ORIGIN}
 const logs=await open(join(fixture,'build.log'),'w'),runtimeLog=await open(join(fixture,'runtime.log'),'w')
 t.after(async()=>{
  if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');if(!await Promise.race([ended.then(()=>true),delay(3000).then(()=>false)])){child.kill('SIGKILL');await ended}}
  await logs.close();await runtimeLog.close();if(!process.env.MIKKA_TEST_KEEP_EVAL)await rm(fixture,{recursive:true,force:true});else t.diagnostic(fixture)
  for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value
 })
 for(const folder of ['apps/eve/agent/channels','apps/eve/agent/tools','apps/eve/agent/hooks','apps/eve/agent/connections','apps/eve/agent/skills','lib/eve','lib/abuse','lib/agent-kit','node_modules','bindings'])await mkdir(join(fixture,folder),{recursive:true})
 for(const name of await readdir(join(root,'node_modules')))if(name!=='.cache')await symlink(join(root,'node_modules',name),join(fixture,'node_modules',name))
 await writeFile(join(fixture,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{eve:'1.0.0-rc.9'}}))
 await writeFile(join(cwd,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{eve:'1.0.0-rc.9'}}))
 await writeFile(join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{module:'ESNext',target:'ES2022',moduleResolution:'Bundler',strict:true,skipLibCheck:true}}))
 await writeFile(join(cwd,'tsconfig.json'),JSON.stringify({extends:'../../tsconfig.json'}))
 const sources=['apps/eve/agent/agent.ts','apps/eve/agent/instructions.ts','apps/eve/agent/channels/evaluation.ts','apps/eve/agent/tools/product.ts','apps/eve/agent/tools/agent.ts','apps/eve/agent/tools/no_reply.ts','apps/eve/agent/tools/ask_question.ts','apps/eve/agent/hooks/product.ts','apps/eve/agent/connections/personal.ts','apps/eve/agent/skills/assigned.ts','lib/eve/auth.ts','lib/eve/scope.ts','lib/eve/runtime.ts','lib/eve/evaluation-channel.ts','lib/eve/evaluation-context.ts','lib/eve/evaluation-runtime.ts','lib/eve/streaming-model.ts','lib/agent-kit/eval-fixtures.ts']
 for(const source of sources)await writeFile(join(fixture,source),await readFile(join(root,source)))
 // Only provider/account boundaries and storage are synthetic. Channel, auth,
 // dynamic capabilities, approvals, hooks and the native Client are unchanged.
 await writeFile(join(fixture,'lib/eve/evaluation-store.ts'),`import{appendFile,readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
 export async function loadEvaluationBinding(_pool,scope,id){try{await appendFile(join(process.env.FIXTURE_BINDINGS,id+'.reads'),'1');const row=JSON.parse(await readFile(join(process.env.FIXTURE_BINDINGS,id+'.json'),'utf8'));return scope.ownerId==='${scope.ownerId}'&&scope.botId==='${scope.botId}'&&scope.workspaceId==='${scope.workspaceId}'?row:null}catch{return null}}
 export async function bindEvaluationSession(_pool,id,sessionId){const path=join(process.env.FIXTURE_BINDINGS,id+'.json'),row=JSON.parse(await readFile(path,'utf8'));if(row.session_id&&row.session_id!==sessionId)throw Error('agentEvaluationMismatch');row.session_id=sessionId;await writeFile(path,JSON.stringify(row))}
 `)
 await writeFile(join(fixture,'lib/db.ts'),`export const pool={async query(_sql,values){return{rowCount:values?.[0]==='${scope.botId}'&&values?.[1]==='${scope.ownerId}'&&values?.[2]==='${scope.workspaceId}'?1:0,rows:[]}}}`)
 await writeFile(join(fixture,'lib/api-auth.ts'),`export const auth={api:{getSession(){throw Error('Human cookies cannot enable evaluation')}}};export function apiWorkspaceAllowed(){return false}`)
 await writeFile(join(fixture,'lib/eve/auth-bot.ts'),`export function resolveEveRequestBot(){throw Error('Human auth cannot enable evaluation')}`)
 await writeFile(join(fixture,'lib/task-workspace.ts'),`export async function requireTaskWorkspace(owner,workspace){if(owner!=='${scope.ownerId}'||workspace!=='${scope.workspaceId}')throw Error('workspaceAccessDenied')}`)
 await writeFile(join(fixture,'lib/eve/product-rpc.ts'),`export async function productRpc(){throw Error('Real business effects forbidden')}`)
 await writeFile(join(fixture,'lib/eve/product-definitions.ts'),`export async function prepareEveExecution(){throw Error('Real business preparation forbidden')}export async function productCatalogue(){throw Error('Real product catalogue forbidden')}`)
 await writeFile(join(fixture,'lib/eve/product-tool.ts'),`export function createProductTool(){throw Error('Real product tools forbidden')}`)
 await writeFile(join(fixture,'lib/eve/projection.ts'),`export function projectEveTurn(){throw Error('Chat projection forbidden')}export const projectTurnState=projectEveTurn`)
 await writeFile(join(fixture,'lib/eve/scheduled-read.ts'),`export async function loadScheduledRead(){throw Error('Scheduled authority forbidden')}`)
 await mkdir(join(fixture,'lib/plugins'),{recursive:true})
 await writeFile(join(fixture,'lib/plugins/runtime.ts'),`export const personalPlugins={async snapshot(){throw Error('Personal MCP forbidden')}}`)
 const modelSource=`import{mockModel}from'eve/evals';import{writeFile}from'node:fs/promises';import{join}from'node:path';export class HostedWorkflowModel{constructor(_owner,_bot,model){return mockModel({provider:'frozen-fixture',modelId:model,respond:async({lastUserMessage,toolResults,messages})=>{
 if(lastUserMessage==='abort'){await writeFile(join(process.env.FIXTURE_BINDINGS,'abort-started'),'started');await new Promise(resolve=>setTimeout(resolve,2000));}

 if(lastUserMessage==='provider-failure')throw Error('Synthetic provider failure');
 if(toolResults.length===0)return{toolCalls:[{name:lastUserMessage==='native-blocked'?'agent':'web_search',input:lastUserMessage==='native-blocked'?{message:'Forbidden dispatch'}:{query:'Acme Example 1.0'}}]};
 return{toolCalls:[{name:'eve__reply',input:{text:messages.some(m=>m.text.includes('Candidate guidance'))?'Candidate: 2026-01-15':'Baseline: 2026-01-15',outcome:lastUserMessage==='native-blocked'?'blocked':'answered'}}]}}})}}`
 await writeFile(join(fixture,'lib/abuse/workflow-model.ts'),modelSource)
 await writeFile(join(fixture,'lib/subscription-workflow-model.ts'),`import{HostedWorkflowModel}from'./abuse/workflow-model';export class SubscriptionWorkflowModel extends HostedWorkflowModel{constructor(frozen){if(frozen.type!=='subscription'||frozen.route!=='codex_cpa'||frozen.connectionRevision!==7)throw Error('Frozen subscription mismatch');super(frozen.ownerId,frozen.consumerId,frozen.modelId)}}`)
 // Imports in unused normal branches are resolved at build time, and remain forbidden.
 await mkdir(join(fixture,'lib/coordinator'),{recursive:true})
 await writeFile(join(fixture,'lib/coordinator/instructions.ts'),`export const COORDINATOR_INSTRUCTIONS='Unused private chat instructions'`)
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const origin=`http://127.0.0.1:${(probe.address()as{port:number}).port}`;await new Promise<void>(resolve=>probe.close(()=>resolve()))
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'production',NITRO_PRESET:'node-server',WORKFLOW_LOCAL_BASE_URL:origin,BETTER_AUTH_SECRET:secret,FIXTURE_BINDINGS:join(fixture,'bindings')}
 const build=spawn(process.execPath,[join(root,'node_modules/eve/bin/eve.js'),'build'],{cwd,env,stdio:['ignore',logs.fd,logs.fd]})
 assert.equal((await once(build,'exit'))[0],0,(await readFile(join(fixture,'build.log'),'utf8')).slice(-4000))
 child=spawn(process.execPath,[join(cwd,'.output/server/index.mjs')],{cwd,env:{...env,HOST:'127.0.0.1',PORT:new URL(origin).port},stdio:['ignore',runtimeLog.fd,runtimeLog.fd]})
 const deadline=Date.now()+30000
 while(true){assert.equal(child.exitCode,null,(await readFile(join(fixture,'runtime.log'),'utf8')).slice(-3000));try{if((await fetch(origin+'/eve/v1/health',{signal:AbortSignal.timeout(500)})).ok)break}catch{}assert.ok(Date.now()<deadline,'native health timeout');await delay(100)}
 process.env.BETTER_AUTH_SECRET=secret;process.env.MIKKA_EVE_ORIGIN=origin
 const definition={...DEFAULT_AGENT_DEFINITION,tools:['web_search'] as typeof DEFAULT_AGENT_DEFINITION.tools}
 const ids:string[]=[]
 for(const kind of ['baseline','candidate','subscription','native-blocked','provider-failure','abort'])await t.test(kind,async t=>{
  const id=randomUUID(),snapshot=makeSnapshot(randomUUID(),kind==='candidate'?2:1,{...definition,instructions:kind==='candidate'?'Candidate guidance':''},'Frozen host',{harness:'ai_sdk',model:kind==='subscription'?'frozen-subscription-model':'frozen-shared-model',...kind==='subscription'?{modelSelection:{type:'subscription',bindingId:randomUUID(),ownerId:scope.ownerId,consumerId:scope.botId,workspaceId:scope.workspaceId,connectionId:randomUUID(),connectionRevision:7,modelId:'frozen-subscription-model',route:'codex_cpa'}}:{}})
  const plan:EvaluationPlan={scope,snapshot,testCase:{...CORE_EVAL_CASES[0],input:['native-blocked','provider-failure','abort'].includes(kind)?kind:'grounded-search'},instructions:snapshot.hostInstructions+'\n'+snapshot.definition.instructions,tools:[{name:'web_search',description:'Inert search fixture',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}]}
  await writeFile(join(fixture,'bindings',id+'.json'),JSON.stringify({id,session_id:null,plan}))
  let endStreamPath: string | undefined
  let teardownReads = 0
  const nativeFetch = globalThis.fetch
  const requests = t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    if (init?.method === 'POST' && path.endsWith('/end')) endStreamPath = path.slice(0, -4) + '/stream'
    if (path === endStreamPath) teardownReads++
    return nativeFetch(input, init)
  })
  if(kind==='abort') {
   const controller=new AbortController(),watcher=watch(join(fixture,'bindings'),(_event,file)=>{if(file==='abort-started')controller.abort()})
   try{await assert.rejects(runEveEvaluation(scope,id,plan,controller.signal),{name:'AbortError'})}finally{watcher.close()}
  } else if(kind==='provider-failure')await assert.rejects(runEveEvaluation(scope,id,plan,AbortSignal.timeout(20000)),/agentEvaluationGenerationFailed/)
  else{const trace=await runEveEvaluation(scope,id,plan,AbortSignal.timeout(20000));assert.equal(trace.tools.length,1);assert.equal(trace.tools[0].effectPerformed,false);assert.equal(trace.tools[0].name,kind==='native-blocked'?'agent':'web_search');assert.equal(trace.tools[0].outcome,kind==='native-blocked'?'error':'ok');assert.match(trace.text,kind==='candidate'?/^Candidate:/ : /^Baseline:/)}
  requests.mock.restore()
  assert.equal(teardownReads, 1, 'one native stream observes the durable session end')
  const binding=JSON.parse(await readFile(join(fixture,'bindings',id+'.json'),'utf8'));assert.ok(binding.session_id);ids.push(binding.session_id)
  const client=new Client({baseUrl:origin+'/mikka/evaluations',headers:()=>({authorization:internalEveAuthorization(scope),'x-mikka-evaluation-id':id})})
  const snapshotResult=await client.sessions.attach(binding.session_id).snapshot()
  assert.ok(snapshotResult.events.some(event=>event.type==='session.ended'))
  if(kind==='abort')assert.ok(snapshotResult.events.some(event=>event.type==='turn.settled'&&event.data.outcome==='cancelled'))
  assert.equal(snapshotResult.events.filter(event=>event.type==='child.opened').length,0)
  const started=snapshotResult.events.filter(event=>event.type==='model.started')
  assert.ok(started.length>0);assert.ok(started.every(event=>event.data.modelId==='frozen-fixture/'+snapshot.runtime.model))
  const foreign=await fetch(origin+'/mikka/evaluations/eve/v1/session/'+(ids[0]===binding.session_id?'wrun_foreign':ids[0])+'/stream',{headers:{authorization:internalEveAuthorization(scope),'x-mikka-evaluation-id':id}})
  assert.equal(foreign.status,404)
  const unauthenticated=await fetch(origin+'/mikka/evaluations/eve/v1/session',{method:'POST',headers:{'content-type':'application/json','x-mikka-evaluation-id':id},body:'{}'})
  assert.equal(unauthenticated.status,401)
  const readCount = async () => (await readFile(join(fixture, 'bindings', id + '.reads'))).length
  const before = await readCount()
  assert.equal((await client.sessions.create()).session.id, binding.session_id)
  assert.equal(await readCount() - before, 1, 'a repeated create reads its current owned binding once')
  await rm(join(fixture, 'bindings', id + '.json'))
  const removed = await fetch(origin+'/mikka/evaluations/eve/v1/session', {
    method:'POST', headers:{authorization:internalEveAuthorization(scope),'x-mikka-evaluation-id':id},
  })
  assert.equal(removed.status, 401, 'the next request observes binding removal')
 })
 assert.equal(new Set(ids).size,6,'each case and revision gets an isolated native session')
})
