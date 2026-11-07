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
  apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
} }
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const success = (frame, response) => send({ type: 'control_response', response: {
  subtype: 'success', request_id: frame.request_id, response,
} })
const emit = event => process.send?.(event)
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
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type === 'user') {
    emit({ event: 'user', uuid: frame.uuid, sessionId: frame.session_id })
    send(frame)
    return
  }
  if (frame.type !== 'control_request') return
  const type = frame.request.subtype
  emit({ event: 'control', type })
  if (type === 'initialize') {
    const reply = () => success(frame, initialization)
    if (mode === 'pause_initialize') releaseInitialize = reply
    else reply()
  } else if (type === 'claim_session') {
    const reply = () => {
      if (mode === 'refuse_claim') {
        send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id,
          error: 'cwd_not_found: anonymous fixture refusal' } })
      } else success(frame, {
        cwd: mode === 'wrong_cwd' ? process.cwd() : frame.request.cwd,
        session_id: mode === 'wrong_session' ? '00000000-0000-0000-0000-000000000000' : sessionId,
        parked_ms: 0, sdk_mcp_settled: true, initialize: initialization,
      })
    }
    if (mode === 'pause_claim') releaseClaim = reply
    else reply()
  } else success(frame, {})
})
lines.once('close', () => process.exit(0))
emit({ event: 'spawn', cwd: process.cwd(), awaitingClaim: args.includes('--await-claim'),
  mcpNames: Object.keys(JSON.parse(flag('--mcp-config') ?? '{"mcpServers":{}}').mcpServers).sort() })
