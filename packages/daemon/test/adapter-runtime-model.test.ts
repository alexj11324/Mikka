import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)

// These synthetic CLIs only emit model observations. Keep every action denied
// while binding the required live host approval bridge to this test's run.
function modelObservationGate(runId: string) {
  return new ToolApprovalGate(runId, {
    permission: () => 'deny',
    ask: async () => 'deny',
    isLive: id => id === runId,
  })
}

it.each(['requested-model', 'protocol-omits-model'])('records only the Codex RPC observed model (%s)', async model => {
  const dataDir = tempDir(), worktree = await makeRepo()
  const binary = resolve(import.meta.dirname, 'fakes/fake-codex.mjs')
  chmodSync(binary, 0o755)
  const adapter = new CodexAdapter({ stateDir: join(dataDir, 'adapters'), sandbox: new NoSandbox(), binary })
  const session = await adapter.start({ runId: 'runtime-test', cwd: worktree, prompt: 'MODEL', model,
    env: buildChildEnv(), log: createLogger(), toolApproval: modelObservationGate('runtime-test') })
  try {
    expect(session.runtimeModel).toBe(model === 'protocol-omits-model' ? null : 'observed:requested-model')
    for await (const event of session.events()) if (event.type === 'exit') {
      expect(event.outcome).toBe('succeeded')
      break
    }
  } finally { await session.cancel() }
})

it('does not replace the Claude root model with a subagent assistant model', async () => {
  const dataDir = tempDir(), worktree = await makeRepo()
  const binary = resolve(import.meta.dirname, 'fakes/fake-claude.mjs')
  chmodSync(binary, 0o755)
  const adapter = new ClaudeAdapter({ stateDir: join(dataDir, 'adapters'), sandbox: new NoSandbox(), configDir: tempDir(), binary })
  const session = await adapter.start({ runId: 'root-model-test', cwd: worktree, prompt: 'MODEL SUBAGENT', model: 'requested-model',
    env: buildChildEnv(), log: createLogger(), toolApproval: modelObservationGate('root-model-test') })
  try {
    for await (const event of session.events()) if (event.type === 'exit') {
      expect(event.outcome).toBe('succeeded')
      break
    }
    expect(session.runtimeModel).toBe('observed:root-model')
  } finally { await session.cancel() }
})

it('synchronously reports a delayed authentic Claude observation before its turn ends', async () => {
  const dataDir = tempDir(), worktree = await makeRepo(), observations: Array<{ sessionId: string; model: string }> = []
  const binary = resolve(import.meta.dirname, 'fakes/fake-claude.mjs')
  chmodSync(binary, 0o755)
  const adapter = new ClaudeAdapter({ stateDir: join(dataDir, 'adapters'), sandbox: new NoSandbox(), configDir: tempDir(), binary })
  const session = await adapter.start({ runId: 'delayed-model-test', cwd: worktree, prompt: 'MODEL DELAYED SUBAGENT', model: 'delayed-requested',
    env: buildChildEnv(), log: createLogger(), toolApproval: modelObservationGate('delayed-model-test'),
    onRuntimeModel: (sessionId, model) => { observations.push({ sessionId, model }) } })
  try {
    expect(session.runtimeModel).toBeNull()
    for await (const event of session.events()) if (event.type === 'exit') {
      expect(event.outcome).toBe('succeeded')
      expect(observations).toContainEqual({ sessionId: session.sessionId, model: 'observed:delayed-model' })
      break
    }
    expect(session.runtimeModel).toBe('observed:delayed-model')
    expect(observations.some(item => item.model === 'observed:subagent-model')).toBe(false)
  } finally { await session.cancel() }
})
