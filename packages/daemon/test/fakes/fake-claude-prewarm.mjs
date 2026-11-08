// Anonymous transport fixture for the real installed SDK. It never executes
// tools or contacts a provider; IPC gives tests exact protocol pause points.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = name => {
  const inline = args.find(arg => arg.startsWith(name + '='))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const sessionId = flag('--session-id')
const mode = flag('--fixture-mode')
const initialization = { commands: [], agents: [], output_style: 'default', account: {
  apiProvider: mode === 'wrong_account' ? 'gateway' : 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
} }
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const success = (frame, response) => send({ type: 'control_response', response: {
  subtype: 'success', request_id: frame.request_id, response,
} })
const emit = event => process.send?.(event)
const sdkReplies = new Map()
let sdkId = 0, sdkServers = []
const sdkCall = (method, params) => new Promise(resolve => {
  const request_id = `mailbox-${++sdkId}`
  sdkReplies.set(request_id, resolve)
  send({ type: 'control_request', request_id, request: { subtype: 'mcp_message', server_name: 'mikka_mailbox',
    message: { jsonrpc: '2.0', id: sdkId, method, params } } })
})
let releaseInitialize, releaseClaim
let descendant
if (mode === 'descendant') {
  descendant = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], 'terminated'); process.exit(0) });
    process.send({ pid: process.pid });
    setInterval(() => {}, 1000);
  `, flag('--termination-file')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  descendant.on('message', value => emit({ event: 'descendant', ...value }))
}
process.on('message', value => {
  if (value?.release === 'initialize') releaseInitialize?.()
  if (value?.release === 'claim') releaseClaim?.()
})
process.on('SIGTERM', () => {
  if (descendant && descendant.exitCode === null) descendant.once('exit', () => process.exit(0))
  else process.exit(0)
})
const lines = createInterface({ input: process.stdin })
lines.on('line', async line => {
  const frame = JSON.parse(line)
  if (frame.type === 'user') {
    emit({ event: 'user', uuid: frame.uuid, sessionId: frame.session_id, text: frame.message.content[0].text })
    send(frame)
    return
  }
  if (frame.type === 'control_response') {
    sdkReplies.get(frame.response.request_id)?.(frame.response.response?.mcp_response ?? frame.response.response)
    sdkReplies.delete(frame.response.request_id)
    return
  }
  if (frame.type !== 'control_request') return
  const type = frame.request.subtype
  emit({ event: 'control', type })
  if (type === 'initialize') {
    sdkServers = frame.request.sdkMcpServers ?? []
    const reply = () => success(frame, initialization)
    if (mode === 'pause_initialize') releaseInitialize = reply
    else reply()
  } else if (type === 'claim_session') {
    const reply = async () => {
      if (mode === 'refuse_claim' || mode === 'project_settings') {
        send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id,
          error: `${mode === 'project_settings' ? 'project_settings_not_claimable' : 'cwd_not_found'}: anonymous fixture refusal` } })
      } else {
        if (sdkServers.includes('mikka_mailbox')) {
          await sdkCall('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
          const catalogue = await sdkCall('tools/list', {})
          emit({ event: 'catalogue', names: catalogue.result.tools.map(tool => tool.name) })
        }
        success(frame, {
        cwd: mode === 'wrong_cwd' ? process.cwd() : frame.request.cwd,
        session_id: mode === 'wrong_session' ? '00000000-0000-0000-0000-000000000000' : sessionId,
        parked_ms: 0, sdk_mcp_settled: true, initialize: initialization,
      })
      }
    }
    if (mode === 'pause_claim') releaseClaim = reply
    else reply()
  } else success(frame, {})
})
lines.once('close', () => process.exit(0))
emit({ event: 'spawn', cwd: process.cwd(), awaitingClaim: args.includes('--await-claim'),
  home: process.env.HOME, model: flag('--model'), append: flag('--append-system-prompt'),
  attribution: JSON.parse(flag('--settings') ?? '{}').attribution ?? null,
  mcpNames: Object.keys(JSON.parse(flag('--mcp-config') ?? '{"mcpServers":{}}').mcpServers).sort() })
