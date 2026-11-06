// Isolated protocol compatibility evidence, never subscription acceptance.
// shouldQuery:false appends/replays the frame without issuing a model turn.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const require = createRequire('/opt/mikka/worker/packages/daemon/package.json')
const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const manifest = JSON.parse(readFileSync('/opt/mikka/worker/.mikka-original-cli.json', 'utf8'))
const binary = manifest.original.claude_code
if (manifest.kind !== 'claude' || !binary) throw Error('original_claude_required')
const hash = () => createHash('sha256').update(readFileSync(binary.path)).digest('hex')
if (hash() !== binary.sha256) throw Error('original_claude_changed')
const version = execFileSync(binary.path, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
const home = await mkdtemp('/tmp/mikka-official-ack-')
const sessionId = randomUUID(), uuid = randomUUID(), abort = new AbortController()
let send, acknowledged, failed
const input = new Promise(resolve => { send = resolve })
const accepted = new Promise(resolve => { acknowledged = resolve })
const failure = new Promise((_, reject) => { failed = reject })
const timeout = setTimeout(() => { failed(Error('official_ack_timeout')); abort.abort() }, 15000)
const session = query({ prompt: (async function* () {
  await input
  yield { type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null, shouldQuery: false,
    message: { role: 'user', content: [{ type: 'text', text: 'Offline protocol acknowledgement.' }] } }
  await new Promise(() => {})
})(), options: {
  pathToClaudeCodeExecutable: binary.path, cwd: home, sessionId, abortController: abort,
  extraArgs: { 'replay-user-messages': null }, settingSources: [], tools: [], mcpServers: {},
  env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), DISABLE_NON_ESSENTIAL_TRAFFIC: '1' },
} })
const read = (async () => {
  for await (const frame of session) if (frame.type === 'user' && frame.session_id === sessionId && frame.uuid === uuid) acknowledged()
})()
void read.catch(failed)
try {
  await Promise.race([session.initializationResult(), failure])
  send()
  await Promise.race([accepted, failure])
  if (hash() !== binary.sha256) throw Error('original_claude_changed')
  console.log(JSON.stringify({ scope: 'offline-protocol-only', shouldQuery: false, exactUserAck: true,
    usesOriginalCli: true, officialBinarySha256: binary.sha256, officialCliVersion: version }))
} finally {
  clearTimeout(timeout); send(); session.close(); abort.abort(); await read.catch(() => {})
  await rm(home, { recursive: true, force: true })
}
