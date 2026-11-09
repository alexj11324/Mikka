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


test('terminal handoff tools do not prove execution before a text reply', () => {
  for (const name of ['submit', 'request_help', 'ask_human', 'report_blocked']) {
    const record = { sampleId: 'handoff-only', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
    const detail = { chunks: [stage('agent_start', 20),
      { chunk: { type: 'tool-input-start', toolCallId: 'handoff' } },
      { chunk: { type: 'tool-input-available', toolCallId: 'handoff', toolName: `mcp__mikka__${name}`, input: { summary: 'No read occurred.' } } },
      { chunk: { type: 'tool-output-available', toolCallId: 'handoff', output: [] } },
      delta('STARTUP_OK_handoff-only')] }
    for (let replay = 0; replay < 2; replay++) {
      assert.equal(observeChunks(record, detail, epoch + replay), false, name)
      assert.equal(record.replyVerified, true)
      assert.equal(record.replyVerifiedAfterTool, false)
      assert.equal(record.toolCalls.length, 1)
      assert.equal(record.toolCalls[0].outcome, 'ok', 'the actual successful handoff stays in the audit')
    }
    assert.doesNotMatch(JSON.stringify(record), /No read occurred|mcp__mikka__|STARTUP_OK_handoff-only/)
  }
})

test('a previous submit cannot provide the independent tool for a submitted report', () => {
  const { record, detail } = submittedReply()
  detail.chunks = [detail.chunks[0],
    { chunk: { type: 'tool-input-available', toolCallId: 'earlier-submit', toolName: 'mcp__mikka__submit', input: { summary: 'No read occurred.' } } },
    { chunk: { type: 'tool-output-available', toolCallId: 'earlier-submit', output: [] } },
    ...detail.chunks.slice(4)]
  for (let replay = 0; replay < 2; replay++) {
    assert.equal(observeChunks(record, detail, epoch + 7000 + replay), false)
    assert.notEqual(record.replyVerified, true)
    assert.equal(record.replyVerifiedAfterTool, false)
    assert.equal(record.toolCalls.filter(tool => tool.outcome === 'ok').length, 2)
  }
})

test('the minimum tool count excludes delivery while keeping the successful read and report', () => {
  const { record, detail } = submittedReply()
  record.minToolCalls = 2
  assert.equal(observeChunks(record, detail, epoch + 7000), false)
  assert.equal(record.replyVerifiedAfterTool, true, 'the independent read still precedes the report')
  assert.equal(record.toolCalls.filter(tool => tool.outcome === 'ok').length, 2, 'audit retains the read and submit')
  record.minToolCalls = 1
  assert.equal(observeChunks(record, detail, epoch + 8000), true)
})

test('a tool error replaces its earlier success in the replay execution count', () => {
  const record = { sampleId: 'error-replay', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
  const detail = { chunks: [stage('agent_start', 20),
    { chunk: { type: 'tool-input-start', toolCallId: 'read-file' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'read-file', output: 'PRIVATE_README' } },
    { chunk: { type: 'tool-output-error', toolCallId: 'read-file', errorText: 'PRIVATE_ERROR' } },
    delta('STARTUP_OK_error-replay')] }
  assert.equal(observeChunks(record, detail, epoch + 7000), false)
  assert.equal(record.replyVerifiedAfterTool, false)
  assert.equal(record.toolCalls[0].outcome, 'error')
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_error-replay/)
})

test('an early marker stays before the tool when full run history is replayed', () => {
  const record = { sampleId: 'ordered', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
  const detail = { chunks: [stage('agent_start', 20), delta('STARTUP_OK_ordered'),
    { chunk: { type: 'tool-input-start', toolCallId: 'read-file' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'read-file', output: 'PRIVATE_README_CONTENT' } }] }
  for (let read = 0; read < 3; read++) {
    assert.equal(observeChunks(record, detail, epoch + read), false)
    assert.equal(record.replyVerified, true)
    assert.equal(record.toolCalls[0].outcome, 'ok')
    assert.equal(record.replyVerifiedAfterTool, false, 'previously accumulated tools cannot reorder a replayed marker')
  }
  detail.chunks.push(delta('An unrelated later reply'))
  assert.equal(observeChunks(record, detail, epoch + 10), false, 'old marker text cannot carry into the post-tool buffer')
  const baseline = { sampleId: 'ordered', requireReply: true, minToolCalls: 1 }
  assert.equal(observeChunks(baseline, detail, epoch), true, 'optional baseline keeps its original reply-plus-tool criterion')
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_ordered/)
})

test('a completed tool followed by the task marker proves reply order', () => {
  const record = { sampleId: 'ordered', requireReply: true, minToolCalls: 1, requireReplyAfterTool: true }
  const detail = { chunks: [stage('agent_start', 20),
    { chunk: { type: 'tool-input-start', toolCallId: 'read-file' } },
    { chunk: { type: 'tool-output-available', toolCallId: 'read-file', output: 'PRIVATE_README_CONTENT' } },
    delta('STARTUP_'), delta('OK_ordered')] }
  assert.equal(observeChunks(record, detail, epoch), true)
  assert.equal(record.replyVerifiedAfterTool, true)
  assert.equal(observeChunks(record, detail, epoch + 10), true)
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_ordered/)
})

test('a successful same-run canonical submit report proves delivery after the completed read', () => {
  const { record, detail } = submittedReply()
  assert.equal(observeChunks(record, detail, epoch + 7000), true)
  assert.equal(record.replyVerified, true)
  assert.equal(record.replyVerifiedAfterTool, true)
  assert.equal(record.replySource, 'submitted_report')
  assert.equal(observeChunks(record, detail, epoch + 8000), true, 'replaying the same stream preserves the actual order')
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_submitted|Read the README/)
})

test('canonical delivery cannot borrow another run, a pending or failed result, or an unordered submit', () => {
  const mutations = [
    d => { d.thread.id = id(902) }, d => { d.thread.rootRunId = id(902) }, d => { d.thread.latestRunId = id(902) },
    d => { d.thread.ownedByCurrentUser = false }, d => { d.thread.detail.harness = 'claude_code' },
    d => { d.thread.detail.summary = 'A different report' }, d => { d.thread.detail = null },
    d => { d.thread.detail.summarySource = 'error' }, d => { d.thread.detail.summarySource = null },
    d => { delete d.thread.detail.summarySource },
    d => { d.thread.status = 'running' }, d => { d.thread.status = 'failed' }, d => { d.thread.status = 'stopped' },
    d => { d.thread.error = 'PRIVATE_ERROR' }, d => { d.thread.finishedAt = null },
    d => { d.thread.finishedAt = new Date(epoch + 4900).toISOString() },
    d => { d.thread.attempts.push({ runId: id(902), status: 'succeeded' }) },
    d => { d.thread.attempts[0].runId = id(902) }, d => { d.thread.attempts[0].status = 'failed' },
    d => { d.thread.continuation = { id: id(902), status: 'succeeded' } },
    d => { d.chunks[4].chunk.input.summary = 'No matching receipt' },
    d => { d.chunks[4].chunk.toolName = 'mcp__other__submit' },
    d => { d.chunks[5].chunk.type = 'tool-output-error' }, d => { d.chunks[5].chunk.toolCallId = 'other-call' },
    d => { d.chunks[5].at = 'invalid' }, d => { d.chunks.pop() },
    d => { d.chunks = [d.chunks[0], ...d.chunks.slice(4), ...d.chunks.slice(1, 4)] },
    d => { d.chunks[2].chunk.type = 'tool-output-error' },
  ]
  for (const mutate of mutations) {
    const { record, detail } = submittedReply(); mutate(detail)
    assert.equal(observeChunks(record, detail, epoch + 7000), false, String(mutate))
    assert.notEqual(record.replyVerified, true, String(mutate))
    assert.equal(record.replyVerifiedAfterTool, false, String(mutate))
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|STARTUP_OK_submitted/)
  }
})

