import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUN_CONTROL_FALLBACK_MS, ToolApprovalGate } from '../src/agents/tool-approval'

const gates: ToolApprovalGate[] = []
afterEach(() => { for (const gate of gates.splice(0)) gate.revoke(); vi.useRealTimers() })
function create(host: { isLive: () => boolean | Promise<boolean> }) {
  const gate = new ToolApprovalGate('run', host)
  gates.push(gate)
  return gate
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('shares one fresh background check across runtime monitors without caching operation authority', async () => {
  vi.useFakeTimers()
  const host = { isLive: vi.fn(() => true) }
  const gate = create(host)
  const credentials = vi.fn(async () => {})
  const access = vi.fn(async () => {})
  gate.watch()
  gate.watch(credentials)
  gate.watch(access)
  await vi.advanceTimersByTimeAsync(3000)
  expect(host.isLive).toHaveBeenCalledTimes(3)
  expect(credentials).toHaveBeenCalledTimes(3)
  expect(access).toHaveBeenCalledTimes(3)
  expect(await gate.checkLive()).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(4)
})

it('keeps the one-second safety check when every work notification is lost', async () => {
  vi.useFakeTimers()
  let live = true
  const host = { isLive: vi.fn(() => live) }
  const gate = create(host)
  gate.watch()
  await vi.advanceTimersByTimeAsync(1000)
  live = false
  await vi.advanceTimersByTimeAsync(999)
  expect(gate.revoked).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(gate.revoked).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(2)
})

it('does not let slow credential checks postpone stop or lease revocation', async () => {
  vi.useFakeTimers()
  let live = true
  const pending = deferred<void>()
  const gate = create({ isLive: () => live })
  const credentials = vi.fn(() => pending.promise)
  gate.watch(credentials)
  await vi.advanceTimersByTimeAsync(1000)
  expect(credentials).toHaveBeenCalledTimes(1)
  live = false
  await vi.advanceTimersByTimeAsync(1000)
  expect(gate.revoked).toBe(true)
  pending.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(gate.revoked).toBe(true)
})

it('rechecks immediately after a push races an older in-flight success', async () => {
  vi.useFakeTimers()
  const pending = deferred<boolean>()
  const host = { isLive: vi.fn<() => boolean | Promise<boolean>>().mockImplementationOnce(() => pending.promise).mockReturnValue(false) }
  const gate = create(host)
  gate.watch()
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 12; i++) gate.invalidate()
  expect(host.isLive).toHaveBeenCalledTimes(1)
  pending.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(host.isLive).toHaveBeenCalledTimes(2)
  expect(gate.revoked).toBe(true)
})

it('rechecks a credential response that overlapped a push without concurrent credential requests', async () => {
  vi.useFakeTimers()
  const pending = deferred<void>()
  const gate = create({ isLive: () => true })
  const credentials = vi.fn<() => Promise<void>>().mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error('revoked'))
  gate.watch(credentials)
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  expect(credentials).toHaveBeenCalledTimes(1)
  pending.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(credentials).toHaveBeenCalledTimes(2)
  expect(gate.revoked).toBe(true)
})

it('does not consume an operation check started before the first push as its fresh authority', async () => {
  vi.useFakeTimers()
  const pending = deferred<boolean>()
  const host = { isLive: vi.fn<() => boolean | Promise<boolean>>().mockImplementationOnce(() => pending.promise).mockReturnValue(false) }
  const gate = create(host)
  gate.watch()
  const operation = gate.checkLive()
  await vi.advanceTimersByTimeAsync(0)
  gate.invalidate()
  pending.resolve(true)
  await operation
  await vi.advanceTimersByTimeAsync(0)
  expect(host.isLive).toHaveBeenCalledTimes(2)
  expect(gate.revoked).toBe(true)
})

it('never revives a cancelled run when an old socket hint or response arrives', async () => {
  vi.useFakeTimers()
  const pending = deferred<boolean>()
  const host = { isLive: vi.fn(() => pending.promise) }
  const gate = create(host)
  gate.watch()
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  gate.revoke()
  gate.invalidate()
  pending.resolve(true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(gate.revoked).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(1)
})

it('retains monitoring until the final owner leaves and rejects a weaker interval', async () => {
  vi.useFakeTimers()
  const host = { isLive: vi.fn(() => true) }
  const gate = create(host)
  const offRuntime = gate.watch()
  const offTransport = gate.watch()
  expect(() => gate.watch(undefined, 20_001)).toThrow()
  offRuntime()
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.isLive).toHaveBeenCalledTimes(1)
  offTransport()
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(5000)
  expect(host.isLive).toHaveBeenCalledTimes(1)
})

describe('run-control push (#1212)', () => {
  it('connected: no periodic check; a push revokes at once', async () => {
    vi.useFakeTimers()
    let live = true
    const host = { isLive: vi.fn(() => live) }
    const gate = new ToolApprovalGate('run', host, 'push')
    gates.push(gate)
    gate.watch()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(host.isLive).not.toHaveBeenCalled()
    live = false
    gate.invalidate()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.isLive).toHaveBeenCalledTimes(1)
    expect(gate.revoked).toBe(true)
  })

  it(`disconnected: one check every ${RUN_CONTROL_FALLBACK_MS} ms, and losing the socket checks at once`, async () => {
    vi.useFakeTimers()
    let live = true
    const host = { isLive: vi.fn(() => live) }
    const gate = new ToolApprovalGate('run', host, 'push')
    gates.push(gate)
    gate.watch()
    gate.setControlMode('fallback')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.isLive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RUN_CONTROL_FALLBACK_MS - 1)
    expect(host.isLive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.isLive).toHaveBeenCalledTimes(2)
    live = false
    await vi.advanceTimersByTimeAsync(RUN_CONTROL_FALLBACK_MS)
    expect(gate.revoked).toBe(true)
  })

  it('reconnecting stops the fallback timer and checks once for anything missed', async () => {
    vi.useFakeTimers()
    const host = { isLive: vi.fn(() => true) }
    const gate = new ToolApprovalGate('run', host, 'fallback')
    gates.push(gate)
    gate.watch()
    gate.setControlMode('push')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.isLive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * RUN_CONTROL_FALLBACK_MS)
    expect(host.isLive).toHaveBeenCalledTimes(1)
  })

  it('a watcher runs again at the due time it returns (a token expiry), not on a cadence', async () => {
    vi.useFakeTimers()
    const gate = new ToolApprovalGate('run', { isLive: () => true }, 'push')
    gates.push(gate)
    const expiry = Date.now() + 3_600_000
    let valid = true
    const access = vi.fn(async () => { if (!valid) throw new Error('expired'); return expiry })
    gate.watch(access)
    gate.invalidate()
    await vi.advanceTimersByTimeAsync(0)
    expect(access).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_600_000 - 1)
    expect(access).toHaveBeenCalledTimes(1)
    valid = false
    await vi.advanceTimersByTimeAsync(1)
    expect(access).toHaveBeenCalledTimes(2)
    expect(gate.revoked).toBe(true)
  })

  it('a paused wait ends on the next push, or after the fallback cadence when disconnected', async () => {
    vi.useFakeTimers()
    const gate = new ToolApprovalGate('run', { isLive: () => true }, 'push')
    gates.push(gate)
    const signal = new AbortController().signal
    let woke = 0
    void gate.changed(signal).then(() => { woke++ })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(woke).toBe(0)
    gate.invalidate()
    await vi.advanceTimersByTimeAsync(0)
    expect(woke).toBe(1)
    gate.setControlMode('fallback')
    void gate.changed(signal).then(() => { woke++ })
    await vi.advanceTimersByTimeAsync(RUN_CONTROL_FALLBACK_MS)
    expect(woke).toBe(2)
  })
})
