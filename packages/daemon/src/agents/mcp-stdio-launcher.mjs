import { spawn } from 'node:child_process'

const [cwd, command, ...args] = process.argv.slice(2)
if (!cwd || !command) process.exit(1)
const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit', shell: false })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.once('error', () => process.exit(1))
child.once('exit', (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) }
  else process.exit(code ?? 1)
})
