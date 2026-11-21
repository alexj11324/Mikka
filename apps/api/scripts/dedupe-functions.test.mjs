import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { deduplicateVercelFunctions } from './dedupe-functions.mjs'

const exec = promisify(execFile)
const config = { runtime: 'nodejs24.x', handler: 'index.mjs', maxDuration: 120, supportsCancellation: true }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-function-alias-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const functions = join(root, 'functions')
  await mkdir(functions)
  async function create(name, configuration = config, resource = 'required runtime data') {
    const path = join(functions, name + '.func')
    await mkdir(join(path, 'resources'), { recursive: true })
    await writeFile(join(path, '.vc-config.json'), JSON.stringify(configuration))
    await writeFile(join(path, 'index.mjs'), 'import {readFile} from "node:fs/promises"; export default await readFile(new URL("./resources/data",import.meta.url),"utf8")')
    await writeFile(join(path, 'resources/data'), resource)
    return path
  }
  return { root, functions, create }
}

test('equivalent HTTP routes retain their complete execution config and runtime files through archive/extraction', async t => {
  const { root, functions, create } = await fixture(t)
  const first = await create('api/a'), second = await create('api/b')
  const oldAlias = join(functions, 'existing.func')
  await symlink('api/b.func', oldAlias, 'dir')
  const result = await deduplicateVercelFunctions(functions)
  assert.equal(result.implementations, 1)
  assert.equal(result.aliasesAdded, 1)
  assert.ok((await lstat(second)).isSymbolicLink())
  assert.equal(await realpath(oldAlias), first)
  const archive = join(root, 'output.tgz'), unpacked = join(root, 'unpacked')
  await exec('tar', ['-czf', archive, '-C', root, 'functions'])
  await mkdir(unpacked)
  await exec('tar', ['-xzf', archive, '-C', unpacked])
  await rm(functions, { recursive: true })
  for (const name of ['api/a.func', 'api/b.func', 'existing.func']) {
    const path = join(unpacked, 'functions', name)
    assert.deepEqual(JSON.parse(await readFile(join(path, '.vc-config.json'))), config)
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
      `console.log((await import(${JSON.stringify('file://' + join(path, 'index.mjs'))})).default)`])
    assert.equal(stdout.trim(), 'required runtime data')
  }
})

test('different limits, cancellation, unknown platform options, bytes and modes remain independent', async t => {
  const { functions, create } = await fixture(t)
  await create('a')
  const variants = [
    ['duration', { ...config, maxDuration: 300 }],
    ['cancellation', { ...config, supportsCancellation: false }],
    ['region', { ...config, regions: ['cle1'] }],
    ['trigger-a', { ...config, experimentalTriggers: [{ type: 'queue/v2beta', topic: 'same' }] }],
    ['trigger-b', { ...config, experimentalTriggers: [{ type: 'queue/v2beta', topic: 'same' }] }],
  ]
  for (const [name, configuration] of variants) await create(name, configuration)
  await create('different-data', config, 'a different necessary dependency')
  const executable = await create('executable')
  await chmod(join(executable, 'resources/data'), 0o755)
  const directoryMode = await create('directory-mode'), configMode = join(await create('config-mode'), '.vc-config.json')
  await chmod(directoryMode, ((await lstat(directoryMode)).mode & 0o777) ^ 0o010)
  await chmod(configMode, ((await lstat(configMode)).mode & 0o777) ^ 0o040)
  const result = await deduplicateVercelFunctions(functions)
  assert.equal(result.aliasesAdded, 0)
  for (const [name] of variants) assert.ok((await lstat(join(functions, name + '.func'))).isDirectory())
})

test('dependency links and full config values participate in identity; a second packaging pass is stable', async t => {
  const { functions, create } = await fixture(t)
  const first = await create('a'), second = await create('b'), third = await create('c')
  await symlink('resources/data', join(first, 'dependency'))
  await symlink('resources/data', join(second, 'dependency'))
  await symlink('index.mjs', join(third, 'dependency'))
  assert.equal((await deduplicateVercelFunctions(functions)).aliasesAdded, 1)
  assert.equal((await deduplicateVercelFunctions(functions)).aliasesAdded, 0)
  assert.equal(await realpath(second), first)
  assert.ok((await lstat(third)).isDirectory())
})

test('identical relative links at different nesting depths cannot select different external dependency bytes', async t => {
  const { functions, create } = await fixture(t)
  const first = await create('a'), second = await create('nested/b')
  await writeFile(join(functions, 'shared.txt'), 'dependency A')
  await writeFile(join(functions, 'nested/shared.txt'), 'dependency B')
  await symlink('../shared.txt', join(first, 'dependency'))
  await symlink('../shared.txt', join(second, 'dependency'))
  assert.equal((await deduplicateVercelFunctions(functions)).aliasesAdded, 0)
  assert.equal(await readFile(join(first, 'dependency'), 'utf8'), 'dependency A')
  assert.equal(await readFile(join(second, 'dependency'), 'utf8'), 'dependency B')
})
