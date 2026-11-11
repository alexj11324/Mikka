import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { assertRunScope, createWorkspaceProbe, nativeProbeCommand, nativeReceipt, readOptions, runCodingWorkspaceAcceptance } from './coding-workspace.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const epoch = Date.parse('2026-11-08T12:00:00.000Z')
const at = offset => new Date(epoch + offset).toISOString()
const options = { sourceCommit: 'a'.repeat(40), workerSha: 'b'.repeat(40), workerSourceCommit: 'c'.repeat(40) }
const models = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const source = '# README fixture\nA real file selection.\n'
const key = 'v2/github.com/alexj11324/mikka-handoff'

function fixture(harness = 'claude_code', changes = {}) {
  const calls = [], scope = { ownerId: 'fixture-user', workspaceId: id(2), botId: id(3) }
  const record = { sampleId: `fixture_${harness}`, harness, runId: id(harness === 'codex' ? 11 : 1), issueId: id(harness === 'codex' ? 14 : 4), title: '测试 1721 fixture',
    execution: { deviceId: id(5), credentialType: 'subscription', harness, model: models[harness], sharedScope: { verified: true } },
    status: 'execution_proved_awaiting_server_timing', replyVerifiedAfterTool: true }
  const identity = { version: 1, runId: record.runId, repoId: id(6), deviceId: id(5), workspaceId: scope.workspaceId,
    ownerId: scope.ownerId, repositoryKey: key, bindingId: 'e'.repeat(64) }
  const headSha = 'd'.repeat(40), contentSha256 = sha(source), totalLines = source.split('\n').length
  const revision = { source: 'working', headSha, baseSha: headSha, version: sha(`${headSha}:README.md:${contentSha256}`) }
  const file = { ok: true, kind: 'file', identity, revision, observedAt: at(0), availability: 'online', path: 'README.md',
    size: Buffer.byteLength(source), format: 'text', content: source, contentSha256, language: 'md',
    startLine: 1, endLine: totalLines, totalLines, truncated: false, editable: false }
  const entries = [{ path: 'README.md', name: 'README.md', kind: 'file', size: null }]
  const listRevision = { ...revision, version: sha(JSON.stringify([headSha, entries])) }
  const contextRevision = { ...revision, version: sha(JSON.stringify([['README.md', contentSha256]])) }
  const native = { version: 1, status: 'passed', caseId: record.sampleId, harness, runId: record.runId, repositoryKey: key,
    headSha, workerSha: options.workerSha, workerSourceCommit: options.workerSourceCommit, markerUid: 0, markerMode: 0o444,
    markerWritable: false, sourceUid: 0, sourceWritable: false, path: 'README.md', size: file.size,
    contentSha256, selectedSha256: contentSha256, startLine: 1, endLine: totalLines, totalLines, observedAt: at(1250) }
  const input = { at: at(1000), chunk: { type: 'tool-input-available', toolName: harness === 'codex' ? 'bash' : 'Bash', toolCallId: 'native-probe-1',
    input: { command: nativeProbeCommand(record.sampleId, harness) } } }
  const output = () => ({ at: at(1500), chunk: { type: 'tool-output-available', toolCallId: 'native-probe-1',
    output: harness === 'codex' ? { exitCode: 0, output: `MIKKA_FILES_PROBE=${JSON.stringify(native)}\n` } : `MIKKA_FILES_PROBE=${JSON.stringify(native)}\n` } })
  const stages = [{ at: at(0), chunk: { type: 'data-run-stage', data: { stage: 'worktree', ok: true, ms: 20 } } },
    { at: at(500), chunk: { type: 'data-run-stage', data: { stage: 'agent_start', ok: true, ms: 20 } } }]
  const detail = (proof = true) => ({ thread: { id: record.runId, rootRunId: record.runId, latestRunId: record.runId,
    ownedByCurrentUser: true, status: 'running', detail: { harness }, attempts: [{ runId: record.runId, status: 'running' }] },
  chunks: [...stages, ...(proof ? [input, output()] : [])] })
  const selection = { kind: 'file', path: 'README.md', range: { startLine: 1, endLine: 20 } }
  const mention = { id: id(7), runId: record.runId, repoId: identity.repoId, selection,
    files: [{ path: 'README.md', range: { startLine: 1, endLine: totalLines }, expected: { headSha, contentSha256 } }],
    revision: contextRevision, omitted: 0, expiresAt: at(600000) }
  let clock = 0, released = false, unlockTree
  const treeReady = changes.parallelTree ? new Promise(resolve => { unlockTree = resolve }) : Promise.resolve()
  const client = {
    async request(path, init) {
      const url = new URL(path, 'https://app.aspectlylabs.com'), body = init?.body ? JSON.parse(init.body) : null
      calls.push({ type: 'http', path: url.pathname, query: Object.fromEntries(url.searchParams), body, released })
      if (url.pathname === '/api/agent-cli-policy') return Response.json({ policy: { readOnly: false, permissions: { install_dependency: changes.denyShell ? 'deny' : 'allow' } }, revision: 'f'.repeat(64) })
      if (released) return Response.json(changes.denialBody ?? { ok: false, code: 'workspace_machine_unavailable' }, { status: changes.denialStatus ?? 409 })
      if (changes.windowMiss) return Response.json({ ok: false, code: 'workspace_machine_unavailable' }, { status: 409 })
      if (url.pathname.endsWith('/identity')) return Response.json({ ok: true, identity })
      if (url.pathname.endsWith('/files')) {
        const kind = url.searchParams.get('kind')
        if (kind === 'tree') {
          await treeReady
          if (changes.failTree) return Response.json({ ok: false, code: 'workspace_path_unavailable' }, { status: 404 })
          return Response.json({ ok: true, kind, identity, revision: listRevision, observedAt: at(0), availability: 'online', path: '', entries: entries.map(entry => ({ ...entry, size: file.size })), truncated: false, nextCursor: null })
        }
        if (kind === 'search') {
          unlockTree?.(); changes.searchStarted?.(); await changes.searchWait
          return Response.json({ ok: true, kind, identity, revision: listRevision, observedAt: at(0), availability: 'online', entries: entries.map(entry => ({ ...entry, size: file.size })), truncated: false })
        }
        return Response.json(changes.badFile ? { ...file, revision: { ...revision, version: '0'.repeat(64) } } : file)
      }
      if (body?.action === 'create') return Response.json({ ok: true, mention }, { status: 201 })
      if (body?.action === 'resolve') return Response.json({ ids: [mention.id], ok: true, kind: 'context', identity, revision: contextRevision,
        observedAt: at(0), availability: 'online', files: [file], omitted: 0 })
      assert.fail(`Unexpected fixture path ${url.pathname}`)
    },
    async rpc(action, args) {
      calls.push({ type: 'rpc', action, args })
      if (action === 'teams.listTeams') return changes.noTeam ? [] : [{ id: id(8), workspaceId: scope.workspaceId }]
      if (action === 'issues.createIssueForTeam') return { issue: { id: record.issueId } }
      if (action === 'issues.getIssue') return { issue: { id: record.issueId, title: record.title, revision: 1 } }
      if (action === 'issue-operations.setIssueDeleted') { if (changes.failDelete) throw Error('PRIVATE_DELETE_FAILURE'); return { ok: true } }
      if (action === 'agents.getIssueThread') return detail(false)
      if (action === 'agents.getThreadMachine') return { kind: 'cloud', state: 'paused' }
      assert.fail(`Unexpected fixture action ${action}`)
    },
  }
  const release = () => {
    released = true
    record.cleanup = { status: 'passed', errors: [], taskRetained: true, retainedFixture: { issueId: record.issueId, runIds: [record.runId] },
      machines: [{ runId: record.runId, outcome: 'ended', state: 'ended' }],
      machineViews: [{ runId: record.runId, kind: 'cloud', state: 'ended', sandboxIdHash: null }],
      [`machineEnded_${record.runId}`]: true, [`machineVerified_${record.runId}`]: true }
  }
  const probe = createWorkspaceProbe(options, { client, record, scope, now: () => epoch + ++clock, signal: changes.signal })
  return { client, record, scope, identity, file, native, input, output, detail, release, probe, calls, live: { checkActive() {} } }
}

test('readOptions accepts only the three exact release pins', () => {
  assert.deepEqual(readOptions({ EXPECTED_SOURCE_SHA: options.sourceCommit, EXPECTED_WORKER_SHA: options.workerSha, EXPECTED_WORKER_SOURCE_SHA: options.workerSourceCommit }), options)
  for (const key of ['EXPECTED_SOURCE_SHA', 'EXPECTED_WORKER_SHA', 'EXPECTED_WORKER_SOURCE_SHA']) {
    assert.throws(() => readOptions({ EXPECTED_SOURCE_SHA: options.sourceCommit, EXPECTED_WORKER_SHA: options.workerSha, EXPECTED_WORKER_SOURCE_SHA: options.workerSourceCommit, [key]: 'main' }), /options_invalid/)
  }
})

test('the emitted Python computes the actual multiline README range rather than literal backslash-n', () => {
  const command = nativeProbeCommand('multiline_readme', 'codex')
  const statements = command.split('\n').filter(line => /^    (lines|selected) = /.test(line)).map(line => line.trim()).join('\n')
  assert.equal(statements.split('\n').length, 2)
  const readme = Array.from({ length: 25 }, (_, index) => `README line ${index + 1}; literal \\n stays inside the line`).join('\n') + '\n'
  const result = spawnSync('python3', ['-c', `import sys, json, hashlib\ncontents = sys.stdin.buffer.read()\n${statements}\nprint(json.dumps(dict(totalLines=len(lines), endLine=min(20,len(lines)), selectedSha256=hashlib.sha256(selected).hexdigest())))`], { input: readme, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { totalLines: 26, endLine: 20, selectedSha256: sha(readme.split('\n').slice(0, 20).join('\n')) })
})

for (const harness of Object.keys(models)) test(`${harness}: native input/output pairs prove the actual run, README and installed worker`, () => {
  const f = fixture(harness)
  const value = nativeReceipt(f.detail(), f.record, options)
  assert.equal(value.runId, f.record.runId)
  assert.equal(value.workerSha, options.workerSha)
  assert.equal(value.workerSourceCommit, options.workerSourceCommit)
  assert.equal(value.contentSha256, sha(source))
  assert.equal(value.commandSha256, sha(f.input.chunk.input.command))
  assert.ok(f.probe.instructions.length <= 10000)
})

test('model prose, missing or forged native inputs, unrelated tool names and later attempts are not proof', () => {
  const f = fixture()
  for (const chunks of [[f.output()], [{ at: at(1600), chunk: { type: 'text-delta', delta: f.output().chunk.output } }],
    [{ ...f.input, chunk: { ...f.input.chunk, input: { command: `echo '${f.output().chunk.output}'` } } }, f.output()],
    [{ ...f.input, chunk: { ...f.input.chunk, toolName: 'mcp__shell' } }, f.output()]]) {
    const detail = f.detail(false); detail.chunks.push(...chunks)
    assert.equal(nativeReceipt(detail, f.record, options), null)
  }
  for (const change of [thread => { thread.latestRunId = id(99) }, thread => { thread.rootRunId = id(99) },
    thread => { thread.attempts.push({ runId: id(99), status: 'running' }) }, thread => { thread.continuation = { runId: id(99) } }]) {
    const detail = f.detail(); change(detail.thread)
    assert.throws(() => assertRunScope(detail, f.record), /run_scope_mismatch/)
  }
})

test('wrong worker SHA/source, writable marker, forged case/run, extra output fields and duplicate receipts fail', () => {
  for (const change of [native => { native.workerSha = '0'.repeat(40) }, native => { native.workerSourceCommit = '0'.repeat(40) },
    native => { native.markerMode = 0o644 }, native => { native.markerWritable = true }, native => { native.markerUid = 1000 },
    native => { native.caseId = 'other' }, native => { native.runId = id(99) }, native => { native.extra = 'PRIVATE' }]) {
    const f = fixture(); change(f.native)
    assert.throws(() => nativeReceipt(f.detail(), f.record, options), /native_(worker_mismatch|tool_invalid)/)
  }
  const f = fixture(), detail = f.detail(); detail.chunks.push(f.output())
  assert.throws(() => nativeReceipt(detail, f.record, options), /native_tool_invalid/)
})

test('Codex failed native exit and input/output reversal cannot supply evidence', () => {
  const f = fixture('codex'), detail = f.detail()
  detail.chunks.at(-1).chunk.output.exitCode = 1
  assert.throws(() => nativeReceipt(detail, f.record, options), /native_tool_invalid/)
  const reversed = f.detail(false); reversed.chunks.push(f.output(), f.input)
  assert.equal(nativeReceipt(reversed, f.record, options), null)
})

test('the first worktree push starts identity then parallel tree/search before any native receipt', { timeout: 3000 }, async () => {
  const f = fixture('claude_code', { parallelTree: true })
  await f.probe.createIssue({ title: f.record.title, status: 'todo', priority: 'low' })
  assert.equal(await f.probe.observe(f.detail(false), f.live), false)
  assert.deepEqual(f.record.codingWorkspace.requests.map(row => row.operation), ['teams', 'issue_create', 'identity', 'tree', 'search', 'policy', 'file', 'mention_create', 'mention_resolve'])
  assert.equal(f.record.codingWorkspace.active, 'passed')
  const create = f.calls.find(call => call.action === 'issues.createIssueForTeam')
  assert.equal(create.args[0].teamId, id(8))
  assert.ok(!f.calls.some(call => call.action === 'issues.saveIssue'))
  assert.equal(await f.probe.observe(f.detail(), f.live), true)
  assert.equal(f.calls.filter(call => call.path?.endsWith('/identity')).length, 1, 'push replay never repeats the probe')
  f.release(); await f.probe.afterRelease()
  assert.equal(f.record.cleanup.taskDeleted, true)
  assert.equal(f.record.cleanup.retainedFixture, undefined)
  assert.equal(f.record.codingWorkspace.denials.length, 3)
  const deleted = f.calls.findIndex(call => call.action === 'issue-operations.setIssueDeleted')
  assert.equal(f.calls.filter((call, index) => index < deleted && call.released).length, 3)
  const evidence = JSON.stringify(f.record.codingWorkspace)
  assert.ok(!evidence.includes(source) && !evidence.includes('python3') && !evidence.includes(scopeOwner(f)))
})
const scopeOwner = f => f.scope.ownerId

test('a worktree stage while preparing waits for the normal running push before its single Files attempt', async () => {
  const f = fixture(), preparing = f.detail(false)
  preparing.thread.status = 'preparing'; preparing.thread.attempts[0].status = 'preparing'
  assert.equal(await f.probe.observe(preparing, f.live), false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.record.codingWorkspace.worktreeObservedAt, undefined)
  assert.equal(await f.probe.observe(f.detail(false), f.live), false)
  assert.equal(f.calls.filter(call => call.path?.endsWith('/identity')).length, 1)
  assert.equal(await f.probe.observe(f.detail(), f.live), true)
  assert.equal(f.calls.filter(call => call.path?.endsWith('/identity')).length, 1)
})

test('an unconfigured authorized Team fails before dispatch rather than using No-Team or changing ACLs', async () => {
  const f = fixture('codex', { noTeam: true })
  await assert.rejects(f.probe.createIssue({ title: f.record.title }), /team_unavailable/)
  assert.equal(f.calls.length, 1)
})

test('a terminal initial observation fails active_window_missed without retrying a run or Files', async () => {
  const f = fixture(), detail = f.detail()
  detail.thread.status = 'succeeded'
  await assert.rejects(f.probe.observe(detail, f.live), /active_window_missed/)
  assert.equal(f.calls.length, 0)
})

test('a real paused-machine refusal is classified as active_window_missed with one bounded status read', async () => {
  const f = fixture('codex', { windowMiss: true })
  await assert.rejects(f.probe.observe(f.detail(false), f.live), /active_window_missed/)
  assert.deepEqual(f.record.codingWorkspace.requests.map(row => row.operation), ['identity', 'window_status', 'window_machine'])
})

test('actual policy must permit native shell, and altered file revisions fail closed', async () => {
  for (const [changes, expected] of [[{ denyShell: true }, /native_shell_unavailable/], [{ badFile: true }, /files_revision_mismatch/]]) {
    const f = fixture('claude_code', changes)
    await assert.rejects(f.probe.observe(f.detail(), f.live), expected)
  }
})

test('native README content must agree with the real file and resolved mention', async () => {
  const f = fixture(); f.native.contentSha256 = '0'.repeat(64)
  await assert.rejects(f.probe.observe(f.detail(), f.live), /native_file_mismatch/)
})

test('release proof is required before any negative read or fixture deletion', async () => {
  const f = fixture(); await f.probe.observe(f.detail(), f.live)
  f.release(); delete f.record.cleanup[`machineVerified_${f.record.runId}`]
  await assert.rejects(f.probe.afterRelease(), /release_unconfirmed/)
  assert.ok(!f.calls.some(call => call.released || call.action === 'issue-operations.setIssueDeleted'))
  assert.ok(f.record.cleanup.retainedFixture)
})

test('401, wrong 404 bodies, successful responses and wrong typed failures cannot pass ended access denial', async () => {
  for (const changes of [{ denialStatus: 401 }, { denialStatus: 404 }, { denialStatus: 200 },
    { denialBody: { ok: false, code: 'workspace_not_found' } }, { denialBody: { error: 'PRIVATE' } }]) {
    const f = fixture('claude_code', changes); await f.probe.observe(f.detail(), f.live); f.release()
    await assert.rejects(f.probe.afterRelease(), /release_denial_missing/)
    assert.ok(!f.calls.some(call => call.action === 'issue-operations.setIssueDeleted'))
    assert.equal(f.record.codingWorkspace.released, true)
  }
})

test('normal end-token revocation produces a typed 404 denial and still permits fixture deletion', async () => {
  const f = fixture('codex', { denialStatus: 404, denialBody: { ok: false, code: 'workspace_not_found' } })
  await f.probe.observe(f.detail(), f.live); f.release(); await f.probe.afterRelease()
  assert.equal(f.record.cleanup.taskDeleted, true)
  assert.deepEqual(f.record.codingWorkspace.denials.map(value => [value.httpStatus, value.code]), Array(3).fill([404, 'workspace_not_found']))
})

test('a failed parallel Files request drains its deferred peer before observer cleanup can start', async () => {
  const started = Promise.withResolvers(), peer = Promise.withResolvers()
  const f = fixture('codex', { failTree: true, searchStarted: started.resolve, searchWait: peer.promise })
  let settled = false
  const observation = f.probe.observe(f.detail(), f.live).catch(error => { settled = true; return error })
  await started.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  peer.resolve()
  const error = await observation
  assert.equal(error.code, 'files_api_refused')
  assert.ok(f.record.codingWorkspace.requests.every(row => row.outcome !== 'running' && Number.isFinite(row.ms)))
})

test('fixture deletion failure is retained after VM release and never swallowed', async () => {
  const f = fixture('codex', { failDelete: true }); await f.probe.observe(f.detail(), f.live); f.release()
  await assert.rejects(f.probe.afterRelease(), /fixture_delete_failed/)
  assert.equal(f.record.codingWorkspace.released, true)
  assert.equal(f.record.codingWorkspace.status, 'failed')
  assert.ok(f.record.cleanup.retainedFixture)
})

test('abort stops new observation work but does not prevent release verification and owned fixture cleanup', async () => {
  const controller = new AbortController(), f = fixture('claude_code', { signal: controller.signal })
  await f.probe.observe(f.detail(), f.live)
  controller.abort(); f.release(); await f.probe.afterRelease()
  assert.equal(f.record.cleanup.taskDeleted, true)
  const stopped = fixture('codex', { signal: controller.signal })
  await assert.rejects(stopped.probe.observe(stopped.detail(), stopped.live), /acceptance_aborted/)
  assert.equal(stopped.calls.length, 0)
})

test('entry uses exactly the two fixed ordinary subscription cases with no worker/secret configuration read', async () => {
  const report = await runCodingWorkspaceAcceptance(options, { env: {}, runStartup: async (input, hooks) => {
    assert.equal(input.origin, 'https://app.aspectlylabs.com')
    assert.equal(input.runs, 2); assert.equal(input.harness, 'both')
    assert.equal(input.officialTiming, 'disabled'); assert.equal(input.expectedWorkerSha, undefined)
    assert.equal(hooks.readWorkerRelease, undefined)
    assert.equal(typeof hooks.createCaseProbe, 'function')
    const samples = []
    for (const harness of Object.keys(models)) {
      const f = fixture(harness); await f.probe.observe(f.detail(), f.live); f.release(); await f.probe.afterRelease()
      f.record.chunks = [{ secret: 'PRIVATE_RAW_CHUNK' }]; f.record.codingWorkspace.content = 'PRIVATE_SOURCE'
      samples.push(f.record)
    }
    return { status: 'candidate_subscription_proved', build: options.sourceCommit, revision: options.sourceCommit,
      samples, cleanup: { errors: [], workspaceRestored: true } }
  } })
  assert.equal(report.status, 'passed')
  assert.deepEqual(report.samples.map(sample => sample.model), Object.values(models))
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
  assert.ok(!JSON.stringify(report).includes(source))
})

test('missing one harness, missing native evidence or cleanup failure never closes acceptance', async () => {
  for (const kind of ['missing_case', 'missing_proof', 'cleanup_failed']) {
    const report = await runCodingWorkspaceAcceptance(options, { env: {}, runStartup: async () => {
      const f = fixture(); await f.probe.observe(f.detail(), f.live); f.release(); await f.probe.afterRelease()
      if (kind === 'missing_proof') delete f.record.codingWorkspace
      return { status: 'candidate_subscription_proved', build: options.sourceCommit, revision: options.sourceCommit,
        samples: [f.record], cleanup: { errors: kind === 'cleanup_failed' ? [{ code: 'PRIVATE_ERROR' }] : [], workspaceRestored: true } }
    } })
    assert.equal(report.status, 'failed')
  }
  const failed = await runCodingWorkspaceAcceptance(options, { env: {}, runStartup: async () => { throw Error('PRIVATE_PASSWORD') } })
  assert.equal(failed.status, 'failed'); assert.ok(!JSON.stringify(failed).includes('PRIVATE_PASSWORD'))
})
