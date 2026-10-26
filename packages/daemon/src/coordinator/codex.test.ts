import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { jsonlConnection } from "../agents/jsonl-rpc"
import { runCodexCoordinator } from "./codex"

const input = { instructions: "You are Mikka. Speak naturally.", context: "[Memory] Alex prefers Chinese.\n[Event] A new email arrived.", timeoutMs: 3000 }
const final = 'root = TextContent("Alex，收到一封邮件，要我准备回复吗？")'

function fixture(mode = "ok") {
  const a = new PassThrough(), b = new PassThrough()
  const client = jsonlConnection(a, b), server = jsonlConnection(b, a)
  const calls: Record<string, unknown> = {}
  const execute = vi.fn(async () => ({ proposed: true, requiresApproval: true }))
  const close = vi.fn(async () => { client.dispose(); server.dispose(); a.destroy(); b.destroy() })
  server.onRequest("initialize", (params: unknown) => { calls.initialize = params; return {} })
  server.onRequest("thread/start", (params: unknown) => { calls.thread = params; return { thread: { id: "thread-1" } } })
  server.onRequest("turn/start", async (params: unknown) => {
    calls.turn = params
    if (mode === "hang") return new Promise(() => undefined)
    if (mode === "disconnect") { a.destroy(); b.destroy(); return {} }
    const call = { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "propose_reply", arguments: { text: "draft" } }
    if (mode === "tools") {
      calls.wrongThread = await server.sendRequest("item/tool/call", { ...call, threadId: "other" })
      calls.unknownTool = await server.sendRequest("item/tool/call", { ...call, tool: "shell" })
      calls.tool = await server.sendRequest("item/tool/call", call)
      calls.duplicate = await server.sendRequest("item/tool/call", call)
      calls.wrongTurn = await server.sendRequest("item/tool/call", { ...call, turnId: "other" })
      calls.approval = await server.sendRequest("item/commandExecution/requestApproval", {})
    }
    // A legal server can notify before returning turn/start.
    await server.sendNotification("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "progress", type: "agentMessage", phase: "commentary", text: "checking" } })
    if (mode !== "empty") await server.sendNotification("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: final } })
    await server.sendNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: mode === "fail" ? "failed" : "completed" } })
    if (mode === "tools") calls.afterEnd = await server.sendRequest("item/tool/call", { ...call, callId: "late" })
    if (mode === "lost-ack") return new Promise(() => undefined)
    return { turn: { id: mode === "wrong-ack" ? "other" : "turn-1" } }
  })
  server.listen()
  const host = { cwd: "/host-owned/private-context", tools: [{ name: "propose_reply", description: "Propose a draft, never send directly", inputSchema: { text: z.string() }, execute }], connect: async () => ({ rpc: client, close }) }
  return { host, calls, execute, close }
}

describe("Codex Coordinator over real JSONL RPC", () => {
  it("replaces base instructions, preserves context/OpenUI and closes the connection", async () => {
    const f = fixture()
    const result = await runCodexCoordinator(input, f.host)
    expect(result.text).toBe(final)
    expect(f.calls.initialize).toMatchObject({ capabilities: { experimentalApi: true } })
    expect(f.calls.thread).toMatchObject({ baseInstructions: expect.stringContaining(input.instructions), sandbox: "read-only", ephemeral: true, config: { "features.shell_tool": false } })
    expect(f.calls.turn).toMatchObject({ input: [{ type: "text", text: input.context }] })
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  it("routes scoped validated tools once and refuses unsolicited effects", async () => {
    const f = fixture("tools")
    const result = await runCodexCoordinator(input, f.host)
    expect(result.toolCalls).toBe(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.calls.tool).toMatchObject({ success: true })
    expect(f.calls.duplicate).toEqual(f.calls.tool)
    for (const key of ["wrongThread", "unknownTool", "wrongTurn", "afterEnd"]) expect(f.calls[key]).toMatchObject({ success: false })
    expect(f.calls.approval).toEqual({ decision: "decline" })
  })
  it.each(["fail", "empty", "wrong-ack", "disconnect"])("rejects %s without fallback and closes", async mode => {
    const f = fixture(mode)
    await expect(runCodexCoordinator(input, f.host)).rejects.toThrow()
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  it.each(["hang", "lost-ack"])("deadline still works for %s", async mode => {
    const f = fixture(mode)
    await expect(runCodexCoordinator({ ...input, timeoutMs: 80 }, f.host)).rejects.toThrow("Aborted")
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  it("does not connect when cancelled before start", async () => {
    const controller = new AbortController(); controller.abort()
    const connect = vi.fn()
    await expect(runCodexCoordinator({ ...input, signal: controller.signal }, { cwd: "/tmp", tools: [], connect })).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })
})
