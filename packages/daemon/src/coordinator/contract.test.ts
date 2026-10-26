import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { coordinatorDeadline, coordinatorSystemPrompt, CoordinatorToolHost, validateCoordinatorInput, validateCoordinatorReply } from "./contract"

const input = { instructions: "You are Mikka", context: "[Event] A new email arrived." }
const definition = (execute = vi.fn(async () => ({ proposed: true }))) => ({ name: "propose_reply", description: "Propose a reply for approval", inputSchema: { text: z.string() }, execute })

describe("Coordinator host contract", () => {
  it("keeps trusted persona separate from event content and requires real approvals", () => {
    const prompt = coordinatorSystemPrompt(input.instructions)
    expect(prompt).toContain("You are Mikka")
    expect(prompt).toContain("untrusted data")
    expect(prompt).toContain("does not authorize")
    expect(prompt).not.toContain(input.context)
  })
  it("preserves OpenUI and plain replies byte for byte", () => {
    for (const text of ['root = TextContent("收到邮件，要帮你准备回复吗？")', '今天想吃什么？']) expect(validateCoordinatorReply(text)).toBe(text)
  })
  it.each(["", "  ", "x".repeat(200_001)])("rejects empty or oversized output (case %#)", text => expect(() => validateCoordinatorReply(text)).toThrow())
  it.each([0, -1, NaN, Infinity, 121])("rejects invalid tool limit %s", maxToolCalls => expect(() => validateCoordinatorInput({ ...input, maxToolCalls })).toThrow())
  it("rejects empty instructions, context and invalid deadline", () => {
    expect(() => validateCoordinatorInput({ ...input, instructions: "" })).toThrow()
    expect(() => validateCoordinatorInput({ ...input, context: "" })).toThrow()
    expect(() => validateCoordinatorInput({ ...input, timeoutMs: 600_001 })).toThrow()
  })
  it("deduplicates concurrent native call IDs and rejects changed arguments", async () => {
    const tool = definition()
    const host = new CoordinatorToolHost([tool], new AbortController().signal, 2)
    const one = host.call("same", tool.name, { text: "draft" })
    const two = host.call("same", tool.name, { text: "draft" })
    expect(one).toBe(two)
    await Promise.all([one, two])
    expect(tool.execute).toHaveBeenCalledTimes(1)
    await expect(host.call("same", tool.name, { text: "send instead" })).rejects.toThrow("Conflict")
  })
  it("retains uncertain failures and never replays their effect", async () => {
    const execute = vi.fn(async () => { throw new Error("effect result lost") })
    const tool = definition(execute)
    const host = new CoordinatorToolHost([tool], new AbortController().signal, 5)
    await expect(host.call("effect", tool.name, { text: "draft" })).rejects.toThrow()
    await expect(host.call("effect", tool.name, { text: "draft" })).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it("refuses unknown tools, malformed arguments and excess calls before execution", async () => {
    const tool = definition()
    const host = new CoordinatorToolHost([tool], new AbortController().signal, 1)
    await expect(host.call("0", "send_email", {})).rejects.toThrow("Unavailable")
    await expect(host.call("0", tool.name, { text: "x", approved: true })).rejects.toThrow("InputInvalid")
    await host.call("1", tool.name, { text: "draft" })
    await expect(host.call("2", tool.name, { text: "draft" })).rejects.toThrow("Limit")
    expect(tool.execute).toHaveBeenCalledTimes(1)
  })
  it("does not start a queued effect after cancellation", async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async () => { await blocked; return { proposed: true } })
    const controller = new AbortController()
    const tool = definition(execute)
    const host = new CoordinatorToolHost([tool], controller.signal, 2)
    const first = host.call("one", tool.name, { text: "x" })
    await Promise.resolve()
    const queued = host.call("two", tool.name, { text: "y" })
    controller.abort()
    release()
    await first
    await expect(queued).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it("rejects duplicate or unsafe tool registrations", () => {
    expect(() => new CoordinatorToolHost([definition(), definition()], new AbortController().signal, 1)).toThrow()
    expect(() => new CoordinatorToolHost([{ ...definition(), name: "../shell" }], new AbortController().signal, 1)).toThrow()
  })
  it("propagates cancellation and releases the deadline", () => {
    const controller = new AbortController()
    const deadline = coordinatorDeadline({ ...input, signal: controller.signal })
    controller.abort()
    expect(deadline.controller.signal.aborted).toBe(true)
    deadline.dispose()
  })
})
