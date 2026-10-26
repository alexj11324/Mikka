#!/usr/bin/env node
// Real JSONL subprocess boundary; enforces the startup constraint seen in Codex 0.163.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const config=readFileSync(join(process.env.CODEX_HOME,'config.toml'),'utf8')
assert.match(config,/approval_policy\s*=\s*"on-request"/)
assert.match(config,/sandbox_mode\s*=\s*"read-only"/)
const out=data=>process.stdout.write(JSON.stringify(data)+'\n')
const response=(id,result)=>out({jsonrpc:'2.0',id,result})
const request=(id,method,params={})=>out({jsonrpc:'2.0',id,method,params})
let context='',toolName=''
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line)
  if(message.method==='initialize') return response(message.id,{})
  if(message.method==='thread/start'){
    assert.equal(message.params.approvalPolicy,'on-request')
    assert.equal(message.params.sandbox,'read-only')
    assert.equal(message.params.config['features.shell_tool'],false)
    assert.match(message.params.baseInstructions,/You are Mikka/)
    toolName=message.params.dynamicTools[0].name
    return response(message.id,{thread:{id:'thread-1'}})
  }
  if(message.method==='turn/start'){
    context=message.params.input[0].text
    response(message.id,{turn:{id:'turn-1'}})
    return request('command-approval','item/commandExecution/requestApproval')
  }
  if(message.id==='command-approval'){
    assert.deepEqual(message.result,{decision:'decline'})
    return request('file-approval','item/fileChange/requestApproval')
  }
  if(message.id==='file-approval'){
    assert.deepEqual(message.result,{decision:'decline'})
    return request('permissions-approval','item/permissions/requestApproval')
  }
  if(message.id==='permissions-approval'){
    assert.deepEqual(message.result,{permissions:{},scope:'turn'})
    return request('host-tool','item/tool/call',{threadId:'thread-1',turnId:'turn-1',callId:'call-1',tool:toolName,arguments:{text:'draft'}})
  }
  if(message.id==='host-tool'){
    assert.equal(message.result.success,true)
    assert.equal(JSON.parse(message.result.contentItems[0].text).pendingApproval,true)
    out({jsonrpc:'2.0',method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:context}}})
    out({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}})
  }
})
