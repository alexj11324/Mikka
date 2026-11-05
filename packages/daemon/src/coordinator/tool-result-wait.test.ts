import { afterEach, describe, expect, it, vi } from "vitest"
import { DeviceWorkSignal } from "../device-work-signal"
import { TOOL_RESULT_FALLBACK_MS, TOOL_RESULT_LEGACY_MS, TOOL_RESULT_PUSH_SAFETY_MS, awaitToolResult } from "./runner"

// #1212: a native Coordinator tool waits for its result on the gateway push the
// server sends when it writes it, not by asking every 500 ms.
describe("awaitToolResult", () => {
  afterEach(() => { vi.useRealTimers() })
  function server() {
    let output: unknown
    const reads: number[] = []
    const read = vi.fn(async () => { reads.push(Date.now()); return output === undefined ? { status: "pending" as const } : { status: "done" as const, output } })
    return { read, reads, finish: (value: unknown) => { output = value } }
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

  it("with push, it asks once, then again only on the push: the result is read at once", async () => {
    vi.useFakeTimers()
    const pushes = new DeviceWorkSignal()
    pushes.setPushedWaits(["coordinatorResults"])
    pushes.setConnected(true)
    const { read, finish } = server()
    const waiting = awaitToolResult(read, new AbortController().signal, pushes)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(1) // the 500 ms loop asked 20 times by now
    finish({ remembered: true })
    pushes.notify()
    await settle()
    await expect(waiting).resolves.toEqual({ remembered: true })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("with push, a lost push is covered by the safety re-ask", async () => {
    vi.useFakeTimers()
    const pushes = new DeviceWorkSignal()
    pushes.setPushedWaits(["coordinatorResults"])
    pushes.setConnected(true)
    const { read, reads, finish } = server()
    const start = Date.now()
    const waiting = awaitToolResult(read, new AbortController().signal, pushes)
    await settle()
    finish("late") // written, but its push never arrives
    await vi.advanceTimersByTimeAsync(TOOL_RESULT_PUSH_SAFETY_MS)
    await expect(waiting).resolves.toBe("late")
    expect(reads.map(at => at - start)).toEqual([0, TOOL_RESULT_PUSH_SAFETY_MS])
  })

  it("against an old server it keeps asking every 500 ms; with the gateway down every 5 s", async () => {
    vi.useFakeTimers()
    const legacy = server()
    const noPush = awaitToolResult(legacy.read, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(2 * TOOL_RESULT_LEGACY_MS)
    expect(legacy.read).toHaveBeenCalledTimes(3)
    legacy.finish(1)
    await vi.advanceTimersByTimeAsync(TOOL_RESULT_LEGACY_MS)
    await expect(noPush).resolves.toBe(1)

    const down = new DeviceWorkSignal()
    down.setPushedWaits(["coordinatorResults"])
    const fallback = server()
    const waiting = awaitToolResult(fallback.read, new AbortController().signal, down)
    await vi.advanceTimersByTimeAsync(2 * TOOL_RESULT_FALLBACK_MS)
    expect(fallback.read).toHaveBeenCalledTimes(3)
    fallback.finish(2)
    await vi.advanceTimersByTimeAsync(TOOL_RESULT_FALLBACK_MS)
    await expect(waiting).resolves.toBe(2)
  })

  it("a cancelled turn stops waiting at once", async () => {
    const pushes = new DeviceWorkSignal()
    pushes.setPushedWaits(["coordinatorResults"])
    pushes.setConnected(true)
    const { read } = server()
    const abort = new AbortController()
    const waiting = awaitToolResult(read, abort.signal, pushes)
    await settle()
    abort.abort()
    await expect(waiting).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
