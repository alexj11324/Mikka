import { afterEach, expect, it, vi } from 'vitest'
import { ToolApprovalGate } from '../src/agents/tool-approval'

// Run control is pushed (decision 2026-11-17-2215): a gate checks on a push
// (invalidate) or at a watcher's own due time, never on a cadence.

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

it('has no timer: an idle watched run is never checked, and a push revokes at once', async () => {
  vi.useFakeTimers()
  let live = true
  const host = { isLive: vi.fn(() => live) }
  const gate = create(host)
  gate.watch()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(host.isLive).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  live = false
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  expect(host.isLive).toHaveBeenCalledTimes(1)
  expect(gate.revoked).toBe(true)
})

it('shares one fresh check per push across runtime monitors without caching operation authority', async () => {
  vi.useFakeTimers()
  const host = { isLive: vi.fn(() => true) }
  const gate = create(host)
  const credentials = vi.fn(async () => {})
  const access = vi.fn(async () => {})
  gate.watch()
  gate.watch(credentials)
  gate.watch(access)
  for (let i = 0; i < 3; i++) { gate.invalidate(); await vi.advanceTimersByTimeAsync(0) }
  expect(host.isLive).toHaveBeenCalledTimes(3)
  expect(credentials).toHaveBeenCalledTimes(3)
  expect(access).toHaveBeenCalledTimes(3)
  expect(await gate.checkLive()).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(4)
})

it('does not let slow credential checks postpone stop or lease revocation', async () => {
  vi.useFakeTimers()
  let live = true
  const pending = deferred<void>()
  const gate = create({ isLive: () => live })
  const credentials = vi.fn(() => pending.promise)
  gate.watch(credentials)
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  expect(credentials).toHaveBeenCalledTimes(1)
  live = false
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
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

it('retains monitoring until the final owner leaves', async () => {
  vi.useFakeTimers()
  const host = { isLive: vi.fn(() => true) }
  const gate = create(host)
  const offRuntime = gate.watch()
  const offTransport = gate.watch()
  offRuntime()
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  expect(host.isLive).toHaveBeenCalledTimes(1)
  offTransport()
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(5000)
  expect(host.isLive).toHaveBeenCalledTimes(1)
})

it('a watcher runs again at the due time it returns (a token expiry), not on a cadence', async () => {
  vi.useFakeTimers()
  const gate = create({ isLive: () => true })
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

it('a seeded due time runs a watcher once at that time without any push', async () => {
  vi.useFakeTimers()
  const gate = create({ isLive: () => true })
  const due = Date.now() + 60_000
  const context = vi.fn(async () => undefined)
  gate.watch(context, { dueAt: due })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(context).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(context).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(context).toHaveBeenCalledOnce()
})

it('a paused wait ends only on the next push', async () => {
  vi.useFakeTimers()
  const gate = create({ isLive: () => true })
  const signal = new AbortController().signal
  let woke = 0
  void gate.changed(signal).then(() => { woke++ })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(woke).toBe(0)
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(0)
  expect(woke).toBe(1)
})
