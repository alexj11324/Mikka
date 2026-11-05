// Local RPC fixture, not an application/backend substitute. It exercises the
// production authenticated server/client and delayed process shutdown.
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol'
import { RpcServer } from '../../../../packages/daemon/src/rpc/server.ts'

const directory = process.argv[2]
const secret = randomBytes(32).toString('hex')
await writeFile(join(directory, 'daemon.secret'), secret, { mode: 0o600 })
await writeFile(join(directory, 'daemon.pid'), `${process.pid}\n`, { mode: 0o600 })
const finish = () => setTimeout(async () => {
  await rm(join(directory, 'daemon.pid'))
  process.exit(0)
}, 250)
const server = new RpcServer({
  socketPath: join(directory, 'daemon.sock'), secret,
  hello: () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: 'acceptance-fixture', pid: process.pid }),
  handlers: { 'daemon.drain': () => {
    setTimeout(async () => {
      await server.close()
      // The production daemon also closes its RPC socket before final flush.
      finish()
    }, 25)
    return { ok: true }
  } },
  log: { error() {}, debug() {} },
})
await server.listen()
process.on('message', async message => {
  if (message !== 'begin-stop') return
  await server.close()
  process.send('socket-closed')
  finish()
})
process.send('ready')
