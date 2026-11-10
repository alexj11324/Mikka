// Local RPC fixture, not an application/backend substitute. It exercises the
// production authenticated server/client and delayed socket startup/shutdown.
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol'
import { RpcServer } from '../../../../packages/daemon/src/rpc/server.ts'

const directory = process.argv[2]
const delayedListen = process.argv[3] === 'delayed-listen'
const helloPid = process.argv[4] ? Number(process.argv[4]) : process.pid
const closeWithoutReply = process.argv[5] === 'close-without-reply'
const holdAfterClose = process.argv[6] === 'hold-after-close'
const drainReply = process.argv[7]
const secret = randomBytes(32).toString('hex')
await writeFile(join(directory, 'daemon.secret'), secret, { mode: 0o600 })
await writeFile(join(directory, 'daemon.pid'), `${process.pid}\n`, { mode: 0o600 })
const finish = () => setTimeout(async () => {
  await rm(join(directory, 'daemon.pid'))
  process.exit(0)
}, 250)
const server = new RpcServer({
  socketPath: join(directory, 'daemon.sock'), secret,
  hello: () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: '0.0.0-acceptance-fixture', pid: helloPid }),
  handlers: { 'daemon.drain': () => {
    if (closeWithoutReply) {
      // Deliberately lose this response at the real protocol/socket boundary.
      // The client must still prove the recorded child exits before cleanup.
      void server.close().then(() => {
        process.send('socket-closed')
        if (!holdAfterClose) finish()
      })
      return new Promise(() => {})
    }
    setTimeout(async () => {
      await server.close()
      // The production daemon also closes its RPC socket before final flush.
      finish()
    }, 25)
    if (drainReply === 'error') throw new Error('NATIVE_DAEMON_DRAIN_TIMEOUT')
    return drainReply === 'invalid' ? { ok: false } : { ok: true }
  } },
  log: { error() {}, debug() {} },
})
process.on('message', async message => {
  if (message === 'finish-stop' && closeWithoutReply && holdAfterClose) { finish(); return }
  if (message === 'listen' && delayedListen) {
    await server.listen()
    process.send('ready')
    return
  }
  if (message !== 'begin-stop') return
  await server.close()
  process.send('socket-closed')
  finish()
})
if (delayedListen) process.send('starting')
else {
  await server.listen()
  process.send('ready')
}
