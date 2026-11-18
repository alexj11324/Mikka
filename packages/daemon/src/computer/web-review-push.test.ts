import { afterEach, describe, expect, it } from "vitest"
import type { LocalComputerDecision, LocalComputerRequest } from "@mikka/protocol/computer"
import { DeviceWorkSignal } from "../device-work-signal"
import { ServerUnreachableError } from "../errors"
import { followWebComputerReviews } from "./web-review"
import type { ComputerBroker } from "./broker.mjs"

// Decision 2026-11-17-2215: reviews are synced only while the device session
// is open, and only when the broker changed, a push arrived or the socket
// opened. No timer.
const request = (id: string) => ({ id, digest: id.repeat(64).slice(0, 64), runId: "00000000-0000-4000-8000-000000000001", display: ":1", call: { name: "click", arguments: {} } }) as unknown as LocalComputerRequest

function fakeBroker() {
  const pending = new Map<string, LocalComputerRequest>()
  const decided: LocalComputerDecision[] = []
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of [...listeners]) listener() }
  const broker = {
    list: () => [...pending.values()],
    onPendingChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    decide: async (id: string, digest: string, approve: boolean) => { decided.push({ id, digest, approve }); pending.delete(id); changed() },
  } as unknown as ComputerBroker
  return { broker, decided, add: (row: LocalComputerRequest) => { pending.set(row.id, row); changed() } }
}
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe("web computer review sync", () => {
  const aborts: AbortController[] = []
  afterEach(() => { for (const abort of aborts) abort.abort() })
  function start(answer: (requests: LocalComputerRequest[]) => LocalComputerDecision[] | Promise<LocalComputerDecision[]>, connected = true) {
    const { broker, decided, add } = fakeBroker()
    const signal = new DeviceWorkSignal()
    signal.setConnected(connected)
    const syncs: number[] = []
    let unreachable = 0
    const abort = new AbortController()
    aborts.push(abort)
    const loop = followWebComputerReviews(broker, "device", { async syncComputerReviews(_id, requests) { syncs.push(requests.length); return answer(requests) } }, abort.signal, signal, () => { unreachable++ })
    return { signal, decided, add, syncs, abort, loop, unreachable: () => unreachable }
  }

  it("syncs once on open, once per pending change and once per push; never on a timer", async () => {
    const run = start(() => [])
    await tick(20)
    expect(run.syncs).toEqual([0]) // the cleanup on open
    run.add(request("a"))
    await tick(20)
    expect(run.syncs).toEqual([0, 1])
    await tick(200)
    expect(run.syncs).toEqual([0, 1]) // a pending review does not resync by itself
    run.signal.notify()
    await tick(20)
    expect(run.syncs).toEqual([0, 1, 1])
  })

  it("applies a person's decision on the push at once", async () => {
    let decision: LocalComputerDecision[] = []
    const run = start(() => decision)
    run.add(request("a"))
    await tick(20)
    decision = [{ id: "a", digest: request("a").digest, approve: false }]
    run.signal.notify()
    for (let i = 0; i < 40 && !run.decided.length; i++) await tick(2)
    expect(run.decided).toEqual(decision)
  })

  it("while the socket is down nothing is sent; reopening syncs what changed meanwhile", async () => {
    const run = start(() => [], false)
    run.add(request("a"))
    run.signal.notify()
    await tick(50)
    expect(run.syncs).toEqual([])
    run.signal.setConnected(true)
    await tick(20)
    expect(run.syncs).toEqual([1])
  })

  it("a sync the server could not take asks for a redial instead of retrying on a timer", async () => {
    let fail = true
    const run = start(() => { if (fail) throw new ServerUnreachableError(503); return [] })
    run.add(request("a"))
    await tick(30)
    const attempts = run.syncs.length
    expect(run.unreachable()).toBeGreaterThan(0)
    await tick(100)
    expect(run.syncs.length).toBe(attempts)
    fail = false
    run.signal.setConnected(false)
    run.signal.setConnected(true) // the redialed socket opened
    await tick(20)
    expect(run.syncs.length).toBe(attempts + 1)
  })
})
