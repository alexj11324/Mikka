import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tool } from "ai"
import { z } from "zod"
import { RunFailureError, runFailureSchema } from "@mikka/protocol/run-failure"
import { nativeCoordinatorTurn } from "../workflows/coordinator/native-turn"
import * as native from "../workflows/coordinator/native-steps"

// sleep(ms) moves the faked clock; the turn's wake hook (#1212) never fires here.
// oxlint-disable-next-line unicorn/no-thenable -- a Workflow hook is a thenable.
vi.mock("workflow", () => ({ sleep: vi.fn(async ms => { vi.setSystemTime(Date.now() + ms) }), createHook: () => ({ then: () => undefined, dispose: () => undefined }) }))
vi.mock("../workflows/coordinator/native-steps", () => ({ enqueue: vi.fn(),poll: vi.fn(),finishTool: vi.fn(),close: vi.fn() }))
const runtime = { harness: "codex",deviceId: "11111111-1111-4111-8111-111111111111" }
// The person's Coordinator is an ordinary bot row; its turns name that bot.
const coordinatorBot = "11111111-1111-4111-8111-0000000c0de1"
const reply = 'root = TextContent("收到邮件，要帮你回复吗？")'

function assertRunFailure(code, category) {
  return error => {
    expect(error).toBeInstanceOf(RunFailureError)
    expect(error.code).toBe(code)
    const failure = runFailureSchema.parse(error.failureDetails)
    expect(failure).toMatchObject({ code, category, runId: "holder", provider: "codex" })
    expect(failure.providerMessage).toBeUndefined()
    return true
  }
}

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.mocked(native.enqueue).mockResolvedValue("turn") })
afterEach(() => { vi.useRealTimers() })
describe("durable Coordinator transport relay", () => {
  it("exposes the existing schema, invokes its person-scoped callback once and records the result", async () => {
    const execute = vi.fn(async ({ text }) => ({ owner: "owner-from-closure",text,approval: "required" }))
    const tools = { propose_reply: tool({description:"Propose a reply",inputSchema:z.object({text:z.string()}).strict(),execute}) }
    const createTools = vi.fn(() => tools)
    const call = { callId:"call",name:"propose_reply",input:{text:"draft"} }
    vi.mocked(native.poll).mockResolvedValueOnce({status:"running",reply:null,calls:[call]}).mockResolvedValueOnce({status:"running",reply:null,calls:[call]}).mockResolvedValueOnce({status:"completed",reply,calls:[]})
    const result = await nativeCoordinatorTurn("owner-from-closure","holder",0,runtime,createTools,coordinatorBot)
    expect(createTools.mock.calls).toEqual([[],[{holder:"holder",turnId:"turn",callId:"call"}]])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(native.enqueue).toHaveBeenCalledWith("owner-from-closure","holder",0,runtime,[expect.objectContaining({name:"propose_reply",inputSchema:expect.objectContaining({type:"object"})})],coordinatorBot)
    expect(native.finishTool).toHaveBeenCalledWith("owner-from-closure","holder","turn","call",{owner:"owner-from-closure",text:"draft",approval:"required"})
    expect(result.text).toBe(reply)
    expect(result.responseMessages.map(message=>message.role)).toEqual(["assistant","tool","assistant"])
    expect(native.close).toHaveBeenCalledTimes(1)
  })
  it("does not execute injected actor fields or invalid tool arguments", async () => {
    const execute = vi.fn(async () => ({}))
    const tools = { propose_reply: tool({inputSchema:z.object({text:z.string()}).strict(),execute}) }
    vi.mocked(native.poll).mockResolvedValueOnce({status:"running",reply:null,calls:[{callId:"call",name:"propose_reply",input:{text:"draft",userId:"victim"}}]}).mockResolvedValueOnce({status:"completed",reply,calls:[]})
    await nativeCoordinatorTurn("owner","holder",0,runtime,() => tools,coordinatorBot)
    expect(execute).not.toHaveBeenCalled()
    expect(native.finishTool).toHaveBeenCalledWith("owner","holder","turn","call",{error:"invalidToolArguments"})
  })
  it("rejects unregistered tools and still closes the native turn", async () => {
    vi.mocked(native.poll).mockResolvedValue({status:"running",reply:null,calls:[{callId:"call",name:"shell",input:{}}]})
    await expect(nativeCoordinatorTurn("owner","holder",0,runtime,() => ({}),coordinatorBot)).rejects.toThrow("UnknownTool")
    expect(native.close).toHaveBeenCalledTimes(1)
  })
  it.each(["failed","closed"])("surfaces %s without another model", async status => {
    vi.mocked(native.poll).mockResolvedValue({status,reply:null,calls:[]})
    await assert.rejects(nativeCoordinatorTurn("owner","holder",0,runtime,() => ({}),coordinatorBot),assertRunFailure("run_failed","internal"))
    expect(native.enqueue).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalledTimes(1)
  })
  it("bounds waiting and does not start a replacement job", async () => {
    vi.mocked(native.poll).mockResolvedValue({status:"queued",reply:null,calls:[]})
    await assert.rejects(nativeCoordinatorTurn("owner","holder",0,runtime,() => ({}),coordinatorBot),assertRunFailure("run_timeout","timeout"))
    expect(native.enqueue).toHaveBeenCalledTimes(1)
    // The 180 s job lifetime bounds it: a read per 15 s re-read (a lost wake) plus the deadline, where the 1 s loop read 180 times.
    expect(native.poll).toHaveBeenCalledTimes(13)
    expect(native.close).toHaveBeenCalledTimes(1)
  })
})
