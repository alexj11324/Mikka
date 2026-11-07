import { registrationLogin } from '../../packages/daemon/src/login'
import { runCli } from '../../packages/daemon/src/cli'
import { startDaemon } from '../../packages/daemon/src/main'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http'

// The parent owns a disposable, attested application and passes a one-use
// enrollment grant over stdin. Never place a credential in argv or stdout.
const origin = process.env.MIKKA_CLOSEOUT_ORIGIN
const dataDir = process.env.MIKKA_CLOSEOUT_DATA_DIR
if (!origin || !dataDir || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) {
  throw new Error('Owned loopback application and daemon directory required')
}
const quiet = { out() {}, err() {} }
if (process.env.MIKKA_CLOSEOUT_RESTART !== '1') {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 256) throw new Error('Invalid one-use enrollment grant')
  }
  const credential = await registrationLogin({ serverUrl: `${origin}/mikka`, token: input.trim() })
  if (await runCli(['daemon', 'login', '--server', `${origin}/mikka`, '--data-dir', dataDir, '--token', credential], quiet) !== 0) {
    throw new Error('Normal daemon enrollment failed')
  }
}
if (process.env.MIKKA_CLOSEOUT_TRANSPORT_ONLY === '1') {
  // Observe the real daemon's own socket. Opening a second probe socket would
  // replace its connection under the gateway's one-device/one-socket contract.
  const NativeWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const target = new URL(url)
      const match = /^\/mikka\/v1\/devices\/([a-f0-9-]{36})\/socket$/.exec(target.pathname)
      if (target.origin !== origin.replace('http:', 'ws:') || !match || target.search || target.hash) throw new Error('Unexpected device gateway')
      super(url, protocols)
      this.addEventListener('open', () => this.send('ping'), { once: true })
      let reported = false
      this.addEventListener('message', event => {
        if (!reported && event.data === 'pong') {
          reported = true
          process.send?.({ phase: 'gateway-pong', deviceId: match[1] })
        }
      })
    }
  }
  const observedFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (target.origin !== origin || !target.pathname.startsWith('/mikka/v1/')) throw new Error('Unexpected device request')
    const response = await fetch(input, init)
    const heartbeat = /^\/mikka\/v1\/devices\/([a-f0-9-]{36})\/heartbeat$/.exec(target.pathname)
    if (heartbeat && init?.method === 'POST' && response.ok) process.send?.({ phase: 'heartbeat', deviceId: heartbeat[1] })
    return response
  }
  // Normal registration, RPC, HTTP and gateway; no fake harness or model work.
  const daemon = await startDaemon({ dataDir, flavor: 'prod', modelProbe: false,
    link: new HttpServerLink(`${origin}/mikka`, observedFetch), retainResources: true })
  // Existing public lifecycle method: real HTTP sync, never a state override.
  await daemon.syncWithServer()
  process.send?.({ phase: 'ready', status: daemon.status() })
  process.on('message', message => {
    if ((message as { command?: unknown })?.command !== 'sync-after-revocation') return
    void daemon.syncWithServer().then(() => process.send?.({ phase: 'revocation-sync', status: daemon.status() }))
  })
  const stop = () => { void daemon.stop().then(() => process.exit(0)) }
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop)
} else {
  const code = await runCli(['daemon', '--server', `${origin}/mikka`, '--data-dir', dataDir, '--retain-resources'], quiet)
  if (code !== null) process.exitCode = code
}
