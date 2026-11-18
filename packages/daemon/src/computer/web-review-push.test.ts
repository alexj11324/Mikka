import { afterEach, describe, expect, it } from "vitest"
import type { LocalComputerDecision, LocalComputerRequest } from "@mikka/protocol/computer"
import { DeviceWorkSignal } from "../device-work-signal"
import { pollWebComputerReviews } from "./web-review"
import type { ComputerBroker } from "./broker.mjs"

// #1212: local broker changes and gateway pushes wake immediately; server syncs
// retain only the needed legacy/disconnect fallback.
const request = (id: string) => ({ id, digest: id.repeat(64).slice(0, 64), runId: "00000000-0000-4000-8000-000000000001", display: ":1", call: { name: "click", arguments: {} } }) as unknown as LocalComputerRequest

function fakeBroker() {
  const pending = new Map<string, LocalComputerRequest>()
  const decided: LocalComputerDecision[] = []
  const listeners = new Set<() => void>()
  let pendingRevision = 0
  const changed = () => { pendingRevision++; for (const listener of [...listeners]) listener() }
  const broker = {
    get pendingRevision() { return pendingRevision },
    onPendingChange(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    list: () => [...pending.values()],
    decide: async (id: string, digest: string, approve: boolean) => { decided.push({ id, digest, approve }); pending.delete(id); changed() },
  } as unknown as ComputerBroker
  return { broker, pending, decided, addPending: (id: string, value: LocalComputerRequest) => { pending.set(id, value); changed() } }
}
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe("web computer review sync", () => {
  const aborts: AbortController[] = []
  afterEach(() => { for (const abort of aborts) abort.abort() })
  function start(signalSource: DeviceWorkSignal | undefined, answer: (requests: LocalComputerRequest[]) => LocalComputerDecision[]) {
    const { broker, pending, decided, addPending } = fakeBroker()
    const syncs: number[] = []
    const abort = new AbortController()
    aborts.push(abort)
    const loop = pollWebComputerReviews(broker, "device", { async syncComputerReviews(_id, requests) { syncs.push(requests.length); return answer(requests) } }, abort.signal, 5, signalSource)
    return { pending, decided, syncs, abort, loop, addPending }
  }
  const pushing = () => {
    const signal = new DeviceWorkSignal()
    signal.setPushedWaits(["computerReviews"])
    signal.setConnected(true)
    return signal
  }

  it("with push, a pending review is synced when it appears and sleeps until a change or push", async () => {
    const run = start(pushing(), () => [])
    const { pending, syncs } = run
    await tick(30)
    expect(syncs).toEqual([0]) // the startup cleanup only
    run.addPending("a", request("a"))
    await tick(100)
    expect(syncs).toEqual([0, 1]) // one server sync on the broker event
    await tick(200)
    expect(syncs).toEqual([0, 1]) // no periodic presence refresh
  })

  it("with push, a person's decision is applied immediately; reconnect catches a missed push", async () => {
    let decision: LocalComputerDecision[] = []
    const signal = pushing()
    const run = start(signal, () => decision)
    const { pending, decided, syncs } = run
    run.addPending("a", request("a"))
    await tick(40)
    const before = syncs.length
    decision = [{ id: "a", digest: request("a").digest, approve: false }]
    const pushedAt = Date.now()
    signal.notify()
    for (let i = 0; i < 40 && !decided.length; i++) await tick(2)
    expect(decided).toEqual(decision)
    expect(Date.now() - pushedAt).toBeLessThan(50) // the old cadence was up to a second
    expect(syncs.length).toBe(before + 2) // decision sync plus empty-snapshot cleanup

    run.addPending("b", request("b"))
    await tick(40)
    decision = [{ id: "b", digest: request("b").digest, approve: true }]
    signal.setConnected(false)
    signal.setConnected(true) // reconnect triggers an authoritative full sync
    for (let i = 0; i < 40 && decided.length < 2; i++) await tick(2)
    expect(decided[1]).toEqual(decision[0])
  })

  it("against a server that does not push decisions, or with the gateway down, a pending review still syncs on every check", async () => {
    const legacy = start(undefined, () => [])
    const old = new DeviceWorkSignal() // the ticket named no review push
    old.setConnected(true)
    const unpushed = start(old, () => [])
    const down = new DeviceWorkSignal()
    down.setPushedWaits(["computerReviews"]) // pushes, but the socket is closed
    const fallback = start(down, () => [])
    for (const run of [legacy, unpushed, fallback]) run.addPending("a", request("a"))
    await tick(100)
    for (const run of [legacy, unpushed, fallback]) expect(run.syncs.length).toBeGreaterThan(8)
  })

  it("an empty broker makes no server calls after its startup cleanup, with or without push", async () => {
    const quiet = start(pushing(), () => [])
    const legacy = start(undefined, () => [])
    await tick(150)
    expect(quiet.syncs).toEqual([0])
    expect(legacy.syncs).toEqual([0])
  })
})

describe("DeviceWorkSignal", () => {
  it("names the mode per wait and wakes waiters on a push or a mode change", async () => {
    const signal = new DeviceWorkSignal()
    expect(signal.mode("computerReviews")).toBe("legacy")
    signal.setPushedWaits(["computerReviews"])
    expect(signal.mode("computerReviews")).toBe("fallback")
    expect(signal.mode("coordinatorResults")).toBe("legacy")
    const woke = signal.next(10_000)
    signal.setConnected(true)
    await woke
    expect(signal.mode("computerReviews")).toBe("push")
    const started = Date.now()
    const pushed = signal.next(10_000)
    signal.notify()
    await pushed
    expect(Date.now() - started).toBeLessThan(100)
    const abort = new AbortController()
    const aborted = signal.next(10_000, abort.signal)
    abort.abort()
    await aborted
  })
})
