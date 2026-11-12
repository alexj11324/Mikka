import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EVE_HOST_PORT, validateHostBuild } from './config.mjs'

function startEveService({ root, env, listen }) {
  const directory = join(root, 'eve')
  const child = spawn(process.execPath, [join(directory, 'server/index.mjs')], {
    cwd: directory, stdio: 'inherit', env: { ...env, HOST: listen.host, NITRO_HOST: listen.host,
      PORT: String(listen.port), NITRO_PORT: String(listen.port), MIKKA_RUNTIME_RESOURCE_ROOT: directory },
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { origin: 'http://127.0.0.1:' + listen.port, exited, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000).unref()
    try { child.kill('SIGTERM'); await exited } finally { clearTimeout(deadline) }
  } }
}

/** Start the same validated upstream runtime used by the application host. */
export async function startCloudflareEveHost({
  root = process.cwd(), env = process.env, signals = process,
  startService, load = path => readFile(path, 'utf8'),
} = {}) {
  if (!process.versions.node.startsWith('24.')) throw new Error('CF_EVE_NODE24_REQUIRED')
  const [build, host] = await Promise.all([
    load(join(root, 'eve', 'mikka-eve-build.json')).then(JSON.parse),
    load(join(root, 'eve-host.json')).then(JSON.parse),
  ])
  validateHostBuild(build, host, env)
  const start = startService ?? startEveService
  const service = await start({ root, env, listen: { host: '0.0.0.0', port: EVE_HOST_PORT } })
  if (!service.origin || !service.exited) {
    await service.close?.()
    throw new Error('CF_EVE_SERVICE_REQUIRED')
  }
  let closing, closeFailure
  const stop = () => {
    closing ??= service.close().catch(error => { closeFailure = error })
  }
  signals.once('SIGTERM', stop)
  signals.once('SIGINT', stop)
  try {
    const exit = await service.exited
    if (closing) await closing
    if (closeFailure) throw new Error('CF_EVE_SHUTDOWN_FAILED', { cause: closeFailure })
    if (exit.code !== 0 && !(closing && exit.signal === 'SIGTERM')) throw new Error('CF_EVE_SERVICE_EXITED')
    return exit
  } finally {
    signals.off('SIGTERM', stop)
    signals.off('SIGINT', stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startCloudflareEveHost().catch(() => {
    // Do not print configuration values, database errors or nested provider bodies.
    console.error('CF_EVE_HOST_START_FAILED')
    process.exitCode = 1
  })
}
