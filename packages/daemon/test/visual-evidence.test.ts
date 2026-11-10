import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { onLines } from '../src/agents/child'
import { MCP_SERVER_SCRIPT, RunContext } from '../src/agents/run-context'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(() => cleanupTempDirs())

async function context() {
  return new RunContext({ harness:'codex',kind:'implement',worktree:await makeRepo(),runDir:tempDir(),privateDir:tempDir() })
}

function client(handoff: string) {
  const child = spawn(process.execPath,[MCP_SERVER_SCRIPT,'--handoff',handoff])
  const waiting = new Map<number,(value: unknown)=>void>()
  onLines(child.stdout,line=>{
    const value=JSON.parse(line) as {id:number}
    waiting.get(value.id)?.(value)
    waiting.delete(value.id)
  })
  let id=0
  return {
    request(method: string, params?: unknown) {
      const current=++id
      return new Promise<unknown>(resolve=>{
        waiting.set(current,resolve)
        child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id:current,method,params})}\n`)
      })
    },
    close:()=>child.kill(),
  }
}

describe('explicit public visual evidence handoff',()=>{
  it('preserves the exact inspected capture from the submit tool through the handoff file and daemon report',async()=>{
    const ctx=await context(), mcp=client(ctx.handoffFile)
    const visualEvidence=[{captureId:randomUUID(),publicSafe:true}]
    try {
      await mcp.request('initialize',{protocolVersion:'2025-06-18'})
      await mcp.request('tools/call',{name:'submit',arguments:{summary:'Recorded the real backend request.',visualEvidence}})
      expect(JSON.parse(readFileSync(ctx.handoffFile,'utf8')).visualEvidence).toEqual(visualEvidence)
      expect(ctx.readHandoff()).toMatchObject({outcome:'succeeded',stopReason:'submitted',report:{visualEvidence}})
    } finally { mcp.close() }
  })

  it('never invents public consent for a capture ID, arbitrary URL, false declaration or malformed handoff',async()=>{
    const ctx=await context(), mcp=client(ctx.handoffFile), captureId=randomUUID()
    try {
      await mcp.request('initialize',{protocolVersion:'2025-06-18'})
      for (const visualEvidence of [[{captureId}],[{captureId,publicSafe:false}],[{captureId,publicSafe:true,url:'https://example.invalid/private.mp4'}],[{captureId:'invented',publicSafe:true}]]) {
        const reply=await mcp.request('tools/call',{name:'submit',arguments:{summary:'Unsafe declaration',visualEvidence}})
        expect(JSON.stringify(reply)).toContain('Visual evidence must name inspected captures explicitly safe for public sharing')
        expect(ctx.readHandoff()).toBeNull()
        writeFileSync(ctx.handoffFile,JSON.stringify({kind:'submit',summary:'Forged file',visualEvidence}))
        expect(ctx.readHandoff()?.report?.visualEvidence).toBeUndefined()
        ctx.clearHandoff()
      }
      await mcp.request('tools/call',{name:'submit',arguments:{summary:'No declaration'}})
      expect(ctx.readHandoff()?.report?.visualEvidence).toBeUndefined()
    } finally { mcp.close() }
  })
})
