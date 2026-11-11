import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'

export async function availableEvePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return port
}

/** Start the pinned eve host as a peer process, with its own Workflow world.
 * It shares application credentials, never the main app's durable queue. */
export async function startEveService({ root = process.cwd(), env = process.env, development = false,
  spawnProcess = spawn, allocatePort = availableEvePort } = {}) {
  if (env.VERCEL || env.MIKKA_EVE_ORIGIN) return { close: async () => {} }
  const directory = development ? join(root, 'apps/eve') : await packagedEveDirectory(root)
  const port = await allocatePort()
  const origin = `http://127.0.0.1:${port}`
  const childEnv = { ...env, HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: String(port), NITRO_PORT: String(port),
    // For the local World its delivery base already contains the mount.
    // An additional prefix would duplicate it in browser callback URLs.
    EVE_PUBLIC_ROUTE_PREFIX: '',
    WORKFLOW_TARGET_WORLD: 'local',
    WORKFLOW_LOCAL_DATA_DIR: env.MIKKA_EVE_DATA_DIR ?? join(env.MIKKA_DATA_DIR ?? join(root, '.cache'), 'eve-workflow') }
  // eve's local World deliberately uses cwd/.eve/.workflow-data rather than
  // WORKFLOW_LOCAL_DATA_DIR. Bind that documented mount to persistent storage.
  await mkdir(childEnv.WORKFLOW_LOCAL_DATA_DIR, { recursive: true, mode: 0o700 })
  await mkdir(join(directory, '.eve'), { recursive: true })
  const storage = join(directory, '.eve/.workflow-data')
  const persistent = await realpath(childEnv.WORKFLOW_LOCAL_DATA_DIR)
  try { await symlink(persistent, storage, 'dir') }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (await realpath(storage) !== persistent) throw new Error('EVE_SERVICE_STORAGE_MISMATCH', { cause: error })
  }
  // Both the local World's deliveries and OAuth callbacks use eve's public
  // namespaced mount, never the main application's root Workflow consumer.
  childEnv.WORKFLOW_LOCAL_BASE_URL = new URL('/mikka/api/agents', env.BETTER_AUTH_URL ?? env.MIKKA_APP_ORIGIN ?? 'http://127.0.0.1:3000').href
  const args = development
    ? [join(root, 'node_modules/eve/bin/eve.js'), 'dev', '--no-ui', '--host', '127.0.0.1', '--port', String(port)]
    : [join(directory, 'server/index.mjs')]
  const child = spawnProcess(process.execPath, args, { cwd: directory, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.resume()
  let closing
  const close = () => closing ??= new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000).unref()
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
  try {
    await new Promise((resolve, reject) => {
      let pending = ''
      const timer = setTimeout(() => reject(new Error('EVE_SERVICE_START_TIMEOUT')), 180_000).unref()
      const finish = (error, origin) => {
        clearTimeout(timer)
        child.stdout.off('data', onOutput)
        if (error) reject(error); else resolve(origin)
      }
      const onOutput = chunk => {
        pending = (pending + chunk.toString()).slice(-16_384)
        const match = /(?:Listening on:?|Local:|server[^\n]*?)\s*(http:\/\/127\.0\.0\.1:\d+)/i.exec(pending)
        if (match && match[1] === origin) finish(null, match[1])
      }
      child.stdout.on('data', onOutput)
      child.once('error', cause => finish(new Error('EVE_SERVICE_START_FAILED', { cause })))
      child.once('exit', () => finish(new Error('EVE_SERVICE_EXITED')))
    })
    child.stdout.resume()
    env.MIKKA_EVE_ORIGIN = origin
    return { origin, close }
  } catch (error) { await close(); throw error }
}

export async function packagedEveDirectory(root) {
  for (const directory of [join(root, 'eve'), join(root, '.output/eve')]) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'mikka-eve-build.json'), 'utf8'))
      if (manifest.version !== 1 || manifest.eve !== '1.0.0-rc.9' || !/^[a-f0-9]{40}$/.test(manifest.revision)) throw new Error('EVE_SERVICE_BUILD_INVALID')
      await readFile(join(directory, 'server/index.mjs'))
      return directory
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error('EVE_SERVICE_BUILD_REQUIRED')
}
