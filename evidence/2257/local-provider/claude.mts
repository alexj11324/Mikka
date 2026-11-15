import { mkdirSync,readFileSync,existsSync,writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ClaudeAdapter } from '../../packages/daemon/src/adapters/claude'
import { buildChildEnv } from '../../packages/daemon/src/env'
import { ToolApprovalGate } from '../../packages/daemon/src/agents/tool-approval'
import { createLogger } from '../../packages/daemon/src/log'
const qa=process.env.E_CODEX_QA!, model='SmolLM2-135M-Instruct-Q4_K_M'
const prompt='Name the capital of France in one short sentence.',runId=randomUUID()
const journal=(s:string)=>existsSync(join(qa,s))?readFileSync(join(qa,s),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[]
const r:any={source:process.env.E_RUN_SOURCE,runId,cli:process.env.E_CODEX_VERSION,cliSha256:process.env.E_CLI_BINARY_SHA,model,weightSha256:process.env.E_WEIGHT_SHA,startedAt:new Date().toISOString(),events:[],scope:'Official pinned Claude Code + unchanged Mikka ClaudeAdapter + real CPU GGUF via authenticated Anthropic Messages over isolated loopback TLS. Synthetic provider credential, no hosted Claude model or subscription.'}
const save=()=>writeFileSync(join(qa,'claude.json'),JSON.stringify(r,null,2),{mode:0o600})
const state=join(qa,'fixture','claude-state'),cert=join(qa,'ephemeral-ca.pem')
mkdirSync(state,{recursive:true});save()
try{
 const adapter=new ClaudeAdapter({stateDir:state,binary:process.env.E_CLI_BINARY!})
 const session=await adapter.start({runId,cwd:join(qa,'fixture/work'),prompt:'E2262_QA_BEGIN '+prompt+' E2262_QA_END',model,log:createLogger({level:'silent'}),env:buildChildEnv({host:{PATH:process.env.PATH,HOME:join(qa,'fixture/home'),SSL_CERT_FILE:cert,NODE_EXTRA_CA_CERTS:cert,LANG:'C.UTF-8'},runId}),credential:{kind:'provider',protocol:'anthropic',baseUrl:'https://127.0.0.1:3857',key:process.env.E_LOOPBACK_KEY!},toolApproval:new ToolApprovalGate(runId,{isLive:()=>true})})
 r.session=session.sessionId;save()
 let text='',selectedMessage:string|undefined
 for await(const event of session.events()){if(event.type==='chunk'){const c=event.chunk;r.events.push(c.type);if(c.type==='text-delta'){text+=c.delta;selectedMessage=c.id.replace(/-\d+$/,'')}}else if(event.type==='exit')r.terminal=event;save()}
 r.output=text;r.runtimeModel=session.runtimeModel;r.selectedMessage=selectedMessage;r.inference=journal('claude-results.jsonl').find(v=>v.id===selectedMessage&&v.prompt===prompt);r.requests=journal('claude-requests.jsonl')
 assert.ok(r.inference,'The pinned Claude Code must reach the isolated model')
 assert.equal(r.inference.output,text);assert.ok(r.inference.output_tokens>0)
 assert.match(text,/\bParis\b/i,'Known factual control sentence should name Paris');assert.ok(r.events.includes('text-delta'));assert.equal(r.terminal?.outcome,'succeeded')
 assert.ok(r.requests.some((x:any)=>x.model===model&&x.marker&&x.route==='/v1/messages'))
 r.success=true
}catch(e){r.error=String(e.message).replaceAll(process.env.E_LOOPBACK_KEY!,'[redacted]').slice(0,1000);process.exitCode=1}
finally{r.endedAt=new Date().toISOString();save()}
