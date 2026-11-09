import { observeChunks } from './scripts/acceptance/cloud-startup.mjs'
const epoch = Date.parse('2026-11-09T00:00:00Z')
const at = ms => new Date(epoch+ms).toISOString()
const record = {sampleId:'counterexample',runId:'00000000-0000-4000-8000-000000000001',harness:'codex',requireReply:true,minToolCalls:1,requireReplyAfterTool:true,requireTerminal:true}
const detail = {thread:{id:record.runId,status:'succeeded'},chunks:[
{at:at(0),chunk:{type:'data-run-stage',data:{stage:'agent_start',ms:1,ok:true}}},
{at:at(1),chunk:{type:'tool-input-available',toolCallId:'submit-only',toolName:'mcp__mikka__submit',input:{summary:'No independent read occurred.'}}},
{at:at(2),chunk:{type:'tool-output-available',toolCallId:'submit-only',output:[]}},
{at:at(3),chunk:{type:'text-delta',delta:'STARTUP_OK_counterexample'}}]}
const result=observeChunks(record,detail,epoch+4)
console.log(JSON.stringify({kind:'submit_only_text_counterexample',result,record}))
if(result!==false) process.exitCode=1
