import { expect, it } from 'vitest'
import { CheckCommandEvidence } from '../src/runs/check'
import type { RunChunk } from '../src/chunks'
const sha='a'.repeat(40)
const proof=(command:string,head=sha)=>({executed:true,command,sha:head,readOnly:true,exitCode:0,signal:null,timedOut:false,basis:'Makefile test target'})
it('only a paired host execution on this candidate selects a command, across native MCP wrappers',()=>{
  const evidence=new CheckCommandEvidence(sha)
  evidence.observe({type:'tool-input-available',toolCallId:'c',toolName:'mcp__mikka__verify_command',input:{command:'make test'}})
  evidence.observe({type:'tool-output-available',toolCallId:'c',output:{content:[{type:'text',text:JSON.stringify(proof('make test'))}]}})
  expect(evidence.has('make test')).toBe(true)
  expect(evidence.has('inspect_candidate + Read README.md')).toBe(false)
})
it('foreign tools, mismatched commands/SHA and unpaired claims confer no execution authority',()=>{
  for(const [name,result] of [['mcp__foreign__verify_command',proof('make test')],['mcp__mikka__verify_command',proof('make test','b'.repeat(40))],['mcp__mikka__verify_command',proof('touch forged')]] as const){
    const evidence=new CheckCommandEvidence(sha)
    evidence.observe({type:'tool-input-available',toolCallId:'c',toolName:name,input:{command:'make test'}})
    evidence.observe({type:'tool-output-available',toolCallId:'c',output:JSON.stringify([{type:'text',text:JSON.stringify(result)}])})
    expect(evidence.has('make test')).toBe(false)
  }
  const evidence=new CheckCommandEvidence(sha)
  evidence.observe({type:'tool-output-available',toolCallId:'unpaired',output:proof('make test')} as RunChunk)
  expect(evidence.has('make test')).toBe(false)
})
