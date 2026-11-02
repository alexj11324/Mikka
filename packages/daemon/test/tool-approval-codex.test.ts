import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { CodexAdapter } from '../src/adapters/codex'
import { createLogger } from '../src/log'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

// Decision 2026-11-01-2335: Codex runs with approvals "never" and no sandbox
// (the fake refuses any other thread/start). A native request that still
// arrives goes ahead while the run is live, bound to its own thread and turn.
afterEach(cleanupTempDirs)
const output = async (session: Awaited<ReturnType<CodexAdapter['start']>>) => {
  let text = ''
  for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') text += event.chunk.delta
  return JSON.parse(text)
}
const adapter = (extra = {}) => new CodexAdapter({ sandbox: new NoSandbox(), stateDir: tempDir(), userHome: tempDir(), binary: resolve(import.meta.dirname, 'fakes/fake-codex.mjs'), ...extra })

it.each([true, false])('accepts a native command request only for its own live turn (live: %s)', async live => {
  const cwd = await makeRepo()
  let calls = 0
  const gate = new ToolApprovalGate('run-1', { isLive: () => ++calls === 1 || live })
  const session = await adapter().start({ runId: 'run-1', cwd, prompt: 'APPROVAL_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  const result = await output(session)
  expect(result.first.decision).toBe(live ? 'accept' : 'decline')
  expect(result.foreign.decision).toBe('decline')
})

it('never turns a native request into a session or root-wide grant', async () => {
  const cwd = await makeRepo()
  const gate = new ToolApprovalGate('run-1', { isLive: () => true })
  const session = await adapter().start({ runId: 'run-1', cwd, prompt: 'APPROVAL_IDS_TEST', env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  const result = await output(session)
  expect(result.first.decision).toBe('accept')
  expect(result.second.decision).toBe('accept')
  expect(result.fileGrant.decision).toBe('cancel')
  expect(result.noExactAccept.decision).toBe('cancel')
})

it.each(['allow', 'ask', 'deny', 'readOnly'] as const)('scopes native computer elicitation to one observed live item under %s policy', async permission => {
  const cwd = await makeRepo()
  const policy = defaultRunPolicy()
  policy.permissions.computer_use = permission === 'readOnly' ? 'allow' : permission
  policy.readOnly = permission === 'readOnly'
  const gate = new ToolApprovalGate('run-1', { isLive: () => true })
  // The computer broker owns computer permission; the CLI transport asks nothing.
  const session = await adapter({
    computerMcp: { command: process.execPath, args: [resolve(import.meta.dirname, '../src/computer/proxy.mjs'), 'tcp://127.0.0.1:32123', 'synthetic-request-only-token'], env: {} },
  }).start({ runId: 'run-1', cwd, prompt: 'MCP_ELICITATION_TEST', policy, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  const result = await output(session)
  expect(result.first).toEqual({ action: 'accept', content: {} })
  for (const name of ['foreignThread', 'foreignTurn', 'unknownServer', 'replay', 'afterCompletion']) expect(result[name]).toEqual({ action: 'decline' })
})

it.each(['MIKKA_ELICITATION_TEST', 'MIKKA_CONTEXT_ELICITATION_TEST'] as const)('permits the fixed Mikka hand-in without a computer spec: %s', async prompt => {
  const cwd = await makeRepo(), stateDir = tempDir()
  const policy = defaultRunPolicy()
  policy.permissions.computer_use = 'deny'
  const gate = new ToolApprovalGate('run-1', { isLive: () => true })
  const session = await adapter({ stateDir }).start({ runId: 'run-1', cwd, prompt, policy, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  const result = await output(session)
  expect(result.first).toEqual({ action: 'accept', content: {} })
  for (const name of ['foreignThread', 'foreignTurn', 'unknownServer', 'replay', 'afterCompletion']) expect(result[name]).toEqual({ action: 'decline' })
  expect(existsSync(join(stateDir, 'runs', 'run-1', 'handoff.json'))).toBe(false)
})

it('refuses an unregistered Mikka tool', async () => {
  const cwd = await makeRepo(), policy = defaultRunPolicy()
  const gate = new ToolApprovalGate('run-1', { isLive: () => true })
  const session = await adapter().start({ runId: 'run-1', cwd, prompt: 'MIKKA_UNKNOWN_ELICITATION_TEST', policy, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  for (const value of Object.values(await output(session))) expect(value).toEqual({ action: 'decline' })
})
