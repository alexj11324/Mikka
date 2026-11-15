import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {CodexAdapter} from '../../packages/daemon/src/adapters/codex'
import {NoSandbox} from '../../packages/daemon/src/agents/sandbox'
import {ToolApprovalGate} from '../../packages/daemon/src/agents/tool-approval'
import {buildChildEnv} from '../../packages/daemon/src/env'
import {createLogger} from '../../packages/daemon/src/log'
const qa=process.env.E_CODEX_QA!,model='SmolLM2-135M-Instruct-Q4_K_M',origin='https://127.0.0.1:3857/v1'
const root=join(qa,'fixture'),cwd=join(root,'work'),home=join(root,'home'),stateDir=join(root,'adapters')
for(const f of [stateDir,home])mkdirSync(f,{recursive:true,mode:0o700})
const source=process.env.E_RUN_SOURCE,binary=process.env.E_CLI_BINARY!
const logs=(name:string)=>existsSync(join(qa,name))?readFileSync(join(qa,name),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]
const evidence:any={source,cliVersion:process.env.E_CODEX_VERSION,cliSha256:process.env.E_CLI_BINARY_SHA,model,weightSha256:process.env.E_WEIGHT_SHA,network:'one TLS loopback endpoint in network namespace containing only lo and no default route',providerScope:'Official CLI Responses requests, extracting marked synthetic user text for small context; no tool execution or forged completions.',trials:[]}
const persist=()=>writeFileSync(join(qa,'receipt.json'),JSON.stringify(evidence,null,2),{mode:0o600})
try{
for(const mode of ['natural','interrupt'] as const){
 const id=randomUUID(),prompt=mode==='natural'?'Name the color of a clear daytime sky in one short sentence.':'Explain evaporation slowly in four full sentences for a beginner.'
 const adapter=new CodexAdapter({stateDir,binary,sandbox:new NoSandbox()})
 const opts={runId:id,cwd,prompt:'E2262_QA_BEGIN '+prompt+' E2262_QA_END',model,log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home,SSL_CERT_FILE:join(qa,'ephemeral-ca.pem'),LANG:'C.UTF-8'},runId:id}),credential:{kind:'provider' as const,protocol:'openai' as const,baseUrl:origin,key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(id,{isLive:()=>true})}
 const trial:any={id,mode,start:new Date().toISOString(),events:[],providerUrl:origin};evidence.trials.push(trial);persist()
 const session=await adapter.start(opts);trial.thread=session.sessionId;trial.selected=session.runtimeModel;persist()
 let text='',cancelled=false
 for await(const event of session.events()){
   if(event.type==='chunk'){
    const c:any=event.chunk;trial.events.push({type:c.type,...(c.type==='text-delta'?{text:c.delta}:{})})
    if(c.type==='text-delta'){text+=c.delta
     if(!cancelled&&mode==='interrupt'){cancelled=true;trial.interruptSent=new Date().toISOString();await session.cancel();trial.interruptReturned=new Date().toISOString()}
    }
   }else if(event.type==='exit'){trial.exit=event;trial.end=new Date().toISOString();persist()}
 }
 trial.transcript=text;trial.inference=logs('results.jsonl').find(x=>x.prompt===prompt);trial.first=logs('first-token.jsonl').find(x=>x.task===prompt);persist()
 assert.ok(trial.first&&text.length)
 if(mode==='natural'){assert.equal(trial.inference.result,text);assert.ok(trial.inference.outputTokens>0);assert.equal(trial.exit.outcome,'succeeded')}
 else{assert.ok(cancelled);assert.equal(trial.exit.outcome,'cancelled')}
}
evidence.success=true;persist()
}catch(error){evidence.error={name:error.name,message:String(error.message).replaceAll(process.env.E_LOOPBACK_KEY!,'[redacted]').slice(0,900)};persist();throw error}
