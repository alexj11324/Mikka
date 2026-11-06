import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJson, writeJsonAtomic } from './fs-util'
import { DAEMON_VERSION, daemonPaths } from './paths'
import { connectDaemonInDataDir, isNoDaemon } from './rpc/client'
import { probeHostedRuntimeModels, type HostedModelProbe } from './cloud-model-probe'

const configSchema = z.object({
  deviceId: z.uuid(), workspaceId: z.uuid(),
  credential: z.string().regex(/^orv_[A-Za-z0-9_-]{43}$/),
  server: z.url({ protocol: /^https$/ }),
  protectionBypass: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/).optional(),
}).strict()

/** Read a one-use control-plane handoff. Never accept a symlink, a file
 * readable by another account, or task-supplied URL credentials. */
export function consumeCloudBootstrap(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error('Invalid cloud worker handoff')
    const config = configSchema.parse(JSON.parse(readFileSync(fd, 'utf8')))
    const url = new URL(config.server)
    if (url.username || url.password || url.search || url.hash || (config.protectionBypass && !url.hostname.endsWith('.vercel.app'))) throw new Error('Invalid cloud worker server')
    unlinkSync(path)
    return config
  } finally { closeSync(fd) }
}

/** A template can preload the worker without an identity. Only an atomic
 * bootstrap.json handoff wakes it; later handoffs rotate the same daemon.
 * Serialize events so a rename and its explicit wake cannot consume twice. */
export function watchCloudBootstraps(directory: string, accept: () => Promise<void>, failed: (error: unknown) => void) {
  const path = join(directory, 'bootstrap.json')
  let busy = false, closed = false, pending = false
  const wake = () => {
    pending = true
    if (busy || closed) return
    busy = true
    void (async () => {
      while (pending && !closed) {
        pending = false
        if (existsSync(path)) await accept()
      }
    })().catch(failed).finally(() => { busy = false; if (pending && !closed) wake() })
  }
  const watcher = watch(directory, (_event, name) => { if (String(name) === 'bootstrap.json') wake() })
  watcher.on('error', failed)
  process.on('SIGUSR1', wake)
  wake()
  return () => { closed = true; watcher.close(); process.off('SIGUSR1', wake) }
}

/** A snapshot is ready only after anonymous official CLI probes and all of
 * their processes finish. The one-use handoff receives only in-memory models;
 * no device identity or credential is read while preparing the snapshot. */
export async function preloadCloudWorker(directory: string, accept: (models: HostedModelProbe) => Promise<void>,
  failed: (error: unknown) => void, probe = probeHostedRuntimeModels) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const models = await probe()
  const closeWatcher = watchCloudBootstraps(directory, () => accept(models), failed)
  const ready = join(directory, 'preloaded.pid')
  const close = () => {
    process.off('exit', close)
    closeWatcher()
    try { unlinkSync(ready) } catch { /* Already removed. */ }
  }
  process.once('exit', close)
  try { writeFileSync(ready, `${process.pid}\n`, { mode: 0o600 }) }
  catch (error) { close(); throw error }
  return close
}

/** Seed a new daemon, or rotate a live daemon's credential over its private
 * authenticated socket. The caller serializes handoffs for this machine. */
export async function installCloudCredential(dataDir: string, config: z.infer<typeof configSchema>): Promise<'start' | 'updated'> {
  const file = daemonPaths(dataDir).device
  const current = readJson(file) as { deviceId?: unknown; workspaceId?: unknown } | undefined
  if (existsSync(file) && (!current || current.deviceId !== config.deviceId || current.workspaceId !== config.workspaceId)) throw new Error('Cloud device identity changed')
  try {
    const client = await connectDaemonInDataDir(dataDir, { name: 'cloud-worker', version: DAEMON_VERSION })
    try {
      const status = await client.request('daemon.status')
      if (status.deviceId && status.deviceId !== config.deviceId) throw new Error('Cloud device identity changed')
      if (!current) throw new Error('Cloud device identity unavailable')
      await client.request('device.setCredential', { credential: config.credential, workspaceId: config.workspaceId })
      return 'updated'
    } finally { client.close() }
  } catch (error) {
    if (!isNoDaemon(error)) throw error
    writeJsonAtomic(file, { ...current, deviceId: config.deviceId, workspaceId: config.workspaceId, credential: config.credential })
    return 'start'
  }
}
