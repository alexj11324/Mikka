// This supervisor runs inside the disposable fake's Linux mount/PID namespace.
// Its private pipe carries command output only to the HTTP fake, never to logs.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const jobs = new Map()
const userUid = process.argv[2], userGid = process.argv[3]
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const message = JSON.parse(line), job = jobs.get(message.pid)
  if (message.op === 'start') {
    const options = message.process
    const command = message.user === 'root' ? options.cmd : '/usr/bin/setpriv'
    const args = message.user === 'root' ? options.args : ['--reuid', userUid, '--regid', userGid, process.getuid() === 0 ? '--clear-groups' : '--keep-groups', options.cmd, ...options.args]
    const child = spawn(command, args, { cwd: options.cwd ?? '/home/user',
      env: { ...process.env, ...options.envs, HOME: message.user === 'root' ? '/root' : '/home/user', USER: message.user },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    jobs.set(child.pid, child)
    send({ id: message.id, type: 'start', pid: child.pid })
    child.stdout.on('data', bytes => send({ id: message.id, type: 'stdout', data: bytes.toString('base64') }))
    child.stderr.on('data', bytes => send({ id: message.id, type: 'stderr', data: bytes.toString('base64') }))
    child.once('error', () => send({ id: message.id, type: 'stderr', data: Buffer.from('Isolated command could not start\n').toString('base64') }))
    child.once('close', (code, signal) => { jobs.delete(child.pid); send({ id: message.id, type: 'end', exitCode: code ?? 128, signal }) })
    if (!message.stdin) child.stdin.end()
  } else if (message.op === 'input') {
    if (job && !job.stdin.destroyed) job.stdin.write(Buffer.from(message.data, 'base64'))
  } else if (message.op === 'close-input') {
    job?.stdin.end()
  } else if (message.op === 'signal' && job) {
    try { process.kill(-job.pid, message.signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
})
input.once('close', () => process.exit(0))
send({ type: 'ready' })
