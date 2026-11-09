import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { windowProof, readWindow, productionWindowGuard, selectAcceptance, previousCaseProof, CASE_STEPS, executionProof, submitProof, linuxProof,
  negativeProof, positiveProof, repositoryPositiveProof, publicationProof, activityProof, mediaPath, readActivityEvidence, retainedEvidenceProof,
  fixture, initialRequest, ownCreditShare, repositorySnapshot, HANDOFF_REPOSITORY, visualCommand, nativeVisualProof, safeFailure } from './factory-visual-evidence.mjs'
import { processCaptureVideo } from '../../packages/daemon/src/agents/capture-video.mjs'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const source = 'a'.repeat(40), head = 'b'.repeat(40), digest = 'c'.repeat(64)
const origin = 'https://app.aspectlylabs.com', now = Date.parse('2026-11-09T16:00:00Z')
const hash = value => createHash('sha256').update(value).digest('hex')
const copy = value => structuredClone(value)
const rejects = (operation, code) => assert.throws(operation, error => safeFailure(error) === code)
function marker(state = 'active', expiresAt = '2026-11-09T17:30:00Z') {
  return `Window for #1783.\n<!-- mikka-factory-1783 ${JSON.stringify({ state, issue: 1783, pr: 1789, headSha: head, expiresAt })} -->`
}
const comment = () => ({ id: 1783001, user: { login: 'alexj11324' }, body: marker() })

test('release window binds the exact final PR head, author, two-hour expiry and unchanged marker', () => {
  const value = comment(), proof = windowProof(value, { headSha: head, now })
  assert.equal(proof.commentId, value.id)
  assert.equal(proof.markerSha256.length, 64)
  for (const changed of [
    { ...value, user: { login: 'another-owner' } }, { ...value, body: marker('released') },
    { ...value, body: marker('active', '2026-11-09T15:59:00Z') },
    { ...value, body: marker('active', '2026-11-09T18:01:00Z') },
  ]) rejects(() => windowProof(changed, { headSha: head, now }), 'window')
  rejects(() => windowProof(value, { headSha: source, now }), 'window')
  rejects(() => windowProof(value, { headSha: head, now, expectedDigest: digest }), 'window')
})

test('ordinary later discussion does not revoke a window; its exact comment edit or a newer own marker does', async () => {
  const value = comment(), comments = [value, { id: value.id + 1, user: { login: 'alexj11324' }, body: 'Working offline on a different PR.' }]
  const calls = []
  const read = async path => { calls.push(path); if (path === '/issues/1752') return { comments: comments.length }
    if (path.startsWith('/issues/1752/comments')) return comments; if (path === `/issues/comments/${value.id}`) return value; throw Error('unexpected route') }
  const selected = await readWindow(read, { headSha: head, now })
  assert.equal(selected.commentId, value.id)
  await readWindow(read, { headSha: head, now, expectedId: value.id, expectedDigest: selected.markerSha256 })
  assert.ok(calls.includes(`/issues/comments/${value.id}`))
  value.body = marker('released')
  await assert.rejects(readWindow(read, { headSha: head, now, expectedId: value.id, expectedDigest: selected.markerSha256 }), /:window/)
  value.body = marker(); comments.push({ ...value, id: value.id + 2 })
  await assert.rejects(readWindow(read, { headSha: head, now, expectedId: value.id }), /:window/)
})

test('an expired or released in-flight window refuses the next real mutation while cleanup remains possible', async () => {
  for (const release of ['expiry', 'edited', 'new-marker', 'slow-read']) {
    const value = comment(), proof = windowProof(value, { headSha: head, now }), comments = [value], calls = []
    let clock = now, writes = 0, cleanups = 0, slow = false
    const read = async path => {
      calls.push(path)
      if (path === '/issues/1752') return { comments: comments.length }
      if (path.startsWith('/issues/1752/comments')) return comments
      if (path === `/issues/comments/${value.id}`) { if (slow) clock = Date.parse(proof.expiresAt); return value }
      assert.fail('unexpected read')
    }
    const lease = productionWindowGuard(proof, read, { now: () => clock })
    await lease.write(() => { writes++ })
    assert.equal(writes, 1)
    assert.ok(calls.includes(`/issues/comments/${value.id}`))
    if (release === 'expiry') clock = Date.parse(proof.expiresAt)
    if (release === 'edited') value.body = marker('released')
    if (release === 'new-marker') comments.push({ ...comment(), id: value.id + 1, body: marker('released') })
    if (release === 'slow-read') slow = true
    try { await assert.rejects(lease.write(() => { writes++ }), /:window/) }
    finally { cleanups++ } // The production finally block calls its owner cleanup directly, outside the write guard.
    assert.equal(writes, 1, release)
    assert.equal(cleanups, 1, release)
    if (release === 'expiry' || release === 'slow-read') rejects(lease.current, 'window')
  }
})

test('Web finishing before its exact E2B release defers without signing in or requesting workload credentials', async () => {
  const paths = [], env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: source, GITHUB_RUN_ID: '420', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN: 'fixture-token', APPLICATION_SHA: source, RUNNER_TEMP: '/tmp', FACTORY_VISUAL_MODEL_CASE: 'all' }
  const fetchImpl = async url => {
    const path = new URL(url).pathname.replace('/repos/alexj11324/Mikka', '') + new URL(url).search
    paths.push(path)
    let value
    if (path === '/pulls/1789') value = { number: 1789, merged: true, merge_commit_sha: source,
      base: { ref: 'main', repo: { full_name: 'alexj11324/Mikka' } },
      head: { ref: 'feat/factory-visual-evidence', sha: head, repo: { full_name: 'alexj11324/Mikka' } } }
    else if (path === '/git/ref/heads/main') value = { object: { type: 'commit', sha: source } }
    else if (path === '/issues/1752') value = { comments: 1 }
    else if (path.startsWith('/issues/1752/comments')) value = [comment()]
    else if (path.includes('/e2b-official-runtime.yml/runs?branch=main&status=')) value = path.includes('status=in_progress&')
      ? { total_count: 1, workflow_runs: [{ id: 99, head_branch: 'main', status: 'in_progress' }] } : { total_count: 0, workflow_runs: [] }
    else throw Error('unexpected network request')
    return Response.json(value)
  }
  const selected = await selectAcceptance(env, {}, { fetchImpl, now: () => now, checkout: false,
    webProof: async () => { throw Error('Web verification must not wait while runtime owns its release') } })
  assert.equal(selected.selected, false); assert.equal(selected.reason, 'runtime_in_progress')
  assert.ok(paths.every(path => !path.includes('auth') && !path.includes('artifacts')))
})

test('only the successful native execution step of the exact job attempt can be reused', () => {
  const expected = { runId: 10, runAttempt: 2, sourceCommit: source }
  const jobs = { total_count: 1, jobs: [{ id: 20, name: 'acceptance', run_id: 10, run_attempt: 2, head_sha: source,
    steps: [{ name: CASE_STEPS.claude, status: 'completed', conclusion: 'failure' },
      { name: CASE_STEPS.codex, status: 'completed', conclusion: 'success' }] }] }
  const result = previousCaseProof(jobs, expected)
  assert.equal(result.claude.attempted, true); assert.equal(result.claude.passed, false)
  assert.equal(result.codex.passed, true); assert.equal(result.codex.runAttempt, 2)
  const skipped = copy(jobs); skipped.jobs[0].steps[1].conclusion = 'skipped'
  assert.equal(previousCaseProof(skipped, expected).codex.passed, false)
  rejects(() => previousCaseProof(jobs, { ...expected, runAttempt: 1 }), 'prior_receipt')
})

const scope = { ownerId: 'shared-smoke-owner', adminId: 'team-subscription-owner', botId: id(1), workspaceId: id(2), evidence: { teamWorkspaceHash: 'team-hash' } }
const item = { id: 'codex', harness: 'codex', model: 'gpt-6-luna' }
const profile = { id: id(3), version: 1, digest }
function runEvidence(runId = id(4)) {
  return { recording: false, captures: [], run: { id: runId, issueId: id(5), botId: scope.botId, status: 'succeeded',
    harness: item.harness, model: item.model, credentialType: 'subscription', subscriptionRoute: 'codex_cli',
    agentProfile: { profileId: profile.id, version: profile.version, digest, source: 'explicit' }, executionIdentity: {
      version: 1, requester: scope.ownerId, executionPrincipal: scope.ownerId, outputOwner: scope.ownerId, botOwner: scope.ownerId,
      botId: scope.botId, workspaceId: scope.workspaceId, personalResourcePolicy: 'requester_only',
      resourceBindings: [{ kind: 'device', id: id(6), ownerId: scope.ownerId, access: 'owner' },
        { kind: 'subscription', id: id(7), ownerId: scope.adminId, access: 'workspace_share', revision: '2' }],
      billingAccount: { model: { kind: 'subscription', ownerId: scope.adminId, resourceId: id(7) },
        runtime: { kind: 'e2b', ownerId: scope.ownerId, resourceId: scope.ownerId } },
    } } }
}

test('official shared subscription proof refuses API fallback, wrong payer and another profile version', () => {
  const expected = { item, scope, profile, issueId: id(5), runId: id(4) }
  assert.equal(executionProof(runEvidence(), expected).sharedSubscription, true)
  for (const change of [e => { e.run.credentialType = 'api_key' }, e => { e.run.model = 'unselected-model' },
    e => { e.run.executionIdentity.billingAccount.model.ownerId = scope.ownerId }, e => { e.run.agentProfile.version++ }]) {
    const value = runEvidence(); change(value); rejects(() => executionProof(value, expected), 'scope')
  }
})

function detail(runId = id(4), { output = 'Handed in. End your turn now.', attempts = [runId], cursorChain = runId, cursorRuns = 1, prefix = '' } = {}) {
  return { thread: { rootRunId: attempts[0], attempts: attempts.map(value => ({ runId: value, status: 'succeeded' })) },
    chunkCursor: { chain: cursorChain, runId, seq: 4, runs: cursorRuns, count: 4 }, chunks: [
      { chunk: { type: 'tool-input-available', toolName: 'mcp__mikka__submit', toolCallId: prefix + 'submit-1', input: { summary: 'Fixture' } } },
      { chunk: { type: 'tool-output-available', toolCallId: prefix + 'submit-1', output } },
    ] }
}

test('submit proof requires the real successful MCP payload, never a prose claim, error wrapper or report_blocked', () => {
  for (const output of ['Handed in. End your turn now.', [{ type: 'text', text: 'Handed in. End your turn now.' }],
    { content: [{ type: 'text', text: 'Handed in. End your turn now.' }] }]) assert.equal(submitProof(detail(id(4), { output }), id(4)).ordinarySubmit, true)
  for (const output of ['I submitted successfully', 'Recorded. End your turn now.',
    [{ type: 'text', text: 'Could not record: unavailable' }], JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Handed in. End your turn now.' }] })]) {
    rejects(() => submitProof(detail(id(4), { output }), id(4)), 'submit_receipt')
  }
  const blocked = detail(); blocked.chunks.push({ chunk: { type: 'tool-input-available', toolName: 'mcp__mikka__report_blocked', toolCallId: 'blocked' } })
  rejects(() => submitProof(blocked, id(4)), 'submit_receipt')
})

test('continuation tool attribution uses actual cursor scope, not the full historical attempt count', () => {
  const next = id(14), continued = detail(next, { attempts: [id(4), next] })
  assert.equal(submitProof(continued, next).runId, next)
  const across = detail(next, { attempts: [id(4), next], cursorChain: `${id(4)},${next}`, cursorRuns: 2, prefix: `${id(4)}:` })
  rejects(() => submitProof(across, next), 'submit_receipt')
  const properlyScoped = detail(next, { attempts: [id(4), next], cursorChain: `${id(4)},${next}`, cursorRuns: 2, prefix: `${next}:` })
  assert.equal(submitProof(properlyScoped, next).runId, next)
})

test('positive stored submit must explicitly name every actual capture once and authorize its safe publication', () => {
  const value = detail(), captureIds = [id(31), id(32)]
  value.chunks[0].chunk.input.visualEvidence = captureIds.map(captureId => ({ captureId, publicSafe: true }))
  assert.deepEqual(submitProof(value, id(4), { captureIds }).visualEvidence, value.chunks[0].chunk.input.visualEvidence)
  for (const declarations of [[], [{ captureId: id(31), publicSafe: true }, { captureId: id(31), publicSafe: true }],
    [{ captureId: id(31), publicSafe: true }, { captureId: id(32), publicSafe: false }],
    [{ captureId: id(31), publicSafe: true }, { captureId: id(99), publicSafe: true }]]) {
    value.chunks[0].chunk.input.visualEvidence = declarations
    rejects(() => submitProof(value, id(4), { captureIds }), 'submit_receipt')
  }
})

test('the two real cases select normal Bot-computer and repository dispatch with task-private tools and media', () => {
  const driver = { runId: 42, runAttempt: 1 }, claude = { id: 'claude', harness: 'claude_code', model: 'claude-haiku-5-5' }
  const negative = fixture(source, head, claude, driver), repository = fixture(source, head, item, driver)
  const binding = { issueId: id(5), botId: scope.botId, profileId: profile.id }
  assert.match(initialRequest(negative, { ...binding, item: claude }), /normal dispatch_bot_computer tool/)
  assert.match(initialRequest(repository, { ...binding, item }), /normal dispatch_run tool/)
  assert.equal(negative.repository, null); assert.equal(repository.repository, HANDOFF_REPOSITORY)
  assert.equal(repository.relativeFile, `docs/issue-1783/${repository.title}`)
  assert.match(negative.initial, /without visualEvidence/)
  assert.doesNotMatch(repository.initial, /deliberate.*omission|without visualEvidence/)
  for (const value of [negative, repository]) {
    assert.match(value.setupCommand, /'--prefix', tools/)
    assert.match(value.setupCommand, /'install', '--with-deps', 'chromium'/)
    assert.match(value.setupCommand, /process.env.MIKKA_RUN_ID/)
    assert.match(value.setupCommand, /await realpath\(allowedTemporary\)/)
    assert.match(value.captureCommand, /temporary !== root && !temporary.startsWith/)
    assert.match(value.captureCommand, /join\(temporary, spec.marker, 'visual'\)/)
    assert.ok(value.followup.length < 10_000, 'normal mobile follow-up limit')
    assert.ok(initialRequest(value, { ...binding, item }).length < 1000, 'dispatch reads saved issue content without duplicating a long tool note')
  }
})

test('temporary credit share changes only this member and restores false even after a lost update response', async () => {
  for (const scenario of ['already_shared', 'temporary', 'lost_response']) {
    let mine = scenario === 'already_shared', writes = 0, guarded = 0
    const client = { rpc: async (action, args) => {
      if (action === 'personal-policy.getCreditShare') { assert.deepEqual(args, [scope.workspaceId]); return { mine, canShare: true } }
      assert.equal(action, 'personal-policy.updateCreditShare'); assert.equal(args[1], scope.workspaceId)
      mine = args[0]; writes++
      if (scenario === 'lost_response' && mine) throw Error('response lost after ordinary update committed')
      return { mine, canShare: true }
    } }
    const share = ownCreditShare(client, scope.workspaceId, async operation => { guarded++; return operation() })
    if (scenario === 'lost_response') await assert.rejects(share.prepare(), /response lost/)
    else await share.prepare()
    await share.restore()
    assert.equal(mine, scenario === 'already_shared')
    assert.equal(writes, scenario === 'already_shared' ? 0 : 2)
    assert.equal(guarded, scenario === 'already_shared' ? 0 : 1, 'cleanup remains possible after lease expiry')
    assert.equal(share.state.restored, scenario !== 'already_shared')
  }
})

test('actual Git delivery rejects an untracked dependency/media file, extra committed file or an altered existing fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-visual-repository-')), relativeFile = 'docs/issue-1783/m1783-fixture.txt'
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Acceptance fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
    git(['remote', 'add', 'origin', `https://github.com/${HANDOFF_REPOSITORY}.git`])
    await writeFile(join(directory, 'README.md'), 'existing\n'); git(['add', 'README.md']); git(['commit', '-m', 'fixture baseline'])
    const base = git(['rev-parse', 'HEAD']); git(['update-ref', 'refs/remotes/origin/main', base])
    await mkdir(join(directory, 'docs/issue-1783'), { recursive: true }); await writeFile(join(directory, relativeFile), 'actual\n')
    git(['add', relativeFile]); git(['commit', '-m', 'own text'])
    const good = git(['rev-parse', 'HEAD']), proof = repositorySnapshot(HANDOFF_REPOSITORY, relativeFile, directory)
    assert.equal(proof.head, good); assert.equal(proof.base, base); assert.deepEqual(proof.changedFiles, [relativeFile])
    await writeFile(join(directory, 'package-lock.json'), '{}\n')
    assert.throws(() => repositorySnapshot(HANDOFF_REPOSITORY, relativeFile, directory), /repository_scope/)
    git(['add', 'package-lock.json']); git(['commit', '--amend', '--no-edit'])
    assert.throws(() => repositorySnapshot(HANDOFF_REPOSITORY, relativeFile, directory), /repository_scope/)
    git(['reset', '--hard', good]); await writeFile(join(directory, 'README.md'), 'changed someone else\n')
    git(['add', 'README.md']); git(['commit', '--amend', '--no-edit'])
    assert.throws(() => repositorySnapshot(HANDOFF_REPOSITORY, relativeFile, directory), /repository_scope/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Linux evidence requires native uname input and actual output from the same run', () => {
  const value = detail(); value.chunks = [
    { chunk: { type: 'tool-input-available', toolName: 'shell', toolCallId: 'uname', input: { command: 'uname -s' } } },
    { chunk: { type: 'tool-output-available', toolCallId: 'uname', output: [{ type: 'text', text: 'Linux\n' }] } },
  ]
  assert.equal(linuxProof(value, id(4)).platform, 'linux')
  value.chunks[0].chunk.input.command = "/bin/bash -lc 'uname -s'"
  assert.equal(linuxProof(value, id(4)).platform, 'linux')
  value.chunks[0].chunk.input.command = "printf Linux"; rejects(() => linuxProof(value, id(4)), 'native_linux')
})

test('native visual proof binds the entire browser program, actual queued capture IDs and downloaded encoded bytes', () => {
  const fixture = { marker: 'm1783-fixture', title: 'm1783-fixture.txt', content: 'actual file\n' }
  const workerSha = 'f'.repeat(40), command = visualCommand(fixture, source, workerSha), runId = id(14), value = detail(runId)
  const receipt = { version: 1, marker: fixture.marker, sourceCommit: source, workerSha, runId, temporaryRootVerified: true, temporaryOutsideWorktree: true,
    platform: 'linux', pageMatched: true, reloadMatched: true,
    fileSha256: hash(fixture.content), image: { path: '/own-worktree/verification.png', bytes: 10, sha256: digest },
    video: { path: '/own-worktree/recorded.webm', originalSha256: 'd'.repeat(64), encodedBytes: 20, encodedSha256: 'e'.repeat(64), durationMs: 2000 } }
  value.chunks = [
    { chunk: { type: 'tool-input-available', toolName: 'bash', toolCallId: 'capture', input: { command } } },
    { chunk: { type: 'tool-output-available', toolCallId: 'capture', output: { exitCode: 0, output: 'MIKKA_1783_VISUAL ' + JSON.stringify(receipt) } } },
    ...[['image', 31], ['video', 32]].flatMap(([kind, number]) => [
      { chunk: { type: 'tool-input-available', toolName: 'mcp__mikka__submit_capture', toolCallId: kind, input: { path: receipt[kind].path } } },
      { chunk: { type: 'tool-output-available', toolCallId: kind, output: [{ type: 'text', text: JSON.stringify({ captureId: id(number), status: 'queued' }) }] } },
    ]),
  ]
  const evidence = { media: [{ kind: 'image', runId, source: 'local', captureId: id(31), sha256: digest, bytes: 10 },
    { kind: 'video', runId, source: 'local', captureId: id(32), sha256: 'e'.repeat(64), bytes: 20 }] }
  assert.equal(nativeVisualProof(value, runId, command, fixture, source, workerSha, evidence).videoEncodedSha256, 'e'.repeat(64))
  const altered = copy(value); altered.chunks[0].chunk.input.command += '\necho fake-receipt'
  rejects(() => nativeVisualProof(altered, runId, command, fixture, source, workerSha, evidence), 'native_visual')
  const wrongCapture = copy(evidence); wrongCapture.media[1].captureId = id(99)
  rejects(() => nativeVisualProof(value, runId, command, fixture, source, workerSha, wrongCapture), 'native_visual')
  const rawInsteadOfProcessed = copy(evidence); rawInsteadOfProcessed.media[1].sha256 = receipt.video.originalSha256
  rejects(() => nativeVisualProof(value, runId, command, fixture, source, workerSha, rawInsteadOfProcessed), 'native_visual')
  rejects(() => nativeVisualProof(value, runId, command, fixture, head, workerSha, evidence), 'native_visual')
  rejects(() => nativeVisualProof(value, runId, command, fixture, source, source, evidence), 'native_visual')
  for (const changed of [{ runId: id(99) }, { temporaryRootVerified: false }, { temporaryOutsideWorktree: false }]) {
    const bad = copy(value); bad.chunks[1].chunk.output.output = 'MIKKA_1783_VISUAL ' + JSON.stringify({ ...receipt, ...changed })
    rejects(() => nativeVisualProof(bad, runId, command, fixture, source, workerSha, evidence), 'native_visual')
  }
})

test('released real FFmpeg processing is byte-deterministic for the native expected-output versus normal uploader comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-visual-ffmpeg-'))
  try {
    const input = join(directory, 'actual-test.webm')
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10', '-t', '0.6',
      '-c:v', 'libvpx-vp9', input], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
    const first = join(directory, 'expected.mp4'), second = join(directory, 'uploaded.mp4')
    const a = await processCaptureVideo(input, first), b = await processCaptureVideo(input, second)
    assert.equal(a.processing.originalSha256, b.processing.originalSha256)
    assert.deepEqual(await readFile(first), await readFile(second))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function blockedState() {
  const task = { id: id(8), issueId: id(5), botId: scope.botId, sourceEventId: id(9), stage: 'execute', status: 'blocked',
    candidateId: id(10), attemptId: id(11), revision: 4, route: { flowVersion: 2 } }
  return { task, candidates: [{ id: id(10), taskId: task.id, runId: id(4), kind: 'deliverable', sha: null,
    repository: `/home/user/.mikka/bot-workspaces/${scope.botId}`, scope: `issue:${task.issueId}` }], attempts: [
    { id: id(11), stage: 'execute', status: 'blocked', candidateId: id(10), runId: id(4), output: { requestEpoch: id(9),
      evidenceGate: { code: 'factory_visual_evidence_required', candidateId: id(10), sourceEventId: id(9), eventId: id(12) } } },
  ] }
}

test('negative requires a persisted current execute gate following real submit, with no downstream stage or capture', () => {
  assert.equal(negativeProof(blockedState(), runEvidence(), detail()).hostGate.code, 'factory_visual_evidence_required')
  for (const change of [state => { delete state.attempts[0].output.evidenceGate }, state => { state.attempts[0].output.evidenceGate.candidateId = id(99) },
    state => { state.task.sourceEventId = id(99) }, state => { state.candidates[0].repository = 'none' },
    state => { state.attempts.push({ stage: 'review', output: { requestEpoch: id(9) } }) }]) {
    const state = blockedState(); change(state); rejects(() => negativeProof(state, runEvidence(), detail()), 'negative_host_gate_missing')
  }
  const evidence = runEvidence(); evidence.captures.push({ id: id(20), kind: 'video' })
  rejects(() => negativeProof(blockedState(), evidence, detail()), 'negative_capture_present')
})

function reviewedState() {
  const state = blockedState(); state.task = { ...state.task, id: id(13), sourceEventId: id(15), candidateId: id(16), attemptId: id(17), stage: 'approval', status: 'pending', revision: 9 }
  state.candidates = [{ ...state.candidates[0], id: id(16), taskId: id(13), runId: id(14) }]
  state.attempts = ['execute', 'review'].map((stage, i) => ({ id: id(18 + i), stage, status: 'passed', candidateId: id(16), runId: id(14 + i * 10), output: { requestEpoch: id(15) } }))
  return state
}
const passedRuns = () => new Map([[id(14), { status: 'succeeded' }], [id(24), { status: 'succeeded' }]])
const negative = () => negativeProof(blockedState(), runEvidence(), detail())
const positive = () => positiveProof(reviewedState(), negative(), passedRuns())

test('positive continuation can use a new task, but cannot reuse the old epoch, producer, candidate or independent check', () => {
  assert.equal(positive().taskId, id(13))
  for (const change of [state => { state.task.sourceEventId = id(9) }, state => { state.candidates[0].runId = id(4) },
    state => { state.task.botId = id(99) }, state => { state.candidates[0].taskId = id(8) }]) {
    const state = reviewedState(); change(state); rejects(() => positiveProof(state, negative(), passedRuns()), 'positive_candidate')
  }
  const state = reviewedState(); state.attempts[1].runId = id(14)
  rejects(() => positiveProof(state, negative(), passedRuns()), 'independent_checks')
})

test('repository positive proof binds the actual commit and independent checks without pretending a negative continuation ran', () => {
  const state = reviewedState(); state.candidates[0] = { ...state.candidates[0], kind: 'repository', sha: head,
    repository: `https://github.com/${HANDOFF_REPOSITORY}.git` }
  const expected = { issueId: id(5), botId: scope.botId }, proof = repositoryPositiveProof(state, expected, passedRuns())
  assert.equal(proof.candidateSha, head); assert.equal(proof.repository, HANDOFF_REPOSITORY)
  for (const change of [value => { value.candidates[0].repository = 'https://github.com/someone/another.git' },
    value => { value.candidates[0].kind = 'deliverable' }, value => { value.candidates[0].sha = null },
    value => { value.task.status = 'passed' }, value => { value.task.botId = id(99) }]) {
    const changed = copy(state); change(changed); rejects(() => repositoryPositiveProof(changed, expected, passedRuns()), 'positive_candidate')
  }
  state.attempts[1].runId = state.attempts[0].runId
  rejects(() => repositoryPositiveProof(state, expected, passedRuns()), 'independent_checks')
})

test('host publication projection requires the same producer, candidate and authorized repository while leaving direct GitHub proof pending', () => {
  const positive = { ...positiveProof(reviewedState(), negative(), passedRuns()), candidateSha: head }, url = `https://github.com/${HANDOFF_REPOSITORY}/pull/12`
  const view = { task: { pullRequest: { url, state: 'open' } }, artifacts: [
    { kind: 'pull_request', url, state: 'open', runId: positive.runId, candidateId: positive.candidateId },
  ] }
  const proof = publicationProof(view, positive, 'AC-42')
  assert.equal(proof.branch, 'mikka/ac-42'); assert.equal(proof.directGitHubRead, 'pending_operator_connector_verification')
  for (const change of [value => { value.artifacts[0].runId = id(99) }, value => { value.artifacts[0].candidateId = id(99) },
    value => { value.artifacts[0].state = 'merged' }, value => { value.task.pullRequest.url += '3' },
    value => { value.artifacts[0].url = 'https://github.com/someone/another/pull/12' }]) {
    const changed = copy(view); change(changed); rejects(() => publicationProof(changed, positive, 'AC-42'), 'publication')
  }
})

function activity() {
  const p = positive(), reportId = id(30)
  const media = ['video', 'image'].map((kind, i) => ({ captureId: id(31 + i), runId: p.runId, candidateId: p.candidateId,
    appliesToCurrentCandidate: true, kind, contentType: kind === 'video' ? 'video/mp4' : 'image/png', size: 10,
    url: `${origin}/mikka/api/captures/${id(31 + i)}` }))
  return { version: 1, task: { id: p.taskId, issueId: p.issueId, revision: p.revision,
    acceptance: { artifactId: reportId, version: 2, runId: p.runId, candidateId: p.candidateId, media } }, artifacts: [
    { kind: 'acceptance', artifactId: reportId, version: 2, runId: p.runId, candidateId: p.candidateId,
      downloadUrl: `/mikka/api/artifacts/${reportId}/versions/2/download` },
    ...media.map(value => ({ ...value, url: `/mikka/api/factory/tasks/${p.taskId}/media/${value.captureId}`,
      posterUrl: value.kind === 'video' ? `/mikka/api/factory/tasks/${p.taskId}/media/${value.captureId}/poster` : null })),
  ] }
}

test('activity binds exact report version and current producer media; historical, reviewer or foreign-origin files cannot substitute', () => {
  assert.equal(activityProof(activity(), positive()).media.length, 2)
  for (const change of [value => { value.artifacts[0].version++ }, value => { value.artifacts[0].runId = id(24) },
    value => { value.task.acceptance.media[0].candidateId = id(10) }, value => { value.task.acceptance.media[0].appliesToCurrentCandidate = false }]) {
    const value = activity(); change(value); rejects(() => activityProof(value, positive()), 'report_binding')
  }
  const stale = activity(); stale.task.revision--; rejects(() => activityProof(stale, positive()), 'activity')
  const old = activity(); old.artifacts[1].runId = id(4); rejects(() => activityProof(old, positive()), 'activity')
  const wrong = activity(); wrong.task.acceptance.media[0].url = `https://outside.invalid/mikka/api/captures/${id(31)}`
  rejects(() => activityProof(wrong, positive()), 'media_origin')
  rejects(() => mediaPath(`/mikka/api/artifacts/${id(30)}/versions/1/download`, `/mikka/api/artifacts/${id(30)}/versions/2/download`), 'media_origin')
})

test('actual GET bytes through activity and immutable report links must match; every image, video and poster is decoded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-visual-1783-')), p = positive(), view = activity()
  const video = Buffer.from('0123456789'), screenshot = Buffer.from('abcdefghij'), poster = Buffer.from('poster'), decoded = []
  const content = `${p.runId}\n${p.candidateId}\n${view.task.acceptance.media.map(value => value.url).join('\n')}\n`
  let tamper = false
  const client = { request: async path => {
    if (path.includes('/artifacts/')) return new Response(content, { headers: { 'content-type': 'text/markdown' } })
    if (path.endsWith('/poster')) return new Response(poster, { headers: { 'content-type': 'image/jpeg' } })
    const isVideo = path.endsWith(id(31)), bytes = isVideo ? video : screenshot
    return new Response(tamper && path.startsWith('/api/captures/') ? Buffer.from('wrong-data') : bytes,
      { headers: { 'content-type': isVideo ? 'video/mp4' : 'image/png', 'content-length': String(bytes.length) } })
  } }
  try {
    const evidence = await readActivityEvidence(client, view, p, { directory, caseId: 'codex', decode: (file, kind) => {
      decoded.push({ file, kind }); return { decoded: true, codec: 'fixture', width: 16, height: 16 }
    } })
    assert.equal(evidence.media[0].sha256, hash(video)); assert.equal(decoded.length, 3)
    assert.equal((await readFile(join(directory, evidence.report.file), 'utf8')), content)
    const snapshot = { task: { id: p.taskId, issueId: p.issueId, candidateId: p.candidateId, stage: 'approval', status: 'cancelled', revision: p.revision + 1 } }
    view.task.revision++
    const retained = await readActivityEvidence(client, view, { ...p, revision: view.task.revision }, { directory, caseId: 'codex-after-cleanup', decode: () => ({ decoded: true, codec: 'fixture', width: 16, height: 16 }) })
    assert.equal(retainedEvidenceProof(snapshot, p, evidence, retained).normalCancellationAfterVerification, true)
    const wrongCandidate = copy(snapshot); wrongCandidate.task.candidateId = id(99)
    rejects(() => retainedEvidenceProof(wrongCandidate, p, evidence, retained), 'cleanup')
    for (const change of [value => { value.report.version++ }, value => { value.report.sha256 = digest }, value => { value.media[0].sha256 = digest }]) {
      const wrong = copy(retained); change(wrong); rejects(() => retainedEvidenceProof(snapshot, p, evidence, wrong), 'report_binding')
    }
    view.task.revision--
    tamper = true
    await assert.rejects(readActivityEvidence(client, view, p, { directory, caseId: 'codex', decode: () => ({ decoded: true }) }), /:media_bytes/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('workflow keeps failed native steps red, continues the other path, and gates all credentials behind exact release checks', async () => {
  const text = await readFile(new URL('../../.github/workflows/factory-visual-evidence-acceptance.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /continue-on-error|secrets:\s*inherit|pull_request_target/)
  assert.match(text, /workflows: \[Web deploy, E2B additive runtime release\]/)
  assert.match(text, /group: production-smoke-owner-acceptance/)
  assert.match(text, /ref: \$\{\{ needs\.authorize\.outputs\.source-sha \}\}/)
  const codex = text.slice(text.indexOf('- name: ' + CASE_STEPS.codex), text.indexOf('- name: Require both official'))
  assert.match(codex, /if: always\(\) && steps\.attest\.outcome == 'success' && steps\.password\.outcome == 'success'/)
  const final = text.slice(text.indexOf('- name: Require both official'), text.indexOf('- name: Retain actual'))
  assert.match(final, /if: always\(\)/); assert.match(final, /factory-visual-evidence\.mjs complete/)
  assert.equal((text.match(/identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/g) ?? []).length, 2)
  assert.ok(text.indexOf('factory-visual-evidence.mjs attest') < text.indexOf('secret-name: SMOKE_OWNER_EMAIL'))
  assert.match(text, /secret-name: SMOKE_OWNER_PASSWORD/)
  assert.doesNotMatch(text, /ACME_DEMO_|E2B_API_KEY|MIKKA_DATABASE_URL|DATABASE_URL/)
})
