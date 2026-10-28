import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, dirname } from 'node:path'

// Preservation is mandatory in every environment until cleanup is authorized.
export function retainMvpResources(_env = process.env) { return true }

// Credential revocation is distinct from deleting resources or stopping a
// process whose signal handlers may delete them.
export async function finishMvpResources({ revoke, retain: _retain, stop: _stop, cleanup: _cleanup } = {}) {
  if (revoke) await revoke()
}

// Only explicit non-secret identifiers are permitted in the private index.
export function resourceRecord(kind, value) {
  const allowed = new Set(['database-target', 'workflow-directory', 'origin-directory', 'daemon-directory', 'owner-id', 'device-id', 'run-id', 'token-id', 'scenario-id'])
  if (!allowed.has(kind) || typeof value !== 'string' || !value || ['\r', '\n', String.fromCharCode(0)].some(char => value.includes(char))) throw new Error('Invalid MVP resource record')
  return JSON.stringify({ kind, value }) + '\n'
}

export async function indexMvpResource(kind, value, env = process.env) {
  if (!retainMvpResources(env)) return
  const path = env.MIKKA_MVP_RESOURCE_INDEX
  if (!path || !isAbsolute(path)) throw new Error('Retain mode requires an absolute MIKKA_MVP_RESOURCE_INDEX')
  const dir = await lstat(dirname(path))
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw new Error('MVP index directory must be private')
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('MVP index file must be private')
    await file.write(resourceRecord(kind, value))
  } finally { await file.close() }
}
