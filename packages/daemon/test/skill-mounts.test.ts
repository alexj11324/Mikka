import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { skillMarkdown, type SkillAssignmentReceipt } from '@mikka/protocol/skill'
import { defaultRunPolicy, runPolicyDigestInput } from '@mikka/protocol/agent-policy'
import { emptyRunReport, type RunCompletion } from '@mikka/protocol/run'
import type { AgentAdapter, AgentReport, SessionOptions, StartOptions } from '../src/adapters/types'
import { endedSession } from '../src/agents/child'
import { RunContext, runPaths } from '../src/agents/run-context'
import { createLogger } from '../src/log'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { BASELINE_ARTIFACT, BASELINE_SKILL } from '../../../lib/self-improvement/builtin-skill'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)

async function fixture(mode: 'valid' | 'missing' | 'tampered' | 'wrong-session' | 'wrong-receipt' | 'cached-handoff' | 'wrong-fixture' | 'delayed-handoff' = 'valid', resumed = false, benchmark = false, observedModel: string | null = 'observed-model', questionContinuation?: 'valid' | 'expired' | 'wrong-device' | 'missing-worktree', team?: 'approved' | 'withdrawn') {
  const root = tempDir(), repo = await makeRepo(), runId = randomUUID(), worktree = join(root, 'worktree')
  execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: repo, stdio: 'ignore' })
  const receipt: SkillAssignmentReceipt = { id: randomUUID(), runId, issueId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(),
    deviceId: randomUUID(), assignedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), artifact: team ? {...BASELINE_ARTIFACT,registryId:'mikka-team'} : BASELINE_ARTIFACT }
  const benchmarkPolicy = { ...defaultRunPolicy(), readOnly: true }
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
  const assignment = { runId, issueId: receipt.issueId, repoId: receipt.repoId, deviceId: receipt.deviceId,
    baseBranch: 'main', harness: 'codex' as const, prompt: 'synthetic boundary test', skills: [BASELINE_SKILL], skillReceipt: receipt,
    leaseExpiresAt: receipt.leaseExpiresAt,
    ...(benchmark ? { policy: benchmarkPolicy, model: 'requested-model', verifyCommand: 'node verify-report.mjs', benchmark: {
      sourceCommit,
      benchmarkDigest: 'c'.repeat(64), caseId: 'case-1', fixtureDigest: createHash('sha256').update(sourceCommit).digest('hex'),
      policyDigest: createHash('sha256').update(runPolicyDigestInput(benchmarkPolicy)).digest('hex'),
    } } : {}),
  }
  if (mode === 'wrong-fixture' && assignment.benchmark) assignment.benchmark.fixtureDigest = 'f'.repeat(64)
  const journalFile = join(root, 'journal.json'), adapterStateDir = join(root, 'adapters')
  let journal = new RunJournal(journalFile), cancelled = false
  const priorMount = { receiptId: receipt.id, versionId: receipt.artifact.versionId, sha256: receipt.artifact.sha256,
    sessionId: 'actual-session', mountedAt: receipt.assignedAt }
  const priorExecution = assignment.benchmark ? { ...assignment.benchmark, harness: 'codex' as const,
    requestedModel: assignment.model!, observedModel: 'durably-observed-model', verifyCommand: assignment.verifyCommand! } : undefined
  const parentRunId = randomUUID(), parentReceipt = { ...receipt, id: randomUUID(), runId: parentRunId }
  if (questionContinuation) {
    journal.put({ assignment: { ...assignment, runId: parentRunId, skillReceipt: parentReceipt }, state: 'stopped',
      worktree, baseCommit: sourceCommit, sessionId: 'actual-session', skillMount: { ...priorMount, receiptId: parentReceipt.id },
      lastSeq: 0, error: null, stopReason: 'asked_human', waitingQuestionId: randomUUID(), updatedAt: new Date().toISOString() })
    Object.assign(assignment, { continuesRunId: parentRunId, resumeSessionId: 'actual-session', requireSessionResume: true,
      followUp: 'Answer: use the baseline Skill.' })
    if (questionContinuation === 'expired') {
      receipt.leaseExpiresAt = new Date(Date.now() - 1000).toISOString()
      assignment.leaseExpiresAt = receipt.leaseExpiresAt
    }
    if (questionContinuation === 'wrong-device') receipt.deviceId = randomUUID()
  }
  if (mode === 'wrong-receipt') priorMount.receiptId = randomUUID()
  if (resumed) {
    journal.put({ assignment, state: 'running', worktree, baseCommit: assignment.benchmark?.sourceCommit ?? 'b'.repeat(40), execution: priorExecution, sessionId: 'actual-session', skillMount: priorMount,
      lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
    journal = new RunJournal(journalFile)
  }
  let delayedObserved = false, replaying = false
  let releaseAfterCrash: () => void = () => {}
  const delayedGate = new Promise<void>(resolve => { releaseAfterCrash = resolve })
  const open = async (options: SessionOptions) => {
    // The base was durably recorded before any adapter/model execution.
    expect(journal.get(runId)?.baseCommit).toMatch(/^[a-f0-9]{40}$/)
    if (mode !== 'missing') {
      const context = new RunContext({ harness: 'codex', worktree, runDir: runPaths(adapterStateDir, runId).runDir,
        privateDir: root, skills: [BASELINE_SKILL], skillReceipt: receipt })
      if (mode === 'tampered') writeFileSync(join(context.skillsDir, 'run-report', 'SKILL.md'), 'changed')
    }
    if (mode === 'cached-handoff' || replaying) return endedSession('actual-session', { type: 'exit', outcome: 'succeeded', stopReason: 'turn_ended', report: { summary: 'durable handoff' } })
    return { runtimeModel: mode === 'delayed-handoff' ? null : observedModel, sessionId: mode === 'wrong-session' ? 'other-session' : 'actual-session', cancel: async () => { cancelled = true }, send: async () => {},
      async *events() {
        if (mode === 'delayed-handoff') {
          options.onRuntimeModel?.('actual-session', 'late-observed-model')
          writeFileSync(join(runPaths(adapterStateDir, runId).runDir, 'handoff.json'), JSON.stringify({ kind: 'submit', summary: 'durable handoff' }))
          const persisted = new RunJournal(journalFile)
          expect(persisted.get(runId)?.runtime?.observedModel).toBe('late-observed-model')
          expect(persisted.get(runId)?.execution?.observedModel).toBe('late-observed-model')
          delayedObserved = true
          await delayedGate
        }
        yield { type: 'exit' as const, outcome: 'succeeded' as const, stopReason: 'turn_ended' as const,
        report: { summary: 'test', execution: { observedModel: 'model-fake' }, sourceCommit: 'f'.repeat(40), skillMount: { ...priorMount, sessionId: 'model-lie' } } as AgentReport } } }
  }
  let startOptions: StartOptions | undefined, revalidations=0
  const adapter: AgentAdapter = { harness: 'codex', capabilities: { supportsResume: true, supportsInterject: false }, envAllow: [],
    start: options => { startOptions = options; return open(options) }, resume: (_id, options) => open(options) }
  const completions: RunCompletion[] = []
  const deps = { journal, adapterStateDir, adapters: new Map([['codex', adapter]]), log: createLogger(),
    repository: () => ({ repoId: receipt.repoId, name: 'test', path: repo }),
    prepareRepository: async () => {},
    baseRef: async () => {
      if (benchmark) throw new Error('Frozen benchmarks must use their pinned commit')
      return assignment.baseBranch
    },
    worktrees: { create: async () => worktree, continueFrom: async () => questionContinuation === 'missing-worktree' ? null : worktree, bootstrap: async () => 'test', pathFor: () => worktree, changedFiles: async () => [] },
    outbox: { push: (_id: string, item: { kind: string; completion: RunCompletion }) => { if (item.kind === 'complete') completions.push(item.completion) },
      compact: async () => {}, lastChunkSeq: () => 0 },
    revalidateSkillAssignment: async () => {
      revalidations++
      if(team==='withdrawn')throw new Error('Team Skill withdrawn')
      return { skillReceipt: receipt, leaseExpiresAt: receipt.leaseExpiresAt }
    },
  } as unknown as SupervisorDeps
  mkdirSync(adapterStateDir, { recursive: true })
  const supervisor = new RunSupervisor(deps)
  if (resumed) await supervisor.resumeAll()
  else supervisor.start(assignment)
  if (mode === 'delayed-handoff') {
    await waitFor(() => delayedObserved)
    expect(completions).toHaveLength(0)
    await supervisor.stop()
    releaseAfterCrash()
    journal = new RunJournal(journalFile)
    replaying = true
    const restarted = new RunSupervisor({ ...deps, journal })
    await restarted.resumeAll()
    await restarted.idle()
  } else await supervisor.idle()
  return { revalidations, report: completions.at(-1)?.report??emptyRunReport(), journal, cancelled, priorMount, priorExecution, runId, receipt, parentRunId, parentReceipt, startOptions, worktree, stopReason: completions.at(-1)?.stopReason }
}

it('revalidates question continuation bytes and journals a fresh receipt in the original session', async () => {
  const result = await fixture('valid', false, false, 'resumed-model', 'valid')
  expect(result.stopReason).toBe('turn_ended')
  expect(result.startOptions).toMatchObject({ requireSessionResume: true, skillReceipt: result.receipt, skills: [BASELINE_SKILL],
    continueSession: { sessionId: 'actual-session', runId: result.parentRunId, message: 'Answer: use the baseline Skill.' } })
  expect(result.receipt.id).not.toBe(result.parentReceipt.id)
  expect(result.report.skillMount).toMatchObject({ receiptId: result.receipt.id, sessionId: 'actual-session', sha256: BASELINE_ARTIFACT.sha256 })
  expect(result.report.runtime).toMatchObject({ harness: 'codex', observedModel: 'resumed-model', sourceCommit: result.report.sourceCommit })
  const saved = new RunJournal(join(result.worktree, '..', 'journal.json')).get(result.runId)
  expect(saved).toMatchObject({ assignment: { skillReceipt: result.receipt }, questionResumeState: 'accepted',
    sessionId: 'actual-session', worktree: result.worktree, skillMount: result.report.skillMount, runtime: result.report.runtime })
  expect(result.journal.get(result.parentRunId)?.skillMount?.receiptId).toBe(result.parentReceipt.id)
})

it('refuses a missing original question worktree before opening the supported harness', async () => {
  const result = await fixture('valid', false, false, 'resumed-model', 'missing-worktree')
  expect(result.stopReason).toBe('error')
  expect(result.startOptions).toBeUndefined()
  expect(result.report.summary).toContain('Original question worktree is unavailable')
  expect(result.report.skillMount).toBeUndefined()
})

it.each(['missing', 'tampered', 'wrong-session'] as const)('rejects question continuation with %s mount evidence', async mode => {
  const result = await fixture(mode, false, false, 'resumed-model', 'valid')
  expect(result.stopReason).toBe('error')
  expect(result.cancelled).toBe(true)
  expect(result.report.skillMount).toBeUndefined()
  expect(result.report.runtime).toBeUndefined()
  expect(result.journal.get(result.runId)?.questionResumeState).not.toBe('accepted')
})

it.each(['expired', 'wrong-device'] as const)('rejects question continuation with %s authorization before opening the adapter', async authorization => {
  const result = await fixture('valid', false, false, 'resumed-model', authorization)
  expect(result.stopReason).toBe('error')
  expect(result.startOptions).toBeUndefined()
  expect(result.report.skillMount).toBeUndefined()
  expect(result.report.runtime).toBeUndefined()
})

it('rereads real RunContext bytes and ignores model-supplied evidence', async () => {
  const result = await fixture()
  expect(result.report.sourceCommit).toMatch(/^[a-f0-9]{40}$/)
  expect(result.report.sourceCommit).not.toBe('f'.repeat(40))
  expect(result.report.skillMount).toMatchObject({ receiptId: result.receipt.id, sessionId: 'actual-session', sha256: BASELINE_ARTIFACT.sha256 })
  expect(result.journal.get(result.runId)?.skillMount).toEqual(result.report.skillMount)
  expect(skillMarkdown(BASELINE_SKILL)).toContain('Run report')
})
it.each(['missing', 'tampered'] as const)('does not record a %s mount', async mode => {
  const result = await fixture(mode)
  expect(result.cancelled).toBe(true)
  expect(result.report.skillMount).toBeUndefined()
  expect(result.journal.get(result.runId)?.skillMount).toBeUndefined()
})
it('rereads after restart and retains the original session mount record', async () => {
  const result = await fixture('valid', true)
  expect(result.report.sourceCommit).toBe('b'.repeat(40))
  expect(result.report.skillMount).toEqual(result.priorMount)
})
it('rejects a different resumed session and drops stale journal evidence', async () => {
  const result = await fixture('wrong-session', true)
  expect(result.cancelled).toBe(true)
  expect(result.report.skillMount).toBeUndefined()
})

it('cannot reuse a journal mount recorded for another receipt', async () => {
  const result = await fixture('wrong-receipt', true)
  expect(result.cancelled).toBe(true)
  expect(result.report.skillMount).toBeUndefined()
})

it('records requested and actually observed benchmark models separately', async () => {
  const result = await fixture('valid', false, true)
  expect(result.report.execution).toMatchObject({ requestedModel: 'requested-model', observedModel: 'observed-model',
    harness: 'codex', caseId: 'case-1', verifyCommand: 'node verify-report.mjs' })
  expect(result.report.execution?.sourceCommit).toBe(result.report.sourceCommit)
  expect(result.report.execution?.fixtureDigest).toBe(createHash('sha256').update(result.report.sourceCommit!).digest('hex'))
  expect(result.report.execution?.policyDigest).toBe(createHash('sha256').update(runPolicyDigestInput({ ...defaultRunPolicy(), readOnly: true })).digest('hex'))
})
it('keeps missing protocol model unknown and omits execution for ordinary runs', async () => {
  const missing = await fixture('valid', false, true, null)
  expect(missing.report.execution?.observedModel).toBeNull()
  const ordinary = await fixture()
  expect(ordinary.report.execution).toBeUndefined()
})

it('preserves the observed benchmark model when restarting a durable endedSession without a new turn', async () => {
  const result = await fixture('cached-handoff', true, true, null)
  expect(result.report.execution).toEqual(result.priorExecution)
  expect(result.journal.get(result.runId)?.execution).toEqual(result.priorExecution)
  expect(result.report.skillMount).toEqual(result.priorMount)
})

it('fails closed when server fixture digest differs from the actual clean Git source', async () => {
  const result = await fixture('wrong-fixture', false, true)
  expect(result.stopReason).toBe('error')
  expect(result.report.summary).toContain('fixture digest mismatch')
  expect(result.report.skillMount).toBeUndefined()
})
it('records ordinary baseline runtime observations without inventing benchmark execution', async () => {
  const result = await fixture()
  expect(result.report.execution).toBeUndefined()
  expect(result.report.runtime).toEqual({ harness: 'codex', requestedModel: null, observedModel: 'observed-model',
    sourceCommit: result.report.sourceCommit, policyDigest: createHash('sha256').update(runPolicyDigestInput()).digest('hex') })
})

it('recovers a delayed observation journaled before a durable handoff and daemon restart', async () => {
  const result = await fixture('delayed-handoff', false, true, null)
  expect(result.report.execution?.observedModel).toBe('late-observed-model')
  expect(result.report.runtime?.observedModel).toBe('late-observed-model')
  expect(result.journal.get(result.runId)?.execution?.observedModel).toBe('late-observed-model')
})

it('revalidates a new Team Skill assignment before starting its adapter', async()=>{
  const result=await fixture('valid',false,false,'observed-model',undefined,'approved')
  expect(result.revalidations).toBe(1)
  expect(result.startOptions).toBeDefined()
  expect(result.stopReason).toBe('turn_ended')
})
it('a withdrawn Team Skill never reaches the adapter, including a saved resume', async()=>{
  for(const resumed of [false,true]) {
    const result=await fixture('valid',resumed,false,'observed-model',undefined,'withdrawn')
    expect(result.revalidations).toBe(1)
    expect(result.startOptions).toBeUndefined()
    expect(result.report.skillMount).toBeUndefined()
    expect(result.stopReason).not.toBe('turn_ended')
    if(resumed)expect(result.journal.get(result.runId)?.error).toMatch(/Skill resume blocked/)
  }
})
