// First process in a run container (run-container.ts): the container has no
// network interface, so this relays the CLI's proxy traffic to the run's one
// mounted egress socket, where the daemon applies the run's network approval.
// Then it runs the CLI and exits with it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { startNativeEgress } from './native-egress.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) process.exit(2)
const env = { ...process.env }
if (existsSync('/run/mikka-egress.sock')) {
  const egress = await startNativeEgress()
  Object.assign(env, {
    HTTP_PROXY: egress.url, HTTPS_PROXY: egress.url, http_proxy: egress.url, https_proxy: egress.url,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1',
  })
}
const child = spawn(command, args, { stdio: 'inherit', env })
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('error', () => process.exit(127))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)))
