import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultRunPolicy, type RunPolicy } from '@mikka/protocol/agent-policy'
import { ToolApprovalGate, type ToolApprovalRequest } from '../src/agents/tool-approval'
import { toolApprovalDecision } from '../src/agents/tool-approval-policy'
import { ClaudeAdapter } from '../src/adapters/claude'
import { createLogger } from '../src/log'
import { NoSandbox } from '../src/agents/sandbox'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
it.each(['allow', 'deny'] as const)('uses host %s for the exact Claude SDK permission request', async decision => {
  const cwd = await makeRepo()
  const ask = vi.fn(async () => decision)
  const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask, isLive: () => true })
  const adapter = new ClaudeAdapter({ sandbox:new NoSandbox(), stateDir: tempDir(), configDir: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-claude.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'APPROVAL_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  const result = JSON.parse(output)
  expect(result.first.behavior).toBe(decision)
  expect(result.replay.behavior).toBe('deny')
  expect(ask).toHaveBeenCalledOnce()
})

it.each(['ask', 'absent-policy', 'absent-computer-policy', 'deny', 'readOnly', 'unknown-tool'] as const)(
  'applies production computer callback transport policy through the SDK: %s', async scenario => {
    const cwd = await makeRepo()
    const policy: RunPolicy | undefined = scenario === 'absent-policy' ? undefined : defaultRunPolicy()
    if (policy) {
      policy.permissions.computer_use = scenario === 'deny' ? 'deny' : 'ask'
      if (scenario === 'absent-computer-policy') delete policy.permissions.computer_use
      if (scenario === 'readOnly') policy.readOnly = true
    }
    const runId = `computer-${scenario}`
    const permission = vi.fn((request: Readonly<ToolApprovalRequest>) => toolApprovalDecision(request, policy, cwd))
    // A computer action's ask belongs to the broker. The CLI transport must
    // neither ask again nor grant an action; this fixture invokes no broker.
    const ask = vi.fn(async () => 'deny' as const)
    const gate = new ToolApprovalGate(runId, { permission, ask, isLive: id => id === runId })
    const adapter = new ClaudeAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), configDir: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-claude.mjs') })
    const unknown = scenario === 'unknown-tool'
    const session = await adapter.start({
      runId, cwd, policy, toolApproval: gate,
      prompt: unknown ? 'UNKNOWN_COMPUTER_APPROVAL_TEST' : 'COMPUTER_APPROVAL_TEST',
      env: { PATH: process.env.PATH ?? '' }, log: createLogger(),
    })
    let output = ''
    for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
    const result = JSON.parse(output)
    expect(result.first.behavior).toBe(scenario === 'ask' ? 'allow' : 'deny')
    expect(result.replay.behavior).toBe('deny')
    expect(permission).toHaveBeenCalledOnce()
    expect(permission.mock.calls[0]?.[0]).toMatchObject({
      runId, harness: 'claude_code',
      method: `cli/mcp__mikka_computer__${unknown ? 'arbitrary_tool' : 'click'}`,
      input: { x: 1, y: 2 },
    })
    expect(permission.mock.results[0]?.value).toBe(unknown || scenario === 'absent-policy' ? 'unavailable' : scenario === 'ask' ? 'allow' : 'deny')
    expect(ask).not.toHaveBeenCalled()
  },
)
