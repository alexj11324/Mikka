import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { createLogger } from '../src/log'
import { makeRepo, tempDir } from './helpers'

it.each(['codex','claude_code'] as const)('refuses an already-stale %s assignment before filesystem, credential or CLI startup', async harness => {
  const stateDir=tempDir('mikka-stale-admission-')
  const gate=new ToolApprovalGate('stale-run',{permission:()=> 'allow',ask:async()=> 'allow',isLive:()=>false})
  const token=vi.fn(async()=>({accessToken:'synthetic-not-to-be-read',accountId:'fixture-account',chatgptAccountId:'fixture-account',expiresAt:new Date(Date.now()+60000).toISOString()}))
  const host={stateDir,sandbox:new NoSandbox(),binary:join(stateDir,'must-not-start'),subscriptionAuth:{accountId:'fixture-account',token}}
  const adapter=harness==='codex' ? new CodexAdapter(host) : new ClaudeAdapter(host)
  await expect(adapter.start({runId:gate.runId,cwd:await makeRepo(),prompt:'No provider or CLI invocation',env:{PATH:process.env.PATH??''},log:createLogger({level:'silent'}),toolApproval:gate})).rejects.toThrow('Run tool approval unavailable')
  expect(token).not.toHaveBeenCalled()
  expect(existsSync(join(stateDir,'runs',gate.runId))).toBe(false)
  expect(gate.revoked).toBe(true)
})
