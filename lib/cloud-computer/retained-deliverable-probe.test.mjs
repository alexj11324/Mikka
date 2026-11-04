import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectRetainedDeliverable } from '../../scripts/e2b/inspect-retained-deliverable.mjs'
import { retainedDeliverableProbeCommand } from './retained-deliverable-probe.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const content = 'factory retained delivery\n7 - 4 = 3\nverified artifact\n'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-retained-delivery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const botId = randomUUID(), runId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID(), issueId = randomUUID()
  const roots = { botWorkspaces: join(root, 'bot-workspaces'), worker: join(root, 'worker') }
  const repoPath = join(roots.botWorkspaces, botId), worktreePath = join(roots.worker, 'worktrees', randomUUID())
  mkdirSync(repoPath, { recursive: true }); mkdirSync(join(roots.worker, 'worktrees'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repoPath, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@mikka.invalid', 'commit', '--allow-empty', '-m', 'baseline')
  const sourceCommit = git('rev-parse', 'HEAD').toString().trim()
  git('worktree', 'add', '-b', 'delivery', worktreePath)
  writeFileSync(join(worktreePath, 'artifact.txt'), content)
  git('-C', worktreePath, 'add', 'artifact.txt')
  git('-C', worktreePath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@mikka.invalid', 'commit', '-m', 'delivered file')
  const head = git('-C', worktreePath, 'rev-parse', 'HEAD').toString().trim()
  const patch = git('diff', '--binary', '--no-color', sourceCommit, head)
  const input = { producerRunId: runId, producerSessionId: 'native-session', deviceId, deviceRepoId: repoId, issueId, repoPath, worktreePath, sourceCommit,
    checkpoint: { patchSha256: hash(patch), patchBytes: patch.length, files: 1 } }
  const entry = { assignment: { runId, deviceId, issueId, repoId }, state: 'succeeded', stopReason: 'submitted', sessionId: input.producerSessionId,
    worktree: worktreePath, baseCommit: sourceCommit, updatedAt: '2026-01-01T00:00:00.000Z' }
  const journalPath = join(roots.worker, 'runs.json')
  const journal = { version: 1, runs: { [runId]: entry } }
  const save = () => writeFileSync(journalPath, JSON.stringify(journal))
  save()
  return { input, roots, head, patch, git, journal, entry, journalPath, save, worktreePath, repoPath }
}

test('reads the real retained commit and compares live bytes with the daemon checkpoint without applying it or changing history', async t => {
  const f = fixture(t)
  const before = { journal: readFileSync(f.journalPath), index: readFileSync(join(f.repoPath, '.git', 'worktrees', f.worktreePath.split('/').at(-1), 'index')) }
  const result = await inspectRetainedDeliverable(f.input, f.roots)
  assert.equal(result.head, f.head)
  assert.equal(result.diffSha256, hash(f.patch)); assert.equal(result.diffBytes, f.patch.length)
  assert.equal(result.producerRunId, f.input.producerRunId); assert.equal(result.sessionId, f.input.producerSessionId)
  assert.equal(result.clean, true)
  assert.deepEqual(readFileSync(f.journalPath), before.journal)
  assert.deepEqual(readFileSync(join(f.repoPath, '.git', 'worktrees', f.worktreePath.split('/').at(-1), 'index')), before.index)
  assert.equal(f.git('-C', f.worktreePath, 'status', '--porcelain').toString(), '')
  assert.equal(f.git('-C', f.worktreePath, 'show', 'HEAD:artifact.txt').toString(), content)
})

function legacyQuestionFixture(t) {
  const f = fixture(t)
  const questionId = randomUUID(), continuesRunId = randomUUID()
  f.input.legacyQuestionSubmission = { questionId, continuesRunId }
  Object.assign(f.entry.assignment, { kind: 'implement', harness: 'codex', prompt: 'Synthetic answered delivery',
    questionId, continuesRunId, resumeSessionId: f.input.producerSessionId,
    requireSessionResume: true, preserveQuestionWorktree: true })
  Object.assign(f.entry, { state: 'stopped', questionResumeState: 'accepted',
    error: 'Submitted, but no verify command ran; the work is unverified' })
  f.save()
  return f
}

test('recognizes the historical submitted question journal without relabeling or rewriting it', async t => {
  const f = legacyQuestionFixture(t), before = readFileSync(f.journalPath)
  const result = await inspectRetainedDeliverable(f.input, f.roots)
  assert.equal(result.head, f.head)
  assert.equal(result.producerRunId, f.input.producerRunId)
  assert.equal(result.sessionId, f.input.producerSessionId)
  assert.equal(result.diffSha256, hash(f.patch))
  assert.deepEqual(readFileSync(f.journalPath), before)
  assert.equal(JSON.parse(before).runs[f.input.producerRunId].state, 'stopped')
})

test('legacy admission never grants a general stopped-run or question-binding exception', async t => {
  const f = legacyQuestionFixture(t), original = structuredClone(f.entry)
  const changes = [
    ['failed', entry => { entry.state = 'failed' }],
    ['cancelled', entry => { entry.state = 'cancelled' }],
    ['running', entry => { entry.state = 'running' }],
    ['ordinary stop', entry => { entry.stopReason = 'cancelled' }],
    ['blocked', entry => { entry.stopReason = 'blocked' }],
    ['other error', entry => { entry.error = 'PRIVATE-ERROR-SENTINEL' }],
    ['one changed error character', entry => { entry.error += '.' }],
    ['missing host error', entry => { entry.error = null }],
    ['unaccepted answer', entry => { entry.questionResumeState = 'starting' }],
    ['new delivery contract', entry => { entry.assignment.factoryExecuteKind = 'deliverable' }],
    ['factory check', entry => { entry.assignment.factoryCheck = { stage: 'review', reportOnly: true, inferCommand: false } }],
    ['different kind', entry => { entry.assignment.kind = 'acceptance' }],
    ['different harness', entry => { entry.assignment.harness = 'mock' }],
    ['read-only report', entry => { entry.assignment.policy = { readOnly: true } }],
    ['verification configured', entry => { entry.assignment.verifyCommand = 'must-not-run' }],
    ['empty verification field', entry => { entry.assignment.verifyCommand = '' }],
    ['null verification field', entry => { entry.assignment.verifyCommand = null }],
    ['false verification field', entry => { entry.assignment.verifyCommand = false }],
    ['session resume optional', entry => { entry.assignment.requireSessionResume = false }],
    ['worktree not preserved', entry => { entry.assignment.preserveQuestionWorktree = false }],
    ['different question', entry => { entry.assignment.questionId = randomUUID() }],
    ['different predecessor', entry => { entry.assignment.continuesRunId = randomUUID() }],
    ['different resume session', entry => { entry.assignment.resumeSessionId = 'other-native-session' }],
    ['new delivery snapshot', entry => { entry.deliverableCommit = f.head }],
  ]
  for (const [name, change] of changes) {
    Object.keys(f.entry).forEach(key => delete f.entry[key])
    Object.assign(f.entry, structuredClone(original)); change(f.entry); f.save()
    const before = readFileSync(f.journalPath)
    await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_journal_(?:state|binding)_mismatch/, name)
    assert.deepEqual(readFileSync(f.journalPath), before, name)
  }
  Object.keys(f.entry).forEach(key => delete f.entry[key])
  Object.assign(f.entry, original); f.save()
  await assert.rejects(inspectRetainedDeliverable({ ...f.input, legacyQuestionSubmission: undefined }, f.roots), /retained_delivery_journal_state_mismatch/)
})

test('refuses the old empty baseline instead of calling it a delivered candidate', async t => {
  const f = fixture(t)
  f.git('-C', f.worktreePath, 'reset', '--hard', f.input.sourceCommit)
  await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_checkpoint_mismatch/)
})

test('refuses a changed tracked file or new untracked file', async t => {
  const f = fixture(t)
  writeFileSync(join(f.worktreePath, 'artifact.txt'), 'changed after completion')
  await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_dirty/)
  f.git('-C', f.worktreePath, 'restore', 'artifact.txt')
  writeFileSync(join(f.worktreePath, 'untracked.txt'), 'not in the completed delivery')
  await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_dirty/)
})

test('does not trust a clean status hidden by assume-unchanged or skip-worktree index flags', async t => {
  const f = fixture(t)
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    f.git('-C', f.worktreePath, 'update-index', `--${flag}`, 'artifact.txt')
    writeFileSync(join(f.worktreePath, 'artifact.txt'), 'changed but hidden from status')
    assert.equal(f.git('-C', f.worktreePath, 'status', '--porcelain').toString(), '')
    await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_index_flags/)
    writeFileSync(join(f.worktreePath, 'artifact.txt'), content)
    f.git('-C', f.worktreePath, 'update-index', `--no-${flag}`, 'artifact.txt')
  }
})

test('never executes repository clean filters while inspecting retained files', async t => {
  const f = fixture(t)
  const attributes = join(f.repoPath, '.git', 'probe-attributes'), marker = join(f.repoPath, '.git', 'filter-executed')
  writeFileSync(attributes, 'artifact.txt filter=hostile\n')
  f.git('config', 'core.attributesFile', attributes)
  f.git('config', 'filter.hostile.clean', `touch '${marker}'; cat`)
  writeFileSync(join(f.worktreePath, 'artifact.txt'), content.replace('7 - 4 = 3', '7 - 4 = 8'))
  const error = await inspectRetainedDeliverable(f.input, f.roots).then(() => null, err => err)
  assert.equal(existsSync(marker), false, 'inspection must not execute a repository-supplied clean filter')
  assert.equal(error?.message, 'retained_delivery_git_filter')
})

test('refuses a wrong native session, active journal or changed host checkpoint', async t => {
  const f = fixture(t)
  await assert.rejects(inspectRetainedDeliverable({ ...f.input, producerSessionId: 'other' }, f.roots), /retained_delivery_journal_binding_mismatch/)
  f.entry.state = 'running'; f.save()
  await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_journal_state_mismatch/)
  f.entry.state = 'succeeded'; f.save()
  await assert.rejects(inspectRetainedDeliverable({ ...f.input, checkpoint: { ...f.input.checkpoint, patchSha256: 'a'.repeat(64) } }, f.roots), /retained_delivery_checkpoint_mismatch/)
})

test('rejects path redirection and a journal belonging to another repository', async t => {
  const f = fixture(t)
  const alias = join(f.roots.worker, 'worktrees', randomUUID())
  symlinkSync(f.worktreePath, alias)
  await assert.rejects(inspectRetainedDeliverable({ ...f.input, worktreePath: alias }, f.roots), /retained_delivery_path_mismatch/)
  f.entry.assignment.repoId = randomUUID(); f.save()
  await assert.rejects(inspectRetainedDeliverable(f.input, f.roots), /retained_delivery_journal_binding_mismatch/)
})

test('refuses an active sibling journal and never returns arbitrary filesystem text', async t => {
  const f = fixture(t)
  f.journal.runs[randomUUID()] = { ...f.entry, state: 'running', error: 'PRIVATE-SENTINEL' }; f.save()
  const error = await inspectRetainedDeliverable(f.input, f.roots).then(() => null, err => err)
  assert.equal(error.message, 'retained_delivery_active_run')
  assert.ok(!JSON.stringify(error).includes('PRIVATE-SENTINEL'))
})

test('remote command encodes scope as data and has fixed safe error output', () => {
  const script = readFileSync(new URL('../../scripts/e2b/inspect-retained-deliverable.mjs', import.meta.url), 'utf8')
  const command = retainedDeliverableProbeCommand(script, { repoPath: "bad'; touch /tmp/not-authorized; '" })
  assert.ok(!command.includes('touch /tmp/not-authorized'))
  assert.ok(command.includes('retained_delivery_probe_failed'))
  assert.ok(command.startsWith('/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /opt/mikka/runtime/node/bin/node '))
  // Only translate the official instance's private Node path to this test
  // runner. Execute the real command with a hostile inherited Node preload.
  const localCommand = command.replace('/opt/mikka/runtime/node/bin/node', `'${process.execPath.replaceAll("'", "'\\''")}'`)
  const actual = execFileSync('/bin/sh', ['-c', localCommand], { encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--require=/not-authorized/private-preload.cjs' } })
  assert.deepEqual(JSON.parse(actual), { ok: false, code: 'retained_delivery_scope_mismatch' })
})
