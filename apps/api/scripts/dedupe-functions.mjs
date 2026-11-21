import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value

async function functionPaths(directory) {
  const result = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), entry = await lstat(path)
    if (name.endsWith('.func') && (entry.isDirectory() || entry.isSymbolicLink())) result.push(path)
    else if (entry.isDirectory()) result.push(...await functionPaths(path))
  }
  return result
}

async function fingerprint(directory, configuration) {
  const digest = createHash('sha256').update(JSON.stringify({
    configuration: sorted(configuration), directoryMode: (await lstat(directory)).mode & 0o777,
    configurationMode: (await lstat(join(directory, '.vc-config.json'))).mode & 0o777,
  }))
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      if (current === directory && name === '.vc-config.json') continue
      const path = join(current, name), entry = await lstat(path)
      const metadata = { path: relative(directory, path), mode: entry.mode & 0o777 }
      if (entry.isSymbolicLink()) {
        let target
        try { target = relative(directory, await realpath(path)) }
        catch (error) { if (['ENOENT', 'ELOOP'].includes(error.code)) return false; throw error }
        // Equal link text at different depths can point to different external
        // dependencies. Keep such functions independent, without following an
        // unbounded external graph or changing where their dependencies live.
        if (target === '..' || target.startsWith('../') || isAbsolute(target)) return false
        digest.update(JSON.stringify({ ...metadata, type: 'link', target: await readlink(path), resolved: target }))
      }
      else if (entry.isDirectory()) {
        digest.update(JSON.stringify({ ...metadata, type: 'directory' }))
        if (!await visit(path)) return false
      } else if (entry.isFile()) {
        digest.update(JSON.stringify({ ...metadata, type: 'file', bytes: entry.size }))
        for await (const bytes of createReadStream(path)) digest.update(bytes)
      } else throw new Error('API_FUNCTION_ENTRY_UNSUPPORTED')
    }
    return true
  }
  if (!await visit(directory)) return null
  return digest.digest('hex')
}

/** Nitro copies the complete server once per route with custom config. Keep
 * each route/config intact, aliasing only byte-identical HTTP implementations.
 * Trigger functions remain independent even when their content is identical. */
export async function deduplicateVercelFunctions(functions) {
  const root = resolve(functions), paths = await functionPaths(root), originals = []
  for (const path of paths) if ((await lstat(path)).isDirectory()) originals.push(path)
  const canonical = new Map(), replacements = []
  for (const path of originals) {
    const configuration = JSON.parse(await readFile(join(path, '.vc-config.json'), 'utf8'))
    if (configuration.experimentalTriggers !== undefined || configuration.runtime !== 'nodejs24.x') continue
    const identity = await fingerprint(path, configuration)
    if (!identity) continue
    const target = canonical.get(identity)
    if (target) replacements.push({ path, target })
    else canonical.set(identity, path)
  }
  // Finish all reads before changing output. Every alias uses Nitro's existing
  // relative .func directory contract, including its original public pathname.
  for (const { path, target } of replacements) {
    await rm(path, { recursive: true })
    await symlink(relative(dirname(path), target), path, 'dir')
  }
  for (const path of paths) if ((await lstat(path)).isSymbolicLink()) {
    const target = await realpath(path)
    const link = relative(dirname(path), target)
    if (await readlink(path) !== link) {
      await rm(path)
      await symlink(link, path, 'dir')
    }
  }
  return { functions: paths.length, implementations: originals.length - replacements.length, aliasesAdded: replacements.length }
}
