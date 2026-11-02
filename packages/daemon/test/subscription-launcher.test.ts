// Synthetic account/CLI protocol only. Docker/SRT enforcement is accepted in
// their separate real-runtime suites; this test exercises the exported seam.
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { subscriptionFixture } from '../../../tests/fixtures/subscription'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { NoSandbox } from '../src/agents/sandbox'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import { launchHostedSubscription } from '../src/subscription-launcher'
import { makeRepo, tempDir } from './helpers'

it('preserves successful native completion when the adapter revokes its completed run gate', async () => {
  const {use,access}=subscriptionFixture('codex_cli')
  access.connection!.quota.observedAt=new Date().toISOString()
  const gate=new ToolApprovalGate('completed-policy-run',{isLive:()=>true})
  const session=await launchHostedSubscription(use,{
    runId:gate.runId,toolApproval:gate,cwd:await makeRepo(),prompt:'hello',model:'fixture-model',
    env:buildChildEnv({host:{PATH:process.env.PATH,HOME:tempDir('mikka-completed-owner-')}}),log:createLogger({level:'silent'}),
  },{
    access:async()=>access,worker:{call:async<T>()=>({accessToken:'fixture-access',chatgptAccountId:'fixture-account',expiresAt:new Date(Date.now()+60000).toISOString()}) as T},
    stateDir:tempDir('mikka-completed-state-'),sandbox:new NoSandbox(),codexBinary:resolve(import.meta.dirname,'fakes/fake-codex-subscription.mjs'),
  })
  try {
    const events=[];for await(const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({type:'exit',outcome:'succeeded'})
    expect(events.filter(event=>event.type==='exit')).toHaveLength(1)
    expect(gate.revoked).toBe(true)
  } finally {await session.cancel()}
})

it('cancels a standalone native session when its gate ceases to be live without an HTTP monitor', async () => {
  const { use, access } = subscriptionFixture('claude_code_cli')
  access.connection!.quota.observedAt = new Date().toISOString()
  let live = true
  const gate = new ToolApprovalGate('standalone-policy-run', { isLive:()=>live })
  const credential = vi.fn(async () => ({ accountId:'fixture-account', accessToken:'fixture-access', expiresAt:new Date(Date.now()+60000).toISOString() }))
  const home = tempDir('mikka-standalone-owner-')
  const session = await launchHostedSubscription(use, {
    runId:gate.runId, toolApproval:gate, cwd:await makeRepo(), prompt:'HANG', model:'fixture-model',
    env:buildChildEnv({host:{PATH:process.env.PATH,HOME:home}}), log:createLogger({level:'silent'}),
  }, {
    access:async()=>access, worker:{call:async<T>()=> await credential() as T},
    stateDir:tempDir('mikka-standalone-state-'), sandbox:new NoSandbox(),
    claudeBinary:resolve(import.meta.dirname,'fakes/fake-claude-subscription.mjs'), revocationPollMs:25,
  })
  const finished = (async () => { const events=[]; for await(const event of session.events()) events.push(event); return events })()
  try {
    expect(gate.revoked).toBe(false)
    live=false
    await vi.waitFor(()=>expect(gate.revoked).toBe(true))
    const events=await finished
    expect(events.at(-1)).toMatchObject({type:'exit',outcome:'cancelled'})
    expect(credential).toHaveBeenCalledOnce()
    expect(()=>session.send('late work')).toThrow('Run tool approval unavailable')
  } finally { await session.cancel() }
})
