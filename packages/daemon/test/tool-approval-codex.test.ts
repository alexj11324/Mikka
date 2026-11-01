import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate, type ToolApprovalRequest } from '../src/agents/tool-approval'
import { toolApprovalDecision } from '../src/agents/tool-approval-policy'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { CodexAdapter } from '../src/adapters/codex'
import { createLogger } from '../src/log'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
it.each(['allow', 'deny'] as const)('uses trusted %s only for the exact live Codex request over JSON-RPC', async decision => {
  const cwd = await makeRepo()
  const ask = vi.fn(async () => decision)
  const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask, isLive: () => true })
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'APPROVAL_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  const result = JSON.parse(output)
  expect(result.first.decision).toBe(decision === 'allow' ? 'accept' : 'decline')
  expect(result.replay.decision).toBe('decline')
  expect(result.foreign.decision).toBe('decline')
  expect(ask).toHaveBeenCalledOnce()
})

it('cancels a pending JSON-RPC approval without waiting for a late host reply', async () => {
  const cwd = await makeRepo()
  let release!: (value: 'allow' | 'deny') => void
  let signal: AbortSignal | undefined
  const asked = vi.fn((_request: unknown, abort: AbortSignal) => { signal = abort; return new Promise<'allow' | 'deny'>(r => { release = r }) })
  const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask: asked, isLive: () => true })
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'APPROVAL_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  await vi.waitFor(() => expect(asked).toHaveBeenCalledOnce())
  await session.cancel()
  expect(signal?.aborted).toBe(true)
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(events.at(-1)).toEqual({type:'exit',outcome:'cancelled'})
  release('allow')
  expect(await gate.request({ runId: 'run-1', requestId: 'after-stop', harness: 'codex', method: 'synthetic', input: {} })).toBe('deny')
})

it('distinguishes official subcommand approval IDs within the same item, while rejecting replay', async () => {
  const cwd = await makeRepo()
  const ask = vi.fn(async () => 'allow' as const)
  const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask, isLive: () => true })
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'APPROVAL_IDS_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  const result = JSON.parse(output)
  expect(result.first.decision).toBe('accept')
  expect(result.second.decision).toBe('accept')
  expect(result.replay.decision).toBe('decline')
  expect(result.fileGrant.decision).toBe('cancel')
  expect(result.noExactAccept.decision).toBe('cancel')
  expect(ask).toHaveBeenCalledTimes(2)
})

it.each(['allow', 'ask', 'deny', 'readOnly'] as const)('scopes native computer elicitation to one observed live item under %s policy', async permission => {
  const cwd = await makeRepo()
  const policy = defaultRunPolicy()
  policy.permissions.computer_use = permission === 'readOnly' ? 'allow' : permission
  policy.readOnly = permission === 'readOnly'
  const checkPermission = vi.fn((request: Readonly<ToolApprovalRequest>) => toolApprovalDecision(request, policy, cwd))
  const ask = vi.fn(async () => 'deny' as const)
  const gate = new ToolApprovalGate('run-1', { permission: checkPermission, ask, isLive: () => true })
  // This fixture exercises only adapter/native-RPC identity and replay checks;
  // no broker, desktop driver or provider is launched by the synthetic CLI.
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs'),
    computerMcp: { command: process.execPath, args: [resolve(import.meta.dirname, '../src/computer/proxy.mjs'), 'tcp://127.0.0.1:32123', 'synthetic-request-only-token'], env: {} },
  })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'MCP_ELICITATION_TEST', policy, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  const result = JSON.parse(output)
  const permitted = permission === 'allow' || permission === 'ask'
  expect(result.first).toEqual(permitted ? { action: 'accept', content: {} } : { action: 'decline' })
  for (const name of ['foreignThread', 'foreignTurn', 'unknownServer', 'replay', 'afterCompletion']) expect(result[name]).toEqual({ action: 'decline' })
  expect(checkPermission.mock.calls.length).toBeLessThanOrEqual(1)
  if (permitted) expect(checkPermission).toHaveBeenCalledOnce()
  expect(checkPermission.mock.calls.every(([request]) => request.method === 'cli/mcp__mikka_computer__get_desktop_state')).toBe(true)
  expect(ask).not.toHaveBeenCalled()
})

it.each([['MIKKA_ELICITATION_TEST', 'submit'], ['MIKKA_CONTEXT_ELICITATION_TEST', 'request_help']] as const)('permits the fixed Mikka %s hand-in without a computer spec or action ask', async (prompt, tool) => {
  const cwd = await makeRepo(), stateDir = tempDir()
  const policy = defaultRunPolicy()
  policy.permissions.computer_use = 'deny'
  const checkPermission = vi.fn((request: Readonly<ToolApprovalRequest>) => toolApprovalDecision(request, policy, cwd))
  const ask = vi.fn(async () => 'deny' as const)
  const gate = new ToolApprovalGate('run-1', { permission: checkPermission, ask, isLive: () => true })
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir, userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs') })
  // The fake emits native approval frames only; it never calls the hand-in MCP
  // server, contacts a provider, or writes a handoff file in this case.
  const session = await adapter.start({ runId: 'run-1', cwd, prompt, policy, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  const result = JSON.parse(output)
  expect(result.first).toEqual({ action: 'accept', content: {} })
  for (const name of ['foreignThread', 'foreignTurn', 'unknownServer', 'replay', 'afterCompletion']) expect(result[name]).toEqual({ action: 'decline' })
  expect(checkPermission).toHaveBeenCalledOnce()
  expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({ method: `cli/mcp__mikka__${tool}`, input: {} }))
  expect(ask).not.toHaveBeenCalled()
  expect(existsSync(join(stateDir, 'runs', 'run-1', 'handoff.json'))).toBe(false)
})


it('refuses an unregistered Mikka tool before consulting transport policy', async () => {
  const cwd = await makeRepo(), policy = defaultRunPolicy()
  const permission = vi.fn((request: Readonly<ToolApprovalRequest>) => toolApprovalDecision(request, policy, cwd))
  const ask = vi.fn(async () => 'deny' as const)
  const gate = new ToolApprovalGate('run-1', { permission, ask, isLive: () => true })
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'MIKKA_UNKNOWN_ELICITATION_TEST', policy, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  for (const value of Object.values(JSON.parse(output))) expect(value).toEqual({ action: 'decline' })
  expect(permission).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled()
})
