import { expect, it, vi } from 'vitest'
import { ToolApprovalGate } from './tool-approval'
import { runNetworkApproval } from './run-network'

it('keeps decisions within the immutable maximum and the exact run', async () => {
  const ask = vi.fn(async () => 'allow' as const)
  const gate = new ToolApprovalGate('run-a',{permission:()=> 'ask',ask,isLive:()=>true})
  const signal = new AbortController().signal
  const network = runNetworkApproval('run-a','codex',gate,['example.invalid:443'])
  expect(await network({host:'example.invalid',port:80},signal)).toBe(false)
  expect(await network({host:'other.invalid',port:443},signal)).toBe(false)
  expect(ask).not.toHaveBeenCalled()
  expect(await network({host:'example.invalid',port:443},signal)).toBe(true)
  expect(ask).toHaveBeenCalledOnce()
  expect(() => runNetworkApproval('run-b','codex',gate,['*'])).toThrow('scope')
  gate.revoke()
  expect(await network({host:'example.invalid',port:443},signal)).toBe(false)
})

it('checks live authority even for provider destinations and never widens the ceiling', async () => {
  const live = vi.fn(()=>false), ask=vi.fn(async()=> 'allow' as const)
  const gate = new ToolApprovalGate('run-a',{permission:()=> 'deny',ask,isLive:live})
  const signal = new AbortController().signal
  expect(await runNetworkApproval('run-a','codex',gate,['api.openai.com'])({host:'api.openai.com',port:443},signal)).toBe(false)
  expect(live).toHaveBeenCalledOnce()
  expect(await runNetworkApproval('run-a','codex',gate,[])({host:'api.openai.com',port:443},signal)).toBe(false)
  expect(ask).not.toHaveBeenCalled()
})

it('fences cancellation during a pending exact destination decision', async () => {
  let finish!: (value:'allow')=>void
  const ask=vi.fn(()=>new Promise<'allow'>(resolve=>{finish=resolve}))
  const gate = new ToolApprovalGate('run-a',{permission:()=> 'ask',ask,isLive:()=>true})
  const controller = new AbortController()
  const pending = runNetworkApproval('run-a','codex',gate,['example.invalid'])({host:'example.invalid',port:443},controller.signal)
  await vi.waitFor(()=>expect(ask).toHaveBeenCalledOnce())
  controller.abort()
  expect(await pending).toBe(false)
  finish('allow')
})

it('routes only the trusted computer broker transport without a second approval', async () => {
  const live = vi.fn(() => true), ask = vi.fn(async () => 'allow' as const)
  const gate = new ToolApprovalGate('run-a',{permission:()=> 'deny',ask,isLive:live})
  const signal = new AbortController().signal
  const network = runNetworkApproval('run-a','claude_code',gate,['127.0.0.1:32123'],'127.0.0.1:32123')
  expect(await network({host:'127.0.0.1',port:32123},signal)).toBe(true)
  expect(await network({host:'127.0.0.1',port:32124},signal)).toBe(false)
  expect(await runNetworkApproval('run-a','claude_code',gate,[],'127.0.0.1:32123')({host:'127.0.0.1',port:32123},signal)).toBe(false)
  expect(ask).not.toHaveBeenCalled()
  live.mockReturnValue(false)
  expect(await network({host:'127.0.0.1',port:32123},signal)).toBe(false)
  gate.revoke()
  expect(await network({host:'127.0.0.1',port:32123},signal)).toBe(false)
  for (const endpoint of ['example.invalid:443','127.0.0.1:0','127.0.0.1:65536']) expect(() => runNetworkApproval('run-a','codex',gate,['*'],endpoint)).toThrow()
})
