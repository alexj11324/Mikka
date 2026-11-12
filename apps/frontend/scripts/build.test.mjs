import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildFrontend } from './build.mjs'

test('real frontend builds retain incremental files without fingerprinting them and clean builds remove them', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-build-output-'))
  const previous = process.env.MIKKA_DEPLOYMENT_ID
  try {
    process.env.MIKKA_DEPLOYMENT_ID = 'build-output-contract'
    const stale = join(directory, 'assets/obsolete.js')
    const content = 'import "./previous-deployment.js";\n'
    await mkdir(join(directory, 'assets'))
    await writeFile(stale, content)
    const incremental = await buildFrontend({ target: 'web', outdir: directory, clean: false, publicTestFixture: true })
    assert.equal(await readFile(stale, 'utf8'), content, 'incremental development keeps an already loaded chunk available')
    const clean = await buildFrontend({ target: 'web', outdir: directory, publicTestFixture: true })
    await assert.rejects(readFile(stale), { code: 'ENOENT' })
    assert.equal(clean.publicTestFixture, true)
    assert.equal(incremental.rendererBuild, clean.rendererBuild, 'unreferenced old files cannot change the current application identity')
    assert.deepEqual(incremental.usedActions, clean.usedActions)
    assert.deepEqual(clean.serverModules, [])
  } finally {
    if (previous === undefined) delete process.env.MIKKA_DEPLOYMENT_ID
    else process.env.MIKKA_DEPLOYMENT_ID = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('the public server ships its real handoff pages without the workspace or private providers', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-server-pages-'))
  try {
    const result = await buildFrontend({ target: 'web', outdir: directory })
    const manifest = JSON.parse(await readFile(join(directory, 'renderer-manifest.json'), 'utf8'))
    assert.deepEqual(manifest, result)
    assert.equal(manifest.serverPages, true)
    for (const required of ['components/auth-form.tsx', 'components/device-authorization.tsx',
      'components/oauth-consent.tsx', 'components/plugins/github-settings.tsx', 'apps/desktop/src/renderer/deep-link-routes.tsx']) {
      assert.ok(manifest.inputs.includes(required), required)
    }
    const forbidden = /(?:^|\/)(?:\.hosted-ui\/|apps\/desktop\/src\/renderer\/workspace(?:-loader)?\.tsx?$|components\/(?:workspace\/issue-workspace|slots\/(?:app-frame|tasks|task-detail|inbox|board))\.tsx?$)/
    assert.deepEqual(manifest.inputs.filter(path => forbidden.test(path)), [])
    assert.ok(manifest.inputs.includes('apps/frontend/src/web/server-workspace-loader.ts'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
