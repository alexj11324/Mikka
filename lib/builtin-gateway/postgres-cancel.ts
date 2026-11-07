import { Client, type ClientConfig } from 'pg'
import { CodedError } from '@mikka/protocol/coded-error'

export type BackendKey = { processID: number; secretKey: number }
type CancelConnection = Client['connection'] & {
  sslNegotiation: string
  connect(port: number | string, host?: string): void
  requestSsl(): void
  cancel(processID: number, secretKey: number): void
}

/** Cancel only this session's query. pg's Client.cancel bypasses its SSL
 * negotiation, so use the same Connection transport with CancelRequest in
 * place of startup/auth. The backend key never enters a log or error. */
export async function cancelGatewayQuery(options: ClientConfig, key: BackendKey,
  createClient = (config: ClientConfig) => new Client(config)): Promise<void> {
  const client = createClient(options), connection = client.connection as CancelConnection
  await new Promise<void>((resolve, reject) => {
    let sent = false, settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.stream.destroy()
      reject(new CodedError('BUILTIN_GATEWAY_CANCEL_UNAVAILABLE'))
    }
    timer = setTimeout(fail, 5_000)
    connection.on('error', fail)
    connection.on('errorMessage', fail)
    connection.once('end', () => {
      if (settled) return
      clearTimeout(timer)
      if (!sent) return fail()
      settled = true
      resolve()
    })
    const cancel = () => { if (!settled) { sent = true; connection.cancel(key.processID, key.secretKey) } }
    connection.once('connect', () => {
      if (settled) return
      if (!client.ssl) cancel()
      else if (connection.sslNegotiation !== 'direct') connection.requestSsl()
    })
    connection.once('sslconnect', cancel)
    try {
      if (client.host.startsWith('/')) connection.connect(`${client.host}/.s.PGSQL.${client.port}`)
      else connection.connect(client.port, client.host)
    } catch { fail() }
  })
}
