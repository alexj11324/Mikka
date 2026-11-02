import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { ClaudeAdapter } from '../src/adapters/claude'
import { createLogger } from '../src/log'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
it('starts Claude Code in bypassPermissions with its own sandbox off and no permission prompt tool', async () => {
  const cwd = await makeRepo()
  const gate = new ToolApprovalGate('run-1', { isLive: () => true })
  const adapter = new ClaudeAdapter({ stateDir: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-claude.mjs') })
  const session = await adapter.start({ runId: 'run-1', cwd, prompt: 'PERMISSION_MODE_TEST', policy: defaultRunPolicy(), env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  let output = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
  // Decision 2026-11-01-2335: nothing is asked per tool, local and E2B alike.
  expect(JSON.parse(output)).toEqual({ permissionMode: 'bypassPermissions', skipPermissions: true, sandbox: { enabled: false }, permissionPromptTool: null })
})

it('stops the CLI when the run gate is revoked', async () => {
  const cwd = await makeRepo()
  const gate = new ToolApprovalGate('run-2', { isLive: () => true })
  const adapter = new ClaudeAdapter({ stateDir: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-claude.mjs') })
  const session = await adapter.start({ runId: 'run-2', cwd, prompt: 'HANG', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  gate.revoke()
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(events.at(-1)?.type).toBe('exit')
})
