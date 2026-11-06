import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { readCompiledBuild } from '../../../scripts/start-app.mjs'

const revision = /^[a-f0-9]{40}$/
const fail = code => { throw new Error(code) }

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
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
  if (await exists(resolve(root, '.output/mikka-build.json'))) {
    const built = await readCompiledBuild(root, { expectedRevision })
    return { kind: 'nitro', revision: built.revision, appBuild: built.appBuild,
      args: [...prefix, resolve(root, 'scripts/start-app.mjs'), '--hostname', hostname, '--port', String(port)] }
  }
  const path = resolve(root, '.next/required-server-files.json')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || !(await realpath(path)).startsWith(`${root}${sep}`)) fail('DESKTOP_TEST_COMPILED_FILE_INVALID')
  const built = JSON.parse(await readFile(path, 'utf8'))
  if (built.config?.env?.MIKKA_TEST_BUILD_SHA !== expectedRevision) fail('DESKTOP_TEST_COMPILED_REVISION_MISMATCH')
  return { kind: 'next', revision: expectedRevision,
    args: [...prefix, resolve(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', hostname, '--port', String(port)] }
}
