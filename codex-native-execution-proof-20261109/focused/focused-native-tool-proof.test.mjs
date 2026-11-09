import assert from 'node:assert/strict'
import test from 'node:test'
import { observeChunks } from './scripts/acceptance/cloud-startup.mjs'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const epoch = Date.parse('2026-11-06T12:00:00.000Z')
const stage = (name, at, ok = true) => ({ at: new Date(epoch + at).toISOString(), chunk: { type: 'data-run-stage', data: { stage: name, ms: 300, ok } } })
const delta = (text, at = 4000) => ({ at: new Date(epoch + at).toISOString(), chunk: { type: 'text-delta', delta: text } })
function submittedReply() {
  const record = { sampleId: 'submitted', runId: id(901), harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true, requireTerminal: true }
  const detail = { thread: { id: record.runId, rootRunId: record.runId, latestRunId: record.runId, ownedByCurrentUser: true,
    status: 'succeeded', error: null, finishedAt: new Date(epoch + 6000).toISOString(), continuation: null,
    attempts: [{ runId: record.runId, status: 'succeeded' }], detail: { harness: 'codex', summary: 'PRIVATE_REPORT STARTUP_OK_submitted', summarySource: 'report' } },
    chunks: [stage('agent_start', 20),
      { at: new Date(epoch + 100).toISOString(), chunk: { type: 'tool-input-available', toolCallId: 'read-file', toolName: 'mcp__mikka__inspect_artifact', input: { path: 'README.md' } } },
      { at: new Date(epoch + 200).toISOString(), chunk: { type: 'tool-output-available', toolCallId: 'read-file', output: 'PRIVATE_README' } },
      delta('Read the README.'),
      { at: new Date(epoch + 4500).toISOString(), chunk: { type: 'tool-input-available', toolCallId: 'hand-in', toolName: 'mcp__mikka__submit', input: { summary: 'PRIVATE_REPORT STARTUP_OK_submitted' } } },
      { at: new Date(epoch + 5000).toISOString(), chunk: { type: 'tool-output-available', toolCallId: 'hand-in', output: [] } }] }
  return { record, detail }
}


test('Codex native shell proof requires an exact successful exit code', () => {
  for (const [label, output, expected] of [
    ['zero', { exitCode: 0, output: 'PRIVATE_NATIVE_OUTPUT' }, true],
    ['nonzero', { exitCode: 1 }, false],
    ['negative', { exitCode: -1 }, false],
    ['unknown', { exitCode: null }, false],
    ['missing', {}, false],
    ['string zero', { exitCode: '0' }, false],
    ['absent output', null, false],
  ]) {
    const record = { sampleId: 'native-shell', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const detail = { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-available', toolCallId: 'native', toolName: 'bash', input: { command: 'PRIVATE_COMMAND' } } },
      { chunk: { type: 'tool-output-available', toolCallId: 'native', output } },
      delta('STARTUP_OK_native-shell')] }
    for (let replay = 0; replay < 2; replay++) assert.equal(observeChunks(record, detail, epoch + replay), expected, label)
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_native-shell|toolName|exitCode/)
  }
})

test('Codex patch proof requires the actual completed protocol status', () => {
  for (const [status, expected] of [['completed', true], ['failed', false], ['declined', false], ['inProgress', false], [null, false], [undefined, false], ['success', false]]) {
    const record = { sampleId: 'native-patch', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const detail = { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-available', toolCallId: 'patch', toolName: 'apply_patch', input: { files: ['PRIVATE_FILE'] } } },
      { chunk: { type: 'tool-output-available', toolCallId: 'patch', output: { status } } },
      delta('STARTUP_OK_native-patch')] }
    assert.equal(observeChunks(record, detail, epoch), expected, String(status))
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_native-patch|toolName/)
  }
})

test('Codex native names arriving after the result still qualify an admitted call at the 64-call boundary', () => {
  for (const [toolName, output, expected] of [
    ['bash', { exitCode: 0 }, true], ['bash', { exitCode: 1 }, false],
    ['apply_patch', { status: 'completed' }, true], ['apply_patch', { status: 'failed' }, false],
  ]) {
    const record = { sampleId: 'late-native', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const beforeStart = Array.from({ length: 64 }, (_, i) => ({ chunk: { type: 'tool-input-available', toolCallId: 'earlier-' + i, toolName: 'bash' } }))
    const starts = Array.from({ length: 64 }, (_, i) => ({ chunk: { type: 'tool-input-start', toolCallId: 'admitted-' + i } }))
    const overflow = Array.from({ length: 8 }, (_, i) => ({ chunk: { type: 'tool-input-available', toolCallId: 'overflow-' + i, toolName: 'bash' } }))
    const detail = { chunks: [...beforeStart, stage('agent_start', 20), ...starts, ...overflow,
      { chunk: { type: 'tool-output-available', toolCallId: 'admitted-63', output } },
      delta('STARTUP_OK_late-native'),
      { chunk: { type: 'tool-input-available', toolCallId: 'admitted-63', toolName } }] }
    for (let replay = 0; replay < 2; replay++) assert.equal(observeChunks(record, detail, epoch + replay), expected, toolName + ':' + expected)
    assert.equal(record.toolCalls.length, 64)
  }
})

test('a later unknown name cannot downgrade a recognized Codex native tool', () => {
  for (const [toolName, output] of [['bash', { exitCode: 1 }], ['apply_patch', { status: 'failed' }]]) {
    const record = { sampleId: 'renamed-native', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const detail = { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-available', toolCallId: 'native', toolName } },
      { chunk: { type: 'tool-input-available', toolCallId: 'native', toolName: 'mcp__fixture__status' } },
      { chunk: { type: 'tool-output-available', toolCallId: 'native', output } },
      delta('STARTUP_OK_renamed-native')] }
    assert.equal(observeChunks(record, detail, epoch), false, toolName)
  }
})

test('a later failed Codex available result removes that call from successful execution proof', () => {
  for (const [toolName, initial, final] of [
    ['bash', { exitCode: 0 }, { exitCode: 1 }],
    ['bash', { exitCode: 0 }, { exitCode: null }],
    ['apply_patch', { status: 'completed' }, { status: 'failed' }],
  ]) {
    const record = { sampleId: 'native-update', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const detail = { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-available', toolCallId: 'native', toolName } },
      { chunk: { type: 'tool-output-available', toolCallId: 'native', output: initial } },
      { chunk: { type: 'tool-output-available', toolCallId: 'native', output: final } },
      delta('STARTUP_OK_native-update')] }
    assert.equal(observeChunks(record, detail, epoch), false, toolName)
    assert.equal(record.toolCalls[0].outcome, 'ok', 'the existing redacted wire audit is unchanged')
  }
})

test('canonical Codex submitted reports need a successful native execution outcome', () => {
  for (const [toolName, output, expected] of [
    ['bash', { exitCode: 0 }, true], ['bash', { exitCode: 1 }, false], ['bash', { exitCode: null }, false],
    ['apply_patch', { status: 'completed' }, true], ['apply_patch', { status: 'failed' }, false],
  ]) {
    const { record, detail } = submittedReply()
    detail.chunks[1].chunk.toolName = toolName
    detail.chunks[2].chunk.output = output
    for (let replay = 0; replay < 2; replay++) assert.equal(observeChunks(record, detail, epoch + 7000 + replay), expected, toolName + ':' + expected)
    if (expected) assert.equal(record.replySource, 'submitted_report')
    else assert.notEqual(record.replyVerifiedAfterTool, true)
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_submitted|toolName|exitCode/)
  }
})

test('other harnesses and ordinary MCP tools retain their availability semantics', () => {
  for (const [harness, toolName, output] of [
    ['claude_code', 'bash', { exitCode: 1 }],
    ['claude_code', 'apply_patch', { status: 'failed' }],
    [undefined, 'bash', { exitCode: null }],
    ['codex', 'mcp__fixture__bash', { exitCode: 1 }],
    ['codex', 'mcp__fixture__record_status', { status: 'failed' }],
    ['codex', 'mcp__mikka__inspect_artifact', 'PRIVATE_README'],
  ]) {
    const record = { sampleId: 'other-outcome', harness, requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const detail = { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-available', toolCallId: 'other', toolName } },
      { chunk: { type: 'tool-output-available', toolCallId: 'other', output } },
      delta('STARTUP_OK_other-outcome')] }
    assert.equal(observeChunks(record, detail, epoch), true, String(harness) + ':' + toolName)
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_other-outcome|toolName/)
  }
})

test('Codex native outcome checks retain handoff exclusion and explicit error rejection', () => {
  for (const toolName of ['mcp__mikka__submit', 'mcp__mikka__request_help']) {
    const record = { sampleId: 'native-handoff', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    assert.equal(observeChunks(record, { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-available', toolCallId: 'handoff', toolName } },
      { chunk: { type: 'tool-output-available', toolCallId: 'handoff', output: { exitCode: 0, status: 'completed' } } },
      delta('STARTUP_OK_native-handoff')] }, epoch), false)
  }
  const record = { sampleId: 'native-error', harness: 'codex', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
  assert.equal(observeChunks(record, { chunks: [stage('agent_start', 20),
    { chunk: { type: 'tool-input-available', toolCallId: 'native', toolName: 'bash' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'native', output: { exitCode: 0 } } },
    { chunk: { type: 'tool-output-error', toolCallId: 'native', errorText: 'PRIVATE_ERROR' } },
    delta('STARTUP_OK_native-error')] }, epoch), false)
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_native-error/)
})
