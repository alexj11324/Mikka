#!/usr/bin/env node
// Protocol fixture, not a model: run through the real installed Agent SDK.
import { createInterface } from 'node:readline'
const argv = process.argv.slice(2)
const flag = name => {
  const inline = argv.find(value => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
const out = data => process.stdout.write(`${JSON.stringify(data)}\n`)
const session_id = '11111111-1111-4111-8111-111111111111'
let initialization
const mcp = (request_id, message) => out({ type: 'control_request', request_id, request: { subtype: 'mcp_message', server_name: 'mikka', message } })
const finish = result => out({ type: 'result', subtype: 'success', is_error: false, result, session_id, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
out({ type: 'system', subtype: 'init', session_id, cwd: process.cwd() })
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_response') {
    const id = message.response.request_id
    if (id === 'mcp-init') mcp('mcp-ready', { jsonrpc: '2.0', method: 'notifications/initialized' })
    else if (id === 'mcp-ready') mcp('mcp-call', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose_reply', arguments: { text: 'draft' } } })
    else if (id === 'mcp-call') finish(JSON.stringify(message.response))
    return
  }
  if (message.type === 'control_request') {
    initialization = message.request
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], agents: [], output_style: 'default' } } })
    return
  }
  if (message.type !== 'user') return
  const content = message.message.content
  const prompt = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('')
  if (prompt === 'TOOL') {
    mcp('mcp-init', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })
    return
  }
  if (prompt === 'HANG') return
  if (prompt === 'EXIT') { process.exit(1) }
  if (prompt === 'ERROR') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['fixture failure'], session_id })
    return
  }
  const result = prompt === 'INSPECT' ? JSON.stringify({ systemPrompt: flag('--system-prompt'), initialization, tools: flag('--tools'), settings: flag('--setting-sources'), persisted: !argv.includes('--no-session-persistence') }) : prompt
  out({ type: 'assistant', session_id, message: { id: 'msg_fixture', role: 'assistant', content: [{ type: 'text', text: result }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result, session_id, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
})
