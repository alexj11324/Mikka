// Actual adapters / Claude Agent SDK, local protocol CLI processes and Git.
// No provider, subscription credentials or external requests.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { runAssignmentSchema, type RunAssignment } from '@mikka/protocol'
import { createHostedBotRunner } from '../src/subscription-hosted-runner'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { takeCheckpoint } from '../src/agents/checkpoint'
import { retainDeliverable, snapshotTree } from '../src/agents/publish'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor } from '../src/runs/supervisor'
import { Outbox } from '../src/outbox'
import { MemoryServer } from '../src/server-link'
import { Daemon } from '../src/main'
import { WorktreeManager } from '../src/worktrees'
import { runPaths } from '../src/agents/run-context'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)
async function fixture(harness: 'codex' | 'claude_code', effort?: RunAssignment['effort']) {
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
    prompt: 'ORIGINAL_QUESTION', model: 'fixture-model', ...(effort ? { effort } : {}), subscriptionBinding: { bindingId: randomUUID(), ownerId: 'owner',
      workspaceId: randomUUID(), consumerId: randomUUID(), route: context.route } } as RunAssignment
  const options = (id: string) => ({ runId: id, toolApproval: new ToolApprovalGate(id, { isLive: () => true }), cwd,
    model: assignment.model, ...(effort ? { effort } : {}), prompt: 'ORIGINAL_QUESTION', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }), log: createLogger({ level: 'silent' }) })
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
  const observedEffort = (id: string) => JSON.parse(readFileSync(join(runPaths(stateDir, id).runDir, harness === 'codex' ? 'codex-home' : 'native-home/.claude', 'fixture-effort.json'), 'utf8'))
  return { runner, assignment, next, resumedOptions, journal, stateDir, history, original, context, cwd, observedEffort }
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
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(`${harness}: frozen Profile effort reaches the native protocol and survives resume: %s`, async effort => {
    const f = await fixture(harness, effort)
    expect(f.observedEffort(f.assignment.runId)).toMatchObject({ transport: harness === 'codex' ? 'turn/start' : 'cli', effort, sessionId: f.original.sessionId })
    const session = await f.runner.start(f.next, f.resumedOptions)
    try {
      for await (const _event of session.events()) { /* actual official protocol / SDK process */ }
      expect(session.sessionId).toBe(f.original.sessionId)
      expect(f.observedEffort(f.next.runId)).toMatchObject({ effort, sessionId: f.original.sessionId })
      if (harness === 'claude_code') expect(f.observedEffort(f.next.runId).resumed).toBe(true)
      expect(JSON.parse(readFileSync(f.history(f.next.runId), 'utf8')).messages).toEqual(['ORIGINAL_QUESTION', 'OWNER_ANSWER'])
    } finally { await session.cancel() }
  }, 45000)
  it.each(['assignment', 'options', 'both'] as const)(`${harness}: rejects changed Profile effort on native resume: %s`, async drift => {
    const f = await fixture(harness, 'high')
    if (drift !== 'options') f.next.effort = 'low'
    if (drift !== 'assignment') f.resumedOptions.effort = 'low'
    await expect(f.runner.start(f.next, f.resumedOptions)).rejects.toThrow('subscription_hosted_runtime_unavailable')
    expect(existsSync(join(f.stateDir, 'native-ledgers', f.next.runId + '.json'))).toBe(false)
    expect(JSON.parse(readFileSync(f.history(f.assignment.runId), 'utf8')).messages).toEqual(['ORIGINAL_QUESTION'])
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
    const input = { issueId: randomUUID(), repoId, baseBranch: 'main', harness, prompt: 'ORIGINAL_QUESTION', model: 'fixture-model', effort: 'high' as const,
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
      expect(JSON.parse(readFileSync(join(runDir, harness === 'codex' ? 'codex-home' : 'native-home/.claude', 'fixture-effort.json'), 'utf8'))).toMatchObject({ effort: 'high', sessionId: original.sessionId })
      const historyPath = harness === 'codex' ? join(runDir, 'codex-home', 'sessions', 'fixture-subscription-thread.json')
        : join(runDir, 'native-home', '.claude', 'projects', 'fixture-question.json')
      const history = JSON.parse(readFileSync(historyPath, 'utf8'))
      expect(history.messages).toHaveLength(2)
      expect(history.messages[1]).toBe('OWNER_ANSWER')
      expect(history.messages.join('')).not.toContain('FULL BRIEF MUST NOT REPLAY')
    } finally { await daemon.stop() }
  }, 45000)
}

it('codex: a real legacy submitted journal accepts an explicitly retained fixture worktree without rewriting history', async () => {
  const root = tempDir('question-journal-')
  const roots = { botWorkspaces: join(root, 'bot-workspaces'), worker: join(root, 'worker') }
  const repoPath = join(roots.botWorkspaces, randomUUID()), stateDir = join(roots.worker, 'adapters')
  mkdirSync(roots.botWorkspaces, { recursive: true }); mkdirSync(stateDir, { recursive: true })
  renameSync(await makeRepo(), repoPath)
  const artifact = 'factory retained delivery\n7 - 4 = 3\nverified artifact\n'
  const binary = join(root, 'fake-codex-legacy-submission.mjs')
  const source = readFileSync(resolve(import.meta.dirname, 'fakes/fake-codex-subscription.mjs'), 'utf8')
  const marker = "    if (prompt === 'ORIGINAL_QUESTION') {"
  expect(source.split(marker)).toHaveLength(2)
  // Extend only this disposable CLI process. It writes the file and calls the
  // real MCP submit tool; no test code writes a journal state.
  writeFileSync(binary, source.replace(marker, `
    if (prompt === 'LEGACY_OWNER_ANSWER') {
      writeFileSync('artifact.txt', ${JSON.stringify(artifact)})
      const args = JSON.parse(process.argv.find(value => value.startsWith('mcp_servers.mikka.args=')).slice('mcp_servers.mikka.args='.length))
      execFileSync(process.execPath, args, { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit', arguments: { summary: 'Synthetic answered delivery' } } }) + '\\n', stdio: ['pipe', 'pipe', 'pipe'] })
    }
${marker}`))
  chmodSync(binary, 0o700)
  const deviceId = randomUUID(), repoId = randomUUID(), issueId = randomUUID()
  const server = new MemoryServer(deviceId), log = createLogger({ level: 'silent' })
  const link = Object.assign(server.link(), {
    nativeContext: async () => ({ route: 'codex_cli' as const, modelId: 'fixture-model', revision: 2,
      accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60000).toISOString() }),
    nativeRequest: async () => { throw new Error('No fixture may call a provider') },
  })
  const journalPath = join(roots.worker, 'runs.json'), journal = new RunJournal(journalPath)
  const outbox = new Outbox(join(roots.worker, 'outbox'), link, log)
  const runner = await createHostedBotRunner({ stateDir, link, journal, binaries: { codex: binary } })
  const supervisor = new RunSupervisor({ journal, adapterStateDir: stateDir, outbox, log,
    worktrees: new WorktreeManager(join(roots.worker, 'worktrees')),
    adapters: new Map([['codex', new CodexAdapter({ stateDir, binary, sandbox: new NoSandbox() })]]),
    startSubscription: runner.start,
    prepareRunToolApproval: async assignment => new ToolApprovalGate(assignment.runId, { isLive: () => true }),
    repository: () => ({ repoId, name: 'Retained question fixture', path: repoPath }),
    prepareRepository: async () => {}, baseRef: async () => 'main',
    publisher: { snapshot: ({ worktree, repo }) => snapshotTree(repo.path, worktree),
      publish: async () => { throw new Error('This unverified fixture must not publish') } },
  })
  const firstInput = runAssignmentSchema.parse({ runId: randomUUID(), deviceId, issueId, repoId,
    baseBranch: 'main', kind: 'implement', harness: 'codex', model: 'fixture-model', prompt: 'ORIGINAL_QUESTION',
    preserveQuestionWorktree: true, subscriptionBinding: { bindingId: randomUUID(), ownerId: 'fixture-owner',
      workspaceId: randomUUID(), consumerId: randomUUID(), route: 'codex_cli' } })
  const finish = async (assignment: RunAssignment) => {
    server.queueRun(deviceId, assignment)
    // The real daemon claims before starting. Its tool gate requires the live
    // server lease; queueing alone supplies no authority to launch the CLI.
    const claimed = runAssignmentSchema.parse(await link.claimRun(deviceId, assignment.runId))
    supervisor.start(claimed)
    await supervisor.idle()
    await outbox.flushAll()
    return new RunJournal(journalPath).get(assignment.runId)!
  }
  try {
    const original = await finish(firstInput)
    const originalCompletion = server.runs.get(firstInput.runId)!.completion!
    expect({ state: original.state, error: original.error, completion: originalCompletion },
      `Synthetic question startup: ${JSON.stringify({ original, completion: originalCompletion })}`)
      .toMatchObject({ state: 'stopped', completion: { stopReason: 'asked_human', report: { question: { questionId: expect.any(String) } } } })
    const questionId = originalCompletion.report.question!.questionId
    expect(original).toMatchObject({ state: 'stopped', stopReason: 'asked_human', waitingQuestionId: questionId })
    expect(original.sessionId).toBeTruthy()
    // Reproduce the old claim's omission, without using the newer deliverable
    // flag or granting read-only/report-only treatment to the assignment.
    const answer = runAssignmentSchema.parse({ ...firstInput, runId: randomUUID(), questionId,
      prompt: 'FULL BRIEF MUST NOT REPLAY', followUp: 'LEGACY_OWNER_ANSWER',
      continuesRunId: firstInput.runId, resumeSessionId: original.sessionId, requireSessionResume: true })
    const resumed = await finish(answer), completion = server.runs.get(answer.runId)!.completion!
    expect(resumed).toMatchObject({ state: 'stopped', stopReason: 'submitted', questionResumeState: 'accepted',
      sessionId: original.sessionId, worktree: original.worktree, baseCommit: original.baseCommit,
      error: 'Submitted, but no verify command ran; the work is unverified' })
    expect(resumed.assignment.factoryExecuteKind).toBeUndefined()
    expect(resumed.assignment.factoryCheck).toBeUndefined()
    expect(resumed.assignment.policy?.readOnly).not.toBe(true)
    expect(resumed.assignment.verifyCommand).toBeUndefined()
    expect(resumed.deliverableCommit).toBeUndefined()
    expect(completion).toMatchObject({ stopReason: 'submitted', report: { verify: { status: 'not_run' }, sourceCommit: original.baseCommit } })
    expect(completion.report.publish).toBeUndefined()
    expect(completion.report.deliverableCommit).toBeUndefined()
    expect(new RunJournal(journalPath).get(firstInput.runId)).toEqual(original)
    const historyPath = join(runPaths(stateDir, answer.runId).runDir, 'codex-home', 'sessions', 'fixture-subscription-thread.json')
    const historyBefore = readFileSync(historyPath)
    expect(JSON.parse(historyBefore.toString()).messages).toEqual(['ORIGINAL_QUESTION', 'LEGACY_OWNER_ANSWER'])
    const worktreePath = resumed.worktree!, git = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath })
    // The hosted CLI's private Git context does not advance the bound worktree.
    // The real legacy run above produces the journal and artifact, not a retained
    // commit. Prepare that separate physical precondition explicitly with the
    // existing host function; this is not a replay of an old production history.
    expect(git('rev-parse', 'HEAD').toString().trim()).toBe(resumed.baseCommit)
    expect(readFileSync(join(worktreePath, 'artifact.txt'), 'utf8')).toBe(artifact)
    const journalBefore = readFileSync(journalPath), completionBefore = structuredClone(completion)
    const head = await retainDeliverable(repoPath, worktreePath, answer.runId)
    expect(readFileSync(journalPath)).toEqual(journalBefore)
    expect(server.runs.get(answer.runId)!.completion).toEqual(completionBefore)
    expect(readFileSync(historyPath)).toEqual(historyBefore)
    expect(git('rev-parse', 'HEAD').toString().trim()).toBe(head)
    expect(head).not.toBe(resumed.baseCommit)
    expect(git('status', '--porcelain').toString()).toBe('')
    expect(readFileSync(join(worktreePath, 'artifact.txt'), 'utf8')).toBe(artifact)
    const taken = (await takeCheckpoint({ repoPath, worktree: worktreePath, baseCommit: resumed.baseCommit! }))!
    const patch = gunzipSync(Buffer.from(taken.checkpoint.patch, 'base64'))
    const input = { producerRunId: answer.runId, producerSessionId: resumed.sessionId!, deviceId, deviceRepoId: repoId, issueId,
      repoPath, worktreePath, sourceCommit: resumed.baseCommit!,
      checkpoint: { patchSha256: createHash('sha256').update(patch).digest('hex'), patchBytes: patch.length, files: taken.checkpoint.files },
      legacyQuestionSubmission: { questionId, continuesRunId: firstInput.runId } }
    const indexPath = join(git('rev-parse', '--git-dir').toString().trim(), 'index'), indexBefore = readFileSync(indexPath)
    // Import the unchanged standalone production probe, including its path,
    // journal, Git and checkpoint checks, over the Supervisor's actual files.
    const { inspectRetainedDeliverable } = await import(pathToFileURL(resolve(import.meta.dirname, '../../../scripts/e2b/inspect-retained-deliverable.mjs')).href)
    const observed = await inspectRetainedDeliverable(input, roots)
    expect(observed).toMatchObject({ producerRunId: answer.runId, sessionId: original.sessionId, worktreePath,
      head, tree: taken.tree, clean: true, diffSha256: input.checkpoint.patchSha256, diffBytes: patch.length })
    await expect(inspectRetainedDeliverable({ ...input, legacyQuestionSubmission: undefined }, roots))
      .rejects.toThrow('retained_delivery_journal_state_mismatch')
    expect(readFileSync(journalPath)).toEqual(journalBefore)
    expect(readFileSync(indexPath)).toEqual(indexBefore)
    expect(readFileSync(historyPath)).toEqual(historyBefore)
    expect(git('rev-parse', 'HEAD').toString().trim()).toBe(head)
  } finally { await supervisor.stop(); await outbox.close() }
}, 45000)

it.each(['latest-history', 'stale-ledger-run', 'missing-latest-history'] as const)(
  'codex: explicit recovery of an accepted failed continuation preserves exact SID and scope: %s',
  async mode => {
    const f = await fixture('codex')
    const answered = await f.runner.start(f.next, f.resumedOptions)
    try { for await (const _event of answered.events()) { /* local protocol only */ } }
    finally { await answered.cancel() }
    // Model a transport failure after the answer and a completed tool result.
    // These are disposable journal/history fixtures, not production changes.
    const sourceHistory = JSON.parse(readFileSync(f.history(f.next.runId), 'utf8'))
    sourceHistory.messages.push('LATEST_FAILED_TOOL_RESULT')
    writeFileSync(f.history(f.next.runId), JSON.stringify(sourceHistory))
    f.journal.put({ assignment: f.next, state: 'failed', sessionId: f.original.sessionId, worktree: f.cwd,
      questionResumeState: 'accepted', lastSeq: 0, error: 'synthetic stream interruption', stopReason: 'error', updatedAt: new Date().toISOString() })
    const sourceLedgerPath = join(f.stateDir, 'native-ledgers', f.next.runId + '.json')
    const sourceLedger = JSON.parse(readFileSync(sourceLedgerPath, 'utf8'))
    expect(sourceLedger.scope).toMatchObject({ runId: f.next.runId, bindingId: f.next.subscriptionBinding!.bindingId,
      ownerId: f.next.subscriptionBinding!.ownerId, workspaceId: f.next.subscriptionBinding!.workspaceId,
      consumerId: f.next.subscriptionBinding!.consumerId, modelId: f.next.model, revision: 2 })
    const originalBytes = readFileSync(f.history(f.assignment.runId), 'utf8')
    const recoveryId = randomUUID(), message = 'RECOVER_WITHOUT_REANSWER'
    const assignment = { ...f.next, runId: recoveryId, continuesRunId: f.next.runId, followUp: message }
    const options = { ...f.resumedOptions, runId: recoveryId, toolApproval: new ToolApprovalGate(recoveryId, { isLive: () => true }),
      continueSession: { runId: f.next.runId, sessionId: f.original.sessionId, message } }
    if (mode === 'stale-ledger-run') {
      writeFileSync(sourceLedgerPath, JSON.stringify({ ...sourceLedger, scope: { ...sourceLedger.scope, runId: f.assignment.runId } }))
    }
    if (mode === 'missing-latest-history') rmSync(f.history(f.next.runId))
    if (mode !== 'latest-history') {
      await expect(f.runner.start(assignment, options)).rejects.toThrow()
      expect(existsSync(join(runPaths(f.stateDir, recoveryId).runDir, 'handoff.json'))).toBe(false)
    } else {
      const resumed = await f.runner.start(assignment, options)
      try {
        expect(resumed.sessionId).toBe(f.original.sessionId)
        for await (const _event of resumed.events()) { /* existing official adapter path */ }
        expect(JSON.parse(readFileSync(f.history(recoveryId), 'utf8')).messages)
          .toEqual(['ORIGINAL_QUESTION', 'OWNER_ANSWER', 'LATEST_FAILED_TOOL_RESULT', message])
        const recoveredLedger = JSON.parse(readFileSync(join(f.stateDir, 'native-ledgers', recoveryId + '.json'), 'utf8'))
        expect(recoveredLedger).toEqual({ ...sourceLedger, scope: { ...sourceLedger.scope, runId: recoveryId } })
        expect(JSON.parse(readFileSync(sourceLedgerPath, 'utf8'))).toEqual(sourceLedger)
        expect(JSON.parse(readFileSync(f.history(f.next.runId), 'utf8'))).toEqual(sourceHistory)
      } finally { await resumed.cancel() }
    }
    expect(readFileSync(f.history(f.assignment.runId), 'utf8')).toBe(originalBytes)
  }, 45000)
