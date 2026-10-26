import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join,resolve } from "node:path"
import { afterEach,describe,expect,it,vi } from "vitest"
import { coordinatorCapable,runNativeCoordinatorJob } from "./runner"
import { createLogger } from "../log"
import { NoSandbox } from "../agents/sandbox"
import type { NativeCoordinatorJob } from "@mikka/protocol/coordinator"

const dirs: string[] = []
afterEach(()=>{ for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}) })
const job: NativeCoordinatorJob = {id:"11111111-1111-4111-8111-111111111111",harness:"claude_code",instructions:"You are Mikka.",context:'root = TextContent("今天想吃什么？")',tools:[],expiresAt:new Date(Date.now()+180_000).toISOString()}
function setup() {
  const dir=mkdtempSync(join(tmpdir(),"native-runner-"));dirs.push(dir)
  const command=vi.fn(async()=>undefined)
  const link={coordinatorCommand:command,coordinatorToolResult:vi.fn(async()=>({status:"pending" as const}))}
  return {command,options:{deviceId:"device",stateDir:dir,link,signal:new AbortController().signal,sandbox:new NoSandbox(),log:createLogger(),claudeBinary:resolve("test/fakes/fake-coordinator-claude.mjs")}}
}
describe("native Coordinator runner",()=>{
  it("delivers a personal OpenUI reply without a repository or worker handoff",async()=>{
    const {command,options}=setup()
    await runNativeCoordinatorJob(job,options)
    expect(command).toHaveBeenCalledWith("device",job.id,{type:"complete",text:job.context},options.signal)
    expect(readdirSync(options.stateDir)).toEqual([])
  })
  it("reports failure instead of switching models",async()=>{
    const {command,options}=setup()
    await expect(runNativeCoordinatorJob({...job,context:"ERROR"},options)).rejects.toThrow()
    expect(command).toHaveBeenCalledWith("device",job.id,{type:"failed"},options.signal)
    expect(readdirSync(options.stateDir)).toEqual([])
  })
  it("starts Codex with a supported policy, denies built-in approvals and roundtrips host tools",async()=>{
    const {command,options}=setup()
    const result=vi.fn(async()=>({status:"done" as const,output:{pendingApproval:true}}))
    const tools=[{name:"propose_reply",description:"Propose a draft",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}]
    await runNativeCoordinatorJob({...job,harness:"codex",tools},{...options,codexBinary:resolve("test/fakes/fake-coordinator-codex.mjs"),link:{...options.link,coordinatorToolResult:result}})
    expect(command).toHaveBeenCalledWith("device",job.id,{type:"tool",callId:"call-1",name:"propose_reply",input:{text:"draft"}},expect.any(AbortSignal))
    expect(result).toHaveBeenCalledWith("device",job.id,"call-1",expect.any(AbortSignal))
    expect(command).toHaveBeenCalledWith("device",job.id,{type:"complete",text:job.context},options.signal)
    expect(readdirSync(options.stateDir)).toEqual([])
  })
  it("advertises only installed compatible harnesses",()=>{
    expect(coordinatorCapable({harness:"codex",installed:true,version:"codex-cli 0.162.1"})).toBe(true)
    expect(coordinatorCapable({harness:"codex",installed:true,version:"0.100.0"})).toBe(false)
    expect(coordinatorCapable({harness:"codex",installed:true,version:null})).toBe(false)
    expect(coordinatorCapable({harness:"claude_code",installed:false,version:null})).toBe(false)
    expect(coordinatorCapable({harness:"cursor",installed:true,version:"3.0.0"})).toBe(false)
  })
})
