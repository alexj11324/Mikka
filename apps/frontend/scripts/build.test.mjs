// These suites build the real application through Rolldown, a multi-threaded
// bundler: how it splits and orders modules depends on the threads it gets. The
// frontend test script therefore runs files one at a time (--test-concurrency=1):
// running them in parallel lets CPU contention change a chunk split between two
// builds of the same source, which reads as an unstable application identity.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildFrontend } from './build.mjs'

/** Every asset under `assets/`, keyed by its path relative to the outdir and hashed by content. */
async function emittedAssets(directory) {
  const hashes = {}
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else hashes[relative(directory, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await walk(join(directory, 'assets'))
  return hashes
}

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
    const incrementalAssets = await emittedAssets(directory)
    const clean = await buildFrontend({ target: 'web', outdir: directory, publicTestFixture: true })
    await assert.rejects(readFile(stale), { code: 'ENOENT' })
    assert.equal(clean.publicTestFixture, true)
    // A failure here has to say *which* kind of drift happened: an asset only one
    // run emitted, or the same name carrying different bytes. Those are different
    // bugs, and the bare fingerprint comparison hides which one occurred.
    const cleanAssets = await emittedAssets(directory)
    const drifted = [...new Set([...Object.keys(incrementalAssets), ...Object.keys(cleanAssets)])]
      .filter(name => name !== 'assets/obsolete.js' && incrementalAssets[name] !== cleanAssets[name])
      .map(name => `${name} ${incrementalAssets[name] ?? '(absent)'} -> ${cleanAssets[name] ?? '(absent)'}`)
    assert.equal(incremental.rendererBuild, clean.rendererBuild,
      `unreferenced old files cannot change the current application identity; drift: ${drifted.length ? drifted.join('; ') : 'none'}`)
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
