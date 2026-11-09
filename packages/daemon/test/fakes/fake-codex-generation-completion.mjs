#!/usr/bin/env node
// Offline Codex 0.163 app-server/OTLP fixture. Only the owned loopback sink is used.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const lines = createInterface({ input: process.stdin })
const threadId = 'fixture-generation-thread', turnId = 'fixture-generation-turn'
const usage = { inputTokens: 50, outputTokens: 20, cachedInputTokens: 30, cacheWriteInputTokens: 4, reasoningOutputTokens: 0, totalTokens: 70 }
const receipt = { pid: process.pid, rawCompleted: 0, usageNotifications: 0 }
let authenticated = false
const endpoint = /endpoint="([^"]+)"/.exec(process.argv.find(value => value.startsWith('otel.trace_exporter={otlp-http=')) ?? '')?.[1]
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/v1\/traces\/[a-f0-9]+$/.test(endpoint)) process.exit(2)

async function completed(seed, known, replayUsage = false) {
  const epoch = Date.now() - 1000, id = value => value.toString(16).padStart(16, '0')
  const span = (name, identity, parent, start, end, values = {}) => ({ name, traceId: '0123456789abcdef0123456789abcdef',
    spanId: id(identity), parentSpanId: id(parent), startTimeUnixNano: (BigInt(epoch + start) * 1000000n).toString(),
    endTimeUnixNano: (BigInt(epoch + end) * 1000000n).toString(),
    attributes: Object.entries(values).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } })) })
  const spans = [
    span('try_run_sampling_request', seed, 999, 0, 600, { model: 'gpt-6-luna' }),
    span('stream_request', seed + 1, seed, 0, 50), span('codex.sampling', seed + 2, seed, 0, 550, { 'conversation.id': threadId }),
    span('receiving_stream', seed + 3, seed, 50, 550),
    span('message_from_assistant', seed + 4, seed + 3, 100, 170, { from: 'output_item_added' }),
    span('receiving', seed + 5, seed + 4, 100, 150),
    span('completed', seed + 6, seed + 3, 300, 550, known ? {
      'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 30, 'gen_ai.usage.cache_write.input_tokens': 4,
    } : {}),
    span('receiving', seed + 7, seed + 6, 300, 500),
  ]
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }) })
  if (!response.ok) process.exit(3)
  send({ method: 'rawResponse/completed', params: { threadId, turnId, responseId: `response_${seed}`, usage: known ? usage : null, usageMetadata: null } })
  receipt.rawCompleted++
  // None leaves existing token_info unchanged; the official app-server may replay it.
  if (known || replayUsage) {
    send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 200000 } } })
    receipt.usageNotifications++
  }
}

lines.on('line', async line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') return send({ id, result: { userAgent: 'codex_cli_rs/0.163.0 synthetic-fixture' } })
  if (method === 'account/login/start') {
    if (params.type !== 'chatgptAuthTokens' || params.accessToken !== 'fixture-access') process.exit(2)
    authenticated = true
    return send({ id, result: { type: 'chatgptAuthTokens' } })
  }
  if (method === 'thread/start') {
    if (!authenticated) process.exit(2)
    return send({ id, result: { thread: { id: threadId }, model: 'gpt-6-luna' } })
  }
  if (method === 'turn/start') {
    const scenario = params.input[0].text
    if (!['known', 'missing_fresh', 'missing_reused'].includes(scenario)) process.exit(2)
    send({ id, result: { turn: { id: turnId } } })
    if (scenario === 'known' || scenario === 'missing_reused') await completed(10, true)
    if (scenario !== 'known') await completed(40, false, scenario === 'missing_reused')
    writeFileSync(join(process.env.CODEX_HOME, 'fixture-process.json'), JSON.stringify(receipt))
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'fixture-message', delta: 'PRIVATE_RESPONSE' } })
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null } } })
    return
  }
  send({ id, result: {} })
})
lines.on('close', () => process.exit(0))
