import { beforeEach, describe, expect, it, vi } from "vitest"
import { tool } from "ai"
import { z } from "zod"
import { nativeCoordinatorTurn } from "../workflows/coordinator/native-turn"
import * as native from "../workflows/coordinator/native-steps"

vi.mock("workflow", () => ({ sleep: vi.fn(async () => undefined) }))
vi.mock("../workflows/coordinator/native-steps", () => ({ enqueue: vi.fn(),poll: vi.fn(),finishTool: vi.fn(),close: vi.fn() }))
const runtime = { harness: "codex",deviceId: "11111111-1111-4111-8111-111111111111" }
const reply = 'root = TextContent("收到邮件，要帮你回复吗？")'

beforeEach(() => { vi.resetAllMocks(); vi.mocked(native.enqueue).mockResolvedValue("turn") })
describe("durable Coordinator transport relay", () => {
  it("exposes the existing schema, invokes its person-scoped callback once and records the result", async () => {
    const execute = vi.fn(async ({ text }) => ({ owner: "owner-from-closure",text,approval: "required" }))
    const tools = { propose_reply: tool({description:"Propose a reply",inputSchema:z.object({text:z.string()}).strict(),execute}) }
    const createTools = vi.fn(() => tools)
    const call = { callId:"call",name:"propose_reply",input:{text:"draft"} }
    vi.mocked(native.poll).mockResolvedValueOnce({status:"running",reply:null,calls:[call]}).mockResolvedValueOnce({status:"running",reply:null,calls:[call]}).mockResolvedValueOnce({status:"completed",reply,calls:[]})
    const result = await nativeCoordinatorTurn("owner-from-closure","holder",0,runtime,createTools)
    expect(createTools.mock.calls).toEqual([[],[{holder:"holder",turnId:"turn",callId:"call"}]])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(native.enqueue).toHaveBeenCalledWith("owner-from-closure","holder",0,runtime,[expect.objectContaining({name:"propose_reply",inputSchema:expect.objectContaining({type:"object"})})])
    expect(native.finishTool).toHaveBeenCalledWith("owner-from-closure","holder","turn","call",{owner:"owner-from-closure",text:"draft",approval:"required"})
    expect(result.text).toBe(reply)
    expect(result.responseMessages.map(message=>message.role)).toEqual(["assistant","tool","assistant"])
    expect(native.close).toHaveBeenCalledTimes(1)
  })
  it("does not execute injected actor fields or invalid tool arguments", async () => {
    const execute = vi.fn(async () => ({}))
    const tools = { propose_reply: tool({inputSchema:z.object({text:z.string()}).strict(),execute}) }
    vi.mocked(native.poll).mockResolvedValueOnce({status:"running",reply:null,calls:[{callId:"call",name:"propose_reply",input:{text:"draft",userId:"victim"}}]}).mockResolvedValueOnce({status:"completed",reply,calls:[]})
    await nativeCoordinatorTurn("owner","holder",0,runtime,() => tools)
    expect(execute).not.toHaveBeenCalled()
    expect(native.finishTool).toHaveBeenCalledWith("owner","holder","turn","call",{error:"invalidToolArguments"})
  })
  it("rejects unregistered tools and still closes the native turn", async () => {
    vi.mocked(native.poll).mockResolvedValue({status:"running",reply:null,calls:[{callId:"call",name:"shell",input:{}}]})
    await expect(nativeCoordinatorTurn("owner","holder",0,runtime,() => ({}))).rejects.toThrow("UnknownTool")
    expect(native.close).toHaveBeenCalledTimes(1)
  })
  it.each(["failed","closed"])("surfaces %s without another model", async status => {
    vi.mocked(native.poll).mockResolvedValue({status,reply:null,calls:[]})
    await expect(nativeCoordinatorTurn("owner","holder",0,runtime,() => ({}))).rejects.toThrow("Failed")
    expect(native.close).toHaveBeenCalledTimes(1)
  })
  it("bounds waiting and does not start a replacement job", async () => {
    vi.mocked(native.poll).mockResolvedValue({status:"queued",reply:null,calls:[]})
    await expect(nativeCoordinatorTurn("owner","holder",0,runtime,() => ({}))).rejects.toThrow("TimedOut")
    expect(native.enqueue).toHaveBeenCalledTimes(1)
    expect(native.poll).toHaveBeenCalledTimes(180)
    expect(native.close).toHaveBeenCalledTimes(1)
  })
})
