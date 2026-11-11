import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packageCloudflareEveHost } from '../../../scripts/package-cf-eve-host.mjs'

const sourceSha = 'a'.repeat(40), uiSha = 'b'.repeat(40)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-cf-eve-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.output/eve/server'), { recursive: true })
  await writeFile(join(root, '.output/eve/server/index.mjs'), 'export default {}')
  await writeFile(join(root, '.output/eve/mikka-eve-build.json'), JSON.stringify({
    version: 1, eve: '1.0.0-rc.9', revision: sourceSha, preset: 'node-server',
    world: '@workflow/world-postgres', worldVersion: '5.1.1',
  }))
  await mkdir(join(root, 'cloudflare/eve-runtime'), { recursive: true })
  await cp(new URL('../runtime', import.meta.url), join(root, 'cloudflare/eve-runtime/runtime'), { recursive: true })
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts/eve-service.mjs'), 'export const startEveService = () => {}')
  return { root, sourceSha, uiSha, releaseId: 'fixture-1' }
}

test('a private runtime image contains only the verified artifact, launcher and public release metadata', async t => {
  const options = await fixture(t)
  const result = await packageCloudflareEveHost(options)
  assert.deepEqual(JSON.parse(await readFile(join(result.output, 'eve-host.json'), 'utf8')), {
    version: 1, sourceSha, uiSha, releaseId: 'fixture-1',
  })
  assert.equal(await readFile(join(result.output, 'eve/server/index.mjs'), 'utf8'), 'export default {}')
  assert.match(await readFile(join(result.output, 'runtime/start.mjs'), 'utf8'), /startEveService/)
  await assert.rejects(packageCloudflareEveHost(options), /CF_EVE_IMAGE_OUTPUT_NOT_EMPTY/)
})

test('foreign builds and materialized local Workflow data are never packaged as the PG host', async t => {
  const options = await fixture(t)
  await assert.rejects(packageCloudflareEveHost({ ...options, sourceSha: 'c'.repeat(40) }), /CF_EVE_HOST_CONFIGURATION_INVALID/)
  await mkdir(join(options.root, '.output/eve/.eve/.workflow-data'), { recursive: true })
  await assert.rejects(packageCloudflareEveHost(options), /CF_EVE_IMAGE_LOCAL_STATE_REFUSED/)
})

test('runtime credentials in an environment file are not accepted into a reusable image', async t => {
  const options = await fixture(t)
  await writeFile(join(options.root, '.output/eve/.env'), 'PRIVATE_FIXTURE=do-not-package')
  await assert.rejects(packageCloudflareEveHost(options), /CF_EVE_IMAGE_ENV_FILE_REFUSED/)
})

test('relative dependency links remain portable after the entire build source is removed', async t => {
  const options = await fixture(t)
  await mkdir(join(options.root, '.output/eve/server/dependency'))
  await writeFile(join(options.root, '.output/eve/server/dependency/package.json'), '{"name":"fixture-dependency"}')
  await symlink('dependency', join(options.root, '.output/eve/server/linked'), 'dir')
  const { output } = await packageCloudflareEveHost(options)
  await rm(join(options.root, '.output/eve'), { recursive: true })
  assert.equal(await readlink(join(output, 'eve/server/linked')), 'dependency')
  assert.equal(JSON.parse(await readFile(join(output, 'eve/server/linked/package.json'), 'utf8')).name, 'fixture-dependency')
})

test('an artifact that still depends on the build checkout is refused before image creation', async t => {
  const options = await fixture(t)
  await symlink(options.root, join(options.root, '.output/eve/build-checkout'), 'dir')
  await assert.rejects(packageCloudflareEveHost(options), /CF_EVE_IMAGE_EXTERNAL_LINK_REFUSED/)
})
