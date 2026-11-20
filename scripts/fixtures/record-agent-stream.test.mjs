import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockAdapter } from '../../packages/daemon/src/adapters/mock.ts'
import { checkFixtures, checkRecordedDirectory } from './check-fixtures.mjs'
import { convertAgentExport, importAgentExport } from './record-agent-stream.mjs'
import { sanitizeRecording, scanSensitive } from './sanitize.mjs'
import { validateFixture } from './schema.mjs'

// Artificial parser inputs only. These are never installed as recorded fixtures.
const example = patch => ({ schemaVersion: 1, provenance: 'existing-run-export', harness: 'claude-code', cliVersion: '2.1.309', runDate: '2026-11-19', sourceRuntime: 'device', scenario: 'tools',
  events: [
    { t: 0, event: { type: 'chunk', chunk: { type: 'start', messageId: 'private-message' } } },
    { t: 2, event: { type: 'chunk', chunk: { type: 'tool-input-available', toolCallId: 'private-call', toolName: 'Bash', input: { command: 'cat /home/alex/private-repo/request.txt', owner: 'alex@example.test', token: 'unit-' + 'x'.repeat(32) } } } },
    { t: 5, event: { type: 'chunk', chunk: { type: 'tool-output-available', toolCallId: 'private-call', output: { body: 'Private owner request', authorization: 'Bearer ' + 'unit'.repeat(8) } } } },
    { t: 8, event: { type: 'exit', outcome: 'succeeded', stopReason: 'turn_ended' } },
  ], ...patch })

test('offline import redacts free text, credentials and paths while preserving real event order and tool correlation', async () => {
  const source = example(), raw = JSON.stringify(source)
  const { fixture, metadata } = await convertAgentExport(raw)
  const lines = await validateFixture(fixture, { recorded: true })
  assert.deepEqual(lines.map(line => line.t), [0, 2, 5, 8])
  assert.equal(lines[1].chunk.toolCallId, lines[2].chunk.toolCallId)
  assert.notEqual(lines[1].chunk.toolCallId, 'private-call')
  assert.ok(!fixture.includes('Private owner request') && !fixture.includes('alex') && !fixture.includes('/home/'))
  assert.deepEqual(scanSensitive(lines), [])
  assert.deepEqual(metadata.eventTypes, ['exit', 'start', 'tool-input-available', 'tool-output-available'])
  assert.equal(metadata.harness, 'claude-code')
  assert.equal(metadata.cliVersion, '2.1.309')
  assert.equal(metadata.sourceRuntime, 'device')
  assert.deepEqual(metadata.replayEvidence, [], 'Source runtime is not replay proof')
  assert.ok(!lines.some(line => line.submit), 'A normal turn ending does not invent an explicit hand-in')
})

test('the scanner rejects suspicious credentials without including the value or private key names in findings', () => {
  const candidates = ['sk-' + 'x'.repeat(32), 'github_pat_' + 'x'.repeat(24), 'Bearer ' + 'x'.repeat(24), 'alex@example.test', '/home/alex/private/file', '-----BEGIN PRIVATE KEY-----']
  for (const candidate of candidates) {
    const found = scanSensitive({ nested: [{ output: candidate }] })
    assert.ok(found.length)
    assert.ok(!JSON.stringify(found).includes(candidate))
    assert.deepEqual(scanSensitive(sanitizeRecording({ output: candidate })), [])
  }
  const key = 'github_pat_' + 'y'.repeat(30)
  assert.ok(scanSensitive({ [key]: 'value' }).length)
  assert.ok(!JSON.stringify(scanSensitive({ [key]: 'value' })).includes(key))
  assert.ok(!JSON.stringify(sanitizeRecording({ 'Private user field': { '/home/alex/repository': 'Private value' } })).includes('Private'))
})

test('a real daemon MockAdapter consumes the sanitized JSONL but never executes exported tool input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-record-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = join(directory, 'source.json'), output = join(directory, 'imported.jsonl')
  const source = example()
  source.events[1].event.chunk.input.command = `touch ${join(directory, 'must-not-exist')}`
  await writeFile(input, JSON.stringify(source), { mode: 0o600 })
  await importAgentExport(input, output)
  assert.equal((await stat(output)).mode & 0o777, 0o600)
  assert.equal((await stat(`${output}.metadata.json`)).mode & 0o777, 0o600)
  const adapter = new MockAdapter({ fixturesDir: directory, stateDir: join(directory, 'state'), speed: Infinity })
  const session = await adapter.start({ runId: 'recording-unit-test', fixture: 'imported', prompt: 'Artificial unit test input', cwd: directory, env: {}, log: { info() {}, error() {} } })
  const events = await Array.fromAsync(session.events())
  assert.deepEqual(events.map(event => event.type), ['chunk', 'chunk', 'chunk', 'exit'])
  assert.equal(events.at(-1).stopReason, 'turn_ended')
  await assert.rejects(stat(join(directory, 'must-not-exist')), { code: 'ENOENT' })
  assert.equal((await checkRecordedDirectory(directory)).validated, 1)
  await assert.rejects(checkRecordedDirectory(directory, { requireLibrary: true }), /recording_library_incomplete/)
  await assert.rejects(importAgentExport(input, output), { code: 'EEXIST' })
  const before = await readFile(output, 'utf8')
  await writeFile(output, before.replace('recorded_tool_1', 'changed_tool'))
  await assert.rejects(checkRecordedDirectory(directory), /recording_digest_mismatch/)
})

test('missing source provenance, invented scenarios, invalid SDK chunks and exported side effects fail closed', async () => {
  for (const patch of [{ provenance: 'handwritten' }, { cliVersion: 'unknown' }, { scenario: 'plan' }, { sourceRuntime: 'claimed-cloud' }, { events: [{ t: 0, event: { type: 'exec', command: 'echo unsafe' } }] }]) {
    await assert.rejects(convertAgentExport(JSON.stringify(example(patch))))
  }
  const invalid = example()
  delete invalid.events[1].event.chunk.toolCallId
  await assert.rejects(convertAgentExport(JSON.stringify(invalid)), /fixture_chunk_schema_invalid/)
  await assert.rejects(validateFixture(JSON.stringify({ t: 0, exec: { toolCallId: 'a', command: 'echo no' } }), { recorded: true }), /fixture_recorded_side_effect/)
  await assert.rejects(validateFixture(JSON.stringify({ t: -1, exit: { outcome: 'failed' } })), /fixture_invalid_time/)
  await assert.rejects(validateFixture(JSON.stringify({ t: 0, chunk: { type: 'data-usage', data: { inputTokens: 'changed shape', outputTokens: 1, costUsd: 0, source: 'fixture' } } })), /fixture_data_schema_invalid/)
  await assert.rejects(validateFixture(JSON.stringify({ t: 0, chunk: { type: 'data-private-body', data: { secret: true } } })), /fixture_data_schema_invalid/)
})

test('hand-in, question and quota retain terminal semantics without leaking owner body text', async () => {
  const source = example({ scenario: 'question', events: [{ t: 0, event: { type: 'exit', outcome: 'succeeded', stopReason: 'asked_human', report: { summary: 'Private task', question: { questionId: '00000000-0000-4000-8000-000000000001', kind: 'context', question: 'Private user request' } } } }] })
  const question = await convertAgentExport(JSON.stringify(source))
  assert.match(question.fixture, /asked_human/)
  assert.ok(!question.fixture.includes('Private'))
  source.scenario = 'quota'
  source.events = [{ t: 0, event: { type: 'exit', outcome: 'failed', stopReason: 'quota_exhausted', quota: { resetsAt: '2026-11-21T00:00:00.000Z' } } }]
  const quota = await convertAgentExport(JSON.stringify(source))
  assert.equal(JSON.parse(quota.fixture).exit.quota.resetsAt, '2026-11-21T00:00:00.000Z')
  source.scenario = 'long-running'
  source.events = [{ t: 0, event: { type: 'chunk', chunk: { type: 'start', messageId: 'source' } } }, { t: 61_000, event: { type: 'exit', outcome: 'succeeded', stopReason: 'submitted', report: { summary: 'Private report' } } }]
  const handedIn = await convertAgentExport(JSON.stringify(source))
  assert.ok((await validateFixture(handedIn.fixture)).some(line => line.submit?.summary === '[redacted:text]'))
})

test('a successful PR scenario requires both daemon push and a separate exported server publication', async () => {
  const source = example({ scenario: 'success-pr', events: [
    { t: 0, event: { type: 'chunk', chunk: { type: 'data-publish', data: { branch: 'private-branch', commit: 'a'.repeat(40), pushed: true, remote: 'private-origin' } } } },
    { t: 1, event: { type: 'exit', outcome: 'succeeded', stopReason: 'submitted', report: { summary: 'Private hand-in' } } },
  ] })
  await assert.rejects(convertAgentExport(JSON.stringify(source)), /recording_scenario_not_observed/)
  source.publication = { status: 'published', pullRequest: { url: 'https://github.com/private-owner/private-repository/pull/23', state: 'open' } }
  const result = await convertAgentExport(JSON.stringify(source))
  assert.match(result.metadata.sourcePublicationSha256, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(result).includes('private-owner'))
  assert.equal((await validateFixture(result.fixture))[0].chunk.data.pushed, true)
  source.publication.status = 'pending'
  await assert.rejects(convertAgentExport(JSON.stringify(source)), /recording_source_publication_invalid/)
})

test('all repository fixtures face the current schemas; the deliberate forged verify is required to fail', async () => {
  const result = await checkFixtures()
  assert.ok(result.handWrittenSchemaValidated >= 15)
  assert.equal(result.adversarialReportsRejected, 1)
  assert.equal(result.recorded.validated + result.recorded.missing.length, 14)
})
