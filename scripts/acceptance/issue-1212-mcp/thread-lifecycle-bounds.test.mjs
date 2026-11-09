import test from 'node:test'
import assert from 'node:assert/strict'
import { activeCommand, activeToolProof, terminalPauseBound } from './thread-lifecycle-bounds.mjs'

test('terminal pause timing requires an owned positive provider observation within the actual 60-second bound',()=>{
  const terminal={finishedAt:'2026-11-08T05:00:00.000Z'}
  const provider={status:'observed',state:'paused',ownershipVerified:true,observedAt:'2026-11-08T05:00:30.125Z'}
  const result=terminalPauseBound(terminal,provider)
  assert.equal(result.elapsedUpperBoundMs,30125)
  assert.equal(result.exactProviderTransition,false)
  for(const patch of [{status:'blocked'},{state:'running'},{state:'missing'},{ownershipVerified:false},{observedAt:'invalid'}])
    assert.throws(()=>terminalPauseBound(terminal,{...provider,...patch}),/terminal_pause_observation/)
  for(const observedAt of ['2026-11-08T04:59:59.999Z','2026-11-08T05:01:00.001Z'])
    assert.throws(()=>terminalPauseBound(terminal,{...provider,observedAt}),/terminal_pause_limit/)
  assert.equal(terminalPauseBound(terminal,{...provider,observedAt:'2026-11-08T05:01:00.000Z'}).elapsedUpperBoundMs,60000)
})

const scope = { caseId:'00000000-0000-4000-8000-000000000001', sourceCommit:'a'.repeat(40), runId:'00000000-0000-4000-8000-000000000002' }
const exact = (actual, expected) => actual === expected
function pair({ runId=scope.runId, elapsedMs=160050, wallMs=160051, phase='work', command=activeCommand(scope.caseId,scope.sourceCommit,phase) }={}) {
  const toolCallId=runId+':tool-1'
  return [{chunk:{type:'tool-input-available',toolName:'Bash',toolCallId,input:{command}}},
    {chunk:{type:'tool-output-available',toolCallId,output:{exitCode:0,output:'MIKKA_1593_ACTIVE '+JSON.stringify({...scope,runId:undefined,phase,elapsedMs,wallMs})}}}]
}
test('only a paired exact native command in the current run proves active execution',()=>{
  const valid=pair(), proof=activeToolProof({chunks:valid},scope,exact)
  assert.equal(proof.started,true); assert.equal(proof.completed,true); assert.equal(proof.receipt.elapsedMs,160050)
  assert.deepEqual(activeToolProof({chunks:[valid[1],valid[0]]},scope,exact),{started:true,completed:false,receipt:null})
  for(const chunks of [pair({runId:'00000000-0000-4000-8000-000000000003'}),pair({command:'echo fake'}),
    [{chunk:{type:'text-delta',delta:valid[1].chunk.output.output}}]]) {
    assert.deepEqual(activeToolProof({chunks},scope,exact),{started:false,completed:false,receipt:null})
  }
})
test('too-short, nonnumeric, clock-skewed and duplicate tool receipts fail closed',()=>{
  for(const values of [{elapsedMs:1000},{elapsedMs:'160000'},{wallMs:180000},{elapsedMs:300000}]) {
    assert.throws(()=>activeToolProof({chunks:pair(values)},scope,exact),/active_receipt/)
  }
  const chunks=pair(); assert.throws(()=>activeToolProof({chunks:[...chunks,chunks[1]]},scope,exact),/duplicate_active_tool/)
  assert.throws(()=>activeToolProof({chunks:[...chunks,...pair().map(row=>({chunk:{...row.chunk,toolCallId:scope.runId+':tool-2'}}))]},scope,exact),/duplicate_active_tool/)
})
test('the observation margin cannot substitute for the longer lease-renewal command',()=>{
  const chunks=pair({phase:'margin',elapsedMs:30001,wallMs:30002})
  assert.equal(activeToolProof({chunks},{...scope,phase:'margin'},exact).completed,true)
  assert.equal(activeToolProof({chunks},scope,exact).started,false)
  assert.throws(()=>activeCommand(scope.caseId,'$(printenv)'),/command_scope/)
})
