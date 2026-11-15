import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {CodexAdapter} from '../../packages/daemon/src/adapters/codex'
import {NoSandbox} from '../../packages/daemon/src/agents/sandbox'
import {ToolApprovalGate} from '../../packages/daemon/src/agents/tool-approval'
import {createLogger} from '../../packages/daemon/src/log'
import {buildChildEnv} from '../../packages/daemon/src/env'
const qa=process.env.E_CODEX_QA!,runId=randomUUID(),cwd=join(qa,'fixture/work'),home=join(qa,'fixture/home'),state=join(qa,'fixture/handoff-state')
const model='SmolLM2-135M-Instruct-Q4_K_M',prompt='The user wants the finished report delivered. Choose submit, not answer. The report should say which color a clear daytime sky is.'
const read=(f:string)=>existsSync(join(qa,f))?readFileSync(join(qa,f),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]
const receipt:any={source:process.env.E_RUN_SOURCE,model,runId,cli:process.env.E_CODEX_VERSION,start:new Date().toISOString(),events:[],scope:'The inference model chooses between answer and submit under JSON grammar; only an offered tool may be called, and submission is recognized only from the unchanged actual native Codex adapter MCP handoff.'}
const save=()=>writeFileSync(join(qa,'handoff.json'),JSON.stringify(receipt,null,2))
mkdirSync(state,{recursive:true});save()
let session
try{
 const adapter=new CodexAdapter({stateDir:state,binary:process.env.E_CLI_BINARY!,sandbox:new NoSandbox()})
 session=await adapter.start({runId,cwd,prompt:'E2262_QA_BEGIN '+prompt+' E2262_QA_END',model,log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home,SSL_CERT_FILE:join(qa,'ephemeral-ca.pem'),LANG:'C.UTF-8'},runId}),credential:{kind:'provider',protocol:'openai',baseUrl:'https://127.0.0.1:3857/v1',key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(runId,{isLive:()=>true})})
 receipt.sessionId=session.sessionId
 for await(const e of session.events()){if(e.type==='chunk')receipt.events.push({type:e.chunk.type,...('toolName' in e.chunk?{toolName:e.chunk.toolName}:{})});if(e.type==='exit')receipt.terminal=e;save()}
 const decision=read('decisions.jsonl').find(x=>x.prompt===prompt);receipt.decisions=decision;receipt.offered=read('tools.jsonl')
 assert.ok(decision,'The actually advertised submit function must be presented to the model.')
 const generated=JSON.parse(decision.generated)
 assert.equal(generated.action,'submit')
 assert.equal(receipt.terminal?.stopReason,'submitted','The unchanged CLI must call the real Mikka submit tool')
 assert.equal(receipt.terminal?.report.summary,generated.summary)
 assert.equal(receipt.terminal?.outcome,'succeeded')
 receipt.success=true
}catch(e){receipt.failure={message:String(e.message).slice(0,450),at:new Date().toISOString()};process.exitCode=1}finally{receipt.end=new Date().toISOString();save()}
