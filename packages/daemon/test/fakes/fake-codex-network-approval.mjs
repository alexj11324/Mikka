#!/usr/bin/env node
// Deterministic app-server protocol fixture. It makes real HTTP proxy requests
// inside the official outer sandbox; it never calls a model or provider.
import { request } from 'node:http'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.163.0')
  process.exit(0)
}
const threadId = 'synthetic-network-thread'
const turnId = 'synthetic-network-turn'
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const notify = (method, params) => send({ method, params })
let running = false

function proxyGet(target) {
  // Only the runtime's normal proxy URL supplies transport credentials. No
  // model/CLI-controlled run, device, command or user identity headers exist.
  const destination = new URL(target)
  if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1' || destination.username || destination.password) throw new Error('loopback HTTP fixture required')
  const proxy = new URL(process.env.HTTP_PROXY ?? '')
  if (proxy.protocol !== 'http:') throw new Error('runtime HTTP_PROXY required')
  return new Promise(resolve => {
    const headers = proxy.username || proxy.password ? {
      'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`,
    } : {}
    const outgoing = request({ hostname: proxy.hostname, port: proxy.port, method: 'GET', path: destination.href, headers, agent: false }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    outgoing.on('error', error => resolve({ error: error.code ?? error.message }))
    outgoing.setTimeout(45_000, () => outgoing.destroy(new Error('synthetic proxy request deadline')))
    outgoing.end()
  })
}

function complete(status = 'completed') {
  running = false
  notify('turn/completed', { threadId, turn: { id: turnId, status, error: null } })
}

async function run(input) {
  const plan = JSON.parse(input)
  const allowed = await proxyGet(plan.target)
  const outside = plan.outside ? await proxyGet(plan.outside) : undefined
  const output = JSON.stringify({ allowed, outside, proxyConfigured: Boolean(process.env.HTTP_PROXY), privateIpcInherited: process.send !== undefined || process.env.NODE_CHANNEL_FD !== undefined, pid: process.pid })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'network-outcome', delta: output })
  // Hold the live turn so the host can test consumed/replayed/foreign decisions
  // before session completion revokes the entire gate and launcher.
}

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  switch (method) {
    case 'initialize':
      return send({ id, result: { userAgent: 'codex_cli_rs/0.163.0', codexHome: process.env.CODEX_HOME } })
    case 'thread/start':
      if (params.sandbox !== 'danger-full-access' || !params.cwd) return send({ id, error: { code: -1, message: 'invalid thread setup' } })
      return send({ id, result: { thread: { id: threadId } } })
    case 'turn/start':
      running = true
      send({ id, result: { turn: { id: turnId, status: 'inProgress', error: null } } })
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null } })
      void run(params.input[0].text).catch(error => {
        notify('error', { threadId, error: { message: error.message }, willRetry: false })
        complete('failed')
      })
      return
    case 'turn/steer':
      if (!running || params.expectedTurnId !== turnId) return send({ id, error: { code: -1, message: 'no live turn' } })
      send({ id, result: {} })
      return complete()
    case 'turn/interrupt':
      send({ id, result: {} })
      return complete('interrupted')
    default:
      return send({ id, error: { code: -32601, message: method } })
  }
})
