import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readCompiledBuild } from '../../../scripts/start-app.mjs'

const revision = /^[a-f0-9]{40}$/
const fail = code => { throw new Error(code) }

/** Each independent listener is a real same-origin application. Keep the
 * descriptor/DB/lease environment unchanged; only its public auth/RPC origin
 * follows this instance's already selected listening port. */
export function productionEnvironment(env, { origin, port }) {
  const endpoint = new URL(origin)
  if (endpoint.origin !== origin || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail('DESKTOP_TEST_SERVER_ADDRESS_INVALID')
  endpoint.port = String(port)
  return { ...env, BETTER_AUTH_URL: endpoint.origin }
}

/** Identify a real compiled application before starting it. A present but stale
 * Nitro build is an error, never a reason to silently launch an old Next build.
 * HTTP attestation and the exact database/lease checks remain with the caller. */
export async function productionApplication(directory, { expectedRevision, hostname, port, preload } = {}) {
  if (!revision.test(expectedRevision ?? '')) fail('DESKTOP_TEST_COMPILED_REVISION_REQUIRED')
  if (typeof hostname !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(hostname)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail('DESKTOP_TEST_SERVER_ADDRESS_INVALID')
  const root = await realpath(directory)
  const prefix = preload ? ['--require', resolve(preload)] : []
  // The application is always the compiled Nitro build; there is no Next
  // server to start, so a directory without it fails closed.
  const built = await readCompiledBuild(root, { expectedRevision })
  return { kind: 'nitro', revision: built.revision, appBuild: built.appBuild,
    args: [...prefix, resolve(root, 'scripts/start-app.mjs'), '--hostname', hostname, '--port', String(port)] }
}

/** Stop only a child created by the calling harness. Completion means its exit
 * event, not the signal being accepted; a forced kill remains failed evidence. */
export async function stopOwnedApplication(child, { graceMs = 35_000, killMs = 5_000, signal = (owned, name) => {
  try { process.kill(process.platform === 'win32' ? owned.pid : -owned.pid, name) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
} } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const completion = Promise.withResolvers()
  const onExit = () => completion.resolve()
  child.once('exit', onExit)
  const wait = async milliseconds => {
    let timer
    try { return await Promise.race([completion.promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    signal(child, 'SIGTERM')
    if (await wait(graceMs)) return
    signal(child, 'SIGKILL')
    if (!await wait(killMs)) fail('DESKTOP_TEST_SERVER_STOP_UNPROVEN')
    fail('DESKTOP_TEST_SERVER_STOP_FORCED')
  } finally { child.removeListener('exit', onExit) }
}
