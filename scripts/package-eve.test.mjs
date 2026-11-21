import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packageEve } from './package-eve.mjs'

test('Node packaging rejects mixed revisions and includes Eve and application resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-packaging-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, '.output'), source = join(root, 'apps/eve/.output')
  await mkdir(source, { recursive: true })
  await mkdir(join(output, 'lib'), { recursive: true })
  const revision = 'a'.repeat(40)
  const agent = { version: 1, revision, eve: '1.0.0-rc.9', preset: 'node-server' }
  const save = (path, value) => writeFile(path, JSON.stringify(value))
  await save(join(source, 'mikka-eve-build.json'), agent)
  await writeFile(join(source, 'eve-entry.mjs'), 'export default 1')
  await writeFile(join(output, 'lib/resource.txt'), 'runtime resource')
  const app = { revision: 'b'.repeat(40), resources: [{ path: 'lib/resource.txt' }] }
  await save(join(output, 'mikka-build.json'), app)
  await assert.rejects(packageEve({ root }), /EVE_APP_BUILD_MISMATCH/)
  await assert.rejects(packageEve({ root, preset: 'vercel' }), /EVE_BUILD_PRESET_INVALID/)
  app.revision = revision
  await save(join(output, 'mikka-build.json'), app)
  await packageEve({ root })
  assert.equal(await readFile(join(output, 'eve/eve-entry.mjs'), 'utf8'), 'export default 1')
  assert.equal(await readFile(join(output, 'eve/lib/resource.txt'), 'utf8'), 'runtime resource')
  assert.deepEqual(JSON.parse(await readFile(join(output, 'mikka-build.json'), 'utf8')).eve, agent)
})
