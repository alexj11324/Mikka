import { describe, expect, it } from 'vitest'
import { requireRunToolApproval, ToolApprovalGate } from './tool-approval'

describe('run live gate', () => {
  it('exposes irreversible revocation for the adapter response handoff', () => {
    const gate = new ToolApprovalGate('run-1', { isLive: () => true })
    expect(gate.revoked).toBe(false)
    gate.revoke()
    expect(gate.revoked).toBe(true)
    expect(() => requireRunToolApproval('run-1',gate)).toThrow('Run tool approval unavailable')
    gate.revoke()
    expect(gate.revoked).toBe(true)
  })
  it('requires a gate bound to the exact run', () => {
    const gate = new ToolApprovalGate('run-1', { isLive: () => true })
    expect(requireRunToolApproval('run-1', gate)).toBe(gate)
    expect(() => requireRunToolApproval('run-2', gate)).toThrow('unavailable')
    expect(() => requireRunToolApproval('run-1')).toThrow('unavailable')
  })
  it('is live only while the host says so and until revoked', async () => {
    let live = true
    const gate = new ToolApprovalGate('run-1', { isLive: () => live })
    expect(await gate.checkLive()).toBe(true)
    live = false
    expect(await gate.checkLive()).toBe(false)
    live = true
    let called = 0
    gate.onRevoke(() => { called++ })
    gate.revoke()
    expect(called).toBe(1)
    expect(await gate.checkLive()).toBe(false)
  })
})
