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

describe('thread mode approvals (#1730)', () => {
  const request = { requestId: 'turn-1', method: 'tool' as const, tool: 'Bash', input: { command: 'npm test' } }

  it('a policy that asks nothing keeps the old live-run behavior', async () => {
    let asked = 0
    const gate = new ToolApprovalGate('run-1', { isLive: () => true, requestApproval: async () => { asked++; return 'approved' } })
    expect(gate.asksAny).toBe(false)
    expect(await gate.requestApproval(request)).toBe(true)
    expect(asked).toBe(0)
  })

  it('a policy asking for an action the gate does not cover still asks nothing', async () => {
    // `write_outside_repo` is enforced by the sandbox, not a CLI callback, so
    // it is not gate-expressible and must not turn the gate on.
    let asked = 0
    const gate = new ToolApprovalGate('run-1', { isLive: () => true, requestApproval: async () => { asked++; return 'approved' } }, 'legacy', [])
    expect(await gate.requestApproval(request, undefined, 'write_outside_repo')).toBe(true)
    expect(asked).toBe(0)
  })

  it('an asking policy fails closed without a transport, on a denial and after revocation', async () => {
    const asks = ['install_dependency']
    const missing = new ToolApprovalGate('run-1', { isLive: () => true }, 'legacy', asks)
    expect(missing.asksAny).toBe(true)
    expect(await missing.requestApproval(request, undefined, 'install_dependency')).toBe(false)
    const denied = new ToolApprovalGate('run-1', { isLive: () => true, requestApproval: async () => 'denied' }, 'legacy', asks)
    expect(await denied.requestApproval(request, undefined, 'install_dependency')).toBe(false)
    const approved = new ToolApprovalGate('run-1', { isLive: () => true, requestApproval: async () => 'approved' }, 'legacy', asks)
    expect(await approved.requestApproval(request, undefined, 'install_dependency')).toBe(true)
    approved.revoke()
    expect(await approved.requestApproval(request, undefined, 'install_dependency')).toBe(false)
  })

  it('Ask never treats a transport error or an aborted turn as approval', async () => {
    const failing = new ToolApprovalGate('run-1', { isLive: () => true, requestApproval: async () => { throw new Error('offline') } }, 'legacy', ['install_dependency'])
    expect(await failing.requestApproval(request)).toBe(false)
    const hanging = new ToolApprovalGate('run-1', { isLive: () => true, requestApproval: () => new Promise(() => {}) }, 'legacy', ['install_dependency'])
    const abort = new AbortController()
    const pending = hanging.requestApproval(request, abort.signal)
    abort.abort()
    expect(await pending).toBe(false)
  })
})
