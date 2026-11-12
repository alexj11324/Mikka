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
    const incremental = await buildFrontend({ target: 'web', outdir: directory, clean: false })
    assert.equal(await readFile(stale, 'utf8'), content, 'incremental development keeps an already loaded chunk available')
    const clean = await buildFrontend({ target: 'web', outdir: directory })
    await assert.rejects(readFile(stale), { code: 'ENOENT' })
    assert.equal(incremental.rendererBuild, clean.rendererBuild, 'unreferenced old files cannot change the current application identity')
    assert.deepEqual(incremental.usedActions, clean.usedActions)
    assert.deepEqual(clean.serverModules, [])
    for (const path of ['favicon.ico', 'apple-icon.png', 'brand/mikka-app-icon-48.png', 'brand/mikka-app-icon-96.png', 'brand/mikka-app-icon-192.png']) {
      assert.deepEqual(await readFile(join(directory, path)), await readFile(new URL(`../../../public/${path}`, import.meta.url)))
    }
    await assert.rejects(readFile(join(directory, 'icon.svg')), { code: 'ENOENT' })
  } finally {
    if (previous === undefined) delete process.env.MIKKA_DEPLOYMENT_ID
    else process.env.MIKKA_DEPLOYMENT_ID = previous
    await rm(directory, { recursive: true, force: true })
  }
})
