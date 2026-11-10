#!/usr/bin/env node
// Offline SDK wire fixture. No provider request, real credential or external sink.
import { closeSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR !== '3') process.exit(2)
const token = readFileSync(3, 'utf8')
closeSync(3)
if (token !== 'fixture-access') process.exit(2)
const args = process.argv.slice(2)
const sessionId = args[args.indexOf('--session-id') + 1]
const config = process.env.CLAUDE_CONFIG_DIR
mkdirSync(config, { recursive: true })
writeFileSync(join(config, 'fixture-process.json'), JSON.stringify({ pid: process.pid }))
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
      response: { commands: [], agents: [], models: [], account: { apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' } } } })
    return
  }
  if (frame.type !== 'user') return
  const scenario = frame.message.content[0].text
  if (!['normal', 'aborted', 'duplicate_abort', 'abort_then_crash'].includes(scenario)) process.exit(2)
  if (args.includes('--replay-user-messages')) out({ ...frame, session_id: sessionId, isReplay: true })
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-haiku-5-5' })
  const message = { id: 'msg_abort_fixture', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }
  const stream = event => out({ type: 'stream_event', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    event, ...(event.type === 'message_start' ? { ttft_ms: 20 } : {}) })
  stream({ type: 'message_start', message })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE_PARTIAL_OUTPUT' } })
  const assistant = { type: 'assistant', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    message: { ...message, content: [{ type: 'text', text: 'PRIVATE_PARTIAL_OUTPUT' }] },
    ...(scenario === 'normal' ? {} : { aborted: true }) }
  out(assistant)
  if (scenario === 'duplicate_abort') out({ ...assistant, uuid: randomUUID() })
  if (scenario === 'abort_then_crash') {
    // Drain the interrupted frame before the real SDK observes transport failure.
    process.stdout.write('', () => process.exit(1))
    return
  }
  if (scenario === 'normal') {
    stream({ type: 'content_block_stop', index: 0 })
    stream({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
    stream({ type: 'message_stop' })
  }
  out({ type: 'result', subtype: scenario === 'normal' ? 'success' : 'error_during_execution', uuid: randomUUID(), session_id: sessionId,
    is_error: scenario !== 'normal', errors: scenario === 'normal' ? [] : ['PRIVATE_INTERRUPTION_DETAIL'],
    ...(scenario === 'normal' ? { result: 'PRIVATE_RESULT' } : {}),
    num_turns: 1, duration_ms: 35, duration_api_ms: 30, stop_reason: scenario === 'normal' ? 'end_turn' : null,
    total_cost_usd: 0, usage: { ...message.usage, output_tokens: scenario === 'normal' ? 7 : 1 }, modelUsage: {}, permission_denials: [] })
})
lines.on('close', () => process.exit(0))
