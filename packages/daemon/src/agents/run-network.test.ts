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

it('fences cancellation while current policy is being checked', async () => {
  let finish!: (value:'ask')=>void
  const permission=vi.fn(()=>new Promise<'ask'>(resolve=>{finish=resolve}))
  const ask=vi.fn(async()=> 'allow' as const)
  const gate = new ToolApprovalGate('run-a',{permission,ask,isLive:()=>true})
  const controller = new AbortController()
  const pending = runNetworkApproval('run-a','codex',gate,['example.invalid'])({host:'example.invalid',port:443},controller.signal)
  await vi.waitFor(()=>expect(permission).toHaveBeenCalledOnce())
  controller.abort()
  expect(await pending).toBe(false)
  finish('ask')
  expect(ask).not.toHaveBeenCalled()
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

it('obtains one scoped grant and reuses it without exhausting mutation receipts', async () => {
  let live=true, decision:'allow'|'ask'|'deny'='ask'
  const ask=vi.fn(async()=> 'allow' as const)
  const gate=new ToolApprovalGate('run-a',{permission:()=>decision,ask,isLive:()=>live})
  const network=runNetworkApproval('run-a','codex',gate,['example.invalid:443'])
  const signal=new AbortController().signal
  for(let i=0;i<2048;i++) expect(await network({host:'example.invalid',port:443},signal)).toBe(true)
  expect(ask).toHaveBeenCalledOnce()
  decision='deny'
  expect(await network({host:'example.invalid',port:443},signal)).toBe(false)
  decision='allow';live=false
  expect(await network({host:'example.invalid',port:443},signal)).toBe(false)
  live=true
  // Network checks cannot exhaust the ordinary action replay guard.
  expect(await gate.request({runId:'run-a',harness:'codex',requestId:'first-action',method:'cli/Write',input:{}})).toBe('allow')
})

it('cannot use the pre-authorized transport for another run or a mutation', async () => {
  const gate=new ToolApprovalGate('run-a',{permission:()=> 'allow',ask:async()=> 'allow',isLive:()=>true})
  const base={runId:'run-a',harness:'codex' as const,requestId:'x',method:'sandbox/network',input:{host:'example.invalid',port:443}}
  expect(await gate.preapprovedNetwork({...base,runId:'run-b'})).toBe(false)
  expect(await gate.preapprovedNetwork({...base,method:'cli/Bash'})).toBe(false)
  gate.revoke()
  expect(await gate.preapprovedNetwork(base)).toBe(false)
})

it('coalesces explicit ask and never grants a new destination or a later run from that consent', async () => {
  let resolve!: (choice:'allow'|'deny')=>void
  const ask=vi.fn(()=>new Promise<'allow'|'deny'>(done=>{resolve=done}))
  const gate=new ToolApprovalGate('run-a',{permission:()=> 'ask',ask,isLive:()=>true})
  const network=runNetworkApproval('run-a','codex',gate,['*']),signal=new AbortController().signal
  const pending=Array.from({length:12},()=>network({host:'example.invalid',port:443},signal))
  await vi.waitFor(()=>expect(ask).toHaveBeenCalledOnce())
  resolve('allow');expect(await Promise.all(pending)).toEqual(Array.from({length:12},()=>true))
  const other=network({host:'other.invalid',port:443},signal)
  await vi.waitFor(()=>expect(ask).toHaveBeenCalledTimes(2));resolve('deny');expect(await other).toBe(false)
  expect(await network({host:'other.invalid',port:443},signal)).toBe(false)
  expect(ask).toHaveBeenCalledTimes(2)
  const next=new ToolApprovalGate('run-b',{permission:()=> 'ask',ask,isLive:()=>true})
  const fresh=runNetworkApproval('run-b','codex',next,['*'])({host:'example.invalid',port:443},signal)
  await vi.waitFor(()=>expect(ask).toHaveBeenCalledTimes(3));next.revoke();expect(await fresh).toBe(false);resolve('allow')
})
it('cloud allow never creates an approval while explicit deny cannot be bypassed',async()=>{
 let decision:'allow'|'deny'='allow'
 const ask=vi.fn(async()=> 'allow' as const)
 const gate=new ToolApprovalGate('run-a',{permission:()=>decision,ask,isLive:()=>true})
 const network=runNetworkApproval('run-a','codex',gate,['*']),signal=new AbortController().signal
 expect(await network({host:'example.invalid',port:443},signal)).toBe(true)
 decision='deny';expect(await network({host:'example.invalid',port:443},signal)).toBe(false)
 expect(ask).not.toHaveBeenCalled()
})

it('reaches the run\'s Mikka app host without a network ask, inside the ceiling only', async () => {
  const ask = vi.fn(async () => 'allow' as const)
  const gate = new ToolApprovalGate('run-a',{permission:()=> 'deny',ask,isLive:()=>true})
  const signal = new AbortController().signal
  expect(await runNetworkApproval('run-a','claude_code',gate,['mikka.example'],undefined,'mikka.example')({host:'mikka.example',port:443},signal)).toBe(true)
  expect(await runNetworkApproval('run-a','claude_code',gate,[],undefined,'mikka.example')({host:'mikka.example',port:443},signal)).toBe(false)
  expect(await runNetworkApproval('run-a','claude_code',gate,['mikka.example','other.example'],undefined,'mikka.example')({host:'other.example',port:443},signal)).toBe(false)
  expect(ask).not.toHaveBeenCalled()
})
