// Actual adapters / Claude Agent SDK, local protocol CLI processes and Git.
// No provider, subscription credentials or external requests.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { createHostedBotRunner } from '../src/subscription-hosted-runner'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import { RunJournal } from '../src/runs/journal'
import { MemoryServer } from '../src/server-link'
import { Daemon } from '../src/main'
import { runPaths } from '../src/agents/run-context'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)
async function fixture(harness: 'codex' | 'claude_code') {
  const root = tempDir('question-native-'), stateDir = join(root, 'adapters'), cwd = await makeRepo()
  mkdirSync(stateDir)
  const journal = new RunJournal(join(root, 'runs.json')), deviceId = randomUUID(), runId = randomUUID()
  const context = { route: harness === 'codex' ? 'codex_cli' as const : 'claude_code_cli' as const,
    modelId: 'fixture-model', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }
  const link = Object.assign(new MemoryServer(deviceId).link(), { nativeContext: async () => context,
    nativeRequest: async () => { throw new Error('No fixture may call a provider') } })
  const binary = resolve(import.meta.dirname, 'fakes', harness === 'codex' ? 'fake-codex-subscription.mjs' : 'fake-claude-subscription.mjs')
  chmodSync(binary, 0o700)
  const runner = await createHostedBotRunner({ stateDir, link, binaries: { [harness]: binary }, journal })
  const assignment = { runId, deviceId, issueId: randomUUID(), repoId: randomUUID(), baseBranch: 'main', harness,
    prompt: 'ORIGINAL_QUESTION', model: 'fixture-model', subscriptionBinding: { bindingId: randomUUID(), ownerId: 'owner',
      workspaceId: randomUUID(), consumerId: randomUUID(), route: context.route } } as RunAssignment
  const options = (id: string) => ({ runId: id, toolApproval: new ToolApprovalGate(id, { isLive: () => true }), cwd,
    model: assignment.model, prompt: 'ORIGINAL_QUESTION', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }), log: createLogger({ level: 'silent' }) })
  const original = await runner.start(assignment, options(runId))
  for await (const _event of original.events()) { /* actual adapter process */ }
  journal.put({ assignment, state: 'stopped', sessionId: original.sessionId, worktree: cwd, lastSeq: 0, error: null,
    stopReason: 'blocked', updatedAt: new Date().toISOString() })
  const nextId = randomUUID()
  const next: RunAssignment = { ...assignment, runId: nextId, prompt: 'FULL BRIEF MUST NOT REPLAY', requireSessionResume: true,
    continuesRunId: runId, resumeSessionId: original.sessionId, followUp: 'OWNER_ANSWER' }
  const resumedOptions = { ...options(nextId), prompt: next.prompt, requireSessionResume: true,
    continueSession: { runId, sessionId: original.sessionId, message: 'OWNER_ANSWER' } }
  const history = (id: string) => harness === 'codex'
    ? join(runPaths(stateDir, id).runDir, 'codex-home', 'sessions', 'fixture-subscription-thread.json')
    : join(runPaths(stateDir, id).runDir, 'native-home', '.claude', 'projects', 'fixture-question.json')
  return { runner, assignment, next, resumedOptions, journal, stateDir, history, original, context, cwd }
}
for (const harness of ['codex', 'claude_code'] as const) {
  it(`${harness}: required subscription answer resumes original native history and session`, async () => {
    const f = await fixture(harness), session = await f.runner.start(f.next, f.resumedOptions)
    try {
      expect(session.sessionId).toBe(f.original.sessionId)
      for await (const _event of session.events()) { /* actual protocol / SDK */ }
      const history = JSON.parse(readFileSync(f.history(f.next.runId), 'utf8'))
      expect(history.messages).toEqual(['ORIGINAL_QUESTION', 'OWNER_ANSWER'])
      if (harness === 'codex') expect(JSON.parse(readFileSync(join(runPaths(f.stateDir, f.next.runId).runDir, 'codex-home', 'fixture-resume.json'), 'utf8')))
        .toEqual({ method: 'thread/resume', threadId: f.original.sessionId })
      expect(JSON.parse(readFileSync(join(f.stateDir, 'native-ledgers', f.next.runId + '.json'), 'utf8')))
        .toMatchObject({ scope: { runId: f.next.runId, bindingId: f.next.subscriptionBinding!.bindingId }, sessionId: f.original.sessionId })
      await expect(f.runner.start(f.next, { ...f.resumedOptions, toolApproval: new ToolApprovalGate(f.next.runId, { isLive: () => true }) })).rejects.toThrow()
      expect(JSON.parse(readFileSync(f.history(f.next.runId), 'utf8')).messages).toEqual(history.messages)
    } finally { await session.cancel() }
  }, 45000)
  it.each(['session', 'binding', 'owner', 'workspace', 'model', 'worktree', 'harness', 'ledger-account', 'ledger-revision', 'native-session', 'missing-history'] as const)(`${harness}: rejects question source drift: %s`, async drift => {
    const f = await fixture(harness)
    if (drift === 'session') f.next.resumeSessionId = f.resumedOptions.continueSession.sessionId = 'wrong-session'
    if (drift === 'binding') f.next.subscriptionBinding = { ...f.next.subscriptionBinding!, bindingId: randomUUID() }
    if (drift === 'owner') f.next.subscriptionBinding = { ...f.next.subscriptionBinding!, ownerId: 'another-owner' }
    if (drift === 'workspace') f.next.subscriptionBinding = { ...f.next.subscriptionBinding!, workspaceId: randomUUID() }
    if (drift === 'model') f.next.model = f.resumedOptions.model = 'another-model'
    if (drift === 'worktree') f.resumedOptions.cwd = await makeRepo()
    if (drift === 'harness') f.journal.get(f.assignment.runId)!.assignment.harness = harness === 'codex' ? 'claude_code' : 'codex'
    if (drift === 'ledger-account' || drift === 'ledger-revision') {
      const path = join(f.stateDir, 'native-ledgers', f.assignment.runId + '.json'), ledger = JSON.parse(readFileSync(path, 'utf8'))
      if (drift === 'ledger-account') ledger.scope.accountId = 'another-account'
      else ledger.scope.revision++
      writeFileSync(path, JSON.stringify(ledger))
    }
    if (drift === 'native-session') {
      f.resumedOptions.requireSessionResume = false // The trusted assignment must still force the SID fence.
      const path = f.history(f.assignment.runId), history = JSON.parse(readFileSync(path, 'utf8'))
      history.resumeSessionId = 'different-native-session'; writeFileSync(path, JSON.stringify(history))
    }
    if (drift === 'missing-history') rmSync(f.history(f.assignment.runId))
    await expect(f.runner.start(f.next, f.resumedOptions)).rejects.toThrow()
    expect(existsSync(join(runPaths(f.stateDir, f.next.runId).runDir, 'handoff.json'))).toBe(false)
  }, 45000)
}

for (const harness of ['codex', 'claude_code'] as const) {
  it(`${harness}: daemon supervisor delivers a required question answer to the original subscription session`, async () => {
    const dataDir = tempDir('question-supervisor-'), repo = await makeRepo(), deviceId = randomUUID(), repoId = randomUUID()
    const server = new MemoryServer(deviceId)
    server.addRepo(deviceId, { repoId, name: 'Question fixture', path: repo })
    const link = Object.assign(server.link(), {
      prepareRunToolApproval: async (assignment: RunAssignment) => new ToolApprovalGate(assignment.runId, { isLive: () => true }),
      nativeContext: async () => ({ route: harness === 'codex' ? 'codex_cli' as const : 'claude_code_cli' as const,
        modelId: 'fixture-model', revision: 2, accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }),
      nativeRequest: async () => { throw new Error('No fixture provider calls') },
    })
    const binary = resolve(import.meta.dirname, 'fakes', harness === 'codex' ? 'fake-codex-subscription.mjs' : 'fake-claude-subscription.mjs')
    const daemon = await new Daemon({ dataDir, flavor: 'dev', link, credential: 'synthetic', hostedSubscriptions: true,
      harnessBinaries: { [harness]: binary }, quotaSource: null, heartbeatMs: 50, log: createLogger({ level: 'silent' }) }).start()
    const input = { issueId: randomUUID(), repoId, baseBranch: 'main', harness, prompt: 'ORIGINAL_QUESTION', model: 'fixture-model',
      preserveQuestionWorktree: true, subscriptionBinding: { bindingId: randomUUID(), ownerId: 'owner', workspaceId: randomUUID(),
        consumerId: randomUUID(), route: harness === 'codex' ? 'codex_cli' as const : 'claude_code_cli' as const } }
    const finish = async (runId: string) => {
      await daemon.syncWithServer()
      await waitFor(() => daemon.supervisor.list().some(run => run.runId === runId))
      await daemon.supervisor.idle()
      return daemon.supervisor.get(runId)
    }
    try {
      const first = server.queueRun(deviceId, input), original = await finish(first)
      expect(original.sessionId).toBeTruthy()
      const next = server.queueRun(deviceId, { ...input, prompt: 'FULL BRIEF MUST NOT REPLAY', followUp: 'OWNER_ANSWER',
        continuesRunId: first, resumeSessionId: original.sessionId!, requireSessionResume: true })
      const resumed = await finish(next)
      expect(resumed).toMatchObject({ sessionId: original.sessionId, worktree: original.worktree })
      expect(new RunJournal(join(dataDir, 'runs.json')).get(next)?.questionResumeState).toBe('accepted')
      const runDir = runPaths(join(dataDir, 'adapters'), next).runDir
      const historyPath = harness === 'codex' ? join(runDir, 'codex-home', 'sessions', 'fixture-subscription-thread.json')
        : join(runDir, 'native-home', '.claude', 'projects', 'fixture-question.json')
      const history = JSON.parse(readFileSync(historyPath, 'utf8'))
      expect(history.messages).toHaveLength(2)
      expect(history.messages[1]).toBe('OWNER_ANSWER')
      expect(history.messages.join('')).not.toContain('FULL BRIEF MUST NOT REPLAY')
    } finally { await daemon.stop() }
  }, 45000)
}
