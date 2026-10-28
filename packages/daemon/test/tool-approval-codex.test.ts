import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
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
