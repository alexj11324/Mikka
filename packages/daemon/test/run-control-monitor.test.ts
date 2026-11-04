import { afterEach, expect, it, vi } from 'vitest'
import { ToolApprovalGate } from '../src/agents/tool-approval'

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
  gate.monitor()
  gate.monitor(credentials)
  gate.monitor(access)
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
  gate.monitor()
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
  gate.monitor(credentials)
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
  gate.monitor()
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
  gate.monitor(credentials)
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
  gate.monitor()
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
  gate.monitor()
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
  const offRuntime = gate.monitor()
  const offTransport = gate.monitor()
  expect(() => gate.monitor(undefined, 1001)).toThrow()
  offRuntime()
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.isLive).toHaveBeenCalledTimes(1)
  offTransport()
  gate.invalidate()
  await vi.advanceTimersByTimeAsync(5000)
  expect(host.isLive).toHaveBeenCalledTimes(1)
})
