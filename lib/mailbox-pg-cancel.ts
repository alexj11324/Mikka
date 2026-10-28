import { Client, type PoolClient } from 'pg'
import type { EventEmitter } from 'node:events'
import { mailboxDiagnostic } from './mailbox-diagnostics'

type Wire = EventEmitter & {
  connect(...args: (number | string)[]): void
  requestSsl(): void
  cancel(pid: number, key: number): void
  stream: { destroy(): unknown }
}
type Connected = {
  processID?: number; secretKey?: number
  connectionParameters?: { host?: string; port?: number; ssl?: boolean | Record<string, unknown>; sslnegotiation?: string }
}
type Result = 'closed-after-send' | 'unavailable' | 'failed' | 'timeout'
/** PostgreSQL cancellation is a separate protocol connection, NOT a query or
 * new login. Use only the already authenticated client's endpoint and ephemeral
 * PID/key. Never reuse the checked-out client until this bounded attempt ends.
 * The driver handles SSL negotiation/CA verification; never downgrade to plain.
 * Server EOF is not a cancellation ACK: the original query still decides outcome.
 */
export async function cancelMailboxBackend(client: PoolClient, makeWire: (options: Record<string, unknown>) => Wire = options => (new Client(options) as unknown as { connection: Wire }).connection): Promise<Result> {
  const raw = client as unknown as Connected, p = raw.connectionParameters
  const pid = raw.processID, key = raw.secretKey
  if (!p || typeof p.host !== 'string' || !p.host || !Number.isInteger(p.port) || p.port! < 1 || p.port! > 65535
    || !Number.isInteger(pid) || pid! <= 0 || pid! > 2147483647 || !Number.isInteger(key) || key! < -2147483648 || key! > 2147483647
    || (p.sslnegotiation !== undefined && !['postgres', 'direct'].includes(p.sslnegotiation))
    || (typeof p.ssl === 'object' && p.ssl?.rejectUnauthorized === false)) {
    mailboxDiagnostic('cancel.unavailable'); return 'unavailable'
  }
  const host = p.host, port = p.port!
  let wire: Wire
  try {
    // No startup/authentication is sent. Explicit dummy values avoid ambient
    // PGUSER/PGPASSWORD/PGDATABASE selection even in the unused Client wrapper.
    wire = makeWire({ host: p.host, port: p.port, ssl: p.ssl ?? false, sslnegotiation: p.sslnegotiation,
      user: 'unused-cancel-protocol', database: 'unused-cancel-protocol', password: () => undefined })
    if (!['connect', 'cancel', 'requestSsl'].every(name => typeof Reflect.get(wire, name) === 'function') || !wire.stream?.destroy) throw Error('Unsupported pg cancellation wire')
  } catch { mailboxDiagnostic('cancel.unavailable', { backendPID: pid }); return 'unavailable' }
  return new Promise<Result>(resolve => {
    let sent = false, done = false
    const finish = (result: Result) => {
      if (done) return; done = true; clearTimeout(timer)
      mailboxDiagnostic('cancel.finish', { backendPID: pid, outcome: result })
      // Keep the error listener until this wire is collected: destroying a
      // TLS socket may deliver a final asynchronous error after close.
      wire.removeListener('connect', connected); wire.removeListener('sslconnect', send); wire.removeListener('end', ended)
      try { wire.stream.destroy() } catch { /* bounded control connection only */ }
      resolve(result)
    }
    const send = () => { if (done) return; try { wire.cancel(pid!, key!); sent = true; mailboxDiagnostic('cancel.sent', { backendPID: pid }) } catch { finish('failed') } }
    const connected = () => { if (done) return; if (!p.ssl) send(); else if (p.sslnegotiation !== 'direct') { try { wire.requestSsl() } catch { finish('failed') } } }
    const ended = () => finish(sent ? 'closed-after-send' : 'failed')
    const timer = setTimeout(() => finish('timeout'), 1000)
    wire.on('error', () => finish('failed')); wire.once('end', ended); wire.once('connect', connected); wire.once('sslconnect', send)
    mailboxDiagnostic('cancel.connect', { backendPID: pid })
    try { if (host.startsWith('/')) wire.connect(host + '/.s.PGSQL.' + port); else wire.connect(port, host) } catch { finish('failed') }
  })
}
