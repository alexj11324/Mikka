import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { ClaudeAdapter } from '../src/adapters/claude'
import { createLogger } from '../src/log'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
it.each(['allow', 'deny'] as const)('uses host %s for the exact Claude SDK permission request', async decision => {
  const cwd = await makeRepo()
  const ask = vi.fn(async () => decision)
  const gate = new ToolApprovalGate('run-1', { permission: () => 'ask', ask, isLive: () => true })
  const adapter = new ClaudeAdapter({ stateDir: tempDir(), configDir: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-claude.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'APPROVAL_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  const result = JSON.parse(output)
  expect(result.first.behavior).toBe(decision)
  expect(result.replay.behavior).toBe('deny')
  expect(ask).toHaveBeenCalledOnce()
})
