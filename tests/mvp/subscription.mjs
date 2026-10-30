// Synthetic model boundary for the existing isolated MVP acceptance environment.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertMvpEnvironment } from './isolated-env.mjs'
export const MVP_SUBSCRIPTION_MODEL = 'mvp-subscription-model'
export async function seedMvpSubscription(pool, ownerId) {
  assertMvpEnvironment()
  const { rows: [workspace] } = await pool.query(`SELECT w.id FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id WHERE m."userId"=$1 AND m.status='active' ORDER BY w."createdAt" LIMIT 1`, [ownerId])
  assert.ok(workspace, 'MVP owner needs its real workspace')
  const connectionId=randomUUID(),bindingId=randomUUID(),consumerId=randomUUID()
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject",quota) VALUES ($1,$2,$3,'codex','connected',$4,$5,'mvp-synthetic',$6)`,[connectionId,ownerId,workspace.id,`mvp-synthetic-${connectionId}`,'0'.repeat(64),JSON.stringify({vendor:'codex',source:'official',status:'ok',observedAt:new Date().toISOString(),plan:null,windows:[{kind:'five_hour',used:0.1,resetsAt:null}]})])
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'codex_cpa',$6)`,[bindingId,ownerId,workspace.id,consumerId,connectionId,MVP_SUBSCRIPTION_MODEL])
  return { connectionId,bindingId }
}

/** Adapt the real OpenAI-compatible subscription request to the same scripted model. */
export function subscriptionPrompt(payload) {
  const names=new Map()
  const prompt=payload.messages.map(message=>{
    if(message.role==='tool') {
      const toolName=names.get(message.tool_call_id)
      assert.ok(toolName,'Tool result needs a preceding real tool call')
      return {role:'tool',content:[{type:'tool-result',toolCallId:message.tool_call_id,toolName,output:{type:'json',value:JSON.parse(message.content)}}]}
    }
    const content=typeof message.content==='string'?[{type:'text',text:message.content}]:(message.content??[])
    for(const call of message.tool_calls??[]) {
      names.set(call.id,call.function.name)
      content.push({type:'tool-call',toolCallId:call.id,toolName:call.function.name,input:JSON.parse(call.function.arguments)})
    }
    return {role:message.role==='developer'?'system':message.role,content}
  })
  return {prompt,tools:payload.tools?.map(tool=>({name:tool.function.name}))}
}
export function subscriptionChunks(answer, model) {
  const calls=answer.content.filter(part=>part.type==='tool-call')
  const text=answer.content.filter(part=>part.type==='text').map(part=>part.text).join('')
  const base={id:'mvp-subscription',object:'chat.completion.chunk',created:1,model}
  const delta={role:'assistant',...(text?{content:text}:{}),...(calls.length?{tool_calls:calls.map((call,index)=>({index,id:call.toolCallId,type:'function',function:{name:call.toolName,arguments:call.input}}))}:{})}
  return [`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`,`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`,'data: [DONE]\n\n'].join('')
}
