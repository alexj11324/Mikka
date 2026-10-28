import { describe, expect, it, vi } from 'vitest'
import { requireRunToolApproval, ToolApprovalGate, type ToolApprovalRequest } from './tool-approval'

const request = (id = 'call-1', runId = 'run-1'): ToolApprovalRequest => ({ runId, requestId: id, harness: 'codex', method: 'item/commandExecution/requestApproval', input: { command: 'synthetic' } })
const deferred = () => { let resolve!: (value: 'allow' | 'deny') => void; const promise = new Promise<'allow' | 'deny'>(r => { resolve = r }); return { promise, resolve } }

describe('run-bound tool approval', () => {
  it('requires a gate bound to the exact run', () => {
    const gate = new ToolApprovalGate('run-1', { permission: () => 'deny', ask: async () => 'deny', isLive: () => true })
    expect(requireRunToolApproval('run-1', gate)).toBe(gate)
    expect(() => requireRunToolApproval('run-2', gate)).toThrow('unavailable')
    expect(() => requireRunToolApproval('run-1')).toThrow('unavailable')
  })
  it('lets trusted allow pass, rejects deny, and never asks for either', async () => {
    const ask = vi.fn(async () => 'allow' as const)
    const permission = vi.fn().mockReturnValueOnce('allow').mockReturnValueOnce('deny')
    const gate = new ToolApprovalGate('run-1', { permission, ask, isLive: () => true })
    expect(await gate.request(request('a'))).toBe('allow')
    expect(await gate.request(request('b'))).toBe('deny')
    expect(ask).not.toHaveBeenCalled()
  })
  it('holds ask until host makes an exact decision, accepts only once', async () => {
    const answer = deferred(); const ask = vi.fn(() => answer.promise)
    const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask, isLive: () => true })
    let settled = false
    const pending = gate.request(request()).then(value => { settled = true; return value })
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(await gate.request(request())).toBe('deny')
    answer.resolve('allow')
    expect(await pending).toBe('allow')
    expect(await gate.request(request())).toBe('deny')
  })
  it('unblocks cancellation while an uncooperative host is still pending', async () => {
    const answer = deferred(); const ask = vi.fn(() => answer.promise)
    const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask, isLive: () => true })
    const abort = new AbortController()
    const pending = gate.request(request('waiting'), abort.signal)
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce())
    abort.abort()
    expect(await pending).toBe('deny')
    answer.resolve('allow')
    expect(await gate.request(request('waiting'))).toBe('deny')
  })
  it('cannot allow when revocation happens during the final live check', async () => {
    const live = deferred(); let checks = 0
    const gate = new ToolApprovalGate('run-1', { permission: () => 'allow', ask: async () => 'deny', isLive: () => ++checks === 1 ? true : live.promise.then(() => true) })
    const pending = gate.request(request('race'))
    await vi.waitFor(() => expect(checks).toBe(2))
    gate.revoke(); live.resolve('allow')
    expect(await pending).toBe('deny')
  })
  it('rejects foreign run, explicit denial, cancellation and revocation, including late allow', async () => {
    const answer = deferred(); let live = true
    const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask: () => answer.promise, isLive: () => live })
    expect(await gate.request(request('foreign', 'run-old'))).toBe('deny')
    const abort = new AbortController()
    const cancelled = gate.request(request('cancel'), abort.signal)
    await Promise.resolve(); abort.abort(); answer.resolve('allow')
    expect(await cancelled).toBe('deny')
    const next = deferred()
    const revoked = new ToolApprovalGate('run-1', { permission: () => 'ask', ask: () => next.promise, isLive: () => live })
    const pending = revoked.request(request('revoke'))
    await Promise.resolve(); live = false; revoked.revoke(); next.resolve('allow')
    expect(await pending).toBe('deny')
    const denied = new ToolApprovalGate('run-1', { permission: () => 'ask', ask: async () => 'deny', isLive: () => true })
    expect(await denied.request(request('deny'))).toBe('deny')
  })
})
