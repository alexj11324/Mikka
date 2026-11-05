import { afterEach, expect, it, vi } from 'vitest'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { RunAuthorityLease, type RunAuthorityChallenge, type RunAuthorityGrant, type RunAuthoritySource } from '../src/agents/run-authority'

afterEach(()=>vi.useRealTimers())
function time() { vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']}) }
function grant(challenge:RunAuthorityChallenge,extra:Partial<RunAuthorityGrant>={}):RunAuthorityGrant {
  return {...challenge,live:true,validForMs:10_000,...extra}
}

it('expires an initially silent source without any chunk or operation',async()=>{
  time()
  const unavailable=vi.fn()
  let signal:AbortSignal|undefined
  const lease=new RunAuthorityLease('run',async(_,s)=>{signal=s;return new Promise(()=>{})},unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(signal?.aborted).toBe(true)
  expect(await lease.ready).toBe(false)
  expect(lease.current).toBe(false)
})

it('measures the lease from sending, not from receiving a delayed success',async()=>{
  time()
  let reply!:(grant:RunAuthorityGrant)=>void,challenge!:RunAuthorityChallenge
  const unavailable=vi.fn()
  const lease=new RunAuthorityLease('run',async c=>{challenge=c;return new Promise(r=>{reply=r})},unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(600)
  reply(grant(challenge))
  await vi.advanceTimersByTimeAsync(1)
  expect(lease.current).toBe(true)
  await vi.advanceTimersByTimeAsync(399)
  expect(lease.current).toBe(false)
  expect(unavailable).toHaveBeenCalledTimes(1)
})

it('never revives a stopped lease when a late response arrives',async()=>{
  time()
  let reply!:(grant:RunAuthorityGrant)=>void,challenge!:RunAuthorityChallenge
  const unavailable=vi.fn()
  const lease=new RunAuthorityLease('run',async c=>{challenge=c;return new Promise(r=>{reply=r})},unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(1000)
  reply(grant(challenge))
  await vi.advanceTimersByTimeAsync(1000)
  expect(lease.current).toBe(false)
  expect(unavailable).toHaveBeenCalledTimes(1)
})

it.each([
  ['replayed nonce',{nonce:'old'}],['wrong run',{runId:'foreign'}],['refusal',{live:false}],
  ['expired',{validForMs:0}],['invalid duration',{validForMs:Infinity}],
] as const)('refuses %s without extending current authority',async(_,changed)=>{
  time()
  const unavailable=vi.fn()
  const lease=new RunAuthorityLease('run',async c=>grant(c,changed),unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(1)
  expect(lease.current).toBe(false)
  expect(unavailable).toHaveBeenCalledTimes(1)
})

it('uses natural expiry even when no database mutation or hint arrives',async()=>{
  time()
  const unavailable=vi.fn()
  const lease=new RunAuthorityLease('run',async c=>grant(c,{validForMs:50}),unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(49)
  expect(lease.current).toBe(true)
  await vi.advanceTimersByTimeAsync(2)
  expect(lease.current).toBe(false)
  expect(unavailable).toHaveBeenCalledTimes(1)
})

it('fails closed on an invalid transport frame without an unhandled rejection',async()=>{
  time()
  const unavailable=vi.fn()
  const lease=new RunAuthorityLease('run',async()=>null as unknown as RunAuthorityGrant,unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(1)
  expect(lease.current).toBe(false)
  expect(unavailable).toHaveBeenCalledTimes(1)
})

it('terminates immediately on a failed source and does not turn reconnection into a renewal',async()=>{
  time()
  let reject=false
  const unavailable=vi.fn()
  const lease=new RunAuthorityLease('run',async c=>{if(reject)throw Error('source lost');return grant(c)},unavailable)
  lease.start()
  await vi.advanceTimersByTimeAsync(1)
  expect(lease.current).toBe(true)
  reject=true;lease.invalidate()
  await vi.advanceTimersByTimeAsync(1)
  expect(lease.current).toBe(false)
  reject=false;lease.invalidate()
  await vi.advanceTimersByTimeAsync(1000)
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(lease.current).toBe(false)
})

it('keeps actual operations fresh while replacing only the negotiated background host check',async()=>{
  time()
  const host={isLive:vi.fn(async()=>true)}
  const source=vi.fn<RunAuthoritySource>(async c=>grant(c))
  const gate=new ToolApprovalGate('run',host,source)
  gate.monitor()
  await vi.advanceTimersByTimeAsync(2000)
  expect(gate.revoked).toBe(false)
  expect(host.isLive).not.toHaveBeenCalled()
  expect(source.mock.calls.length).toBeGreaterThan(1)
  expect(await gate.checkLive()).toBe(true)
  expect(await gate.checkLive()).toBe(true)
  expect(host.isLive).toHaveBeenCalledTimes(2)
  gate.revoke()
})

it('retains the legacy background host checks when no bounded source was negotiated',async()=>{
  time()
  const host={isLive:vi.fn(async()=>true)}
  const gate=new ToolApprovalGate('run',host)
  gate.monitor()
  await vi.advanceTimersByTimeAsync(2001)
  expect(host.isLive).toHaveBeenCalledTimes(2)
  expect(gate.revoked).toBe(false)
  gate.revoke()
})
